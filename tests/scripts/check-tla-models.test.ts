import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	TLA_TOOLS,
	buildJavaArgs,
	classifyTlcOutput,
	computeConcurrency,
	listModelConfigs,
	parseConcurrencyArg,
	parseModelHeader,
	parseShardArg,
	resolveJarPath,
	runPool,
	selectConfigs,
	selectShard,
	verdictMatches,
} from "../../scripts/check-tla-models.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

/** A promise plus its own resolve, for driving `runPool` step by step. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Flush a couple of microtask turns so a resolved promise's `.then` chain runs. */
async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
}

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// Trimmed from real TLC 2.19 runs of formal/file-locks.
const TLC_PASS = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Computing initial states...
Model checking completed. No error has been found.
178 states generated, 74 distinct states found, 0 states left on queue.`;
const TLC_VIOLATED = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Error: Invariant MutualExclusion is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>`;
// Trimmed from a real TLC 2.19 run of formal/dispatch-pipeline
// SiblingRestoreQueuedInHold (CHECK_DEADLOCK TRUE).
const TLC_DEADLOCK = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Finished computing initial states: 1 distinct state generated at 2026-10-01 06:52:13.
Error: Deadlock reached.
Error: The behavior up to this point is:
State 1: <Initial predicate>`;
const TLC_PARSE_ERROR = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Error: TLC threw an unexpected exception.
This was probably caused by an error in the spec or model.`;

describe("parseModelHeader (#3447)", () => {
	it("reads a pass expectation and its module", () => {
		expect(
			parseModelHeader("\\* expect: pass\n\\* module: FileLock\nCONSTANTS\n"),
		).toEqual({ module: "FileLock", expect: { status: "pass" } });
	});

	it("reads the invariant a violation expects", () => {
		expect(
			parseModelHeader(
				"\\* expect: violated NoOrphanLock\n\\* module: FileLock\n",
			),
		).toEqual({
			module: "FileLock",
			expect: { status: "violated", invariant: "NoOrphanLock" },
		});
	});

	it.each([
		[
			"no expectation",
			"\\* module: FileLock\n",
			"missing `\\* expect:` header",
		],
		["no module", "\\* expect: pass\n", "missing `\\* module:` header"],
		[
			"a violation with no invariant",
			"\\* expect: violated\n\\* module: FileLock\n",
			'unrecognised expectation "violated"',
		],
		[
			"an unknown verdict",
			"\\* expect: fails\n\\* module: FileLock\n",
			'unrecognised expectation "fails"',
		],
	])("names the header problem: %s", (_label, text, error) => {
		expect(parseModelHeader(text)).toEqual({ error });
	});
});

describe("classifyTlcOutput (#3447)", () => {
	it("reads a completed check as pass", () => {
		expect(classifyTlcOutput(TLC_PASS)).toEqual({ status: "pass" });
	});

	it("reads which invariant was violated", () => {
		expect(classifyTlcOutput(TLC_VIOLATED)).toEqual({
			status: "violated",
			invariant: "MutualExclusion",
		});
	});

	// Recurrence: #3830. A lock-order model checks for deadlock; without this the
	// config's `violated Deadlock` expectation would read as a tool error.
	it("reads a deadlock as a violation named Deadlock", () => {
		expect(classifyTlcOutput(TLC_DEADLOCK)).toEqual({
			status: "violated",
			invariant: "Deadlock",
		});
		expect(
			parseModelHeader(
				"\\* expect: violated Deadlock\n\\* module: SiblingRestore\n",
			),
		).toEqual({
			module: "SiblingRestore",
			expect: { status: "violated", invariant: "Deadlock" },
		});
	});

	it("reports a spec or tool error rather than a verdict", () => {
		expect(classifyTlcOutput(TLC_PARSE_ERROR)).toEqual({
			status: "error",
			detail: "Error: TLC threw an unexpected exception.",
		});
		expect(classifyTlcOutput("")).toEqual({
			status: "error",
			detail: "no verdict",
		});
	});
});

describe("verdictMatches (#3447)", () => {
	const violated = (invariant: string) =>
		({ status: "violated", invariant }) as const;

	it("matches equal verdicts", () => {
		expect(verdictMatches({ status: "pass" }, { status: "pass" })).toBe(true);
		expect(
			verdictMatches(violated("MutualExclusion"), violated("MutualExclusion")),
		).toBe(true);
	});

	it("reds a fix the config does not record yet, and a hidden bug", () => {
		expect(
			verdictMatches(violated("MutualExclusion"), { status: "pass" }),
		).toBe(false);
		expect(
			verdictMatches({ status: "pass" }, violated("MutualExclusion")),
		).toBe(false);
	});

	it("reds a different invariant or a tool error", () => {
		expect(
			verdictMatches(violated("MutualExclusion"), violated("NoOrphanLock")),
		).toBe(false);
		expect(
			verdictMatches({ status: "pass" }, { status: "error", detail: "x" }),
		).toBe(false);
	});
});

describe("resolveJarPath (#3447)", () => {
	it("makes a relative --jar absolute, since TLC runs from each config's directory", () => {
		const resolved = resolveJarPath(".cache/tla2tools.jar", REPO_ROOT);
		expect(path.isAbsolute(resolved)).toBe(true);
		expect(resolved).toBe(path.resolve(".cache/tla2tools.jar"));
	});

	it("defaults to the repo's .cache/ jar", () => {
		expect(resolveJarPath(undefined, REPO_ROOT)).toBe(
			path.join(REPO_ROOT, ".cache", "tla2tools.jar"),
		);
	});
});

describe("computeConcurrency (#3572)", () => {
	it("bounds the pool by the CPU count when there are more configs than cores", () => {
		expect(computeConcurrency(320, 4)).toBe(4);
	});

	it("bounds the pool by the config count when there are fewer configs than cores", () => {
		expect(computeConcurrency(2, 8)).toBe(2);
	});

	it("floors at 1 even if the host reports zero or negative parallelism", () => {
		expect(computeConcurrency(320, 0)).toBe(1);
		expect(computeConcurrency(320, -1)).toBe(1);
	});
});

describe("parseConcurrencyArg (#3572)", () => {
	it("accepts a positive integer", () => {
		expect(parseConcurrencyArg("4")).toBe(4);
		expect(parseConcurrencyArg("1")).toBe(1);
	});

	it("throws on a missing value, so a bad flag fails loudly instead of silently becoming 1 lane", () => {
		expect(() => parseConcurrencyArg(undefined)).toThrow(
			/--concurrency must be an integer/,
		);
	});

	it("throws on a non-numeric value", () => {
		expect(() => parseConcurrencyArg("many")).toThrow(
			/--concurrency must be an integer/,
		);
	});

	it("throws on zero, a negative number, or a non-integer", () => {
		expect(() => parseConcurrencyArg("0")).toThrow();
		expect(() => parseConcurrencyArg("-1")).toThrow();
		expect(() => parseConcurrencyArg("2.5")).toThrow();
	});
});

describe("parseShardArg (#3918)", () => {
	it("reads i/N", () => {
		expect(parseShardArg("2/4")).toEqual({ index: 2, total: 4 });
	});

	// Recurrence: a typo'd `--shard` that fell back to "all configs" would not
	// fail CI, the shard would just stop being a shard and rerun everything.
	it.each(["", "0/4", "5/4", "1/0", "2", "a/b", "1/2/3", "-1/4", "1.5/4"])(
		"throws on %j",
		(raw) => {
			expect(() => parseShardArg(raw)).toThrow(/--shard must be i\/N/);
		},
	);

	it("throws when the value is missing", () => {
		expect(() => parseShardArg(undefined)).toThrow(/--shard must be i\/N/);
	});
});

describe("selectShard (#3918)", () => {
	const items = ["a", "b", "c", "d", "e", "f", "g"];

	it("steps through the list round-robin, so a directory's configs spread across shards", () => {
		expect(selectShard(items, { index: 1, total: 3 })).toEqual(["a", "d", "g"]);
		expect(selectShard(items, { index: 2, total: 3 })).toEqual(["b", "e"]);
		expect(selectShard(items, { index: 3, total: 3 })).toEqual(["c", "f"]);
	});
});

describe("selectConfigs (#3918)", () => {
	it("returns every config without --shard", () => {
		expect(selectConfigs([], REPO_ROOT)).toEqual(listModelConfigs(REPO_ROOT));
	});

	it("narrows to the shard's configs with --shard", () => {
		const all = listModelConfigs(REPO_ROOT);
		expect(selectConfigs(["--shard", "1/2"], REPO_ROOT)).toEqual(
			all.filter((_, position) => position % 2 === 0),
		);
	});

	// Recurrence: more shards than configs would leave a runner green on
	// nothing; it must fail loudly.
	it("throws when the shard selects nothing", () => {
		const total = listModelConfigs(REPO_ROOT).length + 1;
		expect(() =>
			selectConfigs(["--shard", `${total}/${total}`], REPO_ROOT),
		).toThrow(/selects no formal/);
	});
});

describe("buildJavaArgs (#3572, #3517)", () => {
	it("always emits a literal `-workers 1`, never `auto` and never a caller-supplied count", () => {
		// #3517: TLC's own thread interleaving under `-workers auto` decides
		// which invariant a multi-violation config reports first. Every config
		// is pinned to one worker so the seam has no way to vary this — there
		// is no parameter left for a caller (main() included) to widen it.
		const args = buildJavaArgs("/jar", "/meta", "X.cfg", "Mod");
		const workersIndex = args.indexOf("-workers");
		expect(workersIndex).toBeGreaterThan(-1);
		expect(args[workersIndex + 1]).toBe("1");
	});

	it("runs the config by its basename, from the module's own directory", () => {
		const args = buildJavaArgs("/jar", "/meta", "X.cfg", "Mod");
		expect(args).toEqual([
			"-Djava.io.tmpdir=/meta",
			"-XX:+UseParallelGC",
			"-cp",
			"/jar",
			"tlc2.TLC",
			"-workers",
			"1",
			"-metadir",
			"/meta",
			"-config",
			"X.cfg",
			"Mod",
		]);
	});

	it("pins the JVM temp dir to the run's own metadir, not the shared OS temp dir", () => {
		// SANY extracts the TLA+ standard modules to java.io.tmpdir under a
		// fixed filename, so two concurrent TLC processes sharing the OS temp
		// dir can race there (#3572: reproduced running the pool over all of
		// formal/, one `AbortException` in 320 configs). Each run must get its
		// own tmpdir instead of the JVM default.
		const args = buildJavaArgs("/jar", "/meta-a", "X.cfg", "Mod");
		expect(args[0]).toBe("-Djava.io.tmpdir=/meta-a");
		const other = buildJavaArgs("/jar", "/meta-b", "X.cfg", "Mod");
		expect(other[0]).toBe("-Djava.io.tmpdir=/meta-b");
	});
});

describe("runPool (#3572)", () => {
	it("never runs more tasks at once than the given concurrency", async () => {
		const items = [0, 1, 2, 3, 4];
		const controls = items.map(() => deferred<string>());
		const started: number[] = [];
		const task = vi.fn((item: number) => {
			started.push(item);
			return controls[item].promise;
		});

		const resultPromise = runPool(items, 2, task);

		// Two lanes claim their first item synchronously; the rest wait.
		expect(started).toEqual([0, 1]);

		controls[0].resolve("r0");
		await flushMicrotasks();
		expect(started).toEqual([0, 1, 2]);

		controls[1].resolve("r1");
		await flushMicrotasks();
		expect(started).toEqual([0, 1, 2, 3]);

		controls[2].resolve("r2");
		controls[3].resolve("r3");
		await flushMicrotasks();
		expect(started).toEqual([0, 1, 2, 3, 4]);

		controls[4].resolve("r4");
		expect(await resultPromise).toEqual(["r0", "r1", "r2", "r3", "r4"]);
	});

	it("returns results in input order even when later items finish first", async () => {
		const items = [0, 1, 2];
		const controls = items.map(() => deferred<string>());
		const task = (item: number) => controls[item].promise;

		const resultPromise = runPool(items, 3, task);
		// Complete item 2 first, then 0, then 1.
		controls[2].resolve("r2");
		controls[0].resolve("r0");
		controls[1].resolve("r1");

		expect(await resultPromise).toEqual(["r0", "r1", "r2"]);
	});

	it("does not silently drop every task when concurrency is zero", async () => {
		const task = vi.fn(async (item: number) => `r${item}`);
		const results = await runPool([0, 1, 2], 0, task);
		expect(task).toHaveBeenCalledTimes(3);
		expect(results).toEqual(["r0", "r1", "r2"]);
	});

	it("does not hang when concurrency exceeds the item count", async () => {
		const task = vi.fn(async (item: number) => `r${item}`);
		const results = await runPool([0, 1], 10, task);
		expect(results).toEqual(["r0", "r1"]);
	});
});

describe("formal/ models (#3447)", () => {
	const configs = listModelConfigs(REPO_ROOT);

	it("every config names its expectation and an existing module", () => {
		assertNonEmptyScan("TLA+ model configs", configs.length, 74);
		const problems = configs.flatMap((config) => {
			const header = parseModelHeader(fs.readFileSync(config, "utf8"));
			const name = path.relative(REPO_ROOT, config);
			if ("error" in header) return [`${name}: ${header.error}`];
			const spec = path.join(path.dirname(config), `${header.module}.tla`);
			return fs.existsSync(spec) ? [] : [`${name}: no ${header.module}.tla`];
		});
		expect(problems).toEqual([]);
	});

	it("CI runs the checker against the pinned tools release", () => {
		const workflow = yaml.load(
			fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
		) as { jobs: Record<string, { steps?: Array<{ run?: string }> }> };
		const runs = Object.values(workflow.jobs).flatMap((job) =>
			(job.steps ?? []).map((step) => step.run ?? ""),
		);
		expect(
			runs.some((run) =>
				/^\s*node scripts\/check-tla-models\.mjs(?: --shard .+)?\s*$/m.test(
					run,
				),
			),
		).toBe(true);
		expect(TLA_TOOLS.url).toContain(`/download/${TLA_TOOLS.release}/`);
	});
});
