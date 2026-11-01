import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { toPosix } from "../../clients/path-utils.js";
import { COMPLEXITY_ANALYZED_FILES_FLOOR } from "../../scripts/complexity-report.mjs";
import {
	countEvaluated,
	EVALUATED_DIR_ENV,
	EVALUATED_PRODUCERS,
} from "../../scripts/lib/assert-evaluated.mjs";
import type {
	CoERow,
	CoESite,
	CoEStatus,
} from "../support/continue-on-error-census.js";
import {
	classifyProducerFile,
	floorProblems,
	liveRunText,
	readProducerCensus,
	rowProblems,
	stepIdentity,
	stripShellComments,
} from "../support/continue-on-error-census.js";
import {
	auditRegistry,
	stripSource,
	testDeclarations,
} from "../support/sweep-kit.js";
import { vitestCollects } from "../support/vitest-collection.js";

// Recurrence #4514 (retro P2): the four best-effort LSP producers exit 0 under
// continue-on-error, so the nightly read green while 41 captured servers fell
// to 16. A floor is a MEASURED constant: its measuring command and raw output
// are tracked (tests/fixtures/nightly-floors/measurements.json) and this file
// pins each floor between the degraded and the healthy measurement, so a floor
// raised past what a healthy runner reaches (a nightly red forever) and a
// floor lowered under the degraded night (a gate that would not have fired)
// both red here. It also pins the wiring: a producer that stops reporting, a
// floor step made continue-on-error, and a refresh PR that no longer asks
// whether the night evaluated anything.
const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
const measurements = JSON.parse(
	read("tests/fixtures/nightly-floors/measurements.json"),
) as {
	producers: Record<
		string,
		Record<"healthy" | "degraded", { evaluated: number; lines: string[] }>
	>;
	lspHandshake: Record<
		"healthy" | "degraded",
		{ passed: number; line: string }
	>;
};

const lastInt = (line: string) => Number(/(\d+)\s*$/.exec(line)?.[1]);
const many = <T>(n: number, row: T) => Array.from({ length: n }, () => row);

/**
 * Why a `governed-by` row's named test proves nothing, or `[]` when it does.
 * AGENTS "Test requirements": a detector that decides a test exists counts live
 * declarations (`testDeclarations`) in a file vitest collects
 * (`vitestCollects`), never a path that merely exists (#4609 r2 F-1,
 * Greptile r4306428644: a directory and a declaration-free file both passed).
 */
const governedByTestProblems = (
	root: string,
	key: string,
	test: string,
): string[] => {
	const relative = toPosix(test);
	const absolute = resolve(root, relative);
	if (!existsSync(absolute) || !statSync(absolute).isFile())
		return [`${key}: ${test} is not a file`];
	// A `describe`/`suite` wrapper declares no test of its own: AGENTS says the
	// live tests that own the site, so a file whose tests were deleted and whose
	// wrapper remains proves nothing (#4609 r3 LOW-2).
	const declared = testDeclarations(readFileSync(absolute, "utf8")).filter(
		(entry) => entry.live && (entry.callee === "it" || entry.callee === "test"),
	);
	if (declared.length === 0) return [`${key}: ${test} declares no live test`];
	if (!vitestCollects(relative))
		return [`${key}: vitest does not collect ${test}`];
	return [];
};

/**
 * Whether this host can create a symlink. The Windows leg runs this file under
 * a runner without the privilege, so the symlink plant skips there; the
 * directory plant beside it covers the non-file branch on every platform.
 */
const symlinkSupported = (() => {
	const probe = mkdtempSync(join(tmpdir(), "pi-lens-coe-symlink-"));
	try {
		writeFileSync(join(probe, "target.yml"), "jobs: {}\n");
		symlinkSync("target.yml", join(probe, "link.yml"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

/**
 * The value each script hands writeEvaluatedRecord, rebuilt from the raw log
 * lines of a real night, plus rows the count must NOT include (a refused or
 * unclassified row). The count itself is EVALUATED_COUNTS, the one function the
 * script also calls, so a mutation of a count expression reds the derivation
 * below (the idle count read as `counts.total`, probe-clean-signal dropping its
 * `n/a (pull)` arm, characterize-lsp counting refused rows).
 */
const INPUT: Record<string, (lines: string[]) => unknown> = {
	"characterize-lsp": (lines) => [
		...many(lastInt(lines[0]), { mode: "pull" }),
		...many(lastInt(lines[1]), { mode: "push-only" }),
		...many(3, { mode: "unknown" }),
		...many(2, { mode: "refused: project trust is unknown" }),
	],
	"probe-clean-signal": (lines) => [
		...many(lastInt(lines[0]), { behavior: "publishes-versioned" }),
		...many(lastInt(lines[1]), { behavior: "publishes-unversioned" }),
		...many(lastInt(lines[2]), { behavior: "silent" }),
		...many(lastInt(lines[3]), { behavior: "n/a (pull)" }),
		...many(4, { behavior: "unknown" }),
	],
	"server-capabilities": ([line]) =>
		many(Number(/\((\d+) servers captured/.exec(line)?.[1]), {}),
	"measure-lsp-idle-eviction": ([line]) => {
		const m =
			/(\d+) registry servers: (\d+) eligible, (\d+) vetoed, (\d+) inconclusive, (\d+) unavailable/.exec(
				line,
			);
		return {
			total: Number(m?.[1]),
			eligible: Number(m?.[2]),
			vetoed: Number(m?.[3]),
			inconclusive: Number(m?.[4]),
			unavailable: Number(m?.[5]),
		};
	},
};
/** The identifier each script passes as `input`, pinned so it cannot pass a slice. */
const SCRIPT_INPUT: Record<string, string> = {
	"characterize-lsp": "rows",
	"probe-clean-signal": "rows",
	"server-capabilities": "rows",
	"measure-lsp-idle-eviction": "counts",
};

describe("nightly evaluated floors are measured, not guessed (#4514)", () => {
	it("registers exactly the producers that have a measurement", () => {
		expect(Object.keys(EVALUATED_PRODUCERS).sort()).toEqual(
			Object.keys(measurements.producers).sort(),
		);
		expect(Object.keys(INPUT).sort()).toEqual(
			Object.keys(EVALUATED_PRODUCERS).sort(),
		);
	});

	describe.each(Object.keys(EVALUATED_PRODUCERS))("%s", (producer) => {
		const spec = EVALUATED_PRODUCERS[producer];
		const { healthy, degraded } = measurements.producers[producer];

		it("derives each measurement's count from its raw log lines", () => {
			expect(countEvaluated(producer, INPUT[producer](healthy.lines))).toBe(
				healthy.evaluated,
			);
			expect(countEvaluated(producer, INPUT[producer](degraded.lines))).toBe(
				degraded.evaluated,
			);
		});

		it("sits above the degraded night and at or below the healthy one", () => {
			expect(spec.floor).toBeGreaterThan(degraded.evaluated);
			expect(spec.floor).toBeLessThanOrEqual(healthy.evaluated);
		});

		// A doc floor of 1 is the matrix's "not emptied" guard, a different unit.
		const docFloor = spec.doc && spec.doc.floor > 1 ? spec.doc.floor : 0;
		it.skipIf(docFloor === 0)(
			"holds a doc floor in the same band where the doc count is the same unit",
			() => {
				expect(docFloor).toBeGreaterThan(degraded.evaluated);
				expect(docFloor).toBeLessThanOrEqual(healthy.evaluated);
			},
		);

		it("is reported by its own script", () => {
			const code = stripSource(read(`scripts/${producer}.mjs`), {
				strings: "keep",
			});
			// The script hands over its rows, never a count of its own: the one
			// count function (EVALUATED_COUNTS) is what the test above derives.
			expect(code).toMatch(
				new RegExp(
					`writeEvaluatedRecord\\(\\{\\s*producer:\\s*"${producer}",\\s*input:\\s*${SCRIPT_INPUT[producer]},?\\s*\\}\\)`,
				),
			);
		});
	});
});

type Step = {
	name?: string;
	id?: string;
	if?: string;
	run?: string;
	uses?: string;
	"continue-on-error"?: unknown;
	"timeout-minutes"?: unknown;
};
type Job = {
	env?: Record<string, string>;
	steps?: Step[];
	outputs?: Record<string, string>;
	"continue-on-error"?: unknown;
};
const workflow = yaml.load(read(".github/workflows/tool-smoke.yml")) as {
	jobs: Record<string, Job>;
};
const smoke = workflow.jobs["tool-smoke"];
const prs = workflow.jobs["tool-smoke-prs"];
const step = (job: Job, needle: string) => {
	const found = (job.steps ?? []).find((s) => s.name?.includes(needle));
	if (!found) throw new Error(`no step named like "${needle}"`);
	return found;
};

describe("the floor step and the refresh guard are wired and gating (#4514)", () => {
	it("runs the floor as a step that cannot be continue-on-error, after every producer and layer", () => {
		const steps = smoke.steps ?? [];
		const floor = step(smoke, "LSP evaluated floor");
		expect(floor["continue-on-error"]).toBeUndefined();
		expect(floor.id).toBe("evaluated_floor");
		const run = liveRunText(floor);
		expect(run).toContain("scripts/assert-evaluated.mjs --records");
		// A doc-only loss (a matrix cell gone `unknown`) must red the step the
		// notifier reads, not only the refresh job that no tracker watches.
		expect(run).toMatch(/--records "\$\w+" --docs\b/);
		expect(run).toMatch(/^\s*set -o pipefail\s*$/m);
		const at = (name: string) => steps.indexOf(step(smoke, name));
		for (const earlier of [
			"LSP capability matrix",
			"LSP clean-signal probe",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
			"Resolution layer",
		])
			expect(at("LSP evaluated floor"), earlier).toBeGreaterThan(at(earlier));
	});

	it("names the records directory once, in the job env the producers and the floor step share", () => {
		const dir = smoke.env?.[EVALUATED_DIR_ENV];
		expect(dir).toBeTruthy();
		expect(liveRunText(step(smoke, "LSP evaluated floor"))).toContain(
			`"$${EVALUATED_DIR_ENV}"`,
		);
	});

	it("keeps the four producers best-effort (the floor, not them, carries the verdict)", () => {
		for (const name of [
			"LSP capability matrix",
			"LSP clean-signal probe",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
		])
			expect(step(smoke, name)["continue-on-error"], name).toBe(true);
	});

	it("gives the LSP handshake a --min-pass at or below what a healthy and a degraded night both passed", () => {
		const floor = floorOf(
			liveRunText(step(smoke, "LSP handshake layer")),
			/--min-pass=(\d+)/,
		);
		expect(floor).toBeGreaterThan(0);
		for (const night of ["healthy", "degraded"] as const)
			expect(floor).toBeLessThanOrEqual(
				measurements.lspHandshake[night].passed,
			);
		for (const night of ["healthy", "degraded"] as const)
			expect(measurements.lspHandshake[night].line).toContain(
				`${measurements.lspHandshake[night].passed} passed`,
			);
	});

	it("passes --min-pass from main() into the handshake layer (call-site pin)", () => {
		const code = stripSource(read("scripts/smoke-tools.mjs"), {
			strings: "blank",
		});
		expect(code).toMatch(
			/runLspHandshake\(\{\s*langs,\s*install,\s*verbose,\s*minPass\s*\}\)/,
		);
	});

	it("opens no refresh PR before the regenerated docs are checked against HEAD", () => {
		const steps = prs.steps ?? [];
		const guard = step(prs, "Refuse a degraded refresh");
		expect(guard["continue-on-error"]).toBeUndefined();
		expect(liveRunText(guard)).toContain("scripts/assert-evaluated.mjs --docs");
		const guardAt = steps.indexOf(guard);
		expect(guardAt).toBeGreaterThan(steps.indexOf(step(prs, "Overlay")));
		for (const open of [
			"Open/update LSP-docs refresh PR",
			"Open/update idle-eviction promotion PR",
		])
			expect(steps.indexOf(step(prs, open)), open).toBeGreaterThan(guardAt);
	});
});

// Recurrence #4518 (retro P2, the rest of the audit): five more producers sat
// under continue-on-error with no proof of work (the APFS anchors, the Swift
// crash-watch, the PR-time LSP handshake, the complexity report, plus the
// mise-repro and lint jobs that carry a stated reason instead). The floors are
// MEASURED (tests/fixtures/nightly-floors/measurements.json, nonLspFloors) and
// pinned here in both directions: at or below what a healthy run reached (a
// floor above it is a job red forever) and within half of it (a floor of 1 is
// the "did anything run" guard the job already had, not a measured one).
const nonLsp = (
	measurements as unknown as {
		nonLspFloors: {
			"apfs-anchors": { healthy: { evaluated: number; line: string } };
			"install-smoke-lsp-handshake": {
				healthy: Array<{ passed: number; line: string }>;
			};
			"swift-crash-watch": { healthy: { evaluated: number } };
			"complexity-report": { healthy: { evaluated: number } };
			"windows-vitest": { healthy: { evaluated: number; line: string } };
		};
	}
).nonLspFloors;
const withinMeasured = (floor: number, measured: number, fraction = 0.5) => {
	expect(floor).toBeGreaterThan(0);
	expect(floor).toBeLessThanOrEqual(measured);
	expect(floor).toBeGreaterThanOrEqual(measured * fraction);
};
const loadWorkflow = (file: string) =>
	yaml.load(read(`.github/workflows/${file}`)) as {
		jobs: Record<string, Job>;
	};
const floorOf = (run: string | undefined, re: RegExp) =>
	Number(re.exec(run ?? "")?.[1]);

describe("the floors outside the LSP nightly are measured and wired (#4518)", () => {
	it("floors the APFS anchors on tests executed, in a step that cannot be continue-on-error", () => {
		const job = loadWorkflow("ci.yml").jobs["install-test"];
		const anchors = step(job, "POSIX case-insensitive anchors");
		const floor = step(job, "APFS anchors evaluated floor");
		// The results stay advisory; only "nothing ran" is gating.
		expect(anchors["continue-on-error"]).toBe(true);
		expect(floor["continue-on-error"]).toBeUndefined();
		expect(floor.if).toContain("macos-latest");
		expect(floor.if).toContain("!cancelled()");
		const steps = job.steps ?? [];
		expect(steps.indexOf(floor)).toBeGreaterThan(steps.indexOf(anchors));
		// The reporter file the vitest step writes is the file the floor reads.
		expect(anchors.run).toContain(
			'--reporter=json --outputFile.json="$RUNNER_TEMP/apfs-anchors.json"',
		);
		const floorRun = liveRunText(floor);
		expect(floorRun).toContain('"$RUNNER_TEMP/apfs-anchors.json"');
		expect(floorRun).toContain("j.numPassedTests+j.numFailedTests");
		expect(floorRun).toMatch(/--count "apfs-anchors=\$\{count\}"/);
		// 100 of the measured 223 is a decision (review r1 F5): the leg is
		// required, the step exists to catch a run that executed nothing, and a
		// 10% margin would red it on a legitimate removal of 24 tests.
		withinMeasured(
			floorOf(floorRun, /--floor (\d+)/),
			nonLsp["apfs-anchors"].healthy.evaluated,
			0.4,
		);
		expect(nonLsp["apfs-anchors"].healthy.line).toContain(
			`${nonLsp["apfs-anchors"].healthy.evaluated} passed`,
		);
	});

	it("turns exactly 'swift was not evaluated' into a red job, and says so when swift can be lifted", () => {
		const job = loadWorkflow("grammar-health.yml").jobs["swift-crash-watch"];
		const watch = step(job, "Force-load swift");
		const floor = step(job, "Swift crash-watch evaluated floor");
		expect(watch["continue-on-error"]).toBeUndefined();
		expect(floor["continue-on-error"]).toBeUndefined();
		const steps = job.steps ?? [];
		expect(steps.indexOf(floor)).toBeGreaterThan(steps.indexOf(watch));
		// check-grammar-load.mjs: 2 = runtime unavailable, 3 = grammar did not
		// load; both evaluated nothing. Exit 0 is the lift signal; any other
		// status is the known #423 crash and IS an evaluation.
		expect(watch.run).toMatch(/2\|3\)\s*\n\s*evaluated=0/);
		expect(watch.run).toMatch(/0\)\s*\n\s*evaluated=1/);
		expect(watch.run).toMatch(/\*\)\s*\n\s*evaluated=1/);
		expect(watch.run).toContain("::notice title=Swift crash-watch::");
		expect(watch.run).toContain(
			'echo "evaluated=${evaluated}" >> "$GITHUB_OUTPUT"',
		);
		expect((floor as { env?: Record<string, string> }).env?.EVALUATED).toBe(
			"${{ steps.swift.outputs.evaluated }}",
		);
		expect(liveRunText(floor)).toContain(
			'--count "swift-crash-watch=${EVALUATED}" --floor',
		);
		withinMeasured(
			floorOf(liveRunText(floor), /--floor (\d+)/),
			nonLsp["swift-crash-watch"].healthy.evaluated,
		);
	});

	it("gives the PR-time LSP handshake a --min-pass at or below both measured PR runs", () => {
		const job = loadWorkflow("install-smoke.yml").jobs["lsp-handshake"];
		const floor = floorOf(
			liveRunText(step(job, "LSP handshake layer")),
			/--min-pass=(\d+)/,
		);
		const passes = nonLsp["install-smoke-lsp-handshake"].healthy.map(
			(h) => h.passed,
		);
		withinMeasured(floor, Math.min(...passes));
		for (const h of nonLsp["install-smoke-lsp-handshake"].healthy)
			expect(h.line).toContain(`${h.passed} passed`);
	});

	it("hands the analysed-files floor to assertEvaluated and pins it under the measured count", () => {
		withinMeasured(
			COMPLEXITY_ANALYZED_FILES_FLOOR,
			nonLsp["complexity-report"].healthy.evaluated,
		);
	});

	it("floors the Windows subset on tests executed, in the step that already reds a failed outcome", () => {
		const job = loadWorkflow("ci.yml").jobs["unit-tests-windows"];
		const failStep = step(job, "under-executed");
		expect(failStep["continue-on-error"]).toBeUndefined();
		expect(liveRunText(failStep)).toContain(
			'--count "windows-vitest=${executed}"',
		);
		withinMeasured(
			floorOf(liveRunText(failStep), /--floor (\d+)/),
			nonLsp["windows-vitest"].healthy.evaluated,
		);
		expect(nonLsp["windows-vitest"].healthy.line).toContain(
			`${nonLsp["windows-vitest"].healthy.evaluated} passed`,
		);
	});

	it("states why each job without a floor needs none, directly above the job", () => {
		const lint = read(".github/workflows/lint.yml");
		for (const job of ["lint-advisory"]) {
			const at = lint.indexOf(`\n  ${job}:\n`);
			expect(at, job).toBeGreaterThan(0);
			const above = lint.slice(Math.max(0, at - 700), at);
			expect(above, job).toMatch(/# No floor \(#4518\): /);
		}
		const install = read(".github/workflows/install-smoke.yml");
		const miseAt = install.indexOf("\n  mise-repro:\n");
		expect(miseAt).toBeGreaterThan(0);
		expect(install.slice(miseAt, miseAt + 1500)).toMatch(
			/# No floor \(#4518\): /,
		);
	});

	it("keeps the pass-floor, census-plan and file-count comparisons in the one helper (net-count rule)", () => {
		const call = /\bassertEvaluated\(/;
		for (const file of [
			"scripts/smoke-tools.mjs",
			"scripts/ci-shuffle-census.mjs",
			"scripts/complexity-report.mjs",
		]) {
			const code = stripSource(read(file), { strings: "blank" });
			expect(code, file).toMatch(call);
		}
		// The ad hoc comparison the helper replaced must not come back beside it.
		const smoke = stripSource(read("scripts/smoke-tools.mjs"), {
			strings: "blank",
		});
		expect(smoke).not.toMatch(/passed\s*>=\s*minPass/);
		const census = stripSource(read("scripts/ci-shuffle-census.mjs"), {
			strings: "blank",
		});
		expect(census).not.toMatch(/if\s*\(\s*missing\.length\s*>\s*0\s*\)/);
	});
});

// #4518's remainder: the r1 floors covered the sites the issue listed, and a
// sweep found the rest of the tree. A `continue-on-error` producer that
// evaluates nothing reads green, so every such site is registered in
// tests/fixtures/nightly-floors/continue-on-error-sites.json as `floored`
// (naming the gating step whose LIVE text carries the floor), `no-floor`
// (naming the reader that makes an empty result visible), or `governed-by`
// (naming the issue and the tests that own it). The population is DERIVED from
// the parsed files, so a new site, a site the parser stops seeing, and a file
// form the reader does not classify all red here instead of joining silently.
// Review r1 (#4609) found three holes this file now closes: the population
// stopped at `.github/workflows/*.yml` (F1), the floor check matched prose, so
// a comment or an `if: false` step satisfied it (F2), and `tool-smoke.yml` was
// excluded as a FILE, so a new non-LSP site in it was invisible (F4).
const COE_REGISTRY =
	"tests/fixtures/nightly-floors/continue-on-error-sites.json";
const coeRegistry = JSON.parse(read(COE_REGISTRY)) as {
	sites: Record<string, CoERow>;
};
const coeKeys = Object.keys(coeRegistry.sites).sort();
const census = readProducerCensus(ROOT);

describe("every continue-on-error site in the workflow and action tree is registered (#4518)", () => {
	it("reads every file under the producer roots, and classifies every form it finds", () => {
		// A reader that silently skips a file form is a guard with a hole in it
		// (#4609 r1 F1: a `.yaml` workflow and a composite action were both
		// outside the population and outside the old raw-key guard).
		expect(census.unclassified).toEqual([]);
		expect(census.problems).toEqual([]);
		const files = census.files.map((file) => file.path);
		expect(files).toEqual(
			expect.arrayContaining([
				".github/workflows/ci.yml",
				".github/workflows/tool-smoke.yml",
				".github/actions/tool-tree-cache/action.yml",
			]),
		);
		expect(census.files.length).toBeGreaterThanOrEqual(26);
	});

	it("accounts for every site as a floor, a stated reader, or a named owner", () => {
		const audit = auditRegistry({
			sweepName: "continue-on-error census",
			// A `no-floor` row is an admitted exemption with its own reason, so
			// the kit's stale-entry and reason-length checks cover it too.
			flagged: census.sites.map((site) => ({
				key: site.key,
				detail: `${site.file}:${site.scope}${site.step ? ` (${stepIdentity(site.step)})` : ""}`,
			})),
			registered: coeKeys.filter(
				(key) => coeRegistry.sites[key]?.status !== "no-floor",
			),
			exemptions: Object.fromEntries(
				coeKeys
					.filter((key) => coeRegistry.sites[key]?.status === "no-floor")
					.map((key) => [key, coeRegistry.sites[key]?.reason ?? ""]),
			),
			minFlagged: 52,
			scannedCount: census.files.length,
			minScanned: 26,
			remediation:
				"Register the site in tests/fixtures/nightly-floors/continue-on-error-sites.json: floored (a gating step whose live run text carries the floor), no-floor (the reader that makes an empty result visible), or governed-by (the issue and tests that own it).",
		});
		expect(audit.problems).toEqual([]);
	});

	it("registers exactly the sites the census reads, so an unregistered site and a stale row both red", () => {
		expect(census.sites.map((site) => site.key).sort()).toEqual(coeKeys);
	});

	it("gives every row a usable record, and names tests that exist", () => {
		expect(
			coeKeys.flatMap((key) => rowProblems(key, coeRegistry.sites[key])),
		).toEqual([]);
		expect(
			coeKeys.flatMap((key) => {
				const row = coeRegistry.sites[key];
				if (row.status !== "governed-by") return [];
				expect(row.tests?.length, key).toBeGreaterThan(0);
				return (row.tests ?? []).flatMap((test) =>
					governedByTestProblems(ROOT, key, test),
				);
			}),
		).toEqual([]);
	});

	it("gives every floored site a live gating step, after the site, whose run text carries its floor", () => {
		expect(
			census.sites.flatMap((site) =>
				floorProblems(
					site,
					coeRegistry.sites[site.key] ?? { status: "no-floor", reason: "" },
				),
			),
		).toEqual([]);
	});

	it("pins the two job headers the registry marks as human-facing copy", () => {
		const headered = coeKeys.filter((key) => coeRegistry.sites[key].header);
		expect(headered.length).toBe(2);
		const lint = read(".github/workflows/lint.yml");
		for (const job of ["lint-advisory"]) {
			const at = lint.indexOf(`\n  ${job}:\n`);
			expect(at, job).toBeGreaterThan(0);
			expect(lint.slice(Math.max(0, at - 700), at), job).toMatch(
				/# No floor \(#4518\): /,
			);
		}
		const install = read(".github/workflows/install-smoke.yml");
		const miseAt = install.indexOf("\n  mise-repro:\n");
		expect(miseAt).toBeGreaterThan(0);
		expect(install.slice(miseAt, miseAt + 1500)).toMatch(
			/# No floor \(#4518\): /,
		);
		// One header per marked row, in the file that row lives in: an orphan
		// header (no row) and a row with no header both red.
		for (const file of new Set(headered.map((key) => key.split("#")[0]))) {
			const text = read(file);
			expect(text.match(/# No floor \(#4518\): /g)?.length ?? 0, file).toBe(
				headered.filter((key) => key.startsWith(`${file}#`)).length,
			);
		}
	});

	it("registers the four producers #4514 floors one by one, so a new site in the LSP nightly reds", () => {
		const nightly = census.sites.filter(
			(site) => site.file === ".github/workflows/tool-smoke.yml",
		);
		for (const name of [
			"LSP capability matrix (characterize diagnostic mode per server)",
			"LSP clean-signal probe (Tier 2 vs 3 among push servers)",
			"LSP server capability inventory",
			"LSP idle-eviction measurement",
		]) {
			const site = nightly.find((entry) => entry.step?.name?.includes(name));
			expect(site, name).toBeDefined();
			const row = site ? coeRegistry.sites[site.key] : undefined;
			expect(row?.status, name).toBe("governed-by");
			expect(row?.governedBy, name).toBe("#4514");
		}
	});
});

// #4609 r1 F3: every fail-closed path above needs a checked-in plant a future
// edit cannot delete by accident. The trees are built per case, so a broken
// fixture never sits in the repository (where yamllint and the workflow sweeps
// would read it) and each plant names the one shape it exercises.
describe("the census fails closed on every producer surface and floor shape", () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});
	const tree = (files: Record<string, string>): string => {
		const root = mkdtempSync(join(tmpdir(), "pi-lens-coe-census-"));
		roots.push(root);
		for (const [rel, body] of Object.entries(files)) {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), body);
		}
		return root;
	};
	const PROBE = `"on": push
jobs:
  probe:
    runs-on: ubuntu-latest
`;

	it("reads a .yaml workflow and a composite action step, and finds them unaccounted without a row", () => {
		const root = tree({
			".github/workflows/zz-probe.yaml": `${PROBE}    continue-on-error: true
    steps:
      - name: best effort
        continue-on-error: true
        run: echo hi
`,
			".github/actions/probe/action.yaml": `name: probe
runs:
  using: composite
  steps:
    - name: composite best effort
      shell: bash
      continue-on-error: true
      run: echo hi
`,
		});
		const found = readProducerCensus(root);
		expect(found.problems).toEqual([]);
		expect(found.files.map((file) => file.kind).sort()).toEqual([
			"composite",
			"workflow",
		]);
		expect(found.sites.map((site) => site.key).sort()).toEqual([
			".github/actions/probe/action.yaml#composite best effort",
			".github/workflows/zz-probe.yaml#probe",
			".github/workflows/zz-probe.yaml#probe#best effort",
		]);
		const audit = auditRegistry({
			sweepName: "fixture",
			flagged: found.sites.map((site) => site.key),
			registered: [],
		});
		expect(audit.unaccounted.sort()).toEqual(
			found.sites.map((site) => site.key).sort(),
		);
	});

	it("reds on a file under a producer root that it does not classify", () => {
		const root = tree({
			".github/workflows/README.md": "# notes\n",
			".github/workflows/zz-probe.yml": `${PROBE}    steps: []
`,
			".github/actions/probe.yml": "name: stray\n",
			".github/actions/probe/README.md": "# notes\n",
		});
		const found = readProducerCensus(root);
		expect(found.files.map((file) => file.path)).toEqual([
			".github/workflows/zz-probe.yml",
		]);
		expect(found.problems.map((problem) => problem.split(":")[0])).toEqual([
			".github/workflows/README.md",
			".github/actions/probe.yml",
			".github/actions/probe/README.md",
		]);
		expect(found.problems[0]).toContain("does not classify");
	});

	it("classifies an action file by its exact name, so a misnamed copy refuses", () => {
		// LOW-1: `file.startsWith("action.")` read `action.backup.yml` as a
		// composite action GitHub never runs, which would then demand a registry
		// row for it.
		expect(
			[
				".github/actions/probe/action.backup.yml",
				".github/actions/probe/action.yml.bak",
				".github/actions/action.yml",
				".github/workflows/nested/a.yml",
				".github/actions/probe/action.yml",
				".github/actions/probe/action.yaml",
				".github/workflows/a.yml",
			].map((path) => classifyProducerFile(path)),
		).toEqual([null, null, null, null, "composite", "composite", "workflow"]);
		const root = tree({
			".github/actions/probe/action.backup.yml": `name: probe
runs:
  using: composite
  steps:
    - name: stray
      shell: bash
      continue-on-error: true
      run: echo hi
`,
		});
		const found = readProducerCensus(root);
		expect(found.sites).toEqual([]);
		expect(found.problems).toEqual([
			expect.stringContaining(".github/actions/probe/action.backup.yml:"),
		]);
	});

	it("reds on a directory named like a producer file instead of walking past it", () => {
		const root = tree({
			".github/workflows/real.yml": `${PROBE}    steps: []
`,
			".github/workflows/zz-dir.yml/notes.txt": "a nested file\n",
		});
		const found = readProducerCensus(root);
		expect(found.files.map((file) => file.path)).toEqual([
			".github/workflows/real.yml",
		]);
		expect(found.problems).toEqual([
			expect.stringContaining(".github/workflows/zz-dir.yml:"),
		]);
	});

	it.skipIf(!symlinkSupported)(
		"reds on a symlinked producer file instead of following it",
		() => {
			const root = tree({
				".github/workflows/real.yml": `${PROBE}    steps: []
`,
			});
			symlinkSync(
				join(root, ".github/workflows/real.yml"),
				join(root, ".github/workflows/link.yml"),
			);
			const found = readProducerCensus(root);
			// GitHub runs no symlinked workflow, and following the link could read
			// bytes outside the producer roots, so it is reported, never parsed.
			expect(found.files.map((file) => file.path)).toEqual([
				".github/workflows/real.yml",
			]);
			expect(found.problems).toEqual([
				expect.stringContaining(".github/workflows/link.yml:"),
			]);
		},
	);

	it("reds on an unparseable producer file instead of reading it as site-free", () => {
		const root = tree({
			".github/workflows/broken.yml":
				"jobs:\n  a:\n     steps:\n   - name: bad indentation\n",
		});
		expect(readProducerCensus(root).problems).toEqual([
			expect.stringContaining("unparseable producer file"),
		]);
	});

	it("reads a flow-style key and ignores the key spelled in a comment or a run heredoc", () => {
		const root = tree({
			".github/workflows/parser-smoke.yml": `${PROBE}    steps:
      # continue-on-error: true
      - {name: Flow-style unregistered producer, continue-on-error: true, run: echo hi}
      - name: Writes an example workflow
        run: |
          cat > example.yml <<'YAML'
          jobs:
            demo:
              continue-on-error: true
          YAML
      - name: Mentions the key in a comment
        run: |
          # continue-on-error: true
          echo hi
`,
		});
		const found = readProducerCensus(root);
		expect(found.problems).toEqual([]);
		expect(found.sites.map((site) => site.key)).toEqual([
			".github/workflows/parser-smoke.yml#probe#Flow-style unregistered producer",
		]);
	});

	it("reds on a continue-on-error key at a location that is not a job or a step", () => {
		const root = tree({
			".github/workflows/odd.yml": `${PROBE}    services:
      cache:
        image: redis
        continue-on-error: true
    steps: []
`,
		});
		const found = readProducerCensus(root);
		expect(found.sites).toEqual([]);
		expect(found.problems).toEqual([
			".github/workflows/odd.yml: continue-on-error at an unclassified location: jobs.probe.services.cache.continue-on-error",
		]);
	});

	// F2 plants: a floored row is satisfied only by a live line of a step the
	// runner executes.
	const KEY = ".github/workflows/floor.yml#probe#best effort";
	// The probe job's house with values the document DOES carry: two events and
	// a two-leg matrix (#4609 r5 MEDIUM-1). `PROBE` above is the same job with
	// one event and no matrix, which is itself a plant: a condition that reads
	// `matrix` or another event has no value set there.
	const FACTS = `"on": [push, pull_request]
jobs:
  probe:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        arch: [x64]
`;
	const flooredStep = (
		floor: string,
		evidence = '--count "probe=',
		house = PROBE,
	): string[] => {
		const root = tree({
			".github/workflows/floor.yml": `${house}    steps:
      - name: best effort
        continue-on-error: true
        run: node scripts/producer.mjs
${floor}`,
		});
		const found = readProducerCensus(root);
		expect(found.problems).toEqual([]);
		const site = found.sites.find(
			(entry) => entry.step?.name === "best effort",
		);
		expect(site).toBeDefined();
		return floorProblems(site as CoESite, {
			status: "floored",
			floorStep: "evaluated floor",
			evidence,
			reason: "A fixture row; the reason only has to clear the length floor.",
		});
	};

	/** The one refusal every uncredited floor gets. */
	const NOT_EXECUTABLE = (evidence: string) =>
		`${KEY}: "${evidence}" is not on an executable line of that step's run text`;

	it("accepts a floor the runner reaches and reads as a command", () => {
		expect(
			flooredStep(`      - name: evaluated floor
        run: |
          set -o pipefail
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`),
		).toEqual([]);
		// A heredoc earlier in the same step hides only its own body: the command
		// after the terminator is still the floor (the plant beside this case).
		expect(
			flooredStep(`      - name: evaluated floor
        run: |
          cat <<'EOF' > notes.txt
          a note that mentions --count "probe=$count"
          EOF
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`),
		).toEqual([]);
	});

	it("reds when the only occurrence of the floor sits in a shell comment", () => {
		expect(
			flooredStep(`      - name: evaluated floor
        run: |
          # node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
          echo "handshake layer disabled in this probe"
`),
		).toEqual([
			`${KEY}: "--count "probe=" is not on an executable line of that step's run text`,
		]);
	});

	it("reds when the runner skips the floor step", () => {
		// YAML source vs. the value the parser returns: `"!true"` needs its
		// quotes here, because a bare `!true` is a YAML tag, not a condition.
		for (const [source, value] of [
			["false", "false"],
			["${{ false }}", "${{ false }}"],
			['"!true"', "!true"],
			["${{ 1 > 2 }}", "${{ 1 > 2 }}"],
			["${{ 0 == 1 }}", "${{ 0 == 1 }}"],
			["${{ false && true }}", "${{ false && true }}"],
			// A live status function does not excuse a constant-false conjunct:
			// `always()` is true, so the runner still never reaches the step.
			["${{ always() && 1 > 2 }}", "${{ always() && 1 > 2 }}"],
		] as const) {
			const problems = flooredStep(`      - name: evaluated floor
        if: ${source}
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`);
			expect(problems, source).toContain(
				`${KEY}: its floor step may never run (if: ${value} is not a condition known to run), so the floor is unproven`,
			);
		}
	});

	it("accepts only the if: forms that always run, proven from the document", () => {
		// An allowlist (#4609 r4 MEDIUM-1, r5 MEDIUM-1): the absent condition, the
		// short always-running forms, and a comparison whose literal the parsed
		// document lists. The round-4 door — `!cancelled() && <any context
		// comparison>` — is gone: the second conjunct must be PROVEN, not named.
		for (const source of [
			"${{ !cancelled() }}",
			"${{ always() }}",
			"${{ success() }}",
			"always()",
			"true",
			// Document-proven: `on: [push, pull_request]` and matrix.os has two legs.
			"${{ !cancelled() && matrix.os == 'macos-latest' }}",
			"${{ matrix.os == 'macos-latest' }}",
			"${{ github.event_name == 'pull_request' }}",
			"${{ !cancelled() && github.event_name == 'push' }}",
			// `!=` needs one leg that differs: matrix.os has two, matrix.arch one.
			"${{ matrix.os != 'macos-latest' }}",
			// A conjunction of admitted atoms runs whenever the job runs: the
			// guard and a status form are both decided true.
			"${{ !cancelled() && always() }}",
		]) {
			expect(
				flooredStep(
					`      - name: evaluated floor
        if: ${source}
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
					'--count "probe=',
					FACTS,
				),
				source,
			).toEqual([]);
		}
		// No `if:` at all is the common case and stays admitted.
		expect(
			flooredStep(`      - name: evaluated floor
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`),
		).toEqual([]);
	});

	it("reds on every if: outside the allowlist, including a comparison the document disproves", () => {
		// Each source names a context root or a status function, which the round-2
		// predicate read as proof of liveness, and three of them are the round-4
		// hole: a guarded context comparison is not a form that always runs, and
		// `github.event_name`/`matrix.os` are decided by the same document
		// (#4609 r5 MEDIUM-1). Two message shapes: `unplaceable` (the reader has
		// no value set), and `disproved` (it has one, and the literal is not in it).
		const NOT_KNOWN = "is not a condition known to run";
		const DISPROVED = "is false for every run of this workflow";
		for (const [source, reason] of [
			["${{ !always() }}", NOT_KNOWN],
			["${{ github.event_name == 'never' }}", DISPROVED],
			["${{ success() && failure() }}", NOT_KNOWN],
			["${{ 'github.event_name' == 'never' }}", NOT_KNOWN],
			["${{ env.NEVER_SET }}", NOT_KNOWN],
			["${{ matrix.os == 'never-os' }}", DISPROVED],
			// The round-4 admitted forms, each with a value the document disproves.
			["${{ !cancelled() && github.event_name == 'never' }}", DISPROVED],
			["${{ !cancelled() && github.event_name == 'schedule' }}", DISPROVED],
			["${{ !cancelled() && matrix.os == 'never-os' }}", DISPROVED],
			["${{ matrix.arch != 'x64' }}", DISPROVED],
			// A root the document carries no value set for: a name is not proof.
			["${{ !cancelled() && needs.scope.outputs.smoke == 'true' }}", NOT_KNOWN],
			["${{ !cancelled() && matrix.missing == 'x' }}", NOT_KNOWN],
			["${{ !cancelled() || always() }}", NOT_KNOWN],
			["${{ !(github.event_name == 'push') }}", NOT_KNOWN],
			["${{ matrix.os == macos-latest }}", NOT_KNOWN],
			["${{ false && always() }}", NOT_KNOWN],
			["${{ always() && false }}", NOT_KNOWN],
			// LOW-3, stated behaviour: a trivially true literal is still an
			// expression this reader does not evaluate.
			["${{ 2 > 1 }}", NOT_KNOWN],
		] as const) {
			const problems = flooredStep(
				`      - name: evaluated floor
        if: ${source}
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
				'--count "probe=',
				FACTS,
			);
			// The reason is the prefix; a disproved comparison appends the values
			// the document allows, which the case beside this one pins exactly.
			expect(problems.join("\n"), source).toContain(
				`${KEY}: its floor step may never run (if: ${source} ${reason}`,
			);
			expect(problems.join("\n"), source).toContain(
				"), so the floor is unproven",
			);
		}
	});

	it("names the values the document allows when it disproves a guarded comparison", () => {
		// The reason is evidence, not a verdict: it prints the set the literal was
		// measured against, so a reader can check the claim from the workflow.
		const source = "${{ !cancelled() && matrix.os == 'never-os' }}";
		expect(
			flooredStep(
				`      - name: evaluated floor
        if: ${source}
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
				'--count "probe=',
				FACTS,
			),
		).toEqual([
			`${KEY}: its floor step may never run (if: ${source} is false for every run of this workflow: matrix.os is ubuntu-latest, macos-latest), so the floor is unproven`,
		]);
	});

	it("reds on a job if: the document proves can never be true, and admits a legitimate one", () => {
		// LOW-1: the enclosing job's `if:` gates every floor inside it and was
		// never read. Its property is weaker than the step's (a false job
		// condition skips the site too), so only a decided FALSE or an atom the
		// reader cannot place refuses.
		const withJob = (line: string): string[] =>
			flooredStep(
				`      - name: evaluated floor
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
				'--count "probe=',
				`"on": [push, pull_request]\njobs:\n  probe:\n    runs-on: ubuntu-latest\n${line ? `    ${line}\n` : ""}`,
			);
		for (const [source, tail] of [
			["false", "that is never true for this workflow"],
			["${{ false }}", "that is never true for this workflow"],
			[
				"${{ github.event_name == 'never' }}",
				"that is never true for this workflow",
			],
			[
				"${{ github.event_name == 'schedule' }}",
				"that is never true for this workflow",
			],
			[
				"${{ github.event_name == 'never' || github.event_name == 'schedule' }}",
				"that is never true for this workflow",
			],
			["${{ contains(github.ref, 'master') }}", "this reader cannot place"],
			[
				"${{ startsWith(github.ref, 'refs/heads/master') }}",
				"this reader cannot place",
			],
		] as const) {
			expect(withJob(`if: ${source}`), source).toContain(
				`${KEY}: its job carries an if: ${source} ${tail}, so the floor is unproven`,
			);
		}
		// The live shape (`install-smoke.yml#lsp-handshake`): an event the workflow
		// declares, and a `needs` output the document does not decide. Both leave
		// the job reachable, so the floor is not disarmed.
		for (const source of [
			"${{ github.event_name == 'pull_request' && needs.scope.outputs.smoke == 'true' }}",
			"${{ github.event_name == 'push' }}",
			"${{ needs.scope.outputs.smoke == 'true' }}",
			"${{ inputs.lines != '' }}",
			"${{ false || needs.scope.outputs.smoke == 'true' }}",
			"true",
		] as const)
			expect(withJob(`if: ${source}`), source).toEqual([]);
	});

	it("reds when the floor evidence is shell data the runner never executes", () => {
		// The text is present, but the shell reads it as data (a heredoc body, a
		// quoted argument) or never reaches it (an unconditional `exit` above).
		// Each of these read [] before #4609 r2.
		for (const [shape, body] of [
			[
				"a heredoc body",
				`          cat <<'EOF' > /dev/null
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
          EOF
`,
			],
			[
				"a quoted echo",
				`          echo 'node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3'
`,
			],
			[
				"an early exit",
				`          exit 0
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
			// r3 MEDIUM-2: an exit behind an operator or a block still ends the
			// script, and one inside a subshell or an `if` may.
			[
				"an exit behind &&",
				`          false && exit 0
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
			[
				"an exit in a subshell",
				`          ( exit 0 )
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
			[
				"an exit in an if body",
				`          if [ -n "$SKIP" ]; then exit 0; fi
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
		] as const) {
			expect(
				flooredStep(`      - name: evaluated floor
        run: |
${body}`),
				shape,
			).toEqual([NOT_EXECUTABLE('--count "probe=')]);
		}
	});

	it("credits floor evidence only in the argument list of a measuring invocation", () => {
		// r3 MEDIUM-2: the round-2 rule rejected four data regions and credited
		// every other unquoted match, so a printed command and a never-reached
		// shell region both satisfied the floor. The allowlist admits only a
		// floor flag on a top-level measuring invocation.
		for (const [shape, body] of [
			[
				"an echo in argument position",
				`          echo --count "probe=$count"
`,
			],
			[
				"an echo of the whole command",
				`          echo node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
			[
				"a printf of the whole command",
				`          printf '%s\\n' node scripts/assert-evaluated.mjs --count "probe=$count"
`,
			],
			[
				"an uncalled function",
				`          probe() {
            node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
          }
`,
			],
			[
				"an if false branch",
				`          if false; then
            node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
          fi
`,
			],
			[
				"an if true branch",
				`          if true; then
            node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
          fi
`,
			],
			[
				"a case branch",
				`          case "$MODE" in
            probe) node scripts/assert-evaluated.mjs --count "probe=$count" ;;
          esac
`,
			],
			[
				"a subshell",
				`          ( node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3 )
`,
			],
			[
				"a second command on the line",
				`          true; node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
			[
				"a chained command",
				`          true && node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
			[
				"a one-line if body",
				`          if true; then node scripts/assert-evaluated.mjs --count "probe=$count"; fi
`,
			],
			[
				"a second command on the line that prints the flag",
				`          node scripts/assert-evaluated.mjs --count "other=$other" ; echo --count "probe=$count"
`,
			],
			[
				"a different program",
				`          npm run probe -- --count "probe=$count"
`,
			],
		] as const) {
			expect(
				flooredStep(`      - name: evaluated floor
        run: |
${body}`),
				shape,
			).toEqual([NOT_EXECUTABLE('--count "probe=')]);
		}
		// A trailing pipeline or handler after the invocation is credited: the
		// command has already run when the handler sees its status. Both live
		// workflows depend on this (`| tee …` and `|| floor=$?`).
		for (const body of [
			`          set -o pipefail
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3 2>&1 | tee "$RUNNER_TEMP/x.log"
`,
			`          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 1 || floor=$?
`,
		] as const)
			expect(
				flooredStep(`      - name: evaluated floor
        run: |
${body}`),
				body,
			).toEqual([]);
	});

	it("joins a shell line continuation before it decides which command the line is", () => {
		// r4 MEDIUM-2: the scanner read every PHYSICAL line as a command, so a
		// continued line's text was the previous command's argument list. The
		// shell removes `\`+newline and keeps reading after `&&`/`||`/`|`, so the
		// credited line's head is on the line before, and only a logical line that
		// STARTS a measuring invocation is credited.
		for (const [shape, body] of [
			[
				"an echo continued with a backslash",
				`          echo \\
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
			[
				"a test continued with a backslash",
				`          [ "$MODE" = full ] \\
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
			[
				"a false conjunct that needs the next line",
				`          false &&
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
			[
				"a printf continued with a backslash",
				`          printf '%s\\n' \\
          node scripts/assert-evaluated.mjs --count "probe=$count"
`,
			],
			[
				"an unfinished pipeline",
				`          echo hi |
          node scripts/assert-evaluated.mjs --count "probe=$count"
`,
			],
			[
				"a true conjunct that needs the next line",
				`          true &&
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			],
		] as const) {
			expect(
				flooredStep(`      - name: evaluated floor
        run: |
${body}`),
				shape,
			).toEqual([NOT_EXECUTABLE('--count "probe=')]);
		}
		// The legitimate form the physical-line reader refused: the invocation is
		// split across lines by its own continuation, so the join credits it.
		for (const body of [
			`          node scripts/assert-evaluated.mjs \\
            --count "probe=$count" --floor 3
`,
			`          node scripts/complexity-report.mjs \\
            | tee complexity-report.txt
`,
		]) {
			expect(
				flooredStep(
					`      - name: evaluated floor
        run: |
${body}`,
					body.includes("complexity-report")
						? "scripts/complexity-report.mjs"
						: '--count "probe=',
				),
				body,
			).toEqual([]);
		}
	});

	it("ends the script only on an exit in command position, not on the word exit", () => {
		// Greptile P2 on the r4 head (shape 43, text read as structure): `sawExit`
		// fired on any `exit` TOKEN, so `echo exit` and `grep -n exit f` ended the
		// script and refused a floor the shell does run.
		for (const body of [
			`          echo exit
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			`          grep -n exit file
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			`          VAR=exit
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			`          exit_code=1
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
		]) {
			expect(
				flooredStep(`      - name: evaluated floor
        run: |
${body}`),
				body,
			).toEqual([]);
		}
		// An exit the shell really runs still ends it, including behind a prefix
		// word the reader must see through.
		for (const body of [
			`          command exit 0
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			`          exec exit 0
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
			`          echo done; exit 0
          node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
		]) {
			expect(
				flooredStep(`      - name: evaluated floor
        run: |
${body}`),
				body,
			).toEqual([NOT_EXECUTABLE('--count "probe=')]);
		}
	});

	it("credits a floor the script argument itself proves, only for a measuring script", () => {
		// `lint.yml`'s complexity floor is the script path, not a flag: it is
		// credited on the invocation that runs it and refused on anything that
		// merely prints the path.
		expect(
			flooredStep(
				`      - name: evaluated floor
        run: |
          set -o pipefail
          node scripts/complexity-report.mjs | tee complexity-report.txt
`,
				"scripts/complexity-report.mjs",
			),
		).toEqual([]);
		for (const body of [
			"          ls scripts/complexity-report.mjs\n",
			"          cat scripts/complexity-report.mjs\n",
			"          echo scripts/complexity-report.mjs\n",
		] as const)
			expect(
				flooredStep(
					`      - name: evaluated floor
        run: |\n${body}`,
					"scripts/complexity-report.mjs",
				),
				body,
			).toEqual([NOT_EXECUTABLE("scripts/complexity-report.mjs")]);
		// Evidence that names the program, not an argument, proves nothing: the
		// match has to start at or after the invocation's script argument.
		expect(
			flooredStep(
				`      - name: evaluated floor
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`,
				"node",
			),
		).toEqual([NOT_EXECUTABLE("node")]);
	});

	it("reds when the floor step is itself continue-on-error", () => {
		expect(
			flooredStep(`      - name: evaluated floor
        continue-on-error: true
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
`),
		).toContain(
			`${KEY}: its floor step is continue-on-error, so the floor gates nothing`,
		);
	});

	it("reds when the floor step runs before the site it is meant to gate", () => {
		const root = tree({
			".github/workflows/floor.yml": `${PROBE}    steps:
      - name: evaluated floor
        run: node scripts/assert-evaluated.mjs --count "probe=$count" --floor 3
      - name: best effort
        continue-on-error: true
        run: node scripts/producer.mjs
`,
		});
		const found = readProducerCensus(root);
		const site = found.sites.find(
			(entry) => entry.step?.name === "best effort",
		);
		expect(site).toBeDefined();
		expect(
			floorProblems(site as CoESite, {
				status: "floored",
				floorStep: "evaluated floor",
				evidence: '--count "probe=',
				reason: "A fixture row; the reason only has to clear the length floor.",
			}),
		).toEqual([
			`${KEY}: its floor step runs before the site it is meant to gate`,
		]);
	});

	it("reds on a registry row whose fields do not match its status", () => {
		const reason = "A fixture reason, long enough to clear the length floor.";
		expect([
			...rowProblems("floored-x", { status: "floored", reason }),
			...rowProblems("governed-x", {
				status: "governed-by",
				governedBy: "4514",
				tests: [],
				reason,
			}),
			...rowProblems("no-floor-x", {
				status: "no-floor",
				floorStep: "a floor",
				reason,
			}),
			...rowProblems("status-x", {
				status: "waived" as CoEStatus,
				reason,
			}),
		]).toEqual([
			"floored-x: a floored row needs floorStep",
			"floored-x: a floored row needs evidence",
			"governed-x: a governed-by row needs tests",
			'governed-x: governed-by rows name an issue as "#<n>"',
			"no-floor-x: a no-floor row does not carry floorStep",
			'status-x: unknown status "waived"',
		]);
	});

	it("reds when a governed-by test is a path with no live test vitest collects", () => {
		const root = tree({
			"tests/config/live.test.ts":
				'import { it } from "vitest";\nit("runs", () => {});\n',
			"tests/config/skipped.test.ts":
				'import { it } from "vitest";\nit.skip("never runs", () => {});\n',
			// LOW-2: a wrapper with no test of its own proves nothing.
			"tests/config/describe-only.test.ts":
				'import { describe } from "vitest";\ndescribe("wrapper", () => {});\n',
			// The `test` spelling of a live declaration is admitted beside `it`.
			"tests/config/test-call.test.ts":
				'import { test } from "vitest";\ntest("runs", () => {});\n',
			"tests/support/helpers.ts": "export const helper = 1;\n",
			// A collected tree's excluded sibling: vitest never runs it (#4393).
			"tests/fixtures/probe.test.ts": 'it("fixture suite", () => {});\n',
		});
		// The only accepted proof: a live declaration in a file vitest collects.
		expect(
			governedByTestProblems(root, "k", "tests/config/live.test.ts"),
		).toEqual([]);
		expect(governedByTestProblems(root, "k", "tests/config")).toEqual([
			"k: tests/config is not a file",
		]);
		expect(
			governedByTestProblems(root, "k", "tests/config/missing.test.ts"),
		).toEqual(["k: tests/config/missing.test.ts is not a file"]);
		expect(
			governedByTestProblems(root, "k", "tests/support/helpers.ts"),
		).toEqual(["k: tests/support/helpers.ts declares no live test"]);
		expect(
			governedByTestProblems(root, "k", "tests/config/skipped.test.ts"),
		).toEqual(["k: tests/config/skipped.test.ts declares no live test"]);
		expect(
			governedByTestProblems(root, "k", "tests/config/describe-only.test.ts"),
		).toEqual(["k: tests/config/describe-only.test.ts declares no live test"]);
		expect(
			governedByTestProblems(root, "k", "tests/config/test-call.test.ts"),
		).toEqual([]);
		expect(
			governedByTestProblems(root, "k", "tests/fixtures/probe.test.ts"),
		).toEqual(["k: vitest does not collect tests/fixtures/probe.test.ts"]);
	});

	it("keeps a # that is an expansion or a quoted value when it strips comments", () => {
		expect(stripShellComments('echo "${v#p}" $# "a # b" # tail\n')).toBe(
			'echo "${v#p}" $# "a # b" \n',
		);
	});
});
