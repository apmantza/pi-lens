/**
 * #4905: the opaque prescan must not walk a non-git root that is the home
 * folder (or above it), and must not walk a non-git root it already found over
 * its file cap again on every tool call.
 *
 * Recurrence prevented: in a non-git home folder every opaque tool call
 * (every `bash` call, and from #4732 every non-built-in tool call) awaited a
 * stat walk that always stopped at `OPAQUE_SCAN_MAX_FILES + 1`, recorded
 * `file-cap-exceeded` and gave no baseline. The reporter's `latency.log`: 681
 * rows, median 2.1 s, maximum 26 s, total 1871 s. `captureFileStats`'s
 * `budgetMs` is the walk's per-chunk yield cadence, not a wall bound
 * (`walkTreeStackAsync` resets its deadline after every directory read), so a
 * non-home root over the cap paid the same per-call cost.
 *
 * The same session root also reached `lookForOutOfBandChanges`, the declaration
 * file walk `resyncHeadMove` runs at every tool_call and bash tool_result
 * (`clients/out-of-band-changes.ts`): it walked up to 4096 directories of the
 * home folder per bash result, 255-315 ms on a 6000-directory fixture home.
 *
 * Real here: `handleToolCall` and `handleToolResult`, the runtime coordinator,
 * the baseline store, the degradation ledger, the latency log, real trees on
 * disk and the real `HOME` pin (`pinFixtureHome`, the value `os.homedir()`
 * reads). "The walk did not run" is counted, not timed: every source walk
 * writes one `source_walk_skip_summary` latency row per run (the fixtures plant
 * a skippable file), and the tests count those rows.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { subscribeDiskChange } from "../../clients/disk-changes.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	OPAQUE_SCAN_MAX_FILES,
	captureFileStats,
	isGitWorktree,
	resetOpaqueMutationState,
} from "../../clients/opaque-mutation-scan.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import { pinFixtureHome, removeTempDirSync } from "./test-utils.js";

/** Files written under a tree: enough to pass the cap, spread over 50 dirs. */
const OVER_CAP = OPAQUE_SCAN_MAX_FILES + 100;

function fillTree(root: string, count: number): void {
	// A root-level generated file: the source walk visits a root's own files
	// before it descends, so every walk of this tree, capped or not, counts one
	// skip and writes the `source_walk_skip_summary` row `walksOf` reads.
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "bundle.min.js"), "var a=1;\n");
	for (let i = 0; i < count; i++) {
		const dir = path.join(root, `dir${i % 50}`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `f${i}.ts`),
			`export const v${i} = ${i};\n`,
		);
	}
}

/** A directory link that needs no privilege on Windows (a junction). */
function linkDir(target: string, link: string): string {
	fs.mkdirSync(path.dirname(link), { recursive: true });
	fs.symlinkSync(target, link, "junction");
	return link;
}

describe("the opaque prescan at the home root (#4905)", () => {
	let scratch = "";
	let home = "";

	beforeEach(() => {
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opaque-4905-"));
		vi.stubEnv("PILENS_DATA_DIR", path.join(scratch, "data"));
		// The phase rows this file reads are real only outside test mode.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		home = pinFixtureHome("opaque-4905").home;
		// The fixture home sits inside this checkout's scratch tree, so git would
		// discover the checkout above it and the home would read as a worktree.
		// The ceiling stops git's search above the home's parent, the directory
		// the "above the home" case uses as its root: both are non-git folders,
		// as in the report.
		vi.stubEnv("GIT_CEILING_DIRECTORIES", path.dirname(path.dirname(home)));
		// The same scratch tree sits under this checkout's `.gitignore`
		// (`.probe-home/`), which the source walk would read as the project's own
		// and skip every file. An empty `.git` directory is not a repository to
		// git (the ceiling holds) but ends the walk's ignore-root search here, as
		// a real home with no checkout above it does.
		for (const dir of [home, path.dirname(home)])
			fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
		resetOpaqueMutationState();
		resetDegradationLedger();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		resetOpaqueMutationState();
		resetDegradationLedger();
		removeTempDirSync(scratch);
	});

	function runtimeFor(root: string, sessionId: string): RuntimeCoordinator {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = root;
		runtime.setTelemetryIdentity({ sessionId });
		return runtime;
	}

	async function call(
		runtime: RuntimeCoordinator,
		root: string,
		toolName: string,
		n: number,
	): Promise<void> {
		const event = {
			toolName,
			toolCallId: `4905-${toolName}-${n}`,
			input: toolName === "bash" ? { command: "node -e ''" } : { query: "x" },
		};
		await runHandlerExpectingNoThrow(() =>
			handleToolCall({
				event,
				ctx: { cwd: root },
				lensEnabled: true,
				getFlag: (flag: string) => flag === "no-lsp",
				dbg: () => {},
				runtime,
				cacheManager: new CacheManager(false),
				ensureLSPConfigInitialized: async () => {},
				updateLspStatus: () => {},
				resetLSPService: () => {},
			} as unknown as Parameters<typeof handleToolCall>[0]),
		);
		await handleToolResult({
			event: { content: [{ type: "text", text: "ok" }], ...event },
			getFlag: (flag: string) => flag === "no-lsp",
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			testRunnerClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as unknown as Parameters<typeof handleToolResult>[0]);
	}

	/** Every latency row of one phase since `offset`, in order. */
	async function rows(
		offset: number,
		phase: string,
	): Promise<Array<{ result?: string; durationMs?: number }>> {
		await flushLatencyLog();
		const logPath = getLatencyLogPath();
		const text = fs.existsSync(logPath)
			? fs.readFileSync(logPath, "utf8").slice(offset)
			: "";
		const tail = path.join(scratch, "latency-tail.ndjson");
		fs.writeFileSync(tail, text);
		const read = readNdjsonRows<{
			phase?: string;
			result?: string;
			durationMs?: number;
		}>(tail);
		expect(read.skipped).toBe(0);
		return read.rows.filter((row) => row.phase === phase);
	}

	async function latencyOffset(): Promise<number> {
		await flushLatencyLog();
		const logPath = getLatencyLogPath();
		return fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
	}

	/** Source walks of `root` since `offset`: one summary row per walk. */
	async function walksOf(offset: number, root: string): Promise<number> {
		await flushLatencyLog();
		const logPath = getLatencyLogPath();
		const text = fs.existsSync(logPath)
			? fs.readFileSync(logPath, "utf8").slice(offset)
			: "";
		const tail = path.join(scratch, "walks-tail.ndjson");
		fs.writeFileSync(tail, text);
		const read = readNdjsonRows<{ phase?: string; filePath?: string }>(tail);
		expect(read.skipped).toBe(0);
		return read.rows.filter(
			(row) =>
				row.phase === "source_walk_skip_summary" &&
				row.filePath !== undefined &&
				path.resolve(row.filePath) === path.resolve(root),
		).length;
	}

	let readdirSpy: ReturnType<typeof vi.spyOn> | undefined;
	afterEach(() => {
		readdirSpy?.mockRestore();
		readdirSpy = undefined;
	});

	/**
	 * Count the listings of a fixture directory (`dirN` by default, see
	 * `fillTree`; or any directory whose name starts with `namePrefix`) under
	 * `root` from here on, through a pass-through spy on the filesystem
	 * boundary. The opaque walk is refused or memoized in the cases that use it,
	 * so a listing here is the declaration walk's.
	 */
	function countFixtureListings(
		root: string,
		namePrefix = "dir",
	): () => number {
		const real = fs.promises.readdir.bind(fs.promises);
		const spy = vi
			.spyOn(fs.promises, "readdir")
			.mockImplementation(((...args: Parameters<typeof real>) =>
				real(...args)) as never);
		readdirSpy = spy;
		return () =>
			spy.mock.calls.filter(([dir]) => {
				const listed = String(dir);
				return (
					path.basename(listed).startsWith(namePrefix) &&
					listed.startsWith(root + path.sep)
				);
			}).length;
	}

	const declarationLookRecords = () =>
		getDegradationSummary()
			.filter((group) => group.kind === "lsp-declaration-look-capped")
			.map((group) => ({
				count: group.count,
				subjects: group.latestReasons.map((entry) => entry.subject),
			}));

	const refusedRecords = () =>
		getDegradationSummary()
			.filter((group) => group.kind === "opaque-capture-refused")
			.map((group) => ({
				count: group.count,
				subjects: group.latestReasons.map((entry) => entry.subject),
			}));

	async function refusesAtHome(toolName: string): Promise<void> {
		// RECURRENCE GUARDED: #4905. The home folder always passes the file cap, so
		// every call waited for a walk that produced no baseline.
		fillTree(home, OVER_CAP);
		// Arm: the fixture really is a non-git folder (else the git branch ran).
		expect(await isGitWorktree(home)).toBe(false);
		resetOpaqueMutationState();
		const runtime = runtimeFor(home, `4905-home-${toolName}`);
		const offset = await latencyOffset();

		for (const n of [1, 2, 3]) await call(runtime, home, toolName, n);

		expect(
			(await rows(offset, "opaque_mutation_prescan")).map((row) => row.result),
		).toEqual(["home-root", "home-root", "home-root"]);
		// The walk never ran: no directory of the home was listed.
		expect(await walksOf(offset, home)).toBe(0);
		// The verdict downstream is UNKNOWN, never "no change": bash names it in
		// its coverage row, any other tool in the refusal record.
		if (toolName === "bash")
			expect(
				(await rows(offset, "opaque_mutation_coverage_unknown")).map(
					(row) => row.result,
				),
			).toEqual(["home-root", "home-root", "home-root"]);
		// One record across three calls, under the `home-root` subject.
		expect(refusedRecords()).toEqual([{ count: 1, subjects: ["home-root"] }]);
	}

	it(
		"refuses bash's walk at a non-git home root, reads it as unknown, and records once",
		{
			timeout: 60_000,
		},
		async () => {
			await refusesAtHome("bash");
		},
	);

	it(
		"refuses some_ext_tool's walk at a non-git home root, reads it as unknown, and records once",
		{
			timeout: 60_000,
		},
		async () => {
			await refusesAtHome("some_ext_tool");
		},
	);

	it("refuses a non-git root that is above the home folder", async () => {
		// RECURRENCE GUARDED: #4905. `isAtOrAboveHomeDir` is the ancestor test too:
		// a session started in `/Users` or `/` reaches the home through its walk.
		const above = path.dirname(home);
		fillTree(home, OVER_CAP);
		const runtime = runtimeFor(above, "4905-above");
		const offset = await latencyOffset();
		await call(runtime, above, "some_ext_tool", 1);
		expect(
			(await rows(offset, "opaque_mutation_prescan")).map((row) => row.result),
		).toEqual(["home-root"]);
		expect(await walksOf(offset, above)).toBe(0);
	});

	it("still takes a baseline in a small non-git folder under the home", async () => {
		// RECURRENCE GUARDED: #4905 (shape 54, both directions). The refusal is the
		// home root and its ancestors only: a project folder under the home keeps
		// its stat-diff baseline, and the refusal is not recorded for it.
		const project = path.join(home, "project");
		fillTree(project, 3);
		const runtime = runtimeFor(project, "4905-project");
		const offset = await latencyOffset();
		await call(runtime, project, "some_ext_tool", 1);
		// Two walks: the baseline, and the recovery's diff after the call.
		expect(await walksOf(offset, project)).toBe(2);
		expect(
			(await rows(offset, "opaque_mutation_prescan")).map((row) => row.result),
		).toEqual(["scanned:3"]);
		expect(refusedRecords()).toEqual([]);
	});

	it("walks a non-home root over the cap once per session, not once per call", async () => {
		// RECURRENCE GUARDED: #4905. `budgetMs` paces the walk's yields; it does
		// not bound its wall time, so a non-git project over the cap paid its
		// whole walk on every opaque call and never got a baseline from it.
		const project = path.join(scratch, "big-project");
		fillTree(project, OVER_CAP);
		const runtime = runtimeFor(project, "4905-big");
		const offset = await latencyOffset();

		await call(runtime, project, "some_ext_tool", 1);
		expect(await walksOf(offset, project)).toBe(1);
		await call(runtime, project, "some_ext_tool", 2);
		await call(runtime, project, "some_ext_tool", 3);
		// Calls two and three walked nothing.
		expect(await walksOf(offset, project)).toBe(1);
		// The answer stays the one the walk gave: over the cap, unknown.
		expect(
			(await rows(offset, "opaque_mutation_prescan")).map((row) => row.result),
		).toEqual(["file-cap-exceeded", "file-cap-exceeded", "file-cap-exceeded"]);
		expect(refusedRecords()).toEqual([
			{ count: 1, subjects: ["file-cap-exceeded"] },
		]);

		// A new session re-asks: the tree may have shrunk, and the memo is not a
		// process latch (shape 17).
		resetOpaqueMutationState();
		await call(runtime, project, "some_ext_tool", 4);
		expect(await walksOf(offset, project)).toBe(2);
	});
	it(
		"does not walk the home folder's declaration files at a bash result, and says so once",
		{
			timeout: 60_000,
		},
		async () => {
			// RECURRENCE GUARDED: #4905 (same class, second scanner). The head-move
			// look at every tool_call and bash tool_result walked the home folder for
			// declaration files, up to 4096 directories each time, with no home ceiling.
			fillTree(home, OVER_CAP);
			expect(await isGitWorktree(home)).toBe(false);
			resetOpaqueMutationState();
			const listings = countFixtureListings(home);
			const runtime = runtimeFor(home, "4905-oob-home");
			for (const n of [1, 2, 3]) await call(runtime, home, "bash", n);
			expect(listings()).toBe(0);
			// The walk is skipped, not clean: one record says declaration files changed
			// under this root are not looked for, whatever the call count.
			expect(declarationLookRecords()).toEqual([
				{ count: 1, subjects: ["home-root"] },
			]);
		},
	);

	it("still publishes an install change at the home root, without walking it", async () => {
		// RECURRENCE GUARDED: #4905 review (CodeRabbit, out-of-band-changes.ts). The
		// first home refusal returned before the install stamp was read, so a
		// lockfile written under a home-rooted session (or a client rooted at ~)
		// published nothing and restarted nobody, which the code before the PR did.
		// The refusal skips the declaration walk only. Two calls: the first look
		// records the stamp, the lockfile lands, the second look publishes it.
		fillTree(home, 3);
		const listings = countFixtureListings(home);
		const published: Array<{ root: string; paths: unknown }> = [];
		const off = subscribeDiskChange(
			"4905-home-install",
			(change) => {
				published.push({ root: change.root, paths: change.paths });
			},
			["out-of-band"],
		);
		try {
			const runtime = runtimeFor(home, "4905-oob-install");
			await call(runtime, home, "bash", 1);
			expect(published).toEqual([]);
			fs.writeFileSync(path.join(home, "package-lock.json"), "{}\n");
			await call(runtime, home, "bash", 2);
		} finally {
			off();
		}
		// An install cannot be enumerated: the change carries `"unknown"` paths.
		expect(published.map((change) => change.paths)).toEqual(["unknown"]);
		// The declaration walk still never ran, and the refusal is said once.
		expect(listings()).toBe(0);
		expect(declarationLookRecords()).toEqual([
			{ count: 1, subjects: ["home-root"] },
		]);
	});

	it("does not walk declaration files in a folder above the home", async () => {
		// RECURRENCE GUARDED: #4905. `isAtOrAboveHomeDir` is the ancestor test
		// too: a session started in `/Users` reaches the home through the walk.
		const above = path.dirname(home);
		fillTree(home, OVER_CAP);
		const listings = countFixtureListings(above);
		const runtime = runtimeFor(above, "4905-oob-above");
		await call(runtime, above, "bash", 1);
		expect(listings()).toBe(0);
		expect(declarationLookRecords()).toEqual([
			{ count: 1, subjects: ["home-root"] },
		]);
	});

	it("still walks declaration files in a project folder under the home", async () => {
		// RECURRENCE GUARDED: #4905 (shape 54, both directions). The ceiling is the
		// home and its ancestors: a project under the home keeps its look, and no
		// refusal is recorded for it. The counted directory is gitignored, so the
		// opaque walk (which honours the ignore rules) never lists it and only the
		// declaration walk (which walks ignored directories, codegen writes there)
		// does: a declaration look that stopped running reads 0 here.
		fs.writeFileSync(path.join(home, ".gitignore"), "codegen/\n");
		const project = path.join(home, "project");
		fillTree(project, 3);
		fs.mkdirSync(path.join(project, "codegen"), { recursive: true });
		fs.writeFileSync(
			path.join(project, "codegen", "types.d.ts"),
			"export type T = 1;\n",
		);
		const listings = countFixtureListings(project, "codegen");
		const runtime = runtimeFor(project, "4905-oob-project");
		await call(runtime, project, "bash", 1);
		expect(listings()).toBeGreaterThan(0);
		expect(declarationLookRecords()).toEqual([]);
	});

	describe("a home or a root spelled through a link (#4905 review)", () => {
		// RECURRENCE GUARDED: #4905 review F1. `isAtOrAboveHomeDir` compares path
		// spellings, so HOME=/link with root=/real, or HOME=/real with root=/link,
		// read as a project under the home and the home tree was walked.
		const spellings = [
			["HOME is a link to the root", "home-link"],
			["the root is a link to HOME", "root-link"],
		] as const;

		/** The root the session uses and the HOME it runs under, per spelling. */
		function spelled(kind: (typeof spellings)[number][1]): string {
			const link = linkDir(home, path.join(scratch, "links", kind));
			if (kind === "root-link") return link;
			vi.stubEnv("HOME", link);
			vi.stubEnv("USERPROFILE", link);
			return home;
		}

		async function refusesOpaqueWalk(
			kind: (typeof spellings)[number][1],
		): Promise<void> {
			fillTree(home, OVER_CAP);
			const root = spelled(kind);
			const runtime = runtimeFor(root, `4905-link-opaque-${kind}`);
			const offset = await latencyOffset();
			await call(runtime, root, "some_ext_tool", 1);
			expect(
				(await rows(offset, "opaque_mutation_prescan")).map(
					(row) => row.result,
				),
			).toEqual(["home-root"]);
			expect(await walksOf(offset, root)).toBe(0);
		}

		async function refusesDeclarationLook(
			kind: (typeof spellings)[number][1],
		): Promise<void> {
			fillTree(home, 3);
			const root = spelled(kind);
			const listings = countFixtureListings(root);
			const runtime = runtimeFor(root, `4905-link-oob-${kind}`);
			await call(runtime, root, "bash", 1);
			expect(listings()).toBe(0);
			expect(declarationLookRecords()).toEqual([
				{ count: 1, subjects: ["home-root"] },
			]);
		}

		it(
			"refuses the opaque walk when HOME is a link to the root",
			{
				timeout: 60_000,
			},
			async () => {
				await refusesOpaqueWalk("home-link");
			},
		);

		it(
			"refuses the opaque walk when the root is a link to HOME",
			{
				timeout: 60_000,
			},
			async () => {
				await refusesOpaqueWalk("root-link");
			},
		);

		it(
			"refuses the declaration look when HOME is a link to the root",
			{
				timeout: 60_000,
			},
			async () => {
				await refusesDeclarationLook("home-link");
			},
		);

		it(
			"refuses the declaration look when the root is a link to HOME",
			{
				timeout: 60_000,
			},
			async () => {
				await refusesDeclarationLook("root-link");
			},
		);
	});

	it("keys the over-cap memo by the folder, not by how the root is spelled", async () => {
		// RECURRENCE GUARDED: #4905 review M7. A memo keyed by the raw root string
		// let a second spelling of the same folder (a link, then the real path) walk
		// again. Mutating the key to the raw spelling survived every earlier case.
		const project = path.join(scratch, "big-project");
		fillTree(project, OVER_CAP);
		const link = linkDir(project, path.join(scratch, "links", "big-link"));
		const runtime = runtimeFor(project, "4905-memo-key");
		const offset = await latencyOffset();
		await call(runtime, link, "some_ext_tool", 1);
		await call(runtime, project, "some_ext_tool", 2);
		expect(
			(await walksOf(offset, link)) + (await walksOf(offset, project)),
		).toBe(1);
	});

	it("does not memoize a root over the entry budget: it answers entry-budget-exceeded and walks every call", async () => {
		// RECURRENCE GUARDED: #4905 review F2. The memo records only
		// `file-cap-exceeded`; mutating that predicate to `true` survived, and
		// would have turned an entry-budget root's verdict into a file-cap one
		// after its first walk. `maxScanEntries` is the seam standing in for 200,000
		// directory entries: 3 root entries, then 100 data files in one folder,
		// well under the 2000-file cap.
		const root = path.join(scratch, "entry-budget");
		fs.mkdirSync(path.join(root, "sub"), { recursive: true });
		fs.writeFileSync(path.join(root, "bundle.min.js"), "var a=1;\n");
		for (let i = 0; i < 100; i++)
			fs.writeFileSync(path.join(root, "sub", `r${i}.dat`), "x");
		const offset = await latencyOffset();
		const first = await captureFileStats(root, { maxScanEntries: 20 });
		const second = await captureFileStats(root, { maxScanEntries: 20 });
		expect([first.unknownReason, second.unknownReason]).toEqual([
			"entry-budget-exceeded",
			"entry-budget-exceeded",
		]);
		expect(await walksOf(offset, root)).toBe(2);
	});
});
