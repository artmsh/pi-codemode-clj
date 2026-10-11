// Minimal stdio MCP server for test/e2e.test.ts: one tool with structured output, one with text,
// and one that reports failure with isError.

import { createInterface } from "node:readline";

const tools = [
	{
		name: "lookup",
		description: "Look up a record by id",
		inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
		outputSchema: { type: "object", properties: { id: { type: "integer" }, title: { type: "string" } }, required: ["id", "title"] },
	},
	{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
];

function call(name, args) {
	if (name === "lookup") {
		const record = { id: args.id, title: `record ${args.id}` };
		return { content: [{ type: "text", text: JSON.stringify(record) }], structuredContent: record };
	}
	if (name === "echo") return { content: [{ type: "text", text: `echo: ${args.text}` }] };
	return { content: [{ type: "text", text: "backend unavailable" }], isError: true };
}

const handlers = {
	initialize: (params) => ({
		protocolVersion: params.protocolVersion,
		capabilities: { tools: {} },
		serverInfo: { name: "dev-radius", version: "1.0.0" },
		instructions: "Records live here. Look them up by id.",
	}),
	"tools/list": () => ({ tools }),
	"tools/call": (params) => call(params.name, params.arguments ?? {}),
	ping: () => ({}),
};

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	const handler = handlers[message.method];
	const reply = handler
		? { jsonrpc: "2.0", id: message.id, result: handler(message.params ?? {}) }
		: { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } };
	process.stdout.write(`${JSON.stringify(reply)}\n`);
});
