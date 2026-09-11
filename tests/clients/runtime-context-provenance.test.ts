import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency,
}));
import {
	advisoryPathKey,
	snapshotAdvisoryProvenance,
	validateAdvisoryProvenance,
} from "../../clients/advisory-provenance.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	consumeTestFindings,
	peekTestFindings,
	consumeTurnEndFindings,
	peekTurnEndFindings,
} from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("advisory provenance at context delivery (#1413)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		cleanups.splice(0).forEach((cleanup) => cleanup());
		logLatency.mockReset();
	});

	function setup() {
		const env = setupTestEnvironment("pi-lens-advisory-");
		cleanups.push(env.cleanup);
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-a" });
		const cache = new CacheManager(false);
		const file = path.join(env.tmpDir, "src", "file.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "export const value = 1;\n");
		const provenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 7,
			files: [{ path: file, role: "affected" }],
		});
		return { env, runtime, cache, file, provenance };
	}

	it("uses the guard normalizer for Windows and POSIX separators", () => {
		expect(advisoryPathKey("C:\\repo\\src\\file.ts", "C:\\repo")).toBe(
			advisoryPathKey("C:/repo/src/file.ts", "C:/repo"),
		);
	});

	it("keeps exact-hash findings blocking and peek classifies like consume", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache(
			"turn-end-findings",
			{ content: "finding", provenance },
			env.tmpDir,
		);
		const peeked = peekTurnEndFindings(cache, env.tmpDir, runtime);
		const consumed = consumeTurnEndFindings(cache, env.tmpDir, runtime);
		expect(peeked).toEqual(consumed);
		expect(consumed?.messages[0]?.content).toContain("Address 🔴 blockers");
		expect(consumed?.messages[0]?.content).not.toContain("Historical finding");
		expect(logLatency).toHaveBeenCalledTimes(1);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "advisory_provenance_decision",
				metadata: expect.objectContaining({
					decision: "current",
					reasons: [],
					changedPathCount: 0,
					provenanceStamp: expect.stringContaining("generation 7"),
					advisoryKind: "turn-end",
				}),
			}),
		);
	});

	it("keeps unchanged blockers live across beginTurn and project sequence drift", () => {
		const { env, runtime, cache, file, provenance } = setup();
		cache.writeCache(
			"turn-end-findings",
			{ content: "finding", provenance },
			env.tmpDir,
		);
		runtime.beginTurn();
		runtime.bumpFileSeq(file);
		const consumed = consumeTurnEndFindings(cache, env.tmpDir, runtime);
		expect(consumed?.messages[0]?.content).toContain("Address ");
		expect(consumed?.messages[0]?.content).not.toContain("Historical finding");
	});

	it("demotes an edit made after persistence", () => {
		const { env, runtime, cache, file, provenance } = setup();
		cache.writeCache(
			"turn-end-findings",
			{ content: "finding", provenance },
			env.tmpDir,
		);
		fs.writeFileSync(file, "export const value = 2;\n");
		expect(
			consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content,
		).toContain(
			"Historical finding; workspace changed since capture; re-run to confirm.",
		);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					decision: "historical",
					reasons: expect.arrayContaining([
						expect.stringContaining("content-changed:"),
					]),
					changedPathCount: 1,
				}),
			}),
		);
	});

	it("caps logged reasons at 8 plus a '+N more' summary (S3b)", () => {
		const env = setupTestEnvironment("pi-lens-advisory-");
		cleanups.push(env.cleanup);
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "session-a" });
		const cache = new CacheManager(false);
		const files = Array.from({ length: 10 }, (_, i) => {
			const file = path.join(env.tmpDir, "src", `file${i}.ts`);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `export const value = ${i};\n`);
			return { path: file, role: "affected" as const };
		});
		const provenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 1,
			files,
		});
		cache.writeCache(
			"turn-end-findings",
			{ content: "finding", provenance },
			env.tmpDir,
		);
		// Rewrite every captured file so all 10 produce both a `metadata-changed:`
		// and a `content-changed:` reason (20 total) — a bash multi-file write is
		// the real-world shape this guards.
		for (const { path: file } of files) fs.writeFileSync(file, "changed\n");
		consumeTurnEndFindings(cache, env.tmpDir, runtime);
		expect(logLatency).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					reasons: expect.arrayContaining(["+12 more"]),
					changedPathCount: 10,
				}),
			}),
		);
		const call = logLatency.mock.calls.find(
			([entry]) =>
				(entry as { phase?: string }).phase === "advisory_provenance_decision",
		);
		const reasons = (call?.[0] as { metadata: { reasons: string[] } }).metadata
			.reasons;
		expect(reasons).toHaveLength(9);
		expect(reasons[8]).toBe("+12 more");
	});

	it("hash-detects same-size same-mtime rewrites", () => {
		const { env, runtime, cache, file, provenance } = setup();
		cache.writeCache(
			"turn-end-findings",
			{ content: "finding", provenance },
			env.tmpDir,
		);
		fs.writeFileSync(file, "export const value = 2;\n");
		fs.utimesSync(
			file,
			provenance.files[0]!.mtimeMs / 1000,
			provenance.files[0]!.mtimeMs / 1000,
		);
		expect(fs.statSync(file).size).toBe(provenance.files[0]!.size);
		expect(
			consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content,
		).toContain("Historical finding");
	});

	it("treats legacy records and session mismatches as historical", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache("turn-end-findings", { content: "legacy" }, env.tmpDir);
		expect(
			consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content,
		).toContain("generation unknown");
		cache.writeCache(
			"turn-end-findings",
			{ content: "mismatch", provenance },
			env.tmpDir,
		);
		runtime.setTelemetryIdentity({ sessionId: "session-b" });
		expect(
			consumeTurnEndFindings(cache, env.tmpDir, runtime)?.messages[0]?.content,
		).toContain("Historical finding");
	});

	it("treats missing-to-missing as unchanged and validation read failures as unknown", () => {
		const { env, runtime, file } = setup();
		const absent = path.join(env.tmpDir, "never-created.ts");
		const missingProvenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 1,
			files: [{ path: absent, role: "affected" }],
		});
		expect(
			validateAdvisoryProvenance(
				{ provenance: missingProvenance },
				env.tmpDir,
				runtime,
			),
		).toMatchObject({ status: "current", reasons: [] });

		const provenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 2,
			files: [{ path: file, role: "affected" }],
		});
		fs.unlinkSync(file);
		fs.mkdirSync(file);
		expect(
			validateAdvisoryProvenance({ provenance }, env.tmpDir, runtime).status,
		).toBe("unknown");
	});

	it("counts a file CREATED after capture as a changed path (S3a, #1432 review)", () => {
		const { env, runtime } = setup();
		const created = path.join(env.tmpDir, "new-file.ts");
		const provenance = snapshotAdvisoryProvenance({
			cwd: env.tmpDir,
			runtime,
			generation: 1,
			// Snapshotting a not-yet-existing path captures sha256 "missing".
			files: [{ path: created, role: "affected" }],
		});
		fs.writeFileSync(created, "export const value = 1;\n");
		// Before the fix, the `created:` branch pushed a reason but never added
		// to `changedPaths`, undercounting `changedPathCount` for a file that
		// came into existence after capture.
		expect(
			validateAdvisoryProvenance({ provenance }, env.tmpDir, runtime),
		).toMatchObject({
			status: "superseded",
			reasons: [expect.stringContaining("created:")],
			changedPathCount: 1,
		});
	});

	it("does not duplicate the historical preamble on prior-turn test content", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache(
			"test-runner-findings",
			{
				content: "[from a prior turn — already superseded]\n\nfailure",
				provenance,
			},
			env.tmpDir,
		);
		runtime.setTelemetryIdentity({ sessionId: "other-session" });
		const content =
			peekTestFindings(cache, env.tmpDir, runtime)?.messages[0]?.content ?? "";
		expect(content).toContain("[from a prior turn");
		expect(content).not.toContain("Historical finding");
	});

	it("preserves the test-run generation high-water mark across consumption", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache(
			"test-runner-findings",
			{
				content: "failure from batch B",
				testRunGeneration: 2,
				provenance,
			},
			env.tmpDir,
		);
		const delivered = consumeTestFindings(cache, env.tmpDir, runtime);
		expect(delivered).toBeDefined();
		// One-shot: nothing left to deliver...
		expect(peekTestFindings(cache, env.tmpDir, runtime)).toBeUndefined();
		// ...but the generation survives, so a still-in-flight OLDER batch (gen 1)
		// comparing against the persisted slot is suppressed instead of seeing
		// undefined and resurrecting a consumed advisory with stale results.
		const persisted = cache.readCache<Record<string, unknown>>(
			"test-runner-findings",
			env.tmpDir,
		)?.data;
		expect(persisted).toMatchObject({ content: "", testRunGeneration: 2 });
	});

	it("renders the current-findings preamble with a real em dash, not mojibake", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache(
			"test-runner-findings",
			{
				content: "failure",
				provenance,
			},
			env.tmpDir,
		);
		const content =
			consumeTestFindings(cache, env.tmpDir, runtime)?.messages[0]?.content ??
			"";
		expect(content).toContain(
			"Test failures detected last turn — fix before continuing",
		);
	});

	// #2522: a batch made entirely of RUNNER errors (timeout, missing
	// provider/binary) is not a failure the agent introduced. It must not
	// read as "fix before continuing" — that framing is reserved for a
	// genuine failing test.
	it("delivers a runner-error-only batch as advisory, not 'fix before continuing'", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache(
			"test-runner-findings",
			{
				content: "[Tests] ⚠ Could not run tests: spawn opencode ENOENT",
				provenance,
				runnerErrorOnly: true,
			},
			env.tmpDir,
		);
		const content =
			consumeTestFindings(cache, env.tmpDir, runtime)?.messages[0]?.content ??
			"";
		expect(content).not.toContain("fix before continuing");
		expect(content).toContain("advisory");
		expect(content).toContain("Could not run tests");
	});

	// A batch with at least one GENUINE failing test keeps the blocking
	// framing even if `runnerErrorOnly` is explicitly false — same string as
	// the pre-#2522 behavior, unchanged.
	it("keeps the blocking framing when runnerErrorOnly is false", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache(
			"test-runner-findings",
			{
				content: "[Tests] ✗ 1/1 failed",
				provenance,
				runnerErrorOnly: false,
			},
			env.tmpDir,
		);
		const content =
			consumeTestFindings(cache, env.tmpDir, runtime)?.messages[0]?.content ??
			"";
		expect(content).toContain(
			"Test failures detected last turn — fix before continuing",
		);
	});

	it("preserves structured commit-gate state when consumed", () => {
		const { env, runtime, cache, provenance } = setup();
		cache.writeCache(
			"turn-end-findings",
			{
				content: "blocker",
				hasBlockers: true,
				sessionId: "session-a",
				blockerContent: "structured blocker",
				provenance,
			},
			env.tmpDir,
		);
		consumeTurnEndFindings(cache, env.tmpDir, runtime);
		const persisted = cache.readCache<Record<string, unknown>>(
			"turn-end-findings",
			env.tmpDir,
		)?.data;
		expect(persisted).toMatchObject({
			consumed: true,
			blockerContent: "structured blocker",
		});
	});
});
