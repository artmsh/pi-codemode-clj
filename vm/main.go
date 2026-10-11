// The codemode_clj VM: the let-go Clojure interpreter as a WASI module whose only capabilities are
// the host imports below. The host (../worker.mjs) feeds one JSON request on stdin, serves tool
// calls, and collects output; the module has no file system, network, or environment.
//
// Tool calls are split into a non-blocking submit and a blocking wait so that futures which each
// call a tool are all in flight at once, although the module runs on a single thread.
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime"
	"strings"
	"unsafe"

	"github.com/nooga/let-go/pkg/api"
	"github.com/nooga/let-go/pkg/compiler"
	"github.com/nooga/let-go/pkg/vm"
)

//go:wasmimport codemode submit
func hostSubmit(ptr unsafe.Pointer, n uint32)

// hostWait blocks for at most timeoutMs. It returns 0 when no result arrived, the result's length
// when it was written to the buffer, and a length above capacity when the buffer is too small; the
// result then stays queued for the next call.
//
//go:wasmimport codemode wait
func hostWait(ptr unsafe.Pointer, capacity uint32, timeoutMs uint32) uint32

//go:wasmimport codemode emit
func hostEmit(kind uint32, ptr unsafe.Pointer, n uint32)

// hostSafepoint returns normally, or traps when the host wants the script stopped.
//
//go:wasmimport codemode safepoint
func hostSafepoint()

const (
	emitText    = 0
	emitValue   = 2
	emitError   = 3
	emitStore   = 4
	waitSliceMs = 20
)

//go:embed prelude.clj
var prelude string

// Tool names that are usable as a Clojure symbol. Others are reached with codemode/call-tool.
var symbolName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)

type request struct {
	Code  string   `json:"code"`
	Tools []string `json:"tools"`
}

type result struct {
	ID      uint32 `json:"id"`
	OK      bool   `json:"ok"`
	Payload string `json:"payload"`
}

var (
	input   []byte
	pending = map[uint32]chan result{}
	nextID  uint32
	submits uint64
	pumping bool
	exited  bool
)

func bytesPtr(b []byte) unsafe.Pointer {
	if len(b) == 0 {
		return unsafe.Pointer(&[1]byte{})
	}
	return unsafe.Pointer(&b[0])
}

func emit(kind uint32, s string) {
	b := []byte(s)
	hostEmit(kind, bytesPtr(b), uint32(len(b)))
}

// pump delivers results to the goroutines waiting in call. It only blocks in the host once every
// runnable goroutine has had the chance to submit its own call, and never for longer than
// waitSliceMs, so goroutines that compute while calls are in flight keep running.
func pump() {
	buf := make([]byte, 64<<10)
	for {
		seen := submits
		runtime.Gosched()
		if len(pending) == 0 {
			pumping = false
			return
		}
		if submits != seen {
			continue
		}
		n := hostWait(bytesPtr(buf), uint32(len(buf)), waitSliceMs)
		if n == 0 {
			continue
		}
		if int(n) > len(buf) {
			buf = make([]byte, n)
			continue
		}
		var r result
		if err := json.Unmarshal(buf[:n], &r); err != nil {
			panic(fmt.Sprintf("codemode host sent an unreadable result: %v", err))
		}
		ch := pending[r.ID]
		delete(pending, r.ID)
		ch <- r
	}
}

// call runs one host call and returns "+" followed by the JSON result, or "-" followed by the
// error text. The prelude turns the latter into an ex-info.
func call(kind, name, args string) string {
	// The channel is registered before the host hears of the call, so pump can never receive a
	// result it has no channel for.
	nextID++
	id := nextID
	ch := make(chan result, 1)
	pending[id] = ch
	req, _ := json.Marshal(map[string]any{"id": id, "kind": kind, "name": name, "args": args})
	hostSubmit(bytesPtr(req), uint32(len(req)))
	submits++
	if !pumping {
		pumping = true
		go pump()
	}
	r := <-ch
	if !r.OK {
		return "-" + r.Payload
	}
	return "+" + r.Payload
}

// unterminated reports whether the script ends inside a form or a string. let-go's own loop cannot
// tell that from the end of the input and would silently drop the unfinished form, so the script is
// first read as the contents of one vector, which only succeeds when everything is closed.
func unterminated(code string) bool {
	_, err := compiler.NewLispReader(strings.NewReader("["+code+"\n]"), "script").Read()
	return err != nil && compiler.IsErrorEOF(err)
}

func toolsSource(names []string) string {
	var b strings.Builder
	b.WriteString("(ns tools)\n")
	for _, name := range names {
		if !symbolName.MatchString(name) {
			continue
		}
		fmt.Fprintf(&b, "(defn %s ([] (codemode/call-tool %q {})) ([args] (codemode/call-tool %q args)))\n", name, name, name)
	}
	b.WriteString("(in-ns 'user)\n")
	return b.String()
}

func fail(stage string, err error) {
	emit(emitError, fmt.Sprintf("codemode_clj VM failed to %s: %s", stage, vm.FormatError(err)))
	os.Exit(70)
}

func main() {
	vm.Safepoint = hostSafepoint

	var err error
	if input, err = io.ReadAll(os.Stdin); err != nil {
		fail("read its input", err)
	}
	var req request
	if err := json.Unmarshal(input, &req); err != nil {
		fail("parse its input", err)
	}

	lg, err := api.NewLetGo("user")
	if err != nil {
		fail("start", err)
	}
	host := lg.NS("codemode.host")
	natives := map[string]any{
		"call":  call,
		"emit":  func(kind int, s string) { emit(uint32(kind), s) },
		"input": func() string { return string(input) },
		"exit":  func() { exited = true },
	}
	for name, fn := range natives {
		if err := host.Def(name, fn); err != nil {
			fail("define codemode.host/"+name, err)
		}
	}
	ctx := lg.CompilerContext()
	if _, _, err := ctx.CompileMultiple(strings.NewReader(prelude)); err != nil {
		fail("load its prelude", err)
	}
	if _, _, err := ctx.CompileMultiple(strings.NewReader(toolsSource(req.Tools))); err != nil {
		fail("define the tools namespace", err)
	}

	if unterminated(req.Code) {
		emit(emitError, "Syntax error: the script ends inside an unclosed form or string.")
		os.Exit(1)
	}
	_, value, err := ctx.CompileMultiple(strings.NewReader(req.Code))
	switch {
	case exited:
	case err != nil:
		emit(emitError, vm.FormatError(err))
		os.Exit(1)
	case value != vm.NIL:
		if err := lg.Def("codemode-result__", value); err != nil {
			fail("return the script's value", err)
		}
		if _, err := lg.Run("(codemode/return-value user/codemode-result__)"); err != nil {
			fail("return the script's value", err)
		}
	}
	os.Exit(0)
}
