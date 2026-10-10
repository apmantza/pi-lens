import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// release-qa (#3805) drives a pi that is not this repo's devDependency, so it
// names that pi's own pi-ai here. The default is the repo's dev baseline,
// resolved in release-qa's locatePiAiIndex order: pi-ai hoisted beside the host
// (pi-coding-agent 1.0.1+), then nested under it (1.0.0 shipped a shrinkwrap,
// #4004). A host that re-nests pi-ai must not red every real-harness test.
const piAiCandidates = [
	"../../../node_modules/@earendil-works/pi-ai/dist/index.js",
	"../../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
].map((relative) => new URL(relative, import.meta.url));
const { createAssistantMessageEventStream } = await import(
	process.env.REAL_PI_HARNESS_PI_AI_INDEX
		? pathToFileURL(process.env.REAL_PI_HARNESS_PI_AI_INDEX).href
		: (
				piAiCandidates.find((url) => existsSync(fileURLToPath(url))) ??
				piAiCandidates[0]
			).href
);

const scriptPath = process.env.REAL_PI_HARNESS_SCRIPT;
const observationPath = process.env.REAL_PI_HARNESS_PROVIDER_LOG;
let contextShapeDiagnosticRecorded = false;

function loadScript() {
	if (!scriptPath) throw new Error("REAL_PI_HARNESS_SCRIPT is required");
	return JSON.parse(readFileSync(scriptPath, "utf8"));
}

function providerError(message) {
	const error = new Error(message);
	error.name = "ScriptedProviderError";
	return error;
}

function providerTools(context) {
	if (Array.isArray(context?.tools)) return context.tools;

	if (Array.isArray(context?.messages)) {
		const tools = new Map();
		let hasTranscriptTools = false;
		for (const message of context.messages) {
			if (message?.role !== "system") continue;
			if (Array.isArray(message.toolsRemoved)) {
				hasTranscriptTools = true;
				for (const tool of message.toolsRemoved) {
					if (typeof tool?.name === "string") tools.delete(tool.name);
				}
			}
			if (Array.isArray(message.toolsAdded)) {
				hasTranscriptTools = true;
				for (const tool of message.toolsAdded) {
					if (typeof tool?.name === "string") tools.set(tool.name, tool);
				}
			}
		}
		if (hasTranscriptTools) return [...tools.values()];
		return [];
	}

	return undefined;
}

function recordContextShapeDiagnostic() {
	if (contextShapeDiagnosticRecorded || !observationPath) return;
	contextShapeDiagnosticRecorded = true;
	appendFileSync(
		observationPath,
		`${JSON.stringify({ kind: "scripted-provider-context-shape-unavailable" })}\n`,
	);
}

function expandScriptTokens(value) {
	if (typeof value === "string") {
		return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) =>
			process.env[name] ?? match,
		);
	}
	if (Array.isArray(value)) return value.map(expandScriptTokens);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, expandScriptTokens(child)]),
		);
	}
	return value;
}

// The turn counter lives on the process, keyed by the script file: pi re-runs
// the extension factory on an RPC `clone`/`fork`, `new_session` and `/reload`,
// and a counter in the factory's closure restarted the script at turn 0 after
// every such rebind, so no scenario could move the conversation and go on
// (#4185 round 1, F3). One process runs one script file.
const TURN_COUNTERS = Symbol.for("pi-lens.real-harness.scripted-turns");
const turnCounters = (globalThis[TURN_COUNTERS] ??= new Map());

export default function scriptedProvider(pi) {
	const script = loadScript();
	const nextTurn = () => {
		const turn = turnCounters.get(scriptPath) ?? 0;
		turnCounters.set(scriptPath, turn + 1);
		return turn;
	};
	pi.registerProvider("scripted", {
		name: "Scripted harness provider",
		baseUrl: "https://scripted.invalid",
		apiKey: "scripted-harness-key",
		api: "openai-completions",
		models: [
			{
				id: "harness",
				name: "Harness",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 2_000,
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const turnIndex = nextTurn();
			const turn = turnIndex + 1;
			const action = expandScriptTokens(script[turnIndex]);
			if (observationPath) {
				const providerContextTools = providerTools(context);
				if (providerContextTools === undefined) recordContextShapeDiagnostic();
				const tools = (providerContextTools ?? []).map((tool) => ({
					name: tool.name,
					descriptionBytes: Buffer.byteLength(tool.description ?? ""),
					schemaBytes: Buffer.byteLength(JSON.stringify(tool.parameters ?? {})),
					surfaceBytes: Buffer.byteLength(tool.description ?? "") +
						Buffer.byteLength(JSON.stringify(tool.parameters ?? {})),
				})) ?? [];
				// What the model would SEE as user text, so a row can witness an injected
				// turn_end check (the `context` hook adds it to this request only).
				const userMessages = (context?.messages ?? [])
					.filter((message) => message?.role === "user")
					.map((message) =>
						(typeof message.content === "string"
							? message.content
							: JSON.stringify(message.content)
						).slice(0, 2000),
					);
				appendFileSync(observationPath, `${JSON.stringify({ turn: turn - 1, tools, userMessages })}\n`);
			}
			(async () => {
				const output = {
					role: "assistant", content: [], api: model.api,
					provider: model.provider, model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "pending", timestamp: Date.now(),
				};
				try {
					if (!action) throw providerError(`scripted turn ${turn - 1} requested beyond script`);
					stream.push({ type: "start", partial: output });
					for (const item of action) {
						if (item.type === "text") {
							const index = output.content.length;
							const block = { type: "text", text: item.text };
							output.content.push(block);
							stream.push({ type: "text_start", contentIndex: index, partial: output });
							stream.push({ type: "text_delta", contentIndex: index, delta: item.text, partial: output });
							stream.push({ type: "text_end", contentIndex: index, content: item.text, partial: output });
						} else if (item.type === "toolCall") {
							const index = output.content.length;
							const block = { type: "toolCall", id: item.id ?? `scripted-${turn}-${index}`, name: item.name, arguments: item.arguments ?? {} };
							output.content.push(block);
							stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
							stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments), partial: output });
							stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
						}
					}
					output.stopReason = output.content.some((item) => item.type === "toolCall") ? "toolUse" : "stop";
					stream.push({ type: "done", reason: output.stopReason, message: output });
					stream.end();
				} catch (error) {
					output.stopReason = options?.signal?.aborted ? "aborted" : "error";
					output.errorMessage = error instanceof Error ? error.message : String(error);
					stream.push({ type: "error", reason: output.stopReason, error: output });
					stream.end();
				}
			})();
			return stream;
		},
	});
}
