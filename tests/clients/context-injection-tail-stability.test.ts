/**
 * #4743 witness: with `--lens-retain-injections`, request N+1 repeats request
 * N whole, so an exact-prefix prompt cache keeps the conversation.
 *
 * Recurrence prevented (the Qwen/ds4 audit of 2026-10-20 to 10-22): the
 * injection is request-local (`context_with_system` returns an amended copy;
 * pi's agent state is untouched), so N+1 is rebuilt from pi's transcript
 * WITHOUT it. A provider cache that stored N's whole token run sees N+1
 * diverge exactly where the injection sat: cache read 0 after 29 of 29
 * injected requests on a local Qwen, ~165k tokens re-processed each time.
 *
 * Every cell reads what pi really sent through the scripted provider
 * (`tests/support/pi-session.ts`, the BUILT extension in a real
 * `AgentSession`) and compares it the way a provider hashes it: message by
 * message, serialized, and again after pi-ai's own system-message collapse
 * (the head a model without mid-conversation system support receives), plus
 * the tool loadout the system messages declare. The control cell (a quiet N)
 * is green on every build, so the comparison does not itself manufacture the
 * divergence; the flag-off cell pins the request shape the flag must not
 * change.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { snapshotAdvisoryProvenance } from "../../clients/advisory-provenance.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { MAX_RETAINED_ENTRIES } from "../../clients/context-injection-ledger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type PiProviderRequest,
	type PiSession,
	piAiModule,
	piSessionFixture,
	replayToolNames,
	startPiSession,
} from "../support/pi-session.js";

const fixture = piSessionFixture();

const FIRST = "TAIL_WITNESS_FIRST_FINDING";
const SECOND = "TAIL_WITNESS_SECOND_FINDING";
const RETAIN = new Map([["lens-retain-injections", true]]);
/** The snapshot label's fixed opening (`retainedSnapshotLabel`). */
const LABEL = "[pi-lens snapshot: these findings are as of this turn";

interface TranscriptReplay {
	collapseSystemMessages(context: { messages: readonly unknown[] }): {
		messages: readonly unknown[];
	};
	normalizeContext(context: { messages: readonly unknown[] }): {
		messages: readonly unknown[];
	};
}

/** pi-ai's transcript replay, from the certified host's own install. */
const piAi = piAiModule() as unknown as TranscriptReplay;

function stage(cwd: string, text: string): void {
	new CacheManager(false).writeCache(
		"session-start-guidance",
		{ content: text },
		cwd,
	);
}

const serialized = (request: PiProviderRequest): string[] =>
	request.map((message) => JSON.stringify(message));

/**
 * The cache condition: `next` begins with every message `previous` sent, byte
 * for byte. Returns the first divergence, or undefined when the prefix holds.
 */
function firstPrefixBreak(
	previous: PiProviderRequest,
	next: PiProviderRequest,
): { index: number; role: string; was: string; became: string } | undefined {
	const a = serialized(previous);
	const b = serialized(next);
	for (let index = 0; index < a.length; index++) {
		if (a[index] === b[index]) continue;
		let at = 0;
		while (at < a[index].length && a[index][at] === b[index]?.[at]) at++;
		return {
			index,
			role: previous[index].role,
			was: a[index].slice(Math.max(0, at - 30), at + 110),
			became: (b[index] ?? "<missing>").slice(Math.max(0, at - 30), at + 110),
		};
	}
	return undefined;
}

/** The prompt a collapsing provider sends, serialized message by message. */
function collapsedPrompt(request: PiProviderRequest): string {
	return piAi
		.collapseSystemMessages(piAi.normalizeContext({ messages: [...request] }))
		.messages.map((message) => JSON.stringify(message))
		.join("\n\n");
}

/**
 * Acceptance 2: N+1 starts with N's whole rendered payload, on both request
 * shapes a provider caches (the raw transcript and the collapsed head), and
 * declares the same tools.
 */
function expectWholePrefix(n: PiProviderRequest, next: PiProviderRequest) {
	expect(firstPrefixBreak(n, next)).toBeUndefined();
	expect(collapsedPrompt(next).startsWith(collapsedPrompt(n))).toBe(true);
	expect(replayToolNames(next)).toEqual(replayToolNames(n));
}

const count = (request: PiProviderRequest, marker: string): number =>
	JSON.stringify(request).split(marker).length - 1;

/** A quick session (no start-up guidance) and a file the scripted `read` opens. */
async function session(
	name: string,
	responses: Parameters<typeof startPiSession>[0]["responses"],
	flags: ReadonlyMap<string, boolean> = RETAIN,
): Promise<PiSession> {
	const cwd = `${fixture.root}/${name}/proj`;
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(path.join(cwd, "notes.txt"), "plain notes\n");
	return startPiSession({
		root: fixture.root,
		cwd,
		// A quick start writes no session-start guidance, so the warm turn is quiet.
		startupMode: "quick",
		flags,
		responses,
	});
}

const readCall = (cwd: string) =>
	fauxAssistantMessage(
		fauxToolCall("read", { path: path.join(cwd, "notes.txt") }),
	);

/** A scripted reply that stages `text` before the NEXT request is built. */
const stagingReply = (cwd: string, text: string) => () => {
	stage(cwd, text);
	return structuredClone(readCall(cwd));
};

/** `cache_context` rows the loaded copy wrote, in order. */
async function contextRows(
	handle: PiSession,
): Promise<Array<Record<string, unknown>>> {
	const read = await handle.latencyRows();
	expect(read.skipped).toBe(0);
	return read.rows.flatMap((row) => {
		const typed = row as { phase?: unknown; metadata?: unknown };
		const metadata = typed.metadata as Record<string, unknown> | undefined;
		// The sink is file-scoped: keep this session's rows only.
		return typed.phase === "cache_context" &&
			metadata?.sessionId === handle.session.sessionManager.getSessionId()
			? [metadata]
			: [];
	});
}

describe("request N+1 keeps the exact prefix request N sent", () => {
	it("control: a quiet request N is a pure prefix of N+1", async () => {
		const cwd = `${fixture.root}/tail-control/proj`;
		const handle = await session("tail-control", [
			readCall(cwd),
			fauxAssistantMessage("done"),
		]);
		await handle.prompt("look at the notes");
		const [n, next] = handle.requests;
		expect(handle.requests).toHaveLength(2);
		expect(count(n, "pi-lens automated context")).toBe(0);
		expectWholePrefix(n, next);
	});

	it("injection on the active user prompt survives into the tool-result request", async () => {
		const cwd = `${fixture.root}/tail-user/proj`;
		const handle = await session("tail-user", [
			readCall(cwd),
			fauxAssistantMessage("done"),
		]);
		stage(handle.cwd, FIRST);
		await handle.prompt("look at the notes");
		const [n, next] = handle.requests;
		expect(handle.requests).toHaveLength(2);
		// Request N carries the finding inside the user prompt (append-to-last-user).
		expect(count(n, FIRST)).toBe(1);
		// Recurrence: the Qwen/ds4 tail misses. Without the ledger N+1 is rebuilt
		// from pi's transcript and the prefix breaks INSIDE the user message.
		expectWholePrefix(n, next);
		// Repeated once per request, never duplicated by a retained copy.
		expect(count(next, FIRST)).toBe(1);
		// Acceptance 4: the label is in the ORIGINAL bytes, so N carries it too.
		expect(count(n, LABEL)).toBe(1);
		expect(count(next, LABEL)).toBe(1);
		expect(handle.errors).toEqual([]);
	});

	it("injection appended after a tool result survives into the following request", async () => {
		const cwd = `${fixture.root}/tail-append/proj`;
		const handle = await session("tail-append", [
			// Staged while request 1 is being answered, so request 2 (the
			// tool-result request) is the injecting one and its tail is the finding.
			stagingReply(cwd, FIRST),
			readCall(cwd),
			fauxAssistantMessage("done"),
		]);
		await handle.prompt("look at the notes");
		const [, n, next] = handle.requests;
		expect(handle.requests).toHaveLength(3);
		expect(count(n, FIRST)).toBe(1);
		expect(n.at(-1)?.role).toBe("user");
		expectWholePrefix(n, next);
		expect(count(next, FIRST)).toBe(1);
		expect(count(next, LABEL)).toBe(1);
	});

	it("a new injection on N+1 is added after the retained one, not instead of it", async () => {
		const cwd = `${fixture.root}/tail-both/proj`;
		const handle = await session("tail-both", [
			stagingReply(cwd, SECOND),
			fauxAssistantMessage("done"),
		]);
		stage(handle.cwd, FIRST);
		await handle.prompt("look at the notes");
		const [n, next] = handle.requests;
		expect(handle.requests).toHaveLength(2);
		expect(count(n, FIRST)).toBe(1);
		expect(count(next, SECOND)).toBe(1);
		expectWholePrefix(n, next);
		expect(count(next, FIRST)).toBe(1);
		// Each injection carries its own label.
		expect(count(next, LABEL)).toBe(2);
	});

	it("flag off: requests keep the shape they had without the flag", async () => {
		const cwd = `${fixture.root}/tail-off/proj`;
		const handle = await session(
			"tail-off",
			[readCall(cwd), fauxAssistantMessage("done")],
			new Map(),
		);
		stage(handle.cwd, FIRST);
		await handle.prompt("look at the notes");
		const [n, next] = handle.requests;
		// N: the prompt plus ONE appended block, the delimiter and the finding,
		// and no snapshot label.
		expect(n.at(-1)?.content).toEqual([
			{ type: "text", text: "look at the notes" },
			{
				type: "text",
				text: `[pi-lens automated context — not a user request]\n\n${FIRST}`,
			},
		]);
		expect(count(n, LABEL)).toBe(0);
		// N+1 is pi's own transcript: the prompt as pi stored it, nothing
		// retained, so the prefix breaks at the prompt N had extended.
		expect(next[1]?.content).toEqual([
			{ type: "text", text: "look at the notes" },
		]);
		expect(count(next, FIRST)).toBe(0);
		expect(firstPrefixBreak(n, next)?.index).toBe(1);

		// Acceptance 6: the break is recorded where it happened, and named as a
		// dropped injection.
		const [, nextRow] = await contextRows(handle);
		expect(nextRow).toMatchObject({
			prefixDivergence: "diverged",
			firstDifferingMessageIndex: 1,
			divergedAtInjection: true,
		});
		expect(nextRow).not.toHaveProperty("retention");
	});

	it("records the retained request as an append, not a new delivery", async () => {
		const cwd = `${fixture.root}/tail-records/proj`;
		const handle = await session("tail-records", [
			readCall(cwd),
			fauxAssistantMessage("done"),
		]);
		stage(handle.cwd, FIRST);
		await handle.prompt("look at the notes");
		const [nRow, nextRow] = await contextRows(handle);
		expect(nRow).toMatchObject({
			injectionOccurred: true,
			retention: { retainedNew: true, reemitted: 0 },
		});
		// N+1 re-sends one entry and delivers nothing new.
		expect(nextRow).toMatchObject({
			injectionOccurred: false,
			injectionSources: [],
			prefixDivergence: "append-only",
			divergedAtInjection: false,
			retention: { reemitted: 1, pruned: 0, retainedNew: false },
		});
	});

	it("an injection the ledger declines at its cap is delivered once, without the snapshot label", async () => {
		const cwd = `${fixture.root}/tail-cap/proj`;
		// One staged finding per tool round: each is injected after a tool
		// result and retained, until the 65th meets MAX_RETAINED_ENTRIES (64).
		const findings = Array.from(
			{ length: MAX_RETAINED_ENTRIES + 1 },
			(_, index) => `TAIL_CAP_FINDING_${index}_END`,
		);
		const handle = await session("tail-cap", [
			...findings.map((finding) => stagingReply(cwd, finding)),
			readCall(cwd),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("done again"),
		]);
		await handle.prompt("look at the notes");
		const declined = findings.at(-1) ?? "";
		const atCap = handle.requests.findIndex(
			(request) => count(request, declined) > 0,
		);
		const n = handle.requests[atCap];
		const next = handle.requests[atCap + 1];
		expect(n && next).toBeTruthy();
		if (!n || !next) return;
		// Every retained entry is re-sent and labelled; the declined one is
		// delivered once and does not claim it repeats (recurrence: a label
		// promising later requests on bytes no later request carries).
		expect(count(n, LABEL)).toBe(MAX_RETAINED_ENTRIES);
		expect(count(n, declined)).toBe(1);
		expect(JSON.stringify(n.at(-1))).not.toContain(LABEL);
		expect(count(next, declined)).toBe(0);
		expect(count(next, findings[0] ?? "")).toBe(1);
		const rows = await contextRows(handle);
		expect(rows[atCap]).toMatchObject({
			injectionOccurred: true,
			retention: { retainedNew: false, declined: "entry-cap" },
		});

		// The same on the other placement: a finding added to a new user prompt.
		stage(handle.cwd, SECOND);
		await handle.prompt("and now?");
		const last = handle.requests.at(-1);
		expect(last?.at(-1)?.role).toBe("user");
		expect(count(last ?? [], SECOND)).toBe(1);
		expect(JSON.stringify(last?.at(-1))).not.toContain(LABEL);
		expect((await contextRows(handle)).at(-1)).toMatchObject({
			placement: "append-to-last-user",
			retention: { retainedNew: false, declined: "entry-cap" },
		});
	});

	// #5770: the caps come from `contextInjection.retainMax*` in the global config,
	// read when the loaded copy starts, through the whole extension.
	async function withRetainConfig<T>(
		section: Record<string, number>,
		run: () => Promise<T>,
	): Promise<T> {
		const configPath = path.join(fixture.root, "retain-caps-config.json");
		fs.writeFileSync(configPath, JSON.stringify({ contextInjection: section }));
		vi.stubEnv("PI_LENS_CONFIG_PATH", configPath);
		try {
			return await run();
		} finally {
			vi.unstubAllEnvs();
			fs.rmSync(configPath, { force: true });
		}
	}

	it("retainMaxEntries: 0 keeps every injection past the default cap", async () => {
		const cwd = `${fixture.root}/tail-uncapped/proj`;
		const findings = Array.from(
			{ length: MAX_RETAINED_ENTRIES + 1 },
			(_, index) => `TAIL_UNCAPPED_FINDING_${index}_END`,
		);
		await withRetainConfig({ retainMaxEntries: 0 }, async () => {
			const handle = await session("tail-uncapped", [
				...findings.map((finding) => stagingReply(cwd, finding)),
				readCall(cwd),
				fauxAssistantMessage("done"),
			]);
			await handle.prompt("look at the notes");
			const last = findings.at(-1) ?? "";
			const atLast = handle.requests.findIndex(
				(request) => count(request, last) > 0,
			);
			const n = handle.requests[atLast];
			expect(n).toBeTruthy();
			if (!n) return;
			expect(count(n, LABEL)).toBe(MAX_RETAINED_ENTRIES + 1);
			const rows = await contextRows(handle);
			expect(rows[atLast]).toMatchObject({
				injectionOccurred: true,
				retention: { retainedNew: true },
			});
			expect(rows[atLast]?.retention).not.toHaveProperty("declined");
		});
	});

	it("retainMaxEntries: 2 declines the third injection with the entry cap", async () => {
		const cwd = `${fixture.root}/tail-small-cap/proj`;
		const findings = ["A", "B", "C"].map(
			(letter) => `TAIL_SMALL_CAP_FINDING_${letter}_END`,
		);
		await withRetainConfig({ retainMaxEntries: 2 }, async () => {
			const handle = await session("tail-small-cap", [
				...findings.map((finding) => stagingReply(cwd, finding)),
				readCall(cwd),
				fauxAssistantMessage("done"),
			]);
			await handle.prompt("look at the notes");
			const third = findings.at(-1) ?? "";
			const atThird = handle.requests.findIndex(
				(request) => count(request, third) > 0,
			);
			const n = handle.requests[atThird];
			expect(n).toBeTruthy();
			if (!n) return;
			expect(count(n, LABEL)).toBe(2);
			expect((await contextRows(handle))[atThird]).toMatchObject({
				retention: { retainedNew: false, declined: "entry-cap" },
			});
		});
	});

	it("switching injection off forgets what was retained, so switching it back on does not bring it back", async () => {
		const handle = await session("tail-toggle", [
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("quiet answer"),
			fauxAssistantMessage("last answer"),
		]);
		stage(handle.cwd, FIRST);
		await handle.prompt("first question");
		await handle.prompt("/lens-context-toggle");
		await handle.prompt("quiet question");
		await handle.prompt("/lens-context-toggle");
		await handle.prompt("last question");
		const [n, off, on] = handle.requests;
		expect(handle.requests).toHaveLength(3);
		expect(count(n, FIRST)).toBe(1);
		// Off: no pi-lens bytes at all, retained ones included.
		expect(count(off, FIRST)).toBe(0);
		// Back on: the requests sent while off are the prefix to keep, so the
		// old entry stays gone (recurrence: it reappeared mid-conversation and
		// broke the prefix the off requests had built).
		expect(count(on, FIRST)).toBe(0);
		expectWholePrefix(off, on);
	});
});

/**
 * Seed the commit gate's blocker record the way a turn end writes it, so the
 * consume marks it consumed and KEEPS it (`consumeTurnEndFindings`). A turn
 * end names its own session, and only that session's request takes the
 * record (#4943), so the seed names the session that reads it.
 */
function seedBlockerRecord(
	cwd: string,
	content: string,
	sessionId: string,
): void {
	const file = path.join(cwd, "unchanged.ts");
	fs.writeFileSync(file, "export const unchanged = true;\n");
	const provenance = snapshotAdvisoryProvenance({
		cwd,
		runtime: new RuntimeCoordinator(),
		generation: 1,
		files: [{ path: file, role: "affected" }],
	});
	new CacheManager().writeCache(
		"turn-end-findings",
		{ content, provenance, hasBlockers: true, sessionId },
		cwd,
	);
}

const readBlockerRecord = (cwd: string): unknown =>
	new CacheManager().readCache("turn-end-findings", cwd)?.data;

describe("the ledger keeps rendered text only (acceptance 5)", () => {
	it("re-sends N's rendered bytes and never reads or writes the turn-end-findings record", async () => {
		const handle = await session("tail-record", [
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
		]);
		seedBlockerRecord(
			handle.cwd,
			`${FIRST} blocking finding`,
			handle.session.sessionManager.getSessionId(),
		);
		await handle.prompt("first question");
		const n = handle.requests[0];
		expect(count(n, FIRST)).toBe(1);
		// The commit gate moves the record on (another writer, consumed already,
		// so nothing new is delivered from it).
		new CacheManager().writeCache(
			"turn-end-findings",
			{
				...(readBlockerRecord(handle.cwd) as Record<string, unknown>),
				content: `${SECOND} rewritten by the gate`,
				consumed: true,
			},
			handle.cwd,
		);
		const before = JSON.stringify(readBlockerRecord(handle.cwd));
		await handle.prompt("second question");
		const next = handle.requests[1];
		// The retained span is N's text, not the record's current text.
		expectWholePrefix(n, next);
		expect(count(next, FIRST)).toBe(1);
		expect(count(next, SECOND)).toBe(0);
		// The record is exactly what the gate left.
		expect(JSON.stringify(readBlockerRecord(handle.cwd))).toBe(before);
	});
});

describe("nothing retained outlives its transcript or its activation", () => {
	it("compaction drops every retained entry", async () => {
		const cwd = `${fixture.root}/tail-compact/proj`;
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		// A tiny keep window makes this short session compactable.
		fs.writeFileSync(
			path.join(cwd, ".pi", "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
		);
		const handle = await session("tail-compact", [
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			fauxAssistantMessage("the compaction summary"),
			fauxAssistantMessage("after compaction"),
		]);
		stage(handle.cwd, FIRST);
		await handle.prompt("first question");
		await handle.prompt("second question");
		expect(count(handle.requests[1], FIRST)).toBe(1);
		await handle.compact();
		await handle.prompt("third question");
		const after = handle.requests.at(-1);
		if (!after) throw new Error("no request after compaction");
		expect(count(after, FIRST)).toBe(0);
		const rows = await contextRows(handle);
		expect(rows.at(-1)).toMatchObject({
			retention: { reemitted: 0, pruned: 1 },
		});
	});

	it("a resumed session starts with nothing retained", async () => {
		const handle = await session("tail-resume", [
			fauxAssistantMessage("first answer"),
		]);
		stage(handle.cwd, FIRST);
		await handle.prompt("first question");
		const file = handle.sessionFile();
		if (!file) throw new Error("the session wrote no file");
		const resumed = await handle.restart(
			{ reason: "resume", sessionFile: file },
			[fauxAssistantMessage("resumed answer")],
		);
		await resumed.prompt("second question");
		const next = resumed.requests.at(-1);
		if (!next) throw new Error("the resumed session sent no request");
		// The resumed transcript is the same conversation: a ledger shared across
		// activations would line up and re-send the finding here.
		expect(JSON.stringify(next)).toContain("first question");
		expect(count(next, FIRST)).toBe(0);
	});

	it("a reload starts with nothing retained", async () => {
		const handle = await session("tail-reload", [
			fauxAssistantMessage("first answer"),
		]);
		stage(handle.cwd, FIRST);
		await handle.prompt("first question");
		const reloaded = await handle.restart({ reason: "reload" }, [
			fauxAssistantMessage("after reload"),
		]);
		await reloaded.prompt("second question");
		const next = reloaded.requests.at(-1);
		if (!next) throw new Error("the reloaded session sent no request");
		expect(JSON.stringify(next)).toContain("first question");
		expect(count(next, FIRST)).toBe(0);
	});
});
