import * as fs from "node:fs";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { resetSessionScopedState } from "../../clients/runtime-session.js";
import {
	clearWidgetState,
	getFileDiagnosticSummaries,
	markWidgetFileBlockersStale,
	reconcileCascadeNeighborLspErrors,
	reconcileStaleWidgetFiles,
	recordDiagnostics,
	recordRunner,
	retireWidgetDependencyDriftBlockers,
} from "../../clients/widget-state.js";
import { createLensDiagnosticMarkTool } from "../../tools/lens-diagnostic-mark.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";
import { setupTestEnvironment } from "../clients/test-utils.js";

// Recurrence: a zero session result said "No issues ... ✓" / compact "clean"
// while the REAL widget store still had pending or stale evidence. No summary,
// freshness gate, cache manager, or in-process service is mocked in this suite.
describe("session diagnostic evidence", () => {
	let cwd: string;
	let cleanup: () => void;
	let tool: ReturnType<typeof createLensDiagnosticsTool>;

	beforeEach(() => {
		({ tmpDir: cwd, cleanup } = setupTestEnvironment(
			"pi-lens-session-evidence-",
		));
		cwd = fs.realpathSync(cwd);
		resetSessionScopedState(cwd);
		// Widget rows belong to the host's session-store reset, outside the
		// owner-held resets above; each case starts a separate widget session.
		clearWidgetState();
		tool = createLensDiagnosticsTool(new CacheManager(), () => cwd);
	});

	afterEach(() => {
		resetSessionScopedState(cwd);
		clearWidgetState();
		vi.unstubAllEnvs();
		cleanup();
	});

	function file(name = "app.txt") {
		const target = path.join(cwd, name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "export const value = 1;\n");
		return target;
	}

	function run(
		params: Record<string, unknown> = {},
		host: "pi" | "mcp" = "pi",
	) {
		return tool.execute(
			"session-evidence",
			{ mode: "all", ...params },
			undefined,
			undefined,
			{ cwd, host },
		);
	}

	function compact(result: Awaited<ReturnType<typeof run>>) {
		return tool
			.renderResult(result, { expanded: false }, {} as Theme, {
				args: { mode: "all" },
			})
			.render(240)
			.join("\n");
	}

	// #4522 holds the same rule at the dispatch layer: only a clean run reads
	// clean. These rows use its words where they fit: `clean`, `dirty` and
	// `unanswered` carry over, `unchecked` is its word for a path nothing
	// examined, and `stale` has no dispatch twin (an answer about older bytes).
	// A missing, crashed or wrong-version tool is invisible to this cache.
	const STATES: ReadonlyArray<{
		state: string;
		seed: (target: string) => void;
		status: string;
		readsClean: boolean;
	}> = [
		{
			state: "clean",
			seed: (target) => recordDiagnostics(target, []),
			status: "no-matching-findings",
			readsClean: true,
		},
		{
			state: "dirty",
			seed: (target) =>
				recordDiagnostics(target, [
					{
						severity: "error",
						semantic: "blocking",
						tool: "example",
						message: "a live error",
						line: 1,
					},
				]),
			status: "findings",
			readsClean: false,
		},
		{
			state: "unanswered",
			seed: (target) => recordRunner(target, "example", "succeeded", 0),
			status: "inconclusive",
			readsClean: false,
		},
		{
			state: "stale",
			seed: (target) => {
				recordDiagnostics(target, []);
				const future = new Date(Date.now() + 60_000);
				fs.utimesSync(target, future, future);
			},
			status: "inconclusive",
			readsClean: false,
		},
		{
			state: "unchecked",
			seed: () => undefined,
			status: "unverified",
			readsClean: false,
		},
		{
			// Recurrence prevented: #5287. A final snapshot with no finding is also
			// what a file no check completed on leaves behind (a kind nothing can
			// check, `--no-lsp` TypeScript); the projection dropped its reason, so
			// this row read `✓`.
			state: "no check completed",
			seed: (target) =>
				recordDiagnostics(target, [], undefined, undefined, {
					reason: "no analyzer handles this file type",
					inapplicable: true,
				}),
			status: "unverified",
			readsClean: false,
		},
	];

	it.each(STATES)(
		"only a clean read reads clean (#4522): $state reads $status",
		async ({ seed, status, readsClean }) => {
			const target = file();
			seed(target);
			const result = await run({ paths: [target] });
			const text = result.content[0]?.text ?? "";
			expect(result.details).toMatchObject({ validationStatus: status });
			expect(text.includes("✓")).toBe(readsClean);
			expect(compact(result).includes("no matching cached findings")).toBe(
				readsClean,
			);
			expect(compact(result)).not.toContain("— clean");
			expect(text.includes("not a clean verdict")).toBe(
				status === "inconclusive" || status === "unverified",
			);
		},
	);

	// Recurrence prevented: #5287. The line that names the files no check
	// completed on is one per call whatever the count (bounded observability):
	// five names and a remainder, never a row per file.
	it("names at most five unchecked files and counts the rest (#5287)", async () => {
		const reason = "no analyzer handles this file type";
		for (let index = 0; index < 7; index++)
			recordDiagnostics(file(`u${index}.zzz`), [], undefined, undefined, {
				reason,
				inapplicable: true,
			});
		recordDiagnostics(file("ok.ts"), []);

		const result = await run();
		const text = result.content[0]?.text ?? "";

		expect(text).not.toContain("✓");
		expect(text).toContain("⚠ 7 files not checked");
		for (let index = 0; index < 5; index++)
			expect(text).toContain(`u${index}.zzz: ${reason}`);
		expect(text).not.toContain("u5.zzz");
		expect(text).toContain("+2 more");
		expect(result.details).toMatchObject({ uncheckedFileCount: 7 });
		expect(compact(result)).toContain("7 unchecked");
		expect(compact(result)).not.toContain("— clean");
	});

	it.each([{ mode: "all" }, { source: "session", scope: "workspace" }])(
		"discloses pending zero evidence for %j",
		async (params) => {
			const target = file();
			recordRunner(target, "example", "succeeded", 0);
			const result = await run(params);
			expect(result.content[0]?.text).toContain("inconclusive");
			expect(result.content[0]?.text).toContain("1 pending");
			expect(result.content[0]?.text).toContain(JSON.stringify([target]));
			expect(result.content[0]?.text).not.toContain("✓");
			expect(result.details).toMatchObject({
				validationStatus: "inconclusive",
				pendingFileCount: 1,
				nextCheck: {
					tool: "lens_diagnostics",
					source: "lsp",
					scope: "paths",
					paths: [target],
				},
			});
			expect(compact(result)).toContain("inconclusive");
			expect(compact(result)).not.toContain("— clean");
		},
	);

	it("discloses omitted stale evidence beside a final clean snapshot", async () => {
		const stale = file("stale.txt");
		const clean = file("clean.txt");
		recordDiagnostics(stale, []);
		recordDiagnostics(clean, []);
		const future = new Date(Date.now() + 60_000);
		fs.utimesSync(stale, future, future);
		const result = await run();
		expect(result.content[0]?.text).toContain("inconclusive");
		expect(result.content[0]?.text).toContain(
			"1 changed file omitted as stale",
		);
		expect(result.content[0]?.text).not.toContain("✓");
		expect(result.details).toMatchObject({
			validationStatus: "inconclusive",
			staleDropped: 1,
			nextCheck: { paths: [stale] },
		});
		// The changed file is not omitted from the store: it stays as an unfinished
		// record (#4625 F1), the clean sibling as a final one.
		expect(
			new Map(
				getFileDiagnosticSummaries().map((s) => [
					s.filePath,
					s.hasFinalSnapshot,
				]),
			),
		).toEqual(
			new Map([
				[stale, false],
				[clean, true],
			]),
		);
	});

	it("names a deleted stale path without claiming that a probe can validate it", async () => {
		const target = file();
		recordDiagnostics(target, []);
		fs.unlinkSync(target);
		const result = await run({ paths: [target] });
		expect(result.details).toMatchObject({
			validationStatus: "inconclusive",
			staleDropped: 1,
			nextCheck: { paths: [target] },
		});
		expect(result.content[0]?.text).toContain("file-appropriate validator");
	});

	it("keeps past-EOF evidence inconclusive when severity excludes the finding", async () => {
		const target = file();
		recordDiagnostics(target, [
			{
				severity: "error",
				semantic: "blocking",
				tool: "lsp",
				message: "unconfirmed old location",
				line: 407,
			},
		]);
		const result = await run({ severity: "error" });
		expect(result.details).toMatchObject({
			validationStatus: "inconclusive",
			staleDiagnosticCount: 1,
		});
		expect(result.content[0]?.text).toContain("1 stale finding");
		expect(result.content[0]?.text).not.toContain("✓");
		expect(compact(result)).toContain("inconclusive");
	});

	it("preserves live findings alongside footer-capped dependency demotions", async () => {
		const stale = file("stale.txt");
		const live = file("live.txt");
		recordDiagnostics(stale, [
			{
				severity: "error",
				semantic: "blocking",
				tool: "lsp",
				message: "dependency evidence",
				line: 1,
			},
		]);
		expect(markWidgetFileBlockersStale(stale, "dependency-drift")).toBe(true);
		expect(retireWidgetDependencyDriftBlockers(stale)).toBe(true);
		recordRunner(stale, "example", "succeeded", 0);
		recordDiagnostics(live, [
			{
				severity: "error",
				semantic: "blocking",
				tool: "example",
				message: "real live finding",
				line: 1,
			},
		]);
		const result = await run();
		expect(result.details).toMatchObject({
			validationStatus: "inconclusive",
			staleDiagnosticCount: 1,
			pendingFileCount: 1,
			nextCheck: { paths: [stale] },
			totalBlocking: 1,
		});
		expect(result.content[0]?.text).toContain("real live finding");
		expect(compact(result)).toContain("1 blocking");
		expect(compact(result)).toContain("inconclusive");
		expect(result.content[0]?.text).toContain("dependency evidence");
		expect(result.content[0]?.text).toContain(
			"no longer shown in the pi-lens footer",
		);
	});

	it.each(["clean.txt", "selected"])(
		"does not let unrelated stale or pending evidence contaminate %s",
		async (scope) => {
			const clean = file(
				scope === "selected" ? "selected/clean.txt" : "clean.txt",
			);
			const stale = file("unrelated.txt");
			const pending = file("pending.txt");
			const demoted = file("demoted.txt");
			recordDiagnostics(clean, []);
			recordDiagnostics(stale, []);
			recordRunner(pending, "example", "succeeded", 0);
			recordDiagnostics(demoted, [
				{
					severity: "error",
					semantic: "blocking",
					tool: "lsp",
					message: "outside scope",
					line: 1,
				},
			]);
			markWidgetFileBlockersStale(demoted, "dependency-drift");
			retireWidgetDependencyDriftBlockers(demoted);
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(stale, future, future);
			const result = await run({
				source: "session",
				scope: "paths",
				paths: [scope],
			});
			expect(result.details).toMatchObject({
				validationStatus: "no-matching-findings",
				staleDropped: 0,
				pendingFileCount: 0,
				staleDiagnosticCount: 0,
			});
			expect(result.content[0]?.text).not.toMatch(
				/inconclusive|omitted as stale|capped after/,
			);
			expect(result.details).not.toHaveProperty("nextCheck");
			expect(compact(result)).toContain("no matching cached findings");
		},
	);

	it("does not revive a suppressed stale finding in the aggregate", async () => {
		const target = file();
		recordDiagnostics(target, [
			{
				severity: "error",
				semantic: "blocking",
				tool: "lsp",
				rule: "example",
				message: "marked evidence",
				line: 1,
			},
		]);
		markWidgetFileBlockersStale(target, "dependency-drift");
		const mark = createLensDiagnosticMarkTool(() => cwd);
		const marked = await mark.execute(
			"mark",
			{
				filePath: target,
				line: 1,
				rule: "example",
				tool: "lsp",
				message: "marked evidence",
				disposition: "false-positive",
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(marked.isError).toBeFalsy();
		const result = await run();
		expect(result.details).toMatchObject({
			validationStatus: "no-matching-findings",
			staleDiagnosticCount: 0,
		});
		expect(result.content[0]?.text).not.toContain("marked evidence");
		expect(result.content[0]?.text).not.toContain("inconclusive");
	});

	it("distinguishes an empty cache and an unseen requested file from final clean evidence", async () => {
		const empty = await run();
		expect(empty.details).toMatchObject({
			validationStatus: "unverified",
			filesChecked: 0,
		});
		expect(compact(empty)).toContain("unverified");
		expect(empty.content[0]?.text).toContain("with the changed paths");
		const clean = file("clean.txt");
		const unseen = file("unseen.txt");
		recordDiagnostics(clean, []);
		const scoped = await run({ paths: [clean, unseen] });
		expect(scoped.details).toMatchObject({
			validationStatus: "unverified",
			unverifiedFileCount: 1,
			nextCheck: { paths: [unseen] },
		});
		expect(scoped.content[0]?.text).not.toContain("✓");
		expect(scoped.content[0]?.text).toContain("Session cache unverified");
		const final = await run({ paths: [clean] });
		expect(final.details).toMatchObject({
			validationStatus: "no-matching-findings",
		});
		expect(compact(final)).toContain("no matching cached findings");
		expect(final.content[0]?.text).toContain("not active validation");
	});

	it("keeps severity-filtered live findings distinct from incomplete evidence", async () => {
		const target = file();
		recordDiagnostics(target, [
			{
				severity: "warning",
				semantic: "advisory",
				tool: "example",
				message: "a live warning",
				line: 1,
			},
		]);
		const filtered = await run({ severity: "error" });
		expect(filtered.details).toMatchObject({
			validationStatus: "no-matching-findings",
			staleDiagnosticCount: 0,
		});
		const all = await run();
		expect(all.details).toMatchObject({
			validationStatus: "findings",
			totalWarnings: 1,
		});
		expect(all.content[0]?.text).toContain("a live warning");
		expect(all.content[0]?.text).toContain("not active validation");
	});

	it("keeps a final hint-only snapshot's compact wording and still flags a pending neighbour", async () => {
		// #2414: hint-only is clean of code defects. The status is `findings`, and
		// the compact line must not turn that into a new word for the same file.
		const hinted = file("hinted.txt");
		recordDiagnostics(hinted, [
			{
				severity: "hint",
				semantic: "silent",
				tool: "example",
				message: "a style hint",
				line: 1,
			},
		]);
		const final = await run({ paths: [hinted] });
		expect(final.details).toMatchObject({ validationStatus: "findings" });
		expect(compact(final)).toContain("clean, 1 hint");
		recordRunner(file("pending.txt"), "example", "succeeded", 0);
		const mixed = await run();
		expect(mixed.details).toMatchObject({ validationStatus: "inconclusive" });
		expect(compact(mixed)).toContain("inconclusive, 1 hint");
	});

	it("bounds the next check to 100 paths and discloses the remaining path", async () => {
		// Both the widget and the probe's explicit-path input are capped at
		// 100. One directory plus an uncached file produces 101 affected
		// paths through a valid two-entry request.
		for (let i = 0; i < 100; i++)
			recordRunner(file(`pending/${i}.txt`), "example", "succeeded", 0);
		const unseen = file("unseen.txt");
		const result = await run({ paths: [path.join(cwd, "pending"), unseen] });
		const details = result.details as {
			nextCheck: { paths: string[] };
			remainingRescanPathCount: number;
		};
		expect(details.nextCheck.paths).toHaveLength(100);
		expect(details.remainingRescanPathCount).toBe(1);
		expect(new Set(details.nextCheck.paths).size).toBe(100);
		expect(result.content[0]?.text).toContain("1 more path");
	});

	it.each(["pi", "mcp"] as const)(
		"uses the %s host's next-check name",
		async (host) => {
			const target = file();
			recordRunner(target, "example", "succeeded", 0);
			const result = await run({}, host);
			const name = host === "pi" ? "lens_diagnostics" : "pilens_diagnostics";
			expect(result.details).toMatchObject({
				nextCheck: {
					tool: name,
					source: "lsp",
					scope: "paths",
					paths: [target],
				},
			});
			expect(result.content[0]?.text).toContain(
				`${name} source=lsp scope=paths`,
			);
		},
	);

	// #4625 F1: the first read that saw a changed file reported it, and the
	// next read, or the footer's observer-less sweep before the first, found
	// nothing that remembered the file. The store keeps the record as unfinished
	// evidence until a final snapshot replaces it.
	describe("a stale disclosure outlives the read that reported it (#4625 F1)", () => {
		// The mtime moves a minute past every observation. Returns that instant,
		// so a re-analysis can be stamped after the change.
		function changeOnDisk(target: string): number {
			const changedAt = Date.now() + 60_000;
			const when = new Date(changedAt);
			fs.utimesSync(target, when, when);
			return changedAt;
		}

		function nextPaths(result: Awaited<ReturnType<typeof run>>): string[] {
			return [
				...((result.details as { nextCheck?: { paths: string[] } }).nextCheck
					?.paths ?? []),
			].sort();
		}

		// A final clean snapshot for a file that then changes, beside an
		// unchanged final clean sibling that would carry the ✓ alone.
		function changedBesideClean(dir = "") {
			const stale = file(path.join(dir, "stale.txt"));
			const clean = file(path.join(dir, "clean.txt"));
			recordDiagnostics(stale, []);
			recordDiagnostics(clean, []);
			return { stale, clean, changedAt: changeOnDisk(stale) };
		}

		it("stays inconclusive on a second read that rescans nothing", async () => {
			const { stale } = changedBesideClean();
			const first = await run();
			const second = await run();
			expect(first.details).toMatchObject({
				validationStatus: "inconclusive",
				staleDropped: 1,
			});
			expect(second.details).toMatchObject({
				validationStatus: "inconclusive",
				staleDropped: 0,
				pendingFileCount: 1,
			});
			for (const read of [first, second]) {
				expect(nextPaths(read)).toEqual([stale]);
				expect(read.content[0]?.text).not.toContain("✓");
				expect(compact(read)).toContain("inconclusive");
			}
		});

		it("stays inconclusive when the footer's observer-less sweep ran first", async () => {
			const { stale } = changedBesideClean();
			// What `scheduleStaleReconcile` runs: the same reconcile, no observer.
			expect(await reconcileStaleWidgetFiles()).toBe(1);
			const read = await run();
			expect(read.details).toMatchObject({
				validationStatus: "inconclusive",
				staleDropped: 0,
				pendingFileCount: 1,
			});
			expect(nextPaths(read)).toEqual([stale]);
			expect(read.content[0]?.text).not.toContain("✓");
		});

		it.each(["file", "directory"] as const)(
			"keeps a %s scope inconclusive after the footer sweep",
			async (kind) => {
				const { stale } = changedBesideClean("src");
				await reconcileStaleWidgetFiles();
				const read = await run({
					paths: [kind === "file" ? stale : path.join(cwd, "src")],
				});
				expect(read.details).toMatchObject({
					validationStatus: "inconclusive",
				});
				expect(nextPaths(read)).toEqual([stale]);
				expect(read.content[0]?.text).not.toContain("✓");
			},
		);

		it("keeps a pruned record's surviving finding and the disclosure across two reads", async () => {
			const target = file();
			const observed = Date.now();
			recordDiagnostics(
				target,
				[
					{
						severity: "warning",
						semantic: "advisory",
						tool: "biome",
						rule: "lint/style",
						message: "live biome finding",
						line: 1,
					},
				],
				undefined,
				observed,
			);
			// An aging cascade snapshot adds a cross-file error observed long before.
			reconcileCascadeNeighborLspErrors(
				target,
				[
					{
						severity: "error",
						tool: "lsp",
						rule: "TS2304",
						message: "stale cross-file error",
						line: 1,
					},
				],
				undefined,
				observed - 200_000,
			);
			// The file changed between the two observations.
			const between = new Date(observed - 100_000);
			fs.utimesSync(target, between, between);
			for (const read of [await run(), await run()]) {
				expect(read.details).toMatchObject({
					validationStatus: "inconclusive",
				});
				expect(nextPaths(read)).toEqual([target]);
				expect(read.content[0]?.text).toContain("live biome finding");
				expect(read.content[0]?.text).not.toContain("stale cross-file error");
				expect(read.content[0]?.text).not.toContain("✓");
			}
		});

		it("stays inconclusive until a fresh final snapshot replaces the evidence", async () => {
			const { stale, changedAt } = changedBesideClean();
			expect((await run()).details).toMatchObject({
				validationStatus: "inconclusive",
			});
			expect((await run()).details).toMatchObject({
				validationStatus: "inconclusive",
			});
			// The pipeline re-analyses the changed file and commits a final snapshot.
			recordDiagnostics(stale, [], undefined, changedAt + 1_000);
			const cleared = await run();
			expect(cleared.details).toMatchObject({
				validationStatus: "no-matching-findings",
				staleDropped: 0,
				pendingFileCount: 0,
			});
			expect(cleared.details).not.toHaveProperty("nextCheck");
			expect(cleared.content[0]?.text).toContain("✓");
		});

		it("names every changed file when two are omitted, on both reads", async () => {
			const first = file("a.txt");
			const second = file("b.txt");
			for (const target of [first, second, file("clean.txt")])
				recordDiagnostics(target, []);
			changeOnDisk(first);
			changeOnDisk(second);
			const initial = await run();
			expect(initial.content[0]?.text).toContain(
				"2 changed files omitted as stale",
			);
			expect(initial.content[0]?.text).toContain("source=lsp scope=paths");
			expect(initial.details).toMatchObject({
				validationStatus: "inconclusive",
				staleDropped: 2,
				pendingFileCount: 2,
			});
			const again = await run();
			expect(again.details).toMatchObject({
				validationStatus: "inconclusive",
				staleDropped: 0,
				pendingFileCount: 2,
			});
			for (const read of [initial, again])
				expect(nextPaths(read)).toEqual([first, second].sort());
		});
	});

	// #4625 F3: a changed file that leaves no record (it was deleted) counts
	// nowhere else, so the line that gives the verdict's reasons must name it.
	it("names a stale drop in the verdict line, once", async () => {
		const target = file();
		recordDiagnostics(target, []);
		fs.unlinkSync(target);
		const text = (await run({ paths: [target] })).content[0]?.text ?? "";
		const verdict =
			text.split("\n").find((line) => line.includes("not a clean verdict")) ??
			"";
		expect(verdict).toContain("1 changed file omitted as stale");
		expect(text.match(/omitted as stale/g)).toHaveLength(1);
	});

	// #4625 F5: the verdict already carries the one targeted next check, so a
	// scoped read must not append the older `mode=full` advice beside it. A clean
	// scoped read has no next check and keeps the cache-only note.
	it("gives a scoped incomplete read one next step", async () => {
		const target = file();
		recordDiagnostics(target, []);
		const changedAt = new Date(Date.now() + 60_000);
		fs.utimesSync(target, changedAt, changedAt);
		const text = (await run({ paths: [target] })).content[0]?.text ?? "";
		expect(text).toContain("source=lsp scope=paths");
		expect(text).not.toContain("mode=full");
	});

	it("keeps the cache-only note on a clean scoped read", async () => {
		const target = file();
		recordDiagnostics(target, []);
		const result = await run({ paths: [target] });
		expect(result.details).toMatchObject({
			validationStatus: "no-matching-findings",
		});
		expect(result.content[0]?.text).toContain(
			"paths restricts this to cached findings",
		);
	});

	it("records the scoped evidence decision in the real latency sink", async () => {
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		recordRunner(file(), "example", "succeeded", 0);
		await run();
		await flushLatencyLog();
		const log = getLatencyLogPath();
		const records = (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(
				(row) =>
					JSON.parse(row) as {
						phase?: string;
						filePath?: string;
						metadata?: unknown;
					},
			);
		expect(
			records.filter(
				(row) =>
					row.phase === "lens_diagnostics_session_evidence" &&
					row.filePath === cwd,
			),
		).toEqual([
			expect.objectContaining({
				metadata: expect.objectContaining({
					validationStatus: "inconclusive",
					pendingFileCount: 1,
					staleDropped: 0,
				}),
			}),
		]);
	});
});
