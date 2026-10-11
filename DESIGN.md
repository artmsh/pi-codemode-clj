# Design

`vm/main.go` embeds let-go and exposes four host imports: `submit` and `wait` for tool calls,
`emit` for output, and `safepoint`. A call is split into a non-blocking `submit` and a blocking
`wait` so that several futures have their calls in flight together although the module is
single-threaded. `worker.mjs` instantiates the module on a worker thread with a hand-written WASI
implementation (stdin, stdout, stderr, clocks, random, and nothing else) and blocks on a
`SharedArrayBuffer` while the main thread runs the tools. `sandbox.ts` is the host side of that
protocol, and `execute.ts` connects it to a pi session through `ctx.executeTool()`.

`build.sh` clones let-go at a pinned commit, applies `vm/safepoint.patch`, compiles `vm/` for
`wasip1`, and pins the module's memory maximum.

Three properties needed work beyond compiling let-go:

- **Stopping a script.** Bun cannot terminate a worker that is spinning in wasm, and Go's wasm
  port has no preemption, so a loop that never allocates would never reach a host import. The
  patch adds a safepoint to let-go's dispatch loop, every 16384 instructions, which calls an
  import that traps when the host has set the interrupt flag. Timeouts and aborts use it.
- **The memory limit.** `worker.mjs` stops a script when the linear memory passes 256 MB, checked
  at every import. The module's declared maximum is deliberately the wasm32 ceiling of 4 GiB: a
  `memory.grow` that fails crashes Bun in most runs, so growth is always allowed to succeed and
  the script is stopped at the next import instead, before it touches what it reserved.
- **WASI.** Bun's `node:wasi` lacks imports a Go module needs, hence the hand-written one.

Differences from the built-in `codemode`: tool arguments and results are described by their JSON
Schema rather than a TypeScript declaration, and the tool only rewrites its own description, so it
can be active next to the built-in one.
