// Worker that runs one script in the codemode_clj VM (codemode-clj.wasm, see vm/main.go).
//
// The WASI implementation below is the module's whole view of the system: stdin holds the request,
// stdout and stderr are forwarded as console output, and there are clocks and random numbers.
// Every other call fails with ENOSYS, so the script has no file system or network, and its only
// environment variable is the Go memory limit set below.
// Bun's node:wasi cannot instantiate a Go module, which is the other reason this is hand-written.
//
// The thread blocks inside the module, so results reach it through a message port read
// synchronously, with a SharedArrayBuffer to sleep on: Int32[0] counts posted results and Int32[1]
// is the interrupt flag. Every import the module calls checks the flag, and the VM calls
// `safepoint` every few thousand instructions so that a loop that never allocates is stoppable too.

import { randomFillSync } from "node:crypto";
import { receiveMessageOnPort, workerData } from "node:worker_threads";

const { wasm, input, signal, port, memoryLimitBytes } = workerData;
const flags = new Int32Array(signal);
const RESULTS = 0;
const INTERRUPT = 1;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

const ENOSYS = 52;
const EBADF = 8;
const FILETYPE_CHARACTER_DEVICE = 2;

class Exit extends Error {
	constructor(code) {
		super(`exit ${code}`);
		this.code = code;
	}
}

class Interrupted extends Error {}

class OutOfMemory extends Error {}

// The only environment variable: it makes Go's collector work harder as the heap nears the limit,
// instead of growing the linear memory, which can never shrink.
const environment = Buffer.from(`GOMEMLIMIT=${Math.floor(memoryLimitBytes * 0.75)}\0`);
const stdin = Buffer.from(input);
let stdinOffset = 0;
let memory;
/** A result that did not fit the module's buffer, kept for its next `wait`. */
let queued;

const view = () => new DataView(memory.buffer);
const bytes = (ptr, length) => new Uint8Array(memory.buffer, ptr, length);
const readString = (ptr, length) => Buffer.from(memory.buffer, ptr, length).toString("utf8");

// Also enforces the memory limit. The module's declared maximum is the wasm32 ceiling, so that
// memory.grow never fails: a failing grow crashes Bun in most runs. A script can therefore reserve
// more than the limit in one allocation, but is stopped at the next import, before it uses it.
function checkInterrupt() {
	if (Atomics.load(flags, INTERRUPT) !== 0) throw new Interrupted();
	if (memory !== undefined && memory.buffer.byteLength > memoryLimitBytes) throw new OutOfMemory();
}

function forEachIovec(iovs, count, visit) {
	for (let index = 0; index < count; index++) {
		visit(view().getUint32(iovs + index * 8, true), view().getUint32(iovs + index * 8 + 4, true));
	}
}

const wasi = {
	args_sizes_get(countPtr, sizePtr) {
		view().setUint32(countPtr, 1, true);
		view().setUint32(sizePtr, 3, true);
		return 0;
	},
	args_get(argvPtr, bufferPtr) {
		view().setUint32(argvPtr, bufferPtr, true);
		bytes(bufferPtr, 3).set(Buffer.from("vm\0"));
		return 0;
	},
	environ_sizes_get(countPtr, sizePtr) {
		view().setUint32(countPtr, 1, true);
		view().setUint32(sizePtr, environment.length, true);
		return 0;
	},
	environ_get(environPtr, bufferPtr) {
		view().setUint32(environPtr, bufferPtr, true);
		bytes(bufferPtr, environment.length).set(environment);
		return 0;
	},
	clock_time_get(id, _precision, resultPtr) {
		checkInterrupt();
		const now = id === 0 ? BigInt(Date.now()) * 1_000_000n : BigInt(Math.round(performance.now() * 1e6));
		view().setBigUint64(resultPtr, now, true);
		return 0;
	},
	random_get(ptr, length) {
		randomFillSync(bytes(ptr, length));
		return 0;
	},
	sched_yield() {
		checkInterrupt();
		return 0;
	},
	proc_exit(code) {
		throw new Exit(code);
	},
	fd_fdstat_get(fd, resultPtr) {
		if (fd > 2) return EBADF;
		bytes(resultPtr, 24).fill(0);
		view().setUint8(resultPtr, FILETYPE_CHARACTER_DEVICE);
		return 0;
	},
	fd_fdstat_set_flags: () => 0,
	fd_prestat_get: () => EBADF,
	fd_close: () => 0,
	fd_read(fd, iovs, count, resultPtr) {
		if (fd !== 0) return EBADF;
		let total = 0;
		forEachIovec(iovs, count, (ptr, length) => {
			const chunk = stdin.subarray(stdinOffset, stdinOffset + length);
			bytes(ptr, chunk.length).set(chunk);
			stdinOffset += chunk.length;
			total += chunk.length;
		});
		view().setUint32(resultPtr, total, true);
		return 0;
	},
	fd_write(fd, iovs, count, resultPtr) {
		if (fd !== 1 && fd !== 2) return EBADF;
		checkInterrupt();
		const chunks = [];
		forEachIovec(iovs, count, (ptr, length) => chunks.push(Buffer.from(memory.buffer, ptr, length)));
		const data = Buffer.concat(chunks);
		port.postMessage({ type: "console", text: data.toString("utf8") });
		view().setUint32(resultPtr, data.length, true);
		return 0;
	},
	// Go only subscribes to clocks here (timers and sleeps): sleep for the shortest one and report it.
	poll_oneoff(subscriptionsPtr, eventsPtr, count, resultPtr) {
		checkInterrupt();
		let first = 0;
		let shortest = -1n;
		for (let index = 0; index < count; index++) {
			const timeout = view().getBigUint64(subscriptionsPtr + index * 48 + 24, true);
			if (shortest < 0n || timeout < shortest) {
				shortest = timeout;
				first = index;
			}
		}
		if (shortest > 0n) Atomics.wait(sleeper, 0, 0, Number(shortest) / 1e6);
		bytes(eventsPtr, 32).fill(0);
		view().setBigUint64(eventsPtr, view().getBigUint64(subscriptionsPtr + first * 48, true), true);
		view().setUint32(resultPtr, 1, true);
		return 0;
	},
};

const codemode = {
	submit(ptr, length) {
		checkInterrupt();
		port.postMessage({ type: "call", ...JSON.parse(readString(ptr, length)) });
	},
	wait(ptr, capacity, timeoutMs) {
		checkInterrupt();
		if (!queued) {
			const seen = Atomics.load(flags, RESULTS);
			let message = receiveMessageOnPort(port);
			if (!message) {
				Atomics.wait(flags, RESULTS, seen, timeoutMs);
				checkInterrupt();
				message = receiveMessageOnPort(port);
			}
			if (!message) return 0;
			queued = Buffer.from(JSON.stringify(message.message));
		}
		if (queued.length > capacity) return queued.length;
		bytes(ptr, queued.length).set(queued);
		const written = queued.length;
		queued = undefined;
		return written;
	},
	emit(kind, ptr, length) {
		checkInterrupt();
		port.postMessage({ type: "emit", kind, data: readString(ptr, length) });
	},
	safepoint: checkInterrupt,
};

try {
	const needed = WebAssembly.Module.imports(wasm).filter((entry) => entry.module === "wasi_snapshot_preview1");
	const preview1 = Object.fromEntries(needed.map(({ name }) => [name, wasi[name] ?? (() => ENOSYS)]));
	const instance = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: preview1, codemode });
	memory = instance.exports.memory;
	instance.exports._start();
	port.postMessage({ type: "exit", code: 0 });
} catch (error) {
	if (error instanceof Exit) port.postMessage({ type: "exit", code: error.code });
	else if (error instanceof Interrupted) port.postMessage({ type: "interrupted" });
	else if (error instanceof OutOfMemory) port.postMessage({ type: "out-of-memory" });
	else port.postMessage({ type: "crash", message: error instanceof Error ? error.message : String(error) });
}
