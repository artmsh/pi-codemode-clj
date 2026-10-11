/**
 * Runs one codemode_clj script for a pi session: the counterpart of the built-in codemode
 * executor, with the let-go sandbox in place of QuickJS. Nested calls go through
 * `ctx.executeTool()`, so validation, hooks, and permission checks apply as for direct calls, and
 * the result has the built-in tool's shape, so its renderer and transcript handling apply too.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OutputItem, runClojure, type SandboxError } from "./sandbox.ts";

export const TOOL_NAME = "codemode_clj";
const BUILTIN_TOOL_NAME = "codemode";
/** Shared with the built-in tool, so JavaScript and Clojure scripts see each other's values. */
const STORE_ENTRY_TYPE = "codemode-store";

const OPTIONS_PATTERN = /^[ \t]*;+[ \t]*@options:(.*)$/;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
const DEFAULT_SEARCH_LIMIT = 8;
const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type Content = TextContent | ImageContent;

/** The parts of pi's tool and context types this file uses; pi does not export all of them. */
export interface CallableTool {
	name: string;
	description: string;
	parameters: unknown;
	outputSchema?: unknown;
}

export interface ToolNamespace {
	name: string;
	description?: string;
	instructions?: string;
}

interface ToolOutcome {
	toolCall: { id: string };
	isError: boolean;
	result: { content?: { type: string; text?: string }[]; structuredContent?: unknown };
}

export interface ExecuteContext {
	tools: readonly CallableTool[];
	executeTool(name: string, args: unknown, options?: { signal?: AbortSignal }): Promise<ToolOutcome>;
	sessionManager: { getBranch(): readonly { type: string; customType?: string; data?: unknown }[] };
}

export interface ExecuteDeps {
	getNamespace(toolName: string): ToolNamespace | undefined;
	getGuidelines(toolName: string): readonly string[];
	appendEntry(customType: string, data: { set: Record<string, unknown>; delete: string[] }): void;
}

interface NestedCall {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
}

interface Details {
	calls: NestedCall[];
	fullOutputPath?: string;
}

export interface ScriptSource {
	code: string;
	maxOutputTokens?: number;
	timeoutMs?: number;
}

/** Split off a leading `;; @options: {...}` line. The line is blanked so error positions hold. */
export function parseSource(source: string): ScriptSource {
	const lines = source.split("\n");
	const match = OPTIONS_PATTERN.exec(lines[0] ?? "");
	if (!match) return { code: source };
	const supported = "`max_output_tokens` and `timeout_ms`";
	let fields: unknown;
	try {
		fields = JSON.parse(match[1]);
	} catch (error) {
		throw new Error(`@options must be valid JSON with supported fields ${supported}: ${(error as Error).message}`);
	}
	if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
		throw new Error(`@options must be a JSON object with supported fields ${supported}`);
	}
	const { max_output_tokens, timeout_ms, ...rest } = fields as Record<string, unknown>;
	const unknown = Object.keys(rest)[0];
	if (unknown !== undefined) throw new Error(`@options only supports ${supported}; got \`${unknown}\``);
	const natural = (name: string, value: unknown): number | undefined => {
		if (value === undefined) return undefined;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			throw new Error(`@options ${name} must be a non-negative integer`);
		}
		return value;
	};
	lines[0] = "";
	return {
		code: lines.join("\n"),
		maxOutputTokens: natural("max_output_tokens", max_output_tokens),
		timeoutMs: natural("timeout_ms", timeout_ms),
	};
}

/** Tools a script may call: everything callable except the codemode tools themselves. */
export function scriptTools<T extends { name: string }>(tools: readonly T[]): T[] {
	return tools.filter((tool) => tool.name !== TOOL_NAME && tool.name !== BUILTIN_TOOL_NAME);
}

/** `(tools/name args)` when the name is a symbol, otherwise the `call-tool` form. */
export function callForm(name: string): string {
	return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? `(tools/${name} args)` : `(codemode/call-tool ${JSON.stringify(name)} args)`;
}

/** What a script needs to call a tool: how, what it does, its arguments, and what comes back. */
export function describeTool(tool: CallableTool, guidelines: readonly string[] = []): string {
	const bullets = guidelines.flatMap((guideline) => (guideline.trim() ? [`- ${guideline.trim()}`] : []));
	return [
		callForm(tool.name),
		tool.description.trim(),
		...bullets,
		`Arguments (JSON Schema): ${JSON.stringify(tool.parameters)}`,
		tool.outputSchema
			? `Returns a map (JSON Schema, keys become keywords): ${JSON.stringify(tool.outputSchema)}`
			: "Returns a string.",
	].join("\n");
}

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function textOf(result: ToolOutcome["result"]): string {
	return (result.content ?? []).flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** BM25 over tool names, descriptions, and namespaces. Small enough to rebuild per query. */
function rank(query: string, documents: { name: string; text: string }[], limit: number): string[] {
	const tokenized = documents.map((document) => ({ name: document.name, tokens: tokenize(document.text) }));
	const averageLength = tokenized.reduce((sum, document) => sum + document.tokens.length, 0) / (tokenized.length || 1);
	const terms = [...new Set(tokenize(query))];
	const documentFrequency = new Map(
		terms.map((term) => [term, tokenized.filter((document) => document.tokens.includes(term)).length] as const),
	);
	const k1 = 1.2;
	const b = 0.75;
	return tokenized
		.map((document) => {
			let score = 0;
			for (const term of terms) {
				const frequency = document.tokens.filter((token) => token === term).length;
				if (frequency === 0) continue;
				const containing = documentFrequency.get(term) ?? 0;
				const idf = Math.log(1 + (tokenized.length - containing + 0.5) / (containing + 0.5));
				score += (idf * frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * document.tokens.length) / averageLength));
			}
			return { name: document.name, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score)
		.slice(0, limit)
		.map((entry) => entry.name);
}

/** Whether `query` names the namespace: its name, or the part after its last `__` (`dev-radius`). */
function isNamespaceName(namespace: string, query: string): boolean {
	const normalize = (name: string) => name.replace(/[^A-Za-z0-9]/g, "_");
	const suffix = (name: string) => (name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name);
	return normalize(namespace) === normalize(query) || normalize(suffix(namespace)) === normalize(query);
}

/** `image()` input: a base64 data URL, `{image_url}`, or an image block as tools return them. */
function toImage(value: unknown): ImageContent {
	const expected =
		'image expects a base64 data URL, {:image_url "data:..."}, or an image block {:type "image" :data <base64> :mimeType "image/png"}';
	let data: unknown;
	let mimeType: unknown;
	const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	const nested = record?.image_url;
	const url = typeof value === "string" ? value : typeof nested === "string" ? nested : (nested as { url?: unknown })?.url;
	if (typeof url === "string") {
		const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
		if (!match) throw new Error(`${expected}. Remote URLs are not supported.`);
		[, mimeType, data] = match;
	} else if (record?.type === "image") {
		({ data, mimeType } = record);
	}
	if (typeof data !== "string" || typeof mimeType !== "string") throw new Error(expected);
	if (!(mimeType in IMAGE_EXTENSIONS)) {
		throw new Error(`image does not support ${mimeType}; use PNG, JPEG, GIF, or WebP`);
	}
	return { type: "image", data, mimeType };
}

/** Values of `stored`: the store entries on the branch, applied from the root. */
function readStore(branch: ReturnType<ExecuteContext["sessionManager"]["getBranch"]>): Record<string, unknown> {
	const store = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== STORE_ENTRY_TYPE) continue;
		const data = entry.data as { set?: Record<string, unknown>; delete?: string[] } | undefined;
		if (typeof data?.set !== "object" || data.set === null || !Array.isArray(data.delete)) continue;
		for (const key of data.delete) store.delete(key);
		for (const [key, value] of Object.entries(data.set)) store.set(key, value);
	}
	return Object.fromEntries(store);
}

let outputDirectory: Promise<string> | undefined;

/** Write an output file readable only by the user, like pi's own spill files. */
async function writeOutputFile(name: string, data: string | Uint8Array): Promise<string> {
	outputDirectory ??= mkdtemp(join(tmpdir(), "pi-codemode-clj-"));
	outputDirectory.catch(() => {
		outputDirectory = undefined;
	});
	const path = join(await outputDirectory, name);
	await writeFile(path, data, { mode: 0o600 });
	return path;
}

let outputFiles = 0;
const nextFileName = (extension: string) => `${Date.now()}-${++outputFiles}${extension}`;

/**
 * Lay out the output so the model can tell items apart: with several text items each starts with
 * a `==> text N/M <==` line, and printed lines follow in one `<console_output>` block.
 */
function formatOutput(output: readonly OutputItem[]): Content[] {
	const total = output.filter((item) => item.type === "text" && !item.console).length;
	const items: Content[] = [];
	const consoleLines: string[] = [];
	let index = 0;
	for (const item of output) {
		if (item.type === "image") items.push(item);
		else if (item.console) consoleLines.push(item.text);
		else {
			index++;
			items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
		}
	}
	if (consoleLines.length > 0) {
		items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
	}
	return items;
}

/** Join adjacent text items into one, each part starting on its own line. */
function joinAdjacentText(items: Content[]): Content[] {
	const joined: Content[] = [];
	for (const item of items) {
		const last = joined.at(-1);
		if (item.type === "text" && last?.type === "text") {
			const separator = last.text === "" || last.text.endsWith("\n") ? "" : "\n";
			joined[joined.length - 1] = { type: "text", text: `${last.text}${separator}${item.text}` };
		} else {
			joined.push(item);
		}
	}
	return joined;
}

/** Keep the start and end of text that exceeds the budget, and write all of it to a temp file. */
async function truncateOutput(items: Content[], maxTokens: number): Promise<{ items: Content[]; fullOutputPath?: string }> {
	const texts = items.flatMap((item) => (item.type === "text" ? [item.text] : []));
	const combined = texts.join("\n");
	const budget = maxTokens * CHARS_PER_TOKEN;
	if (texts.length === 0 || combined.length <= budget) return { items };
	const headChars = Math.floor(budget / 2);
	const tailChars = budget - headChars;
	const removed = combined.length - headChars - tailChars;
	let text = `Warning: truncated output (original token count: ${Math.ceil(combined.length / CHARS_PER_TOKEN)})\nTotal output lines: ${combined.split("\n").length}\n\n${combined.slice(0, headChars)}…${Math.ceil(removed / CHARS_PER_TOKEN)} tokens truncated…${tailChars > 0 ? combined.slice(-tailChars) : ""}`;
	let fullOutputPath: string | undefined;
	try {
		fullOutputPath = await writeOutputFile(nextFileName(".txt"), combined);
		text += `\n\n[Full output: ${fullOutputPath} (read with offset/limit)]`;
	} catch (error) {
		text += `\n\n[Could not save the full output: ${(error as Error).message}]`;
	}
	return { items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")], fullOutputPath };
}

/** Save each image to a temp file and name its path before it, since scripts cannot write files. */
async function saveImages(items: Content[]): Promise<Content[]> {
	const labels = new Map<string, Promise<string>>();
	const label = async ({ data, mimeType }: ImageContent): Promise<string> => {
		const bytes = Buffer.from(data, "base64");
		const kind = `${mimeType}, ${bytes.length} bytes`;
		try {
			return `[Image saved to ${await writeOutputFile(nextFileName(IMAGE_EXTENSIONS[mimeType]), bytes)} (${kind})]`;
		} catch (error) {
			return `[Image (${kind}) could not be saved: ${(error as Error).message}]`;
		}
	};
	const result = await Promise.all(
		items.map(async (item): Promise<Content[]> => {
			if (item.type !== "image") return [item];
			let pending = labels.get(item.data);
			if (!pending) {
				pending = label(item);
				labels.set(item.data, pending);
			}
			return [{ type: "text", text: await pending }, item];
		}),
	);
	return result.flat();
}

function formatError(error: SandboxError, calls: readonly NestedCall[]): string {
	const head =
		error.kind === "script"
			? error.message
			: error.kind === "timeout"
				? `Script timed out: ${error.message}`
				: error.kind === "aborted"
					? `Script aborted: ${error.message}`
					: `Script sandbox failed: ${error.message}`;
	const summary =
		calls.length === 0
			? "No tool calls were made."
			: `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;
	return `${head}\n\n${summary}`;
}

export async function executeClojure(
	toolCallId: string,
	input: { code: string },
	signal: AbortSignal | undefined,
	onUpdate: ((result: { content: Content[]; details: Details }) => void) | undefined,
	ctx: ExecuteContext,
	deps: ExecuteDeps,
): Promise<{ content: Content[]; details: Details; isError?: true }> {
	const startedAt = performance.now();
	const source = parseSource(input.code);
	const calls: NestedCall[] = [];
	const snapshot = (): Details => ({ calls: calls.map((call) => ({ ...call })) });
	const publish = () => onUpdate?.({ content: [], details: snapshot() });

	const callable = scriptTools(ctx.tools);
	const byName = new Map(callable.map((tool) => [tool.name, tool]));
	const descriptions = new Map(
		callable.map((tool) => [tool.name, describeTool(tool, deps.getGuidelines(tool.name))] as const),
	);
	const entry = (name: string) => ({ name, description: descriptions.get(name) ?? "" });

	const callTool = async (name: string, args: unknown, callSignal: AbortSignal): Promise<unknown> => {
		const tool = byName.get(name);
		if (!tool) {
			throw new Error(`Unknown tool ${JSON.stringify(name)}. Find tools with (search-tools "query") or all-tools.`);
		}
		const record: NestedCall = { id: `${toolCallId}/?`, name, args: truncate(JSON.stringify(args) ?? "", ARGS_PREVIEW_CHARS), status: "running" };
		calls.push(record);
		publish();
		const callStartedAt = performance.now();
		const outcome = await ctx.executeTool(name, args, { signal: callSignal });
		record.id = outcome.toolCall.id;
		record.durationMs = performance.now() - callStartedAt;
		const text = textOf(outcome.result);
		if (outcome.isError) {
			record.status = callSignal.aborted ? "cancelled" : "error";
			record.error = truncate(text || `Tool "${name}" failed`, ERROR_PREVIEW_CHARS);
		} else {
			record.status = "ok";
		}
		publish();
		// Tools with an output schema hand scripts their structured content, also for error results
		// that carry one (MCP results with isError); other failures throw in the script.
		if (tool.outputSchema && outcome.result.structuredContent !== undefined) return outcome.result.structuredContent;
		if (outcome.isError) throw new Error(text || `Tool "${name}" failed`);
		return text;
	};

	const result = await runClojure({
		code: source.code,
		tools: callable.map((tool) => entry(tool.name)),
		callTool,
		store: readStore(ctx.sessionManager.getBranch()),
		timeoutMs: source.timeoutMs,
		signal,
		globals: {
			"search-tools": ([query, options]) => {
				if (typeof query !== "string") throw new Error("search-tools expects a query string");
				const { limit = DEFAULT_SEARCH_LIMIT, namespace } = (options ?? {}) as { limit?: unknown; namespace?: unknown };
				if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
					throw new Error("search-tools :limit must be a positive integer");
				}
				if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
					throw new Error("search-tools :namespace must be a string");
				}
				const documents = callable.flatMap((tool) => {
					const toolNamespace = deps.getNamespace(tool.name);
					if (namespace && (!toolNamespace || !isNamespaceName(toolNamespace.name, namespace))) return [];
					const text = [tool.name, tool.description, toolNamespace?.name, toolNamespace?.description].join(" ");
					return [{ name: tool.name, text }];
				});
				return rank(query, documents, limit).map(entry);
			},
			"describe-tool": ([name]) => {
				if (typeof name !== "string") throw new Error("describe-tool expects a tool name");
				return descriptions.get(name);
			},
			"describe-namespace": ([name]) => {
				if (typeof name !== "string") throw new Error("describe-namespace expects a namespace name");
				let namespace: ToolNamespace | undefined;
				const names: string[] = [];
				for (const tool of callable) {
					const toolNamespace = deps.getNamespace(tool.name);
					if (!toolNamespace || !isNamespaceName(toolNamespace.name, name)) continue;
					namespace ??= toolNamespace;
					names.push(tool.name);
				}
				if (!namespace) return undefined;
				return {
					name: namespace.name,
					...(namespace.description ? { description: namespace.description } : {}),
					...(namespace.instructions ? { instructions: namespace.instructions } : {}),
					tools: names,
				};
			},
			image: ([value], push) => push(toImage(value)),
		},
	});

	// Calls still marked running were cut off by the script ending, a timeout, or an abort.
	for (const call of calls) {
		if (call.status === "running") call.status = "cancelled";
	}

	const scriptOutput = [...result.output];
	if (result.ok) {
		if (Object.keys(result.storeWrites).length > 0) {
			deps.appendEntry(STORE_ENTRY_TYPE, { set: result.storeWrites, delete: [] });
		}
		if (result.value !== undefined) scriptOutput.push({ type: "text", text: result.value });
	}
	const items = formatOutput(scriptOutput);
	if (!result.ok) items.push({ type: "text", text: `Script error:\n${formatError(result.error, calls)}` });

	const truncated = await truncateOutput(joinAdjacentText(items), source.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
	// After truncation, which moves images behind the text, so each path stays next to its image.
	const output = joinAdjacentText(await saveImages(truncated.items));
	const wallTime = ((performance.now() - startedAt) / 1000).toFixed(1);
	const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${wallTime} seconds\nOutput:\n`;
	const details = snapshot();
	if (truncated.fullOutputPath) details.fullOutputPath = truncated.fullOutputPath;
	return {
		content: [{ type: "text", text: header }, ...output],
		details,
		...(result.ok ? {} : { isError: true as const }),
	};
}
