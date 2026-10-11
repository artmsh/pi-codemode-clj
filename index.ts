/**
 * `codemode_clj`: pi's codemode with Clojure as the script language.
 *
 * Scripts run in let-go, a Clojure interpreter compiled to WebAssembly (see vm/ and build.sh),
 * the way the built-in `codemode` runs JavaScript in QuickJS: on a worker thread, with tool calls
 * as the only capability. Like the built-in tool it is built on `exposure`, `prepareLoadout`, and
 * `ctx.executeTool()`, shares `store` values with it, and reads the `codemode.mode` and
 * `codemode.inlineBudget` settings.
 *
 * Registered inactive. Enable it with `--tools +codemode_clj` or `"defaultTools": ["+codemode_clj"]`.
 */

import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CallableTool,
	callForm,
	describeTool,
	type ExecuteContext,
	executeClojure,
	scriptTools,
	TOOL_NAME,
} from "./execute.ts";

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type Loadout = Parameters<NonNullable<ToolDefinition["prepareLoadout"]>>[0];

const DEFAULT_INLINE_BUDGET = 3000;
const CHARS_PER_TOKEN = 4;

const parameters = Type.Object({
	code: Type.String({ description: "Raw Clojure source." }),
});

/** The built-in source grammar with a Clojure comment as the options line. */
const SOURCE_GRAMMAR = String.raw`
start: options_source | plain_source
options_source: OPTIONS_LINE NEWLINE SOURCE
plain_source: SOURCE

OPTIONS_LINE: /[ \t]*;+ @options:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

const DESCRIPTION_INTRO = `Run Clojure that calls other tools. The input is raw Clojure (not JSON, no code fence), evaluated form by form in a sandboxed interpreter (let-go on WebAssembly): persistent data, keywords, macros, clojure.string/set/walk/edn. No JVM classes, file system, network, or environment.
- \`(tools/<name> {...})\` blocks and returns a string, or a map with keyword keys if the tool's declaration says so. A failed call throws ex-info with the tool's error as message: \`(try ... (catch Throwable e (ex-message e)))\`.
- Run calls in parallel with futures: \`(mapv deref (mapv #(future (tools/bash {:command %})) cmds))\`, or \`pmap\`. At most four run at once. Calls still running when the script ends are cancelled.
- The value of the last form is the result. \`(text x)\` adds an output item (non-strings are printed as EDN), \`(image block-or-data-url)\` adds an image, \`println\` goes to a \`<console_output>\` block, \`(exit)\` ends the script.
- \`(store "key" value)\` and \`(stored "key")\` keep JSON-compatible values across calls.
- \`all-tools\`, \`(search-tools "query" {:limit 5 :namespace "name"})\`, \`(describe-tool "name")\`, \`(describe-namespace "name")\`: find tools that are not listed, such as MCP tools.
- Optional first line: \`;; @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a call returns, in a few words: `a string`, or the keys of the map. */
function describeReturn(tool: CallableTool): string {
	const schema = tool.outputSchema;
	if (!isRecord(schema) || schema.type === "string") return "a string";
	if (!isRecord(schema.properties)) return "a value described by `(describe-tool ...)`";
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	return `{${Object.keys(schema.properties)
		.map((key) => (required.has(key) ? `:${key}` : `:${key}?`))
		.join(" ")}}`;
}

/**
 * The description while the tool is active. Tools the model already has declared are named in one
 * line each, since their arguments are their declared parameters. Tools only scripts can reach
 * (`codemode` exposure) are listed in full, grouped by namespace, within the token budget;
 * `deferred` tools are never listed, so the description is stable while MCP servers connect.
 */
function describeLoadout(loadout: Loadout, mode: "on" | "only", budget: number): string {
	const callable = scriptTools(loadout.callable) as unknown as CallableTool[];
	const declared = new Set(loadout.declared.map((tool) => tool.name));
	const isListedInFull = (tool: CallableTool) =>
		loadout.getExposure(tool.name) !== "deferred" && (mode === "only" || !declared.has(tool.name));

	const sections = [DESCRIPTION_INTRO];
	const brief = callable.filter((tool) => declared.has(tool.name) && !isListedInFull(tool));
	if (brief.length > 0) {
		sections.push(
			`Declared tools take their declared arguments as a map:\n${brief
				.map((tool) => `- \`${callForm(tool.name)}\` returns ${describeReturn(tool)}`)
				.join("\n")}`,
		);
	}

	const groups = new Map<string, { heading: string | undefined; entries: string[] }>([
		["", { heading: undefined, entries: [] }],
	]);
	for (const tool of callable.filter(isListedInFull)) {
		const namespace = loadout.getNamespace(tool.name);
		const key = namespace?.name ?? "";
		const group = groups.get(key) ?? {
			heading: `## ${namespace?.name}${namespace?.description ? `\n${namespace.description.trim()}` : ""}`,
			entries: [],
		};
		groups.set(key, group);
		group.entries.push(`### ${describeTool(tool, loadout.getPromptGuidelines(tool.name))}`);
	}
	// Cheapest tools first within each group, so one large schema does not crowd out the rest.
	let remaining = budget * CHARS_PER_TOKEN;
	const listed: string[] = [];
	for (const [key, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
		const fitting = group.entries
			.sort((left, right) => left.length - right.length)
			.filter((entry) => {
				if (entry.length > remaining) return false;
				remaining -= entry.length;
				return true;
			});
		if (group.entries.length === 0) continue;
		const omitted = group.entries.length - fitting.length;
		const note = omitted > 0 ? `\n(${omitted} more not listed; find them with search-tools)` : "";
		if (key !== "") listed.push(`${group.heading}${note}`);
		else if (omitted > 0) listed.push(note.trim());
		listed.push(...fitting);
	}
	if (listed.length > 0) sections.push(`Nested tools:\n\n${listed.join("\n\n")}`);
	return sections.join("\n\n");
}

/**
 * The built-in tool's renderers, which draw the script and its nested calls. They are not
 * exported, so they are taken from the definition `createCodemodeExtension()` registers.
 */
function builtinRenderers(pi: ExtensionAPI): Partial<Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">> {
	try {
		let captured: ToolDefinition | undefined;
		const recorder = new Proxy(pi, {
			get(target, property) {
				if (property === "registerTool") {
					return (definition: ToolDefinition) => {
						captured = definition;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		void createCodemodeExtension()(recorder);
		const { renderCall, renderResult, renderShell } = captured ?? {};
		return { ...(renderCall && { renderCall }), ...(renderResult && { renderResult }), ...(renderShell && { renderShell }) };
	} catch {
		return {};
	}
}

export default function (pi: ExtensionAPI) {
	const settings = () => (pi.getSettings() as { codemode?: { mode?: unknown; inlineBudget?: unknown } }).codemode;
	const mode = () => (settings()?.mode === "only" ? "only" : "on");
	const inlineBudget = () => {
		const budget = settings()?.inlineBudget;
		return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_INLINE_BUDGET;
	};
	const toolInfo = (name: string) => pi.getAllTools().find((tool) => tool.name === name);

	pi.registerTool({
		...builtinRenderers(pi),
		name: TOOL_NAME,
		label: TOOL_NAME,
		// Replaced with the listing of the callable tools when the tool is activated.
		description: DESCRIPTION_INTRO,
		promptSnippet: "Run Clojure that calls other tools",
		promptGuidelines: [
			"Use codemode_clj to batch independent tool calls (futures), chain them, or filter large output, instead of many separate calls.",
		],
		parameters,
		// Scripts must not start other scripts.
		exposure: "model-only",
		defaultActive: false,
		// Capable models write the script as raw text instead of a JSON-escaped string.
		constrainedSampling: { type: "grammar", variants: { openai_lark: SOURCE_GRAMMAR } },
		// Only this tool's own description is changed. The built-in codemode appends JavaScript call
		// notes to declared tools when it is active; doing the same here would fight over them.
		prepareLoadout: (loadout) => {
			const currentMode = mode();
			const callable = new Set(scriptTools(loadout.callable).map((tool) => tool.name));
			return {
				descriptions: { [TOOL_NAME]: describeLoadout(loadout, currentMode, inlineBudget()) },
				hiddenDeclarations:
					currentMode === "only"
						? loadout.declared
								.filter((tool) => callable.has(tool.name) && loadout.getExposure(tool.name) === "direct")
								.map((tool) => tool.name)
						: [],
			};
		},
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			executeClojure(toolCallId, params as { code: string }, signal, onUpdate as never, ctx as unknown as ExecuteContext, {
				getNamespace: (name) => toolInfo(name)?.namespace,
				getGuidelines: (name) => toolInfo(name)?.promptGuidelines ?? [],
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
			}) as never,
	});
}
