/**
 * Test model for test/e2e.test.ts: calls `codemode_clj` once with the script in $CLJ_SCRIPT, then
 * stops. It stands in for an LLM so the run through pi and the sandbox is deterministic.
 *
 * With $CLJ_MCP_SERVER set to a server script, it also registers that script as the MCP server
 * `dev-radius` with `codemode` exposure, and holds the tool call back until the server's tools
 * exist: MCP servers connect in the background after the session starts.
 */

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MCP_WAIT_MS = 15_000;

export default function (pi: ExtensionAPI) {
	const server = process.env.CLJ_MCP_SERVER;
	if (server) {
		pi.registerMcpServer("dev-radius", {
			command: process.execPath.endsWith("bun") ? process.execPath : "bun",
			args: [server],
			exposure: "codemode",
			description: "Record store for tests",
		});
	}
	const faux = fauxProvider();
	faux.setResponses([
		async () => {
			const deadline = Date.now() + MCP_WAIT_MS;
			while (server && Date.now() < deadline && !pi.getAllTools().some((tool) => /^mcp__dev.radius__/.test(tool.name))) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return fauxAssistantMessage(fauxToolCall("codemode_clj", { code: process.env.CLJ_SCRIPT ?? "" }), {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("done"),
	]);
	pi.registerProvider(faux.provider);
}
