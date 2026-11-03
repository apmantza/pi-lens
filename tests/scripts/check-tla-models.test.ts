import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	MODEL_COSTS_FILE,
	TLA_TOOLS,
	buildJavaArgs,
	classifyTlcOutput,
	computeConcurrency,
	formatSummary,
	listModelConfigs,
	loadModelCosts,
	parseCliArgs,
	parseConcurrencyArg,
	parseDistinctStates,
	parseModelHeader,
	parseShardArg,
	resolveConcurrency,
	resolveJarPath,
	runPool,
	selectConfigs,
	STATE_COUNT_FACTOR,
	selectShard,
	stateCountJumps,
	formatStateJump,
	unrecordedStateCounts,
	verdictMatches,
} from "../../scripts/check-tla-models.mjs";

const FIXTURES_TLA_COSTS = path.join(
	import.meta.dirname,
	"..",
	"fixtures",
	"tla-model-costs",
);
import { assertNonEmptyScan } from "../support/sweep-kit.js";

// The two doubles below stand in for the only two things `main` cannot run in
// a unit test: the external `java` process and the external jar's pinned
// checksum (#3927). Everything else — the CLI parser, the real `formal/`
// corpus, the real filesystem, and the run's own summary — is the production
// code path. `cryptoState` is the seam the caller-wiring case sets to the
// pinned digest; the default empty string leaves every other `createHash`
// caller untouched.
const cryptoState = vi.hoisted(() => ({ digest: "" }));
// #4714 F1: the TLC stdout the doubled `java` child emits. Empty means the
// default pass line, so the unchanged caller-wiring case sees no count.
const tlcState = vi.hoisted(() => ({ output: "" }));

vi.mock("node:child_process", async () => {
	const { makeFakeChild } = await import("../support/fake-child.js");
	return {
		spawn: () => {
			const child = makeFakeChild();
			queueMicrotask(() => {
				child.stdout.emit(
					"data",
					tlcState.output ||
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

	it("steps through the list round-robin when no cost table is given, so a directory's configs spread across shards", () => {
		expect(selectShard(items, { index: 1, total: 3 })).toEqual(["a", "d", "g"]);
		expect(selectShard(items, { index: 2, total: 3 })).toEqual(["b", "e"]);
		expect(selectShard(items, { index: 3, total: 3 })).toEqual(["c", "f"]);
	});

	// #4672: with the measured table the split is by COST, which is the whole
	// point -- round-robin by count gave four shards of 733/1255/1617/2148 s.
	it("packs the measured cost, so equal counts do not mean equal work", () => {
		// The measured shape of the corpus (#4672): a handful of very heavy
		// configs and a long cheap tail. A count-based split gives every shard
		// the same number of configs and wildly different work; the LPT pack
		// puts each heavy config in the lightest shard at the time it is placed,
		// so the cheap tail fills around them.
		// Keys are REPO-RELATIVE (the table's own form): `costOf` resolves each
		// config against the root before the lookup.
		const files: Record<string, number> = {
			"formal/heavy/heavy1.cfg": 400,
			"formal/heavy/heavy2.cfg": 300,
		};
		for (let index = 0; index < 16; index += 1) {
			files[`formal/cheap/cheap${String(index).padStart(2, "0")}.cfg`] = 10;
		}
		const costs = { root: "/repo", files, max: 400 };
		const configs = Object.keys(files)
			.sort()
			.map((relative) => `/repo/${relative}`);
		const shards = [1, 2, 3, 4].map((index) =>
			selectShard(configs, { index, total: 4 }, costs),
		);
		// Exactly once, everywhere: the partition property does not soften.
		expect(shards.flat().sort()).toEqual(configs);
		const loads = shards.map((picked) =>
			picked.reduce(
				(sum, config) => sum + files[config.slice("/repo/".length)],
				0,
			),
		);
		// Total 860 s over four shards. 400 s is indivisible, so the best any
		// partition can do is the heavy shard at 400 s: greedy LPT reaches it, and
		// the cheap tail spreads evenly around it instead of piling onto one
		// shard (the old count-based split's failure mode).
		// The exact pack: one shard carries the 400 s config alone, one the 300 s
		// config alone, and the 16 cheap configs split 8/8 across the other two.
		expect([...loads].sort((a, b) => a - b)).toEqual([80, 80, 300, 400]);
		// The two heavy configs never share a shard: their wall clocks add.
		expect(
			shards.filter((picked) =>
				picked.includes("/repo/formal/heavy/heavy1.cfg"),
			).length,
		).toBe(1);
		expect(
			shards.find((picked) => picked.includes("/repo/formal/heavy/heavy1.cfg")),
		).not.toContain("/repo/formal/heavy/heavy2.cfg");
	});

	// A config the table does not know costs the table's MAX, never zero and
	// never the median: a new model is usually a heavy one, and under-pricing it
	// is how the next tail shard appears (#4672).
	it("prices an unmeasured config at the table's maximum, not as free", () => {
		// Two 1 s configs, one unmeasured, max 10 s, two shards. Priced at max the
		// unknown takes a shard of its own; priced at 0 (or at the median, 1) it
		// would share with a known config and the placement changes.
		const costs = {
			root: "/repo",
			files: { "formal/a/a.cfg": 1, "formal/b/b.cfg": 1 },
			max: 10,
		};
		const configs = [
			"/repo/formal/a/a.cfg",
			"/repo/formal/b/b.cfg",
			"/repo/formal/new/new.cfg",
		];
		const shards = [1, 2].map((index) =>
			selectShard(configs, { index, total: 2 }, costs),
		);
		const withNew = shards.find((picked) =>
			picked.includes("/repo/formal/new/new.cfg"),
		);
		expect(withNew).toEqual(["/repo/formal/new/new.cfg"]);
	});

	// The table is the shard's only cost input, so a malformed one must be loud:
	// a silent fallback to equal costs would quietly restore the old tail.
	it("refuses a malformed cost table", () => {
		// The fixture root is removed on EVERY path, green or red: a straggler
		// under the shared tmp root is what the tmp-fixture-hygiene owner reds on,
		// and a throwing assertion would otherwise skip the cleanup below.
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-check-tla-models-costs-"),
		);
		try {
			fs.mkdirSync(path.join(dir, "scripts"));
			const file = path.join(dir, MODEL_COSTS_FILE);
			fs.writeFileSync(
				file,
				JSON.stringify({ files: { "formal/x/a.cfg": -1 } }),
			);
			expect(() => loadModelCosts(dir)).toThrow(/non-negative/);
			fs.writeFileSync(file, JSON.stringify({ nope: true }));
			expect(() => loadModelCosts(dir)).toThrow(/no "files" object/);
			fs.rmSync(file);
			expect(() => loadModelCosts(dir)).toThrow(/unreadable/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
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

	// #4672: the split is by measured cost, so it is no longer "every other
	// config". What this pins is the property the old assertion carried -- a
	// shard is a strict, non-empty SUBSET and the pair covers the tree exactly
	// once.
	it("narrows to the shard's configs with --shard", () => {
		const all = listModelConfigs(REPO_ROOT).map((config) =>
			path.resolve(config),
		);
		const first = selectConfigs(["--shard", "1/2"], REPO_ROOT).map((config) =>
			path.resolve(config),
		);
		const second = selectConfigs(["--shard", "2/2"], REPO_ROOT).map((config) =>
			path.resolve(config),
		);
		assertNonEmptyScan("first shard", first.length, 100);
		expect(first.length).toBeLessThan(all.length);
		expect([...first, ...second].sort()).toEqual([...all].sort());
		expect(first.filter((config) => second.includes(config))).toEqual([]);
	});

	// Recurrence: `indexOf("--shard")` missed both the equals form and a
	// misspelled flag, so the run silently selected the whole population.
	it("narrows to the shard with the --shard= equals form", () => {
		expect(selectConfigs(["--shard=1/2"], REPO_ROOT)).toEqual(
			selectConfigs(["--shard", "1/2"], REPO_ROOT),
		);
		expect(selectConfigs(["--shard=1/2"], REPO_ROOT)).not.toEqual(
			listModelConfigs(REPO_ROOT),
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
	// Runs the real entry module with only the external `java` child and the
	// jar checksum doubled. `root` is the tree the entry is run from: the real
	// repo for the pool-size case, and a temp copy (see `makeEntryRoot`) for the
	// gate cases, so they never read the committed cost table (#4714 F7).
	async function runEntry({
		root = REPO_ROOT,
		shard,
		total,
		tlcOutput = "",
	}: {
		root?: string;
		shard: number;
		total: number;
		tlcOutput?: string;
	}) {
		const stubDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-tla-entry-"),
		);
		const stubJar = path.join(stubDir, "tla2tools.jar");
		fs.writeFileSync(stubJar, "stub jar; the checksum is doubled below");
		cryptoState.digest = TLA_TOOLS.sha256;
		tlcState.output = tlcOutput;
		const scriptPath = path.join(root, "scripts", "check-tla-models.mjs");
		const savedArgv = process.argv;
		const savedExitCode = process.exitCode;
		let exitCode: number | undefined;
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
			`${shard}/${total}`,
		];
		process.exitCode = undefined;
		try {
			// A unique query re-evaluates the module body, so the production
			// entry guard runs its private `main` over this root's corpus.
			await import(
				`${pathToFileURL(scriptPath).href}?caller-wiring=${Date.now()}-${Math.random()}`
			);
			// `Per-directory` is the last line `main` prints before its failure and
			// jump reports, and those print synchronously after it.
			for (
				let i = 0;
				i < 1000 && !logged.some((line) => line.startsWith("Per-directory"));
				i++
			) {
				await flushMicrotasks();
			}
			await flushMicrotasks();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
			process.argv = savedArgv;
			exitCode = process.exitCode;
			process.exitCode = savedExitCode;
			cryptoState.digest = "";
			tlcState.output = "";
			fs.rmSync(stubDir, { recursive: true, force: true });
		}
		return { logged, errors, exitCode };
	}

	// A temp tree with the checker's own script and its one import, two stub
	// configs, and a fixture table: EditDuringGrace recorded at 136 and
	// CarryOwed absent. Nothing here reads the committed table or corpus.
	const RECORDED = "formal/late-aux-drain/EditDuringGrace.cfg";
	const UNRECORDED = "formal/blocker-pending/CarryOwed.cfg";
	function makeEntryRoot() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tla-root-"));
		fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
		for (const rel of [
			"scripts/check-tla-models.mjs",
			"scripts/lib/is-main-module.mjs",
			"scripts/lib/test-shard-assignment.mjs",
		]) {
			fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
		}
		for (const rel of [RECORDED, UNRECORDED]) {
			const file = path.join(root, rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "\\* expect: pass\n\\* module: M\n");
		}
		fs.writeFileSync(
			path.join(root, MODEL_COSTS_FILE),
			JSON.stringify({
				files: { [RECORDED]: 1.4, [UNRECORDED]: 5 },
				states: { [RECORDED]: 136 },
			}),
		);
		return {
			root,
			done: () => fs.rmSync(root, { recursive: true, force: true }),
		};
	}

	// The shard that `--shard i/N` gives this one config. The cost table packs
	// by LPT (`selectShard`), not by sorted position, so the index is searched
	// with the same function `main` calls.
	function configIndex(root: string, rel: string) {
		const all = listModelConfigs(root);
		const costs = { root, ...loadModelCosts(root) };
		const abs = all.find(
			(config) => path.relative(root, config).split(path.sep).join("/") === rel,
		);
		if (abs === undefined) throw new Error(`${rel} is not under formal/`);
		for (let index = 1; index <= all.length; index++) {
			if (selectShard(all, { index, total: all.length }, costs).includes(abs))
				return { shard: index, total: all.length };
		}
		throw new Error(`no shard selects ${rel}`);
	}

	const PASS = "Model checking completed. No error has been found.\n";
	const stats = (distinct: number) =>
		`${distinct * 2} states generated, ${distinct} distinct states found, 0 states left on queue.\n`;

	it("runs the real entry and reports the pool size and summary through the extracted helpers", async () => {
		const total = listModelConfigs(REPO_ROOT).length;
		const { logged, errors } = await runEntry({ shard: 1, total });
		const isSummary = (line: string) => line.includes("wall (concurrency=");
		const resultLines = logged.filter((line) => /^(?:ok  |FAIL) /.test(line));
		const summary = logged.find(isSummary);
		// The run's own per-config result lines are the independent oracle:
		// the summary must account for exactly the configs that ran, name the
		// shard `main` passed, and carry the pool size `main` resolved.
		expect(errors, errors.join("\n")).toEqual([]);
		expect(resultLines).toHaveLength(1);
		expect(summary, errors.join("\n")).toMatch(
			new RegExp(
				`^1 configs \\(shard 1/${total}\\), \\d+\\.\\ds wall \\(concurrency=99, 1 TLC worker/config\\)\\.$`,
			),
		);
	});

	// Recurrence: #4714 F1. A count past 2x the recorded 136 must fail the run,
	// name the config with its old and new counts, and set exit code 1.
	it("fails the run and names the config when its distinct states pass 2x the recorded count", async () => {
		const tree = makeEntryRoot();
		try {
			const { logged, errors, exitCode } = await runEntry({
				root: tree.root,
				...configIndex(tree.root, RECORDED),
				tlcOutput: PASS + stats(300),
			});
			expect(errors, errors.join("\n")).toEqual([]);
			expect(
				logged.some(
					(line) =>
						line.startsWith(`ok   ${RECORDED}: `) &&
						line.endsWith(", 300 distinct states)"),
				),
			).toBe(true);
			expect(
				logged.filter((line) => line.startsWith("STATE-COUNT JUMP")),
			).toEqual([
				expect.stringContaining(`STATE-COUNT JUMP ${RECORDED}: old count 136 `),
			]);
			expect(logged.find((l) => l.startsWith("STATE-COUNT JUMP"))).toContain(
				"new count 300 ",
			);
			expect(exitCode).toBe(1);
		} finally {
			tree.done();
		}
	});

	// The factor is inclusive: 272 is exactly 2x 136, so it passes.
	it("passes a count exactly at the factor, with the exit code unset", async () => {
		const tree = makeEntryRoot();
		try {
			const { logged, exitCode } = await runEntry({
				root: tree.root,
				...configIndex(tree.root, RECORDED),
				tlcOutput: PASS + stats(272),
			});
			expect(logged.some((line) => line.startsWith("STATE-COUNT JUMP"))).toBe(
				false,
			);
			expect(exitCode).toBeUndefined();
		} finally {
			tree.done();
		}
	});

	// Recurrence: #4714 F1. A config with no recorded count only reports; the
	// run stays green however large its count is.
	it("reports an unrecorded config's count without failing the run", async () => {
		const tree = makeEntryRoot();
		try {
			const { logged, exitCode } = await runEntry({
				root: tree.root,
				...configIndex(tree.root, UNRECORDED),
				tlcOutput: PASS + stats(1e9),
			});
			expect(logged.some((line) => line.startsWith("STATE-COUNT JUMP"))).toBe(
				false,
			);
			expect(
				logged.some((line) =>
					line.includes("ran with no recorded distinct-state count"),
				),
			).toBe(true);
			expect(exitCode).toBeUndefined();
		} finally {
			tree.done();
		}
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

// #4714: TLC's distinct-state count is recorded per config, and a config whose
// count grows past the recorded one by more than the factor fails the checker.
// Recurrence: #3836, where three processes at MaxGen=5 reached 30.8M distinct
// states at 3.95 GB without finishing, and the seconds-only table showed
// nothing until the shard hit its cap.
describe("distinct-state ratchet (#4714)", () => {
	const TLC_COUNTS =
		"Model checking completed. No error has been found.\n" +
		"  Finished computing initial states: 1 distinct state generated at 2026-10-24 10:00:00.\n" +
		"3130444 states generated, 3130444 distinct states found, 0 states left on queue.\n" +
		"The depth of the complete state graph search is 41.\n";

	it("reads TLC's own distinct-state count from its statistics line", () => {
		expect(parseDistinctStates(TLC_COUNTS)).toBe(3130444);
		// No statistics line (a parse error) is no count, not zero.
		expect(
			parseDistinctStates("Error: Parsing or semantic analysis failed."),
		).toBe(null);
	});

	// Recurrence: #4714 itself. The fixture grows GROW.cfg from its recorded
	// 1000 states to 2001 (past 2x) and STAY.cfg from 1000 to 2000 (at 2x).
	it("fails a config whose distinct states exceed its recorded count by the factor", () => {
		const states = { "formal/x/Grow.cfg": 1000, "formal/x/Stay.cfg": 1000 };
		const outcomes = [
			{ id: "formal/x/Grow.cfg", distinctStates: 2001 },
			{ id: "formal/x/Stay.cfg", distinctStates: 2000 },
		];
		expect(stateCountJumps(outcomes, states)).toEqual([
			{ id: "formal/x/Grow.cfg", recorded: 1000, observed: 2001 },
		]);
	});

	// Recurrence: a config added after the table was recorded has no count; the
	// ratchet reports it, it never fails the run for lacking a number.
	it("reports a config with no recorded count instead of failing it", () => {
		expect(
			stateCountJumps(
				[
					{ id: "formal/x/New.cfg", distinctStates: 1e9 },
					{ id: "formal/x/Old.cfg", distinctStates: null },
				],
				{ "formal/x/Old.cfg": 1 },
			),
		).toEqual([]);
		expect(
			unrecordedStateCounts(
				[
					{ id: "formal/x/New.cfg", distinctStates: 5 },
					{ id: "formal/x/Old.cfg", distinctStates: 5 },
				],
				{ "formal/x/Old.cfg": 5 },
			),
		).toEqual(["formal/x/New.cfg"]);
	});

	it("names the config, the old count and the new count in the message", () => {
		const line = formatStateJump({
			id: "formal/x/Grow.cfg",
			recorded: 1000,
			observed: 2001,
		});
		expect(line).toContain("formal/x/Grow.cfg");
		expect(line).toContain("old count 1000");
		expect(line).toContain("new count 2001");
		expect(STATE_COUNT_FACTOR).toBe(2);
	});

	// Recurrence: #4714 non-goal guard. A table written before this change has
	// no `states` key and must still load, with an empty count map.
	it("loads a pre-#4714 cost table (no states key) and refuses a malformed count", () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-check-tla-states-"),
		);
		try {
			fs.mkdirSync(path.join(dir, "scripts"));
			const file = path.join(dir, MODEL_COSTS_FILE);
			fs.copyFileSync(
				path.join(FIXTURES_TLA_COSTS, "pre-4714-table.json"),
				file,
			);
			const old = loadModelCosts(dir);
			expect(Object.keys(old.files).length).toBe(823);
			expect(old.states).toEqual({});
			fs.writeFileSync(
				file,
				JSON.stringify({
					files: { "formal/x/a.cfg": 1 },
					states: { "formal/x/a.cfg": -3 },
				}),
			);
			expect(() => loadModelCosts(dir)).toThrow(/states/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
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
