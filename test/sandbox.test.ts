// Runs Clojure scripts in the real VM on a worker thread, with fake tools in place of pi.
// Run with `bun test` after ./build.sh: pi is a Bun binary, so Bun is the runtime that matters.

import { expect, test } from "bun:test";
import { type OutputItem, runClojure, type SandboxOptions } from "../sandbox.ts";

const tools = [
	{ name: "bash", description: "Run a command" },
	{ name: "mcp__dev-radius__search", description: "Search" },
	{ name: "weird.name", description: "Not a symbol" },
];

function run(code: string, overrides: Partial<SandboxOptions> = {}) {
	return runClojure({
		code,
		tools,
		callTool: async (name, args) => {
			const { command, query } = args as { command?: string; query?: string };
			if (name === "bash") {
				if (command === "fail") throw new Error("command not found");
				return { output: `ran ${command}\n`, exit_code: 0, truncated: false };
			}
			if (name === "mcp__dev-radius__search") return { structuredContent: { hits: [query] } };
			return `text from ${name}`;
		},
		...overrides,
	});
}

const texts = (output: OutputItem[], console = false) =>
	output.flatMap((item) => (item.type === "text" && Boolean(item.console) === console ? [item.text] : []));

test("the last form is the value, printed readably", async () => {
	const result = await run('(def m {:a 1}) (assoc m :b ["x" :k])');
	expect(result).toMatchObject({ ok: true, value: '{:a 1, :b ["x" :k]}' });
});

test("data is persistent and keywords are keywords", async () => {
	const result = await run("(let [v [1 2 3] w (conj v 4)] [(count v) (count w) (keyword? :a) (= {:a 1} {:a 1})])");
	expect(result).toMatchObject({ ok: true, value: "[3 4 true true]" });
});

test("tool results are Clojure data with keyword keys", async () => {
	const result = await run('(let [r (tools/bash {:command "ls"})] [(:output r) (:exit_code r) (:truncated r)])');
	expect(result).toMatchObject({ ok: true, value: '["ran ls\\n" 0 false]' });
});

test("tool names with dashes are symbols; others go through call-tool", async () => {
	const result = await run(
		'[(-> (tools/mcp__dev-radius__search {:query "q"}) :structuredContent :hits first) (codemode/call-tool "weird.name" {})]',
	);
	expect(result).toMatchObject({ ok: true, value: '["q" "text from weird.name"]' });
});

test("futures run tool calls in parallel, up to four at once", async () => {
	let inFlight = 0;
	let peak = 0;
	const started = performance.now();
	const result = await run('(mapv deref (mapv #(future (:n (tools/bash {:command (str %)}))) (range 6)))', {
		callTool: async (_name, args) => {
			peak = Math.max(peak, ++inFlight);
			await new Promise((resolve) => setTimeout(resolve, 200));
			inFlight--;
			return { n: Number((args as { command: string }).command) * 10 };
		},
	});
	expect(result).toMatchObject({ ok: true, value: "[0 10 20 30 40 50]" });
	expect(peak).toBe(4);
	// Six 200 ms calls, four at a time: two rounds, not six.
	expect(performance.now() - started).toBeLessThan(900);
});

test("a failed tool call throws ex-info with the tool's error", async () => {
	const result = await run(
		'(try (tools/bash {:command "fail"}) (catch Throwable e [(ex-message e) (ex-data e)]))',
	);
	expect(result).toMatchObject({ ok: true, value: '["command not found" {:tool "bash"}]' });
});

test("text, println and the value are separate outputs", async () => {
	const result = await run('(text "one") (text {:two 2}) (println "log" 1) (println "log" 2) :done');
	expect(result.ok).toBe(true);
	expect(texts(result.output)).toEqual(["one", "{:two 2}"]);
	expect(texts(result.output, true)).toEqual(["log 1", "log 2"]);
	expect(result).toMatchObject({ value: ":done" });
});

test("an uncaught error fails the script and keeps earlier output", async () => {
	const result = await run('(text "before") (throw (ex-info "boom" {:k 1})) (text "after")');
	expect(result.ok).toBe(false);
	expect(texts(result.output)).toEqual(["before"]);
	expect(result).toMatchObject({ error: { kind: "script" } });
	expect(!result.ok && result.error.message).toContain("boom");
});

test("a syntax error is a script error", async () => {
	const result = await run("(let [x 1");
	expect(result).toMatchObject({ ok: false, error: { kind: "script" } });
});

test("errors name the source position without terminal colours", async () => {
	const result = await run("(def a 1)\n(undefined-fn a)");
	expect(result).toMatchObject({ ok: false, error: { kind: "script" } });
	const message = result.ok ? "" : result.error.message;
	expect(message).toContain("Can't resolve undefined-fn");
	expect(message).toContain(":2:");
	expect(message).not.toContain("\u001b");
});

test("one allocation beyond all memory fails the script cleanly", async () => {
	const result = await run("(count (byte-array 1500000000))");
	expect(result).toMatchObject({ ok: false, error: { kind: "script" } });
	expect(!result.ok && result.error.message).toContain("out of memory");
	expect(texts(result.output, true)).toEqual([]);
});

test("exit ends the script successfully", async () => {
	const result = await run('(text "kept") (exit) (text "never")');
	expect(result.ok).toBe(true);
	expect(texts(result.output)).toEqual(["kept"]);
});

test("store writes are returned and readable in the same script; stored reads the snapshot", async () => {
	const result = await run('(store "new" {:n [1 2]}) [(stored "old") (stored "new") (stored "none")]', {
		store: { old: { from: "earlier" } },
	});
	expect(result).toMatchObject({
		ok: true,
		value: '[{:from "earlier"} {:n [1 2]} nil]',
		storeWrites: { new: { n: [1, 2] } },
	});
});

test("host functions are reachable and their errors are catchable", async () => {
	const result = await run(
		'[(search-tools "x" {:limit 2}) (try (describe-tool 1) (catch Throwable e (ex-message e))) (:name (first all-tools))]',
		{
			globals: {
				"search-tools": ([query, options]) => [{ name: `${query}:${(options as { limit: number }).limit}` }],
				"describe-tool": () => {
					throw new Error("expects a tool name");
				},
			},
		},
	);
	expect(result).toMatchObject({ ok: true, value: '[[{:name "x:2"}] "expects a tool name" "bash"]' });
});

test("the sandbox has no file system, environment, or network", async () => {
	const result = await run(
		`[(try (slurp "/etc/hosts") (catch Throwable e :denied))
		  (try (spit "/tmp/codemode-clj-escape" "x") (catch Throwable e :denied))
		  (try (System/getenv "HOME") (catch Throwable e :denied))]`,
	);
	expect(result.ok).toBe(true);
	expect(result.ok && result.value).not.toContain("localhost");
	expect(result.ok && result.value).not.toContain("/Users");
});

for (const [name, loop] of [
	["that never allocates", "(loop [] (recur))"],
	["that allocates", "(loop [i 0] (recur (count (conj [] i))))"],
	["inside a core function", "(reduce + (range))"],
	["in mutual recursion", "(declare b) (defn a [] (b)) (defn b [] (a)) (a)"],
]) {
	test(`a timeout stops a loop ${name}`, async () => {
		const started = performance.now();
		const result = await run(loop, { timeoutMs: 300 });
		expect(result).toMatchObject({ ok: false });
		// Runaway recursion may end as a stack overflow before the deadline; both stop the script.
		expect(["timeout", "script"]).toContain(!result.ok && result.error.kind);
		expect(performance.now() - started).toBeLessThan(2500);
	});
}

test("an abort stops a script that is waiting for a tool, and aborts the tool", async () => {
	const controller = new AbortController();
	let toolAborted = false;
	setTimeout(() => controller.abort(), 150);
	const result = await run('(tools/bash {:command "sleep"})', {
		signal: controller.signal,
		callTool: (_name, _args, signal) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					toolAborted = true;
					reject(new Error("aborted"));
				});
			}),
	});
	expect(result).toMatchObject({ ok: false, error: { kind: "aborted" } });
	expect(toolAborted).toBe(true);
});

test("memory is capped at 256 MB", async () => {
	const result = await run("(def big (atom [])) (loop [] (swap! big conj (vec (range 100000))) (recur))", {
		timeoutMs: 30_000,
	});
	expect(result).toMatchObject({ ok: false, error: { kind: "script" } });
	expect(!result.ok && result.error.message).toMatch(/memory/);
}, 40_000);

test("runaway output fails the script", async () => {
	const result = await run('(def line (apply str (repeat 100000 "x"))) (loop [] (text line) (recur))', {
		timeoutMs: 30_000,
	});
	expect(result).toMatchObject({ ok: false, error: { kind: "script" } });
	expect(!result.ok && result.error.message).toContain("Output limit");
}, 40_000);
