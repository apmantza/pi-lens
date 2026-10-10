/**
 * #4124: `agent_settled` releases the word index's incremental-serialize memo,
 * once per run, for the session that settled.
 *
 * Recurrences this prevents: (1) the memo, a second copy of the index's
 * postings, stayed reachable for the whole idle life of a session; (2) the
 * first fix released it at every publication and made each later edit's persist
 * a full re-serialize, so the release moved to the settle; (3) a settle in one
 * session dropping a memo another live session is mid-run on, or a session
 * replaced while the drain awaited dropping its successor's.
 *
 * Production chain: the real extension activation and `agent_settled` handler
 * (`index.ts`), the real module-level `RuntimeCoordinator`, the real word
 * index. Doubled: session start and the drain, which only supply the runtime
 * and replace the session, the way `/new` lands while the drain awaits.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
	runtime: undefined as undefined | { wordIndex: unknown },
	replaceSession: false,
	successorWire: undefined as unknown,
}));

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
	}));
});
vi.mock("../clients/runtime-session.js", () => ({
	handleSessionStart: async (deps: {
		runtime: {
			projectRoot: string;
			wordIndex: unknown;
			resetForSession: () => void;
		};
		ctxCwd?: string;
	}) => {
		seen.runtime = deps.runtime;
		// The real start begins a fresh scope; a scope the previous case's
		// shutdown retired would otherwise hand out an already-dead handle.
		deps.runtime.resetForSession();
		if (deps.ctxCwd) deps.runtime.projectRoot = deps.ctxCwd;
	},
}));
vi.mock("../clients/runtime-agent-end.js", () => ({
	handleAgentEnd: vi.fn(
		async (deps: {
			runtime: { resetForSession: () => void; wordIndex: unknown };
		}) => {
			if (seen.replaceSession) {
				deps.runtime.resetForSession();
				const { buildWordIndex, serializeWordIndex } =
					await import("../clients/word-index.js");
				const successor = buildWordIndex(DOCS);
				seen.successorWire = serializeWordIndex(successor);
				deps.runtime.wordIndex = successor;
			}
			return undefined;
		},
	),
}));

import { getRecentLoggedPhases } from "../clients/latency-logger.js";
import {
	buildWordIndex,
	serializeWordIndex,
	type WordIndex,
} from "../clients/word-index.js";
import extension from "../index.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

const DOCS = [
	{ path: "src/a.ts", content: "function alphaHandler() {}" },
	{ path: "src/b.ts", content: "function betaHandler() {}" },
	{ path: "src/c.ts", content: "function gammaHandler() {}" },
];

/**
 * Whether the memo still answers for `index`: serializing an unchanged index
 * returns the memoized wire object itself, and a rebuilt one is a new object.
 */
function memoStillHeld(index: WordIndex, wire: unknown): boolean {
	return serializeWordIndex(index) === wire;
}

describe("#4124: agent_settled releases the word index memo for its own session", () => {
	let tmp: string;
	let prevDataDir: string | undefined;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4124-settle-"));
		prevDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(tmp, "data");
		seen.replaceSession = false;
	});

	afterEach(async () => {
		// A primary left registered would make the next case's start a secondary.
		for (const { pi, ctx } of started.splice(0).reverse()) {
			await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		}
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		removeTempDirSync(tmp);
	});

	const started: Array<{
		pi: ReturnType<typeof createPiMock>;
		ctx: ReturnType<typeof makeCtx>;
	}> = [];

	async function start(sessionId: string) {
		const pi = createPiMock({ "no-lsp": true });
		extension(pi.asExtensionAPI());
		const ctx = makeCtx({ cwd: tmp, sessionId });
		await pi.emit("session_start", { reason: "startup" }, ctx);
		started.push({ pi, ctx });
		return { pi, ctx };
	}

	/** The release is a lazy import behind the handler; let it land. */
	async function settle(started: {
		pi: ReturnType<typeof createPiMock>;
		ctx: unknown;
	}): Promise<void> {
		await started.pi.emit("agent_settled", {}, started.ctx);
		await vi.dynamicImportSettled();
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	function holdMemo(): { index: WordIndex; wire: unknown } {
		const index = buildWordIndex(DOCS);
		const wire = serializeWordIndex(index);
		seen.runtime!.wordIndex = index;
		return { index, wire };
	}

	it("drops the held memo at settle and logs one row, keeping the decoded index", async () => {
		const { pi, ctx } = await start("s-4124-primary");
		const { index, wire } = holdMemo();

		await settle({ pi, ctx });

		expect(
			getRecentLoggedPhases().filter(
				(entry) => entry.phase === "word_index_memo_released",
			)[0]?.metadata,
		).toEqual({ trigger: "settle", files: 3 });
		expect(memoStillHeld(index, wire)).toBe(false);
		expect(seen.runtime!.wordIndex).toBe(index);
	});

	it("a concurrent secondary's settle leaves the primary's memo; the primary's own settle drops it", async () => {
		const primary = await start("s-4124-primary-2");
		const secondary = await start("s-4124-secondary");
		const { index, wire } = holdMemo();

		await settle(secondary);
		// No-drop direction: the primary is mid-run and still needs its memo.
		expect(memoStillHeld(index, wire)).toBe(true);
		await settle(primary);
		expect(memoStillHeld(index, wire)).toBe(false);
	});

	it("a session replaced while the drain awaited keeps its successor's memo", async () => {
		const { pi, ctx } = await start("s-4124-replaced");
		holdMemo();
		seen.replaceSession = true;

		await settle({ pi, ctx });

		const successor = seen.runtime!.wordIndex as WordIndex;
		expect(memoStillHeld(successor, seen.successorWire)).toBe(true);
	});
});
