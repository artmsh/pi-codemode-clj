# pi-codemode-clj

A [pi](https://github.com/earendil-works/pi) extension that adds `codemode_clj`:
[codemode](https://lucumr.pocoo.org/2026/10/6/codemode/) with Clojure as the script language.
Scripts run in [let-go](https://github.com/nooga/let-go), a Clojure interpreter compiled to
WebAssembly, on the harness side, with tool calls as their only capability.

```clojure
(let [cmds ["echo one" "echo two" "uname -s"]
      results (mapv deref (mapv #(future (tools/bash {:command %})) cmds))]
  (zipmap cmds (map (comp clojure.string/trim :output) results)))
```

## Install

Needs git, Go 1.27+, and bun or node.

```bash
git clone https://github.com/artmsh/pi-codemode-clj ~/.pi/agent/extensions/codemode-clj
~/.pi/agent/extensions/codemode-clj/build.sh
```

Then enable the tool with `pi --tools +codemode_clj`, or permanently in `~/.pi/agent/settings.json`:

```json
{ "defaultTools": ["+codemode_clj"] }
```

## Script API

| Form | Purpose |
|---|---|
| `(tools/<name> {...})` | Call a tool and block for its result: a string, or a map with keyword keys for tools with structured output. A failure throws `ex-info`. |
| `(codemode/call-tool "name" {...})` | The same, for tool names that are not valid symbols. |
| `future`, `pmap` | Run calls in parallel, at most four at once. |
| last form | The result, printed as EDN unless it is a string. |
| `(text x)`, `(image x)`, `println`, `(exit)` | Output items, images, console lines, early exit. |
| `(store "k" v)`, `(stored "k")` | JSON-compatible values kept across calls in the session, shared with JavaScript codemode. |
| `all-tools`, `(search-tools q opts)`, `(describe-tool name)`, `(describe-namespace name)` | Find tools that are not listed, such as MCP tools. |
| `;; @options: {"timeout_ms": 60000, "max_output_tokens": 10000}` | Optional first line. |

## Limits

- No file system, network, or environment inside the script; 256 MB of memory.
- No `models` API.
- pi's process grows by roughly 300 MB once the 28 MB module has been compiled.
- let-go is a Clojure dialect: no JVM classes or interop.

## Tests

`bun test` after a build. `test/e2e.test.ts` drives the installed `pi` binary with a scripted model
and is skipped when pi is not on the PATH. [DESIGN.md](DESIGN.md) explains how the sandbox works.
