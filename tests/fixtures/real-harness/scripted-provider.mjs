import { readFileSync, appendFileSync } from "node:fs";
import {
	createAssistantMessageEventStream,
} from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";

const scriptPath = process.env.REAL_PI_HARNESS_SCRIPT;
const observationPath = process.env.REAL_PI_HARNESS_PROVIDER_LOG;

function loadScript() {
	if (!scriptPath) throw new Error("REAL_PI_HARNESS_SCRIPT is required");
	return JSON.parse(readFileSync(scriptPath, "utf8"));
}

function providerError(message) {
	const error = new Error(message);
	error.name = "ScriptedProviderError";
	return error;
}

export default function scriptedProvider(pi) {
	const script = loadScript();
	let turn = 0;
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
			const action = script[turn++];
			if (observationPath) {
				appendFileSync(observationPath, `${JSON.stringify({ turn: turn - 1, tools: context.tools?.map((tool) => tool.name) ?? [] })}\n`);
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
