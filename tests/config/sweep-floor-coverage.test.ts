import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const SELF = "tests/config/sweep-floor-coverage.test.ts";

/**
 * Sweep shape requires both an enumeration and an emptiness assertion. The
 * production-symbol list remains an intent exception for registries whose
 * walk is not syntactically obvious. Static detection is evadable by
 * construction; this catches natural shapes, while the exception list catches
 * intent. Exported as a pure function (source in, boolean out) so the
 * emptiness alternation can be unit-tested against literal snippets, not
 * only inferred from a whole-tree census.
 * Floor-call registration matches over comment/string-blanked source so
 * a call named only in prose cannot self-register (#2710; AGENTS.md
 * shape 38, #2693 r2 F1).
 */
export function looksSweepShaped(source: string): boolean {
	const enumerates =
		/(?:fs\.readdirSync|(?<![A-Za-z0-9_$])readdirSync|fs\.promises\.readdir|(?<![A-Za-z0-9_$.])readdir(?!Sync)|globSync|listSourceFiles|clientSourceFiles)/.test(
			source,
		) ||
		/(?:assertNonEmptyScan|auditRegistry|scanDualInstanceImports|LSP_SERVERS|LSP_FIXTURES|ALL_FORMATTERS|DYNAMIC_OR_EXEMPT|isTimingSensitive|scanHostEventShapeViolations)/.test(
			source,
		);
	// #2088 fix round 3, R1: the mainstream `expect(x.length).toBe(0)`
	// spelling (14 existing test files use it) was missing from this
	// alternation, so a sweep written that way never registered as
	// sweep-shaped at all -- invisible to the meta-sweep, not merely
	// unfloored.
	const empties =
		/\.toEqual\(\s*\[\s*\]\s*\)|\.toHaveLength\(\s*0\s*\)|\.toStrictEqual\(\s*\[\s*\]\s*\)|\.length\s*\)\s*\.toBe\(\s*0\s*\)/.test(
			source,
		);
	return enumerates && empties;
}

/**
 * Does this sweep-shaped file make a real sweep-kit floor call? #2710:
 * matched over stripSource-blanked source (AGENTS.md shape 38; the
 * raw-vs-blanked mismatch #2693 r2 F1 fixed in the runner-spawn-cwd sweep)
 * so a helper name quoted in a comment or string cannot register a file
 * that never called it.
 */
function isRegisteredFloorSource(source: string): boolean {
	const stripped = stripSource(source);
	return (
		/assertNonEmptyScan\s*\(/.test(stripped) ||
		/auditRegistry\s*\(\s*\{[\s\S]*?\bminScanned\s*:/.test(stripped)
	);
}

function sweepShapeFiles(): string[] {
	return listSourceFiles(TESTS_ROOT, { extensions: [".ts"] })
		.filter((file) => file.endsWith(".test.ts"))
		.filter((file) => relativePosix(REPO_ROOT, file) !== SELF)
		.filter((file) =>
			looksSweepShaped(stripSource(fs.readFileSync(file, "utf8"))),
		);
}

const DECLARED_EXCEPTIONS: Readonly<Record<string, string>> = {
	// #2725: two-direction set equality over every .d.mts/.mjs sibling pair; the
	// failure list is the whole registry and there are no exemptions by design.
	"tests/config/dmts-export-drift.test.ts":
		"set equality over sibling pairs, no exemption table to audit",
	"tests/clients/dispatch/format-smoke-style-contract.test.ts":
		"contract fixture assertions, not a registered-or-fail source population sweep",
	"tests/clients/formatter-probe-commands.test.ts":
		"direct formatter probe behavior tests; the formatter registry sweep is formatter-policy-consistency",
	"tests/clients/formatters.test.ts":
		"formatter marker parity assertion; formatter registry coverage is tested by formatter-policy-consistency",
	"tests/clients/runtime-tool-result.test.ts":
		"runtime seam behavior cases; filesystem counters verify re-detection, not a population sweep",
	"tests/clients/language-policy.test.ts":
		"policy unit cases over synthetic language definitions, not a production walk",
	"tests/clients/lsp/lsp-primary-reachability.test.ts":
		"synthetic candidate-routing behavior tests; server population coverage is lsp-fixture-coverage",
	"tests/clients/lsp/lsp-registry-consistency.test.ts":
		"registry relation assertions without a blindable source walk",
	"tests/clients/lsp/server-policy.test.ts":
		"server policy behavior cases, not the LSP fixture population sweep",
	"tests/tools/lens-diagnostics.test.ts":
		"diagnostic projection behavior cases, not a production population sweep",
	"tests/clients/ast-grep-rule-precedence-followups.test.ts":
		"rule precedence fixtures, not a production population sweep",
	"tests/clients/atomic-write.test.ts":
		"atomic-write behavior cases, not a production population sweep",
	"tests/clients/bundled-resource-health.test.ts":
		"mocks node:fs's readdirSync for one EACCES fault-injection case and asserts notify/degradation counts with toHaveLength(0); not a registered-or-fail production population sweep (#2636, same shape as skills-resolver.test.ts below)",
	"tests/clients/bus-producer-coverage.test.ts":
		"bus contract cases, not a registered-or-fail population sweep",
	"tests/clients/coderabbit-ast-grep-rules.test.ts":
		"rule fixtures, not a production population sweep",
	"tests/clients/debug-heap.test.ts":
		"heap diagnostic cases, not a production population sweep",
	"tests/clients/delivery-surface-ratchet.test.ts":
		"carries its own declared floor at the 'ratchet floor: at least one " +
		"advisory-marker file detected' check (count >= 3)",
	"tests/clients/deps-centralization.test.ts":
		"dependency relation cases, not a production population sweep",
	"tests/clients/diagnostic-dispositions.test.ts":
		"disposition cases, not a production population sweep",
	"tests/clients/dispatch/dispatch-coverage.test.ts":
		"dispatch relation cases; its stale-entry check is not a population sweep",
	"tests/clients/dispatch/runners/ast-grep-rule-tests.test.ts":
		"rule fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/ast-grep-rule-validity.test.ts":
		"rule fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/ast-grep-tsx-coverage.test.ts":
		"rule fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/garbage-battery.test.ts":
		"runner fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/helm-render.test.ts":
		"render fixtures, not a production population sweep",
	"tests/clients/dispatch/runners/parsed-nothing-sweep.test.ts":
		"runner outcome cases, not a production population sweep",
	"tests/clients/dispatch/runners/run-outcome-ratchet.test.ts":
		"runner outcome cases, not a production population sweep",
	"tests/clients/extension-terminal-silence.test.ts":
		"terminal behavior cases, not a production population sweep",
	"tests/clients/gzip-stage-write.test.ts":
		"gzip stage cases, not a production population sweep",
	"tests/clients/instance-reaper-prune-concurrency.test.ts":
		"concurrency cases, not a production population sweep",
	"tests/clients/instance-registry.test.ts":
		"registry behavior cases, not a production population sweep",
	"tests/clients/lsp/edits.test.ts":
		"edit behavior cases, not a production population sweep",
	"tests/clients/lsp/ruby-drive-dirs.test.ts":
		"path behavior cases, not a production population sweep",
	"tests/clients/pi-host-contract.test.ts":
		"host contract cases, not a production population sweep",
	"tests/clients/project-diagnostics/scanner.test.ts":
		"scanner behavior cases, not a production population sweep",
	"tests/clients/project-snapshot.test.ts":
		"snapshot behavior cases, not a production population sweep",
	"tests/clients/recent-touches.test.ts":
		"touch behavior cases, not a production population sweep",
	"tests/clients/review-graph-git-stamp.test.ts":
		"graph behavior cases, not a production population sweep",
	"tests/clients/review-graph-superseded-persist.test.ts":
		"persistence behavior cases, not a production population sweep",
	"tests/clients/session-state-store.test.ts":
		"store behavior cases, not a production population sweep",
	"tests/clients/skills-resolver.test.ts":
		"mocks node:fs's readdirSync for one EACCES fault-injection case and asserts notify/degradation counts with toHaveLength(0); not a registered-or-fail production population sweep",
	"tests/clients/tree-sitter-879-post-filters.test.ts":
		"tree-sitter behavior cases, not a production population sweep",
	"tests/clients/tree-sitter-query-loader.test.ts":
		"mocks node:fs's readdirSync to fault-inject the bundled tree-sitter-queries root and asserts notify/degradation counts with toHaveLength(0); not a registered-or-fail production population sweep (#2636, same shape as skills-resolver.test.ts)",
	"tests/clients/tree-sitter-cache-stats-astgrep-coverage.test.ts":
		"tree-sitter behavior cases, not a production population sweep",
	"tests/host-sdk-type-only.test.ts":
		"host type cases, not a production population sweep",
	"tests/packaging.test.ts":
		"packaging behavior cases, not a production population sweep",
	"tests/scripts/exec-isolation.test.ts":
		"checks a freshly created temp directory is empty, not a production " +
		"population sweep",
	"tests/scripts/ci-verdict.test.ts":
		"enumerates .github/workflows/*.yml job names for gating/advisory " +
		"classification (#2618 F3) -- an external CI-contract governance " +
		"walk, not a clients/ production module registry sweep",
	"tests/scripts/no-hardcoded-machine-paths.test.ts":
		"carries its own declared floor at the 'scans a nonzero number of " +
		"script files' check (files.length > 10)",
	"tests/scripts/rollup-changelog.test.ts":
		"changelog behavior cases, not a production population sweep",
	"tests/scripts/smoke-tools-cue-fixture.test.ts":
		"smoke fixture cases, not a production population sweep",
	"tests/scripts/warm-loader-cache.test.ts":
		"loader behavior cases, not a production population sweep",
	"tests/skills/skill-doc-drift.test.ts":
		"skill documentation cases, not a production population sweep",
	"tests/typescript-runtime-free.test.ts":
		"runtime dependency cases, not a production population sweep",
};

describe("registered-or-fail sweep floors", () => {
	it("every sweep-shaped test uses sweep-kit or declares a reason", () => {
		const files = sweepShapeFiles().map((file) =>
			relativePosix(REPO_ROOT, file),
		);
		const registered = files.filter((file) =>
			isRegisteredFloorSource(
				fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
			),
		);
		const scannedCount = listSourceFiles(TESTS_ROOT, {
			extensions: [".ts"],
		}).filter((file) => file.endsWith(".test.ts")).length;
		const audit = auditRegistry({
			sweepName: "sweep-floor meta-sweep",
			flagged: files,
			registered,
			exemptions: DECLARED_EXCEPTIONS,
			// Calibration: 831 test files walked on 2026-08-27 (fix round 3, #2088
			// R1: the `.length).toBe(0)` alternation added above pulled 3 more
			// already-registered sweep files into the census); half is 416,
			// rounded up to the documented 420 floor.
			scannedCount,
			minScanned: 420,
			// Calibration: this census flags 58 sweep-shaped files on 2026-08-27
			// (fix round 3) -- 13 registered via assertNonEmptyScan/minScanned, 45
			// declared exceptions. Half of 58 rounded up is 29. Earlier figures (28
			// for a census of 55) were accurate as of round 2 but went stale the
			// moment the R1 regex fix changed what counts as sweep-shaped.
			// Recalibrate by reading this test's OWN measured numbers, not by
			// copying a figure from a comment or a PR body.
			minFlagged: 29,
			minReasonLength: 20,
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});
});

describe("looksSweepShaped emptiness detection (#2088 fix round 3, R1)", () => {
	const enumerateLine = "for (const f of fs.readdirSync(dir)) { use(f); }";

	// Mutation-proof: the R1 fix from a census of 55 to 58 pulled in files
	// spelled exactly this way (grep confirms 14 existing test files use
	// `expect(x.length).toBe(0)`). Deleting the new alternative from the
	// `empties` regex above must red this exact case.
	it("recognizes the expect(x.length).toBe(0) spelling", () => {
		const source = `${enumerateLine}\nexpect(violations.length).toBe(0);`;
		expect(looksSweepShaped(source)).toBe(true);
	});

	it("still recognizes the three previously-supported spellings", () => {
		expect(
			looksSweepShaped(`${enumerateLine}\nexpect(violations).toEqual([]);`),
		).toBe(true);
		expect(
			looksSweepShaped(`${enumerateLine}\nexpect(violations).toHaveLength(0);`),
		).toBe(true);
		expect(
			looksSweepShaped(
				`${enumerateLine}\nexpect(violations).toStrictEqual([]);`,
			),
		).toBe(true);
	});

	it("does not flag an enumeration with no emptiness assertion at all", () => {
		expect(
			looksSweepShaped(`${enumerateLine}\nexpect(violations.length).toBe(3);`),
		).toBe(false);
	});

	it("does not flag an emptiness assertion with no enumeration", () => {
		expect(looksSweepShaped("expect(x.length).toBe(0);")).toBe(false);
	});
});

describe("floor-call registration over blanked source (#2710)", () => {
	// Red-first proof for the #2710 recurrence: a sweep file whose only
	// floor-call mention lives in a comment or a string must stay
	// unregistered, and the same file with a real call must register. The
	// file-level fixture drives the same walk/detect/register/audit
	// pipeline as the meta-sweep above over real fixture files on disk.
	const commentOnlyFixture = [
		`import * as fs from "node:fs";`,
		`import { assertNonEmptyScan } from "../support/sweep-kit.js";`,
		`describe("fixture", () => {`,
		`\tit("scans", () => {`,
		`\t\t// Registered via assertNonEmptyScan("fixture", files.length);`,
		`\t\tconst files = fs.readdirSync(dir);`,
		`\t\texpect(violations).toEqual([]);`,
		`\t});`,
		`});`,
		`const note = "quoted: assertNonEmptyScan(x)";`,
	].join("\n");
	const realCallFixture = [
		`import * as fs from "node:fs";`,
		`import { assertNonEmptyScan } from "../support/sweep-kit.js";`,
		`describe("fixture", () => {`,
		`\tit("scans", () => {`,
		`\t\tconst files = fs.readdirSync(dir);`,
		`\t\texpect(violations).toEqual([]);`,
		`\t\tassertNonEmptyScan("fixture", files.length);`,
		`\t});`,
		`});`,
	].join("\n");

	it("does not register a floor call named only in a comment", () => {
		expect(
			isRegisteredFloorSource(`// registered via assertNonEmptyScan("x", 1);`),
		).toBe(false);
	});

	it("does not register a floor call quoted inside a string", () => {
		expect(
			isRegisteredFloorSource(
				`const note = "call assertNonEmptyScan(x) here";`,
			),
		).toBe(false);
	});

	it("registers a real assertNonEmptyScan floor call", () => {
		expect(isRegisteredFloorSource(`assertNonEmptyScan("x", 1);`)).toBe(true);
	});

	it("registers a real auditRegistry minScanned floor call", () => {
		expect(
			isRegisteredFloorSource(
				`const audit = auditRegistry({ flagged, minScanned: 420 });`,
			),
		).toBe(true);
	});

	it("reports a prose-only fixture sweep file uncovered and passes a real call", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-floor-2710-"));
		try {
			fs.writeFileSync(
				path.join(root, "comment-only.test.ts"),
				commentOnlyFixture,
			);
			fs.writeFileSync(path.join(root, "real-call.test.ts"), realCallFixture);
			const flagged = listSourceFiles(root, { extensions: [".ts"] }).filter(
				(file) => looksSweepShaped(stripSource(fs.readFileSync(file, "utf8"))),
			);
			expect(flagged.map((file) => relativePosix(root, file))).toEqual([
				"comment-only.test.ts",
				"real-call.test.ts",
			]);
			const registered = flagged.filter((file) =>
				isRegisteredFloorSource(fs.readFileSync(file, "utf8")),
			);
			const audit = auditRegistry({
				sweepName: "#2710 fixture sweep",
				flagged: flagged.map((file) => relativePosix(root, file)),
				registered: registered.map((file) => relativePosix(root, file)),
				exemptions: {},
			});
			expect(audit.unaccounted).toEqual(["comment-only.test.ts"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
