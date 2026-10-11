// Runs scripts through the real pi binary: its extension loader, tool pipeline, built-in tools,
// and the Bun it embeds. A scripted model (fixtures/faux-model.ts) issues the one codemode_clj
// call, so no LLM is involved. Skipped when pi is not installed.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const hasPi = spawnSync("pi", ["--version"]).status === 0;

interface ToolResult {
	isError: boolean;
	text: string;
	calls: { name: string; status: string }[];
	description: string;
}

function runInPi(script: string, options: { mcp?: boolean } = {}): ToolResult {
	// A fresh working directory and agent directory, so no project or user settings, context files,
	// extensions, or MCP servers take part.
	const scratch = mkdtempSync(join(tmpdir(), "codemode-clj-e2e-"));
	const run = spawnSync(
		"pi",
		[
			...["-p", "--no-session", "-nc", "-ns", "--mode", "json"],
			// With MCP, pi's built-in extensions load as well (the agent directory is empty, so nothing
			// else does). The MCP extension activates the built-in codemode for servers with `codemode`
			// exposure, so this also covers both codemode tools being active together. The tool is
			// added with `+`: a plain `--tools` list would leave the MCP tools unregistered.
			...(options.mcp ? ["--tools", "+codemode_clj"] : ["-ne", "--no-mcp", "--tools", "codemode_clj,bash,read"]),
			...["-e", join(ROOT, "index.ts"), "-e", join(ROOT, "test/fixtures/faux-model.ts")],
			...["--model", "faux/faux-1", "go"],
		],
		{
			cwd: scratch,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: join(scratch, "agent"),
				PI_OFFLINE: "1",
				CLJ_SCRIPT: script,
				...(options.mcp ? { CLJ_MCP_SERVER: join(ROOT, "test/fixtures/mcp-server.mjs") } : {}),
			},
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	expect(run.status).toBe(0);
	const events = run.stdout.split("\n").flatMap((line) => (line.trim() ? [JSON.parse(line)] : []));
	const messages = events.flatMap((event) => (event.type === "message_end" ? [event.message] : []));
	const result = messages.find((message) => message.role === "toolResult");
	expect(result).toBeDefined();
	const system = JSON.stringify(messages.filter((message) => message.role === "system"));
	return {
		isError: result.isError === true,
		text: result.content.map((block: { text?: string }) => block.text ?? "").join("\n"),
		calls: result.details?.calls ?? [],
		description: system,
	};
}

test.skipIf(!hasPi)("parallel real tool calls, store, console, and value", () => {
	const result = runInPi(`(require '[clojure.string :as str])
(def rs (mapv deref (mapv #(future (tools/bash {:command (str "sleep 1; echo " %)})) ["alpha" "beta" "gamma"])))
(store "seen" {:n (count rs)})
(println "console-line")
(text (str/join "+" (map (comp str/trim :output) rs)))
{:codes (mapv :exit_code rs) :stored (stored "seen") :hosts? (string? (tools/read {:path "/etc/hosts"}))}`);
	expect(result.isError).toBe(false);
	expect(result.text).toStartWith("Script completed\nWall time ");
	expect(result.text).toContain("==> text 1/2 <==\nalpha+beta+gamma");
	expect(result.text).toContain("{:codes [0 0 0], :stored {:n 3}, :hosts? true}");
	expect(result.text).toContain("<console_output>\nconsole-line\n</console_output>");
	expect(result.calls.map((call) => `${call.name}:${call.status}`)).toEqual(["bash:ok", "bash:ok", "bash:ok", "read:ok"]);
	// Three one-second commands in parallel take about one second, not three.
	expect(Number(/Wall time ([\d.]+)/.exec(result.text)?.[1])).toBeLessThan(2.5);
	expect(result.description).toContain("Run Clojure that calls other tools");
	expect(result.description).toContain("(tools/bash args)` returns {:output");
}, 90_000);

test.skipIf(!hasPi)("a failing tool call is catchable; an uncaught one fails the script", () => {
	const caught = runInPi('(try (tools/read {:path "/no/such/file"}) (catch Throwable e (str "caught: " (:tool (ex-data e)))))');
	expect(caught.isError).toBe(false);
	expect(caught.text).toContain("caught: read");
	const uncaught = runInPi('(text "partial") (tools/read {:path "/no/such/file"})');
	expect(uncaught.isError).toBe(true);
	expect(uncaught.text).toStartWith("Script failed");
	expect(uncaught.text).toContain("partial");
	expect(uncaught.text).toContain("Script error:");
	expect(uncaught.text).toContain("Tool calls made before the failure (they are not undone): read (error)");
}, 90_000);

test.skipIf(!hasPi)("timeout_ms stops a loop that never allocates, inside pi", () => {
	const result = runInPi(';; @options: {"timeout_ms": 500}\n(loop [] (recur))');
	expect(result.isError).toBe(true);
	expect(result.text).toContain("Script timed out");
}, 90_000);

test.skipIf(!hasPi)("the memory limit fails the script without taking pi down", () => {
	const result = runInPi("(def big (atom [])) (loop [] (swap! big conj (vec (range 100000))) (recur))");
	expect(result.isError).toBe(true);
	expect(result.text).toContain("out of memory");
}, 90_000);

test.skipIf(!hasPi)("large output is truncated and spilled to a file", () => {
	const result = runInPi(';; @options: {"max_output_tokens": 50}\n(apply str (repeat 2000 "x"))');
	expect(result.isError).toBe(false);
	expect(result.text).toContain("Warning: truncated output");
	expect(result.text).toMatch(/\[Full output: .+\.txt/);
}, 90_000);

test.skipIf(!hasPi)("MCP tools: structured results, isError results, and discovery", () => {
	const result = runInPi(
		`(let [found (tools/mcp__dev_radius__lookup {:id 7})
      echoed (tools/mcp__dev_radius__echo {:text "hi"})
      failed (tools/mcp__dev_radius__fail {})]
  {:structured (:structuredContent found)
   :echo (-> echoed :content first :text)
   :failed [(:isError failed) (-> failed :content first :text)]
   :search (:name (first (search-tools "look up a record" {:namespace "dev-radius"})))
   :namespace (select-keys (describe-namespace "dev-radius") [:name :description])
   :tools (sort (:tools (describe-namespace "dev-radius")))
   :described (boolean (re-find #"Look up a record by id" (describe-tool "mcp__dev_radius__lookup")))
   :unknown (try (codemode/call-tool "mcp__dev_radius__nope" {}) (catch Throwable e (ex-message e)))})`,
		{ mcp: true },
	);
	expect(result.text).toContain(':structured {:id 7, :title "record 7"}');
	expect(result.text).toContain(':echo "echo: hi"');
	expect(result.text).toContain(':failed [true "backend unavailable"]');
	expect(result.text).toContain(':search "mcp__dev_radius__lookup"');
	expect(result.text).toContain(':namespace {:name "mcp__dev_radius", :description "Record store for tests"}');
	expect(result.text).toContain(':tools ("mcp__dev_radius__echo" "mcp__dev_radius__fail" "mcp__dev_radius__lookup")');
	expect(result.text).toContain(":described true");
	expect(result.text).toContain(':unknown "Unknown tool');
	expect(result.isError).toBe(false);
}, 90_000);
