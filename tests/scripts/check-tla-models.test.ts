import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	TLA_TOOLS,
	buildJavaArgs,
	classifyTlcOutput,
	computeConcurrency,
	formatSummary,
	listModelConfigs,
	parseCliArgs,
	parseConcurrencyArg,
	parseModelHeader,
	parseShardArg,
	resolveConcurrency,
	resolveJarPath,
	runPool,
	selectConfigs,
	selectShard,
	verdictMatches,
} from "../../scripts/check-tla-models.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

// The two doubles below stand in for the only two things `main` cannot run in
// a unit test: the external `java` process and the external jar's pinned
// checksum (#3927). Everything else — the CLI parser, the real `formal/`
// corpus, the real filesystem, and the run's own summary — is the production
// code path. `cryptoState` is the seam the caller-wiring case sets to the
// pinned digest; the default empty string leaves every other `createHash`
// caller untouched.
const cryptoState = vi.hoisted(() => ({ digest: "" }));

vi.mock("node:child_process", async () => {
	const { makeFakeChild } = await import("../support/fake-child.js");
	return {
		spawn: () => {
			const child = makeFakeChild();
			queueMicrotask(() => {
				child.stdout.emit(
					"data",
					"Model checking completed. No error has been found.\n",
				);
				child.emit("close", 0);
			});
			return child;
		},
	};
});

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		createHash: () => ({
			update: () => ({ digest: () => cryptoState.digest }),
		}),
	};
});

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

describe("resolveConcurrency (#3927)", () => {
	it("sizes the pool from the host and config count when --concurrency is absent", () => {
		expect(resolveConcurrency(undefined, 2, 8)).toBe(2);
		expect(resolveConcurrency(undefined, 320, 4)).toBe(4);
	});

	it("honors an explicit --concurrency over the host's parallelism", () => {
		expect(resolveConcurrency("3", 2, 8)).toBe(3);
		expect(resolveConcurrency("1", 320, 4)).toBe(1);
	});

	// Recurrence: `main` used to fold the absent branch into `runPool`'s own
	// `|| 1`, so a typo'd `--concurrency` silently became serial execution. The
	// explicit branch must still validate, never fall back to the host default.
	it("rejects an invalid explicit --concurrency instead of sizing from the host", () => {
		expect(() => resolveConcurrency("0", 2, 8)).toThrow(
			/--concurrency must be an integer/,
		);
		expect(() => resolveConcurrency("many", 2, 8)).toThrow(
			/--concurrency must be an integer/,
		);
	});
});

describe("formatSummary (#3927)", () => {
	it("omits the shard suffix for a whole-population run", () => {
		expect(formatSummary(522, undefined, 12.3, 4)).toBe(
			"522 configs, 12.3s wall (concurrency=4, 1 TLC worker/config).",
		);
	});

	it("names the shard when one was selected", () => {
		expect(formatSummary(131, "1/4", 5, 2)).toBe(
			"131 configs (shard 1/4), 5.0s wall (concurrency=2, 1 TLC worker/config).",
		);
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

describe("parseCliArgs (#3920)", () => {
	it("accepts the space form and the equals form identically for every flag", () => {
		expect(parseCliArgs(["--shard", "1/4"])).toEqual({ shard: "1/4" });
		expect(parseCliArgs(["--shard=1/4"])).toEqual({ shard: "1/4" });
		expect(parseCliArgs(["--jar", "/tmp/tla2tools.jar"])).toEqual({
			jar: "/tmp/tla2tools.jar",
		});
		expect(parseCliArgs(["--jar=/tmp/tla2tools.jar"])).toEqual({
			jar: "/tmp/tla2tools.jar",
		});
		expect(parseCliArgs(["--concurrency", "2"])).toEqual({ concurrency: "2" });
		expect(parseCliArgs(["--concurrency=2"])).toEqual({ concurrency: "2" });
	});

	it("returns no options for an empty argv", () => {
		expect(parseCliArgs([])).toEqual({});
	});

	// Recurrence: the pre-#3920 parser used `argv.indexOf("--shard")`, so a
	// repeated flag took the FIRST value. `node:util` `parseArgs` takes the
	// LAST. Pin last-wins so a future hand-rolled dedupe is a deliberate
	// behaviour change, not a silent one (#3927, S2).
	it("takes the last value when a flag repeats", () => {
		expect(parseCliArgs(["--shard", "1/4", "--shard", "3/4"])).toEqual({
			shard: "3/4",
		});
		expect(parseCliArgs(["--concurrency=2", "--concurrency=5"])).toEqual({
			concurrency: "5",
		});
	});

	// Recurrence: `indexOf` ignored a misspelled flag, so the run fell back to
	// the whole population instead of failing. Unknown flags must throw here.
	it.each(["--shrad", "--Shard", "--jar-file", "-s", "shards"])(
		"rejects the unknown flag %j",
		(flag) => {
			expect(() => parseCliArgs([flag, "1/4"])).toThrow(
				/Unknown option|positional/,
			);
		},
	);

	it.each(["--shard", "--jar", "--concurrency"])(
		"rejects the missing value for %s",
		(flag) => {
			expect(() => parseCliArgs([flag])).toThrow(/argument missing/);
		},
	);

	it("rejects a bare positional value instead of ignoring it", () => {
		expect(() => parseCliArgs(["1/4"])).toThrow(/positional|Unexpected/);
	});
});

describe("selectConfigs (#3918)", () => {
	it("returns every config without --shard", () => {
		expect(selectConfigs([], REPO_ROOT)).toEqual(listModelConfigs(REPO_ROOT));
	});

	// Recurrence: the empty-selection error used to name the shard even when
	// none was given, so an empty formal/ tree read as a shard problem. Name
	// the tree instead; a missing root yields no configs without touching disk.
	it("names the empty formal tree, not a shard, when no --shard was given", () => {
		expect(() =>
			selectConfigs([], path.join(REPO_ROOT, "no-such-formal-root")),
		).toThrow(/no formal\/\*\/\*\.cfg found/);
	});

	it("narrows to the shard's configs with --shard", () => {
		const all = listModelConfigs(REPO_ROOT);
		expect(selectConfigs(["--shard", "1/2"], REPO_ROOT)).toEqual(
			all.filter((_, position) => position % 2 === 0),
		);
	});

	// Recurrence: `indexOf("--shard")` missed both the equals form and a
	// misspelled flag, so the run silently selected the whole population.
	it("narrows to the shard with the --shard= equals form", () => {
		const all = listModelConfigs(REPO_ROOT);
		expect(selectConfigs(["--shard=1/2"], REPO_ROOT)).toEqual(
			all.filter((_, position) => position % 2 === 0),
		);
	});

	it.each([
		["a misspelled flag", ["--shrad", "1/2"]],
		["a `--shard` with no value", ["--shard"]],
		["a value-less `--concurrency`", ["--concurrency"]],
		["a bare positional value", ["1/2"]],
	])("does not silently select every config on %s", (_label, argv) => {
		expect(() => selectConfigs(argv, REPO_ROOT)).toThrow();
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

describe("entry guard order (#3920)", () => {
	it("reports an unknown flag, not the JAR lookup, through the real entry module", async () => {
		const scriptPath = path.join(REPO_ROOT, "scripts", "check-tla-models.mjs");
		const missingJar = path.join(REPO_ROOT, "does-not-exist-tla2tools.jar");
		const savedArgv = process.argv;
		const savedExitCode = process.exitCode;
		const messages: string[] = [];
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation((...args) => {
				messages.push(args.map(String).join(" "));
			});
		process.argv = [
			process.execPath,
			scriptPath,
			"--jar",
			missingJar,
			"--shadr",
			"1/4",
		];
		process.exitCode = undefined;
		try {
			// A unique query re-evaluates the module body, so the production
			// entry guard runs its private `main` rather than handing back the
			// instance the test file imported statically.
			await import(
				`${pathToFileURL(scriptPath).href}?entry-guard=${Date.now()}`
			);
			await flushMicrotasks();
		} finally {
			errorSpy.mockRestore();
			process.argv = savedArgv;
			process.exitCode = savedExitCode;
		}
		const output = messages.join("\n");
		expect(output).toContain("Unknown option '--shadr'");
		expect(output).not.toContain("does not exist");
	});
});

describe("main() caller wiring (#3927)", () => {
	// The extracted helpers are pinned by the cases above, but a passing helper
	// does not prove `main` calls it: the pre-#3927 inline expressions sat
	// behind `ensureJar`, so a caller-side change to the pool size or the
	// summary line had no witness. Run the real entry module over the real
	// `formal/` corpus with only the external `java`/jar boundary doubled, and
	// read the run's own summary back. `--shard 1/<count>` selects exactly one
	// real config, and `--concurrency 99` is a value `computeConcurrency` can
	// never return for one config, so a `main` that inlines either expression
	// instead of calling the helper cannot produce the observed summary.
	it("runs the real entry and reports the pool size and summary through the extracted helpers", async () => {
		const stubDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-tla-entry-"),
		);
		const stubJar = path.join(stubDir, "tla2tools.jar");
		fs.writeFileSync(stubJar, "stub jar; the checksum is doubled below");
		cryptoState.digest = TLA_TOOLS.sha256;
		const total = listModelConfigs(REPO_ROOT).length;
		const scriptPath = path.join(REPO_ROOT, "scripts", "check-tla-models.mjs");
		const savedArgv = process.argv;
		const savedExitCode = process.exitCode;
		const logged: string[] = [];
		const errors: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
			logged.push(args.map(String).join(" "));
		});
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation((...args) => {
				errors.push(args.map(String).join(" "));
			});
		process.argv = [
			process.execPath,
			scriptPath,
			"--jar",
			stubJar,
			"--concurrency",
			"99",
			"--shard",
			`1/${total}`,
		];
		process.exitCode = undefined;
		const isSummary = (line: string) => line.includes("wall (concurrency=");
		try {
			// A unique query re-evaluates the module body, so the production
			// entry guard runs its private `main` over the real corpus.
			await import(
				`${pathToFileURL(scriptPath).href}?caller-wiring=${Date.now()}`
			);
			for (let i = 0; i < 1000 && !logged.some(isSummary); i++) {
				await flushMicrotasks();
			}
			await flushMicrotasks();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
			process.argv = savedArgv;
			process.exitCode = savedExitCode;
			cryptoState.digest = "";
			fs.rmSync(stubDir, { recursive: true, force: true });
		}
		// The run's own per-config result lines are the independent oracle:
		// the summary must account for exactly the configs that ran, name the
		// shard `main` passed, and carry the pool size `main` resolved. The
		// expected string is built from that observation and literals, not by
		// calling `formatSummary` (which would let a caller mutation and a
		// helper mutation cancel out).
		const resultLines = logged.filter((line) => /^(?:ok  |FAIL) /.test(line));
		const summary = logged.find(isSummary);
		expect(errors, errors.join("\n")).toEqual([]);
		expect(resultLines).toHaveLength(1);
		expect(summary, errors.join("\n")).toMatch(
			new RegExp(
				`^1 configs \\(shard 1/${total}\\), \\d+\\.\\ds wall \\(concurrency=99, 1 TLC worker/config\\)\\.$`,
			),
		);
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
