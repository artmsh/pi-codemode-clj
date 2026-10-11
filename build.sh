#!/usr/bin/env bash
# Builds codemode-clj.wasm: let-go at a pinned commit with safepoint.patch, compiled for WASI,
# with a memory maximum. Needs git, Go (the version let-go's go.mod asks for), and bun or node.
set -euo pipefail

LETGO_REPO=https://github.com/nooga/let-go
LETGO_COMMIT=e9789b7d534cce6a570fc0781f220f07c30be17e
# The wasm32 ceiling, so that memory.grow itself never fails: a failing grow crashes Bun (about five
# runs in six). worker.mjs stops a script at 256 MiB, at the first import after it grows past that.
MEMORY_MAX_MIB=4096

ROOT=$(cd "$(dirname "$0")" && pwd)
SRC=$ROOT/vm/.let-go

if [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null || true)" != "$LETGO_COMMIT" ]; then
	rm -rf "$SRC"
	git init -q "$SRC"
	git -C "$SRC" fetch -q --depth 1 "$LETGO_REPO" "$LETGO_COMMIT"
	git -C "$SRC" checkout -q FETCH_HEAD
fi
git -C "$SRC" checkout -q -- .
git -C "$SRC" apply "$ROOT/vm/safepoint.patch"

JS=$(command -v bun || command -v node)
(cd "$ROOT/vm" && GOOS=wasip1 GOARCH=wasm CGO_ENABLED=0 GOFLAGS=-mod=mod \
	go build -trimpath -ldflags='-s -w' -o "$ROOT/vm/.let-go/codemode-clj.raw.wasm" .)
"$JS" "$ROOT/vm/cap-memory.mjs" "$ROOT/vm/.let-go/codemode-clj.raw.wasm" "$ROOT/codemode-clj.wasm" "$MEMORY_MAX_MIB"
ls -l "$ROOT/codemode-clj.wasm"
