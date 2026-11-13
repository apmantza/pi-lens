/**
 * Tests for #3693: Appending context injection to active user prompt to preserve KV cache
 * for local models (llama.cpp / Qwen) and prefix-caching providers.
 *
 * TWO TIERS (#4632). Four cases run through a REAL pi session
 * (`tests/support/pi-session.ts`, tier 2): the extension is the built
 * `index.js` loaded by pi's own loader, and the observable is the message the
 * SCRIPTED MODEL received, after pi's own request processing — a string
 * prompt, an empty string prompt (#4913 L3), an image attachment (the host's own
 * `prompt(text, { images })`), and a trailing tool result. Every other case here
 * asserts pi-lens's own return-value shaping for transcripts a scripted provider
 * cannot produce — an empty array, a custom `{ weird: true }` content object, an
 * empty transcript, and the string content arm an empty prompt takes after a
 * transcript rebuild (#4988 F1) — so those stay on the pi double, which is the
 * cheaper and only possible driver for them. Each of those direct-handler cells
 * now carries the host's real system head (`makeContextWithSystemEvent`), so its
 * index positions are the shape pi actually sends (#4631 round 6, R6-1); the
 * empty-transcript cell is the one exception, because the branch it reaches is
 * unreachable from a host.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { _resetProcessSingletonsForTests } from "../../clients/process-singletons.js";
import {
	makeContextWithSystemEvent,
	makeSystemHead,
} from "../support/host-event-factory.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "../support/pi-session.js";

const TIMEOUT_MS = 30_000;

/** The delimiter every injected block is prefixed with. */
const INJECTION_DELIMITER = "[pi-lens automated context — not a user request]";

/**
 * A decodable 1x1 PNG. The image cases go through the host's own entry point,
 * `AgentSession.prompt(text, { images })` (`agent-session.js:1476`), and pi's
 * image stage REJECTS a payload it cannot decode — it replaces the block with
 * an `[Image omitted: …]` hint instead of sending it. So the attachment has to
 * be a real image, not a base64-shaped string. Measured on this host: 8x2 and
 * 1x1 both pass, a corrupt 1x1 does not.
 */
const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The content block shapes these cases read off pi's request. */
interface ContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

const fixture = piSessionFixture();
// No per-case handle list: the helper registers every session it creates and
// disposes the live ones in its own `afterEach`, so a case that fails before
// `dispose()` cannot leak one (#4664 M2).
const sessionCwd = (name: string) => path.join(fixture.root, name, "proj");

let tmpDir: string;

beforeEach(() => {
	_resetProcessSingletonsForTests();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3693-append-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadContextHandler() {
	vi.resetModules();
	const { default: registerExtension } = await import("../../index.js");
	const mock = createPiMock();
	registerExtension(mock.asExtensionAPI() as any);
	// #4631: pi 0.87+ delivers the full transcript to `context_with_system` and
	// strips system messages from `context`, so the injector is that hook. Its
	// event carries the transcript the placement rule reads.
	const context = mock.handlers.get("context_with_system")?.[0];
	expect(context).toBeTypeOf("function");
	return { context: context!, mock };
}

describe("context injection appends to last user message (#3693)", () => {
	it(
		"appends the injected block to the prompt the model actually receives, on a real pi turn",
		async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: sessionCwd("string-prompt"),
				// A QUICK start writes no `session-start-guidance` row (a full start
				// writes it at its END), so the first turn is a genuinely QUIET
				// baseline. At the "full" default both turns would inject and the head
				// comparison below would lose the contrast its name claims.
				startupMode: "quick",
				responses: [
					fauxAssistantMessage(fauxText("ready")),
					fauxAssistantMessage(fauxText("done")),
				],
			});

			await handle.prompt("Warm up");
			const quiet = handle.requests[0];
			expect(JSON.stringify(quiet)).not.toContain(INJECTION_DELIMITER);

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Guidance text" },
				handle.cwd,
			);
			await handle.prompt("Optimize performance");

			// What the model received on the injecting turn, as pi built it: the
			// host's own system head, the quiet turn replayed, then ONE user message
			// carrying the prompt and the injected block — appended, not added as
			// its own message.
			const transcript = handle.requests[1];
			expect(transcript.map((message) => message.role)).toEqual([
				"system",
				"user",
				"assistant",
				"user",
			]);
			// #4631, and this case's witness half: injecting changes no earlier
			// byte, so the head the provider cached survives. Serialized comparison,
			// because a provider hashes the message, not the reference. Pre-fix
			// `restoreSystemMessages` rebuilt the head on the injecting turn and both
			// of these lines red.
			expect(JSON.stringify(transcript[0])).toBe(JSON.stringify(quiet[0]));
			expect(transcript.slice(0, quiet.length)).toEqual(quiet);
			const last = transcript.at(-1);
			if (!last) throw new Error("the injecting turn sent no request");
			expect(last.role).toBe("user");
			const blocks = last.content as ContentBlock[];
			expect(blocks).toHaveLength(2);
			expect(blocks[0]).toEqual({
				type: "text",
				text: "Optimize performance",
			});
			expect(blocks[1].type).toBe("text");
			// The delimiter opens the block, exactly as the unit-level cases
			// above require, and the payload the delivery read follows it.
			expect(blocks[1].text).toBe(`${INJECTION_DELIMITER}\n\nGuidance text`);
			expect(handle.errors).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"handles empty string user prompt without creating leading newline",
		async () => {
			// Tier 2 (#4913 L3): the real session sends the empty prompt as pi builds
			// it, so the claim is the request the scripted model receives. pi keeps
			// the empty text block, and the injected block after it starts with the
			// delimiter, not with a newline.
			const handle = await startPiSession({
				root: fixture.root,
				cwd: sessionCwd("empty-prompt"),
				startupMode: "quick",
				responses: [fauxAssistantMessage(fauxText("done"))],
			});
			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Guidance text" },
				handle.cwd,
			);

			await handle.prompt("");

			const last = handle.requests[0].at(-1);
			if (!last) throw new Error("the empty prompt sent no request");
			expect(last.role).toBe("user");
			expect(last.content as ContentBlock[]).toEqual([
				{ type: "text", text: "" },
				{ type: "text", text: `${INJECTION_DELIMITER}\n\nGuidance text` },
			]);
			expect(handle.errors).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"handles an empty string content arm without creating leading newline",
		async () => {
			// Direct handler (#4988 F1): pi hands the handler `content: [{ type:
			// "text", text: "" }]` above, so that case reaches the ARRAY arm only.
			// A transcript rebuilt from a released writer can carry a string last
			// user message (AGENTS.md shape 57), which takes
			// `appendToUserPromptContent`'s string arm; its empty sub-branch
			// (`content.length > 0 ? … : injectedText`) is pinned here. A leading
			// newline on the empty string reds this case and nothing else.
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Guidance text" },
				tmpDir,
			);

			const emptyPrompt = { role: "user", content: "" };
			const existing = [emptyPrompt];
			const head = makeSystemHead();

			const result = (await context(
				makeContextWithSystemEvent(existing, head),
				makeCtx({ cwd: tmpDir, sessionId: "sess-2" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(2);
			// #4631 round 6 (R6-1): the host's request leads with the system head,
			// which the handler must hand back untouched — the user prompt and the
			// injected block follow it.
			// Compared against a FRESH builder output, not the event's own object: a
			// handler that mutated the head in place would pass the reference check.
			expect(result.messages[0]).toEqual(makeSystemHead());
			expect(result.messages[0].role).toBe("system");
			const last = result.messages[1];
			expect(last.role).toBe("user");
			expect(typeof last.content).toBe("string");
			expect((last.content as string).startsWith("\n")).toBe(false);
			expect(last.content).toBe(`${INJECTION_DELIMITER}\n\nGuidance text`);
			expect(last).not.toBe(emptyPrompt);
			expect(emptyPrompt.content).toBe("");
		},
		TIMEOUT_MS,
	);

	it(
		"appends after an image block on a real pi turn, preserving the blocks, their order and the stored bytes",
		async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: sessionCwd("image-blocks"),
				// Quick, for the QUIET baseline the head comparison needs; see the
				// string-prompt case above.
				startupMode: "quick",
				responses: [
					fauxAssistantMessage(fauxText("ready")),
					fauxAssistantMessage(fauxText("seen")),
					fauxAssistantMessage(fauxText("still seen")),
				],
			});

			await handle.prompt("Warm up");
			const quiet = handle.requests[0];
			expect(JSON.stringify(quiet)).not.toContain(INJECTION_DELIMITER);

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Follow safety guidelines." },
				handle.cwd,
			);
			// pi builds the user message as `[{type:"text"}, ...images]`
			// (`agent-session.js:1476`), so the attachment sits mid-message and
			// the injected block has to land AFTER it, as a third block.
			await handle.session.prompt("Analyze this image", {
				images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
			});

			const injecting = handle.requests[1];
			expect(handle.errors).toEqual([]);
			// #4631: the attachment does not move the head either — the cached
			// prefix survives byte for byte on a turn that carries an image.
			expect(JSON.stringify(injecting[0])).toBe(JSON.stringify(quiet[0]));

			const user = injecting.at(-1);
			if (!user) throw new Error("the injecting turn sent no request");
			expect(user.role).toBe("user");
			const blocks = user.content as ContentBlock[];
			expect(blocks.map((block) => block.type)).toEqual([
				"text",
				"image",
				"text",
			]);
			expect(blocks[0]).toEqual({ type: "text", text: "Analyze this image" });
			expect(blocks[1]).toMatchObject({
				type: "image",
				mimeType: "image/png",
			});
			expect(blocks[2].text).toBe(
				`${INJECTION_DELIMITER}\n\nFollow safety guidelines.`,
			);

			// The tier-2 form of the unit case's immutability half: the injection
			// never rewrites what pi STORED. The next request replays the image
			// message with its two original blocks and the same image bytes.
			await handle.prompt("anything else");
			const replayed = handle.requests[2].find(
				(message) =>
					Array.isArray(message.content) &&
					(message.content as ContentBlock[]).some(
						(block) => block.type === "image",
					),
			);
			if (!replayed)
				throw new Error("the replay turn dropped the image message");
			const replayedBlocks = replayed.content as ContentBlock[];
			expect(replayedBlocks.map((block) => block.type)).toEqual([
				"text",
				"image",
			]);
			expect(replayedBlocks[1].data).toBe(blocks[1].data);
		},
		TIMEOUT_MS,
	);

	/**
	 * #4743 acceptance 3: the image cell with `--lens-retain-injections` on. The
	 * replay request now repeats the injected block (three blocks, by design),
	 * so the immutability half moves to what it was always about: pi's STORED
	 * message keeps its two blocks and its image bytes, because the ledger
	 * works on the per-request copy.
	 */
	it(
		"with retained injections on, repeats the block on the replay and leaves pi's stored image message unchanged",
		async () => {
			const handle = await startPiSession({
				root: fixture.root,
				cwd: sessionCwd("image-blocks-retained"),
				startupMode: "quick",
				flags: new Map([["lens-retain-injections", true]]),
				responses: [
					fauxAssistantMessage(fauxText("ready")),
					fauxAssistantMessage(fauxText("seen")),
					fauxAssistantMessage(fauxText("still seen")),
				],
			});

			await handle.prompt("Warm up");
			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Follow safety guidelines." },
				handle.cwd,
			);
			await handle.session.prompt("Analyze this image", {
				images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
			});
			const injected = handle.requests[1].at(-1);
			await handle.prompt("anything else");

			const isImageMessage = (message: { content?: unknown }) =>
				Array.isArray(message.content) &&
				(message.content as ContentBlock[]).some(
					(block) => block.type === "image",
				);
			const replayed = handle.requests[2].find(isImageMessage);
			if (!replayed || !injected)
				throw new Error("the replay turn dropped the image message");
			// The provider sees the injected message again, byte for byte.
			expect(replayed).toEqual(injected);
			expect(
				(replayed.content as ContentBlock[]).map((block) => block.type),
			).toEqual(["text", "image", "text"]);

			// pi's own transcript never held the block.
			const stored = (
				handle.session.messages as Array<{ content?: unknown }>
			).find(isImageMessage);
			if (!stored) throw new Error("pi stored no image message");
			const storedBlocks = stored.content as ContentBlock[];
			expect(storedBlocks.map((block) => block.type)).toEqual([
				"text",
				"image",
			]);
			expect(storedBlocks[1].data).toBe(
				(replayed.content as ContentBlock[])[1].data,
			);
			expect(handle.errors).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"handles empty array content without creating leading blank blocks",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Rule check." },
				tmpDir,
			);

			const emptyArray: unknown[] = [];
			const originalUser = { role: "user", content: emptyArray };
			const head = makeSystemHead();

			const result = (await context(
				makeContextWithSystemEvent([originalUser], head),
				makeCtx({ cwd: tmpDir, sessionId: "sess-4" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(2);
			// #4631 round 6 (R6-1): the host's request leads with the system head,
			// which the handler must hand back untouched — the user prompt and the
			// injected block follow it.
			// Compared against a FRESH builder output, not the event's own object: a
			// handler that mutated the head in place would pass the reference check.
			expect(result.messages[0]).toEqual(makeSystemHead());
			expect(result.messages[0].role).toBe("system");
			const last = result.messages[1];
			expect(Array.isArray(last.content)).toBe(true);
			const contentBlocks = last.content as Array<{
				type: string;
				text?: string;
			}>;
			expect(contentBlocks).toHaveLength(1);
			expect(contentBlocks[0]).toEqual({
				type: "text",
				text: "[pi-lens automated context — not a user request]\n\nRule check.",
			});
			expect(emptyArray).toHaveLength(0);
			expect(last).not.toBe(originalUser);
		},
		TIMEOUT_MS,
	);

	it(
		"appends after a trailing tool result on a real pi turn instead of into it",
		async () => {
			// The cache the request hook consumes is staged while pi assembles
			// the FIRST request, so it is present for the request that follows
			// the tool call — the transcript that ends in a tool result.
			const MID_RUN = "MIDRUN-GUIDANCE";
			const handle = await startPiSession({
				root: fixture.root,
				cwd: sessionCwd("tool-result-adjacency"),
				responses: [
					() => {
						new CacheManager(false).writeCache(
							"session-start-guidance",
							{ content: MID_RUN },
							sessionCwd("tool-result-adjacency"),
						);
						return fauxAssistantMessage([
							fauxText("checking"),
							fauxToolCall("lens_diagnostics", {}),
						]);
					},
					fauxAssistantMessage(fauxText("done")),
				],
			});

			await handle.prompt("keep working");

			// pi's own transcript: system head, the prompt, the assistant's call,
			// the tool result — then the injection as a NEW user message.
			const second = handle.requests[1];
			expect(second.map((message) => message.role)).toEqual([
				"system",
				"user",
				"assistant",
				"toolResult",
				"user",
			]);

			// Nothing was appended inside the tool result: it still carries the
			// tool's own answer only.
			const toolResultText = JSON.stringify(second[3]);
			expect(toolResultText).not.toContain(MID_RUN);
			expect(toolResultText).toContain(
				"No new findings in the current turn delta.",
			);

			// The injection is the trailing message, prefixed with the delimiter.
			expect(second[4].content).toBe(`${INJECTION_DELIMITER}\n\n${MID_RUN}`);
			expect(handle.errors).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"falls back to prepend semantics for an empty transcript",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Empty transcript check." },
				tmpDir,
			);

			// #4631 round 6 (R6-1): this cell stays HEADLESS on purpose. The branch
			// it reaches (`existingMessages.length === 0`) is unreachable from a
			// host, which always leads the transcript with the system head; giving
			// it a head would delete the branch's only coverage.
			const result = (await context(
				{ messages: [] },
				makeCtx({ cwd: tmpDir, sessionId: "sess-6" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].role).toBe("user");
			expect(result.messages[0].content).toContain("Empty transcript check.");
		},
		TIMEOUT_MS,
	);

	it(
		"routes a non-string non-array prompt down the append-after path preserving content uncoerced",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Uncoerced test guidance." },
				tmpDir,
			);

			const customContent = { weird: true };
			const customUser = { role: "user", content: customContent };
			const existing = [{ role: "assistant", content: "Ready." }, customUser];
			const head = makeSystemHead();

			const result = (await context(
				makeContextWithSystemEvent(existing, head),
				makeCtx({ cwd: tmpDir, sessionId: "sess-7" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			// Appends AFTER the transcript as a new message, leaving customContent untouched
			expect(result.messages).toHaveLength(4);
			// #4631 round 6 (R6-1): the host's head leads the transcript; the
			// prior turns and the appended message follow it.
			// Compared against a FRESH builder output, not the event's own object: a
			// handler that mutated the head in place would pass the reference check.
			expect(result.messages[0]).toEqual(makeSystemHead());
			expect(result.messages[0].role).toBe("system");
			expect(result.messages[1]).toEqual({
				role: "assistant",
				content: "Ready.",
			});
			expect(result.messages[2]).toBe(customUser);
			expect(result.messages[2].content).toBe(customContent);
			expect(result.messages[3].role).toBe("user");
			expect(result.messages[3].content).toContain("Uncoerced test guidance.");
		},
		TIMEOUT_MS,
	);
});
