/**
 * Host side of the codemode_clj sandbox: runs one Clojure script in the let-go VM
 * (codemode-clj.wasm) on a worker thread and serves its tool calls. It knows nothing about pi;
 * execute.ts connects it to a session.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WASM_PATH = join(HERE, "codemode-clj.wasm");
const WORKER_PATH = join(HERE, "worker.mjs");

/** Tool calls one script may have in flight; futures beyond that queue, like pi's own limit. */
const MAX_CONCURRENT_TOOL_CALLS = 4;
/** Mirrors the built-in codemode limits on what a script may print. */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
const MAX_OUTPUT_ITEMS = 100_000;
/** How long an interrupted VM gets to stop before the worker is given up on. */
const INTERRUPT_GRACE_MS = 2000;
/** Size of the VM's linear memory at which the script is stopped, like the built-in codemode limit. */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const TERMINATE_GRACE_MS = 1000;

const OUT_OF_MEMORY =
	"out of memory: the VM has 256 MB. Filter or aggregate large data instead of accumulating it.";

const RESULTS = 0;
const INTERRUPT = 1;

const EMIT_TEXT = 0;
const EMIT_VALUE = 2;
const EMIT_ERROR = 3;
const EMIT_STORE = 4;

/** Exit codes of vm/main.go, plus the Go runtime's own code for a fatal error. */
const EXIT_SCRIPT_ERROR = 1;
const EXIT_GO_FATAL = 2;

export type OutputItem =
	| { type: "text"; text: string; console?: boolean }
	| { type: "image"; data: string; mimeType: string };

export interface SandboxError {
	kind: "script" | "timeout" | "aborted" | "sandbox";
	message: string;
}

export type SandboxResult =
	| { ok: true; output: OutputItem[]; value?: string; storeWrites: Record<string, unknown> }
	| { ok: false; output: OutputItem[]; error: SandboxError };

export interface SandboxOptions {
	code: string;
	/** Tools the script may call. Names usable as symbols become functions in the `tools` namespace. */
	tools: readonly { name: string; description: string }[];
	/** Runs a tool call. The signal aborts when the script ends, times out, or is cancelled. */
	callTool(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
	/** Host functions behind the script API (`search-tools`, `image`, ...), by name. */
	globals?: Record<string, (args: unknown[], push: (item: OutputItem) => void) => unknown>;
	/** Snapshot for `stored`. */
	store?: Record<string, unknown>;
	timeoutMs?: number;
	signal?: AbortSignal;
	wasmPath?: string;
}

const modules = new Map<string, Promise<WebAssembly.Module>>();

/** Read and compile the VM once per path. A failed load is retried on the next script. */
function loadModule(path: string): Promise<WebAssembly.Module> {
	let module = modules.get(path);
	if (!module) {
		module = (async () => {
			if (!existsSync(path)) {
				throw new Error(`${path} is missing. Build it with ${join(HERE, "build.sh")}.`);
			}
			return WebAssembly.compile(await readFile(path));
		})();
		module.catch(() => modules.delete(path));
		modules.set(path, module);
	}
	return module;
}

/** Runs at most `limit` calls at once, in call order. */
function createLimiter(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (run) => {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			return await run();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

/** let-go colours its error reports for a terminal. */
function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runClojure(options: SandboxOptions): Promise<SandboxResult> {
	const output: OutputItem[] = [];
	if (options.signal?.aborted) {
		return { ok: false, output, error: { kind: "aborted", message: "cancelled before the script started" } };
	}

	let wasm: WebAssembly.Module;
	try {
		wasm = await loadModule(options.wasmPath ?? DEFAULT_WASM_PATH);
	} catch (error) {
		return { ok: false, output, error: { kind: "sandbox", message: errorMessage(error) } };
	}

	const flags = new Int32Array(new SharedArrayBuffer(8));
	const { port1: port, port2: workerPort } = new MessageChannel();
	const calls = new AbortController();
	const limit = createLimiter(MAX_CONCURRENT_TOOL_CALLS);
	const storeWrites: Record<string, unknown> = {};
	let value: string | undefined;
	let scriptError: string | undefined;
	let consoleTail = "";
	let outputChars = 0;
	/** Set once the host has decided how the script ends; later VM messages do not change it. */
	let verdict: SandboxError | undefined;

	const input = JSON.stringify({
		code: options.code,
		tools: options.tools.map((tool) => tool.name),
		catalog: options.tools,
		store: Object.fromEntries(
			Object.entries(options.store ?? {}).map(([key, stored]) => [key, JSON.stringify(stored) ?? "null"]),
		),
	});

	const worker = new Worker(WORKER_PATH, {
		workerData: { wasm, input, signal: flags.buffer, port: workerPort, memoryLimitBytes: MEMORY_LIMIT_BYTES },
		transferList: [workerPort],
	});

	return new Promise<SandboxResult>((resolve) => {
		let settled = false;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;

		const finish = (result: SandboxResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(graceTimer);
			clearTimeout(deadline);
			options.signal?.removeEventListener("abort", onAbort);
			calls.abort();
			port.close();
			// Bun cannot terminate a thread that is spinning in wasm, so this is not awaited for long;
			// the interrupt flag is what actually stops the VM.
			Atomics.store(flags, INTERRUPT, 1);
			Atomics.notify(flags, RESULTS);
			void Promise.race([
				worker.terminate(),
				new Promise((done) => setTimeout(done, TERMINATE_GRACE_MS).unref?.()),
			]).then(() => resolve(result));
		};

		const fail = (error: SandboxError) => finish({ ok: false, output, error });

		const interrupt = (error: SandboxError) => {
			if (verdict || settled) return;
			verdict = error;
			calls.abort();
			Atomics.store(flags, INTERRUPT, 1);
			Atomics.notify(flags, RESULTS);
			graceTimer = setTimeout(() => fail(error), INTERRUPT_GRACE_MS);
		};

		const onAbort = () => interrupt({ kind: "aborted", message: "the script was cancelled" });
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
			deadline = setTimeout(
				() => interrupt({ kind: "timeout", message: `no result after ${options.timeoutMs} ms` }),
				options.timeoutMs,
			);
		}

		const push = (item: OutputItem) => {
			outputChars += item.type === "text" ? item.text.length : item.data.length;
			if (outputChars > MAX_OUTPUT_CHARS || output.length >= MAX_OUTPUT_ITEMS) {
				interrupt({
					kind: "script",
					message: `Output limit exceeded (${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} items). Write large data to a file with a tool instead.`,
				});
				return;
			}
			output.push(item);
		};

		const pushConsole = (text: string) => {
			const lines = (consoleTail + text).split("\n");
			consoleTail = lines.pop() ?? "";
			for (const line of lines) push({ type: "text", text: stripAnsi(line), console: true });
		};

		const reply = (id: number, ok: boolean, payload: string) => {
			if (settled) return;
			port.postMessage({ id, ok, payload });
			Atomics.add(flags, RESULTS, 1);
			Atomics.notify(flags, RESULTS);
		};

		const serve = async (message: { id: number; kind: string; name: string; args: string }) => {
			try {
				const args: unknown = JSON.parse(message.args);
				let result: unknown;
				if (message.kind === "tool") {
					result = await limit(() => options.callTool(message.name, args, calls.signal));
				} else {
					const global = options.globals?.[message.name];
					if (!global) throw new Error(`Unknown host function ${message.name}`);
					result = await global(args as unknown[], push);
				}
				reply(message.id, true, result === undefined ? "" : (JSON.stringify(result) ?? ""));
			} catch (error) {
				reply(message.id, false, errorMessage(error));
			}
		};

		port.on("message", (message) => {
			if (settled) return;
			switch (message.type) {
				case "call":
					void serve(message);
					break;
				case "console":
					pushConsole(message.text);
					break;
				case "emit":
					if (message.kind === EMIT_TEXT) push({ type: "text", text: message.data });
					else if (message.kind === EMIT_VALUE) value = message.data;
					else if (message.kind === EMIT_ERROR) scriptError = stripAnsi(message.data).trim();
					else if (message.kind === EMIT_STORE) {
						const [key, json] = JSON.parse(message.data) as [string, string];
						storeWrites[key] = JSON.parse(json);
					}
					break;
				case "interrupted":
					fail(verdict ?? { kind: "sandbox", message: "the VM stopped without a reason" });
					break;
				case "out-of-memory":
					fail(verdict ?? { kind: "script", message: OUT_OF_MEMORY });
					break;
				case "crash":
					fail(verdict ?? { kind: "sandbox", message: message.message });
					break;
				case "exit": {
					if (consoleTail) pushConsole("\n");
					if (verdict) fail(verdict);
					else if (message.code === 0) finish({ ok: true, output, value, storeWrites });
					else if (message.code === EXIT_SCRIPT_ERROR && scriptError !== undefined) {
						fail({ kind: "script", message: scriptError });
					} else if (message.code === EXIT_GO_FATAL) {
						// The Go runtime printed its reason and a goroutine dump to stderr. Keep the reason
						// as the error and drop the dump from the console output.
						const start = output.findIndex(
							(item) => item.type === "text" && item.console && /^(runtime: |fatal error: )/.test(item.text),
						);
						const dump = start < 0 ? [] : output.splice(start);
						const fatal = dump.find((item) => item.type === "text" && item.text.startsWith("fatal error: "));
						const reason = fatal?.type === "text" ? fatal.text : "the interpreter stopped with a fatal error";
						fail({ kind: "script", message: reason.includes("out of memory") ? OUT_OF_MEMORY : reason });
					} else {
						fail({ kind: "sandbox", message: scriptError ?? `the VM exited with code ${message.code}` });
					}
					break;
				}
			}
		});

		worker.on("error", (error) => fail(verdict ?? { kind: "sandbox", message: errorMessage(error) }));
	});
}
