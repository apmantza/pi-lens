#!/usr/bin/env node
// scripts/pre-push-targeted-tests.mjs (#1804)
//
// Runs a targeted vitest selection before a push: a build, then the test
// files that plausibly cover the changed .ts files. Never the full suite —
// the suite is machine-wide-locked (#1101) and CI is authoritative.
//
// Selection is two passes over `tests/**/*.test.ts`, per changed file:
//   1. Path mirror: a changed `clients/foo/bar.ts` selects
//      `tests/clients/foo/bar.test.ts` if it exists — an exact mirrored
//      path, not a basename-only guess.
//   2. Import resolution: every test file's own relative import specifiers
//      are resolved to absolute, extension-stripped paths (exactly the way
//      Node/vitest would resolve them) and compared against the changed
//      file's own absolute, extension-stripped path. This is what catches
//      shared-seam siblings the path mirror misses (tests/index-*-wiring
//      test files import shared modules by name, not by mirrored path; see
//      AGENTS.md's "sibling test files encode the same behavior" note) —
//      WITHOUT the false-positive blow-up a substring/basename match causes
//      (multiple `index.ts` files across the tree all share one basename;
//      a prior basename-suffix version of this script selected 282 test
//      files for a 43-file commit, ~10 minutes, because of exactly that).
// A changed test file is always included directly.
//
// Selection is capped at MAX_SELECTED_TESTS: past that, "targeted" has
// stopped meaning anything cheaper than the full suite, so this degrades to
// the armed governance registries alone (bounded by construction; build-only
// when none is armed) and says so — the "never the full suite" claim holds by
// construction, not by hoping the heuristic stays narrow.
//
// If nothing matches (docs-only / non-.ts changes, or a changed file with no
// covering test), this builds only and skips the test run — never silently
// skips the build too.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quoteForWindowsCmd } from "./with-test-lock.mjs";

export const MAX_SELECTED_TESTS = 25;

// Pre-push budget: 120s. Measured on the built tree on 2026-09-25, the ten
// registry suites took 32.68s (vi-domock-undo, added after, runs in ~3.5s), so
// a production-file push stays a bounded local convenience; CI is still
// authoritative. With the flake-shape ratchet, all twelve registry suites ran
// in 64.91s through this hook on 2026-09-26 (#3492's range, capped selection).
// Suites over the budget on their own
// move to CI_ONLY_PRE_PUSH_TESTS below.

// Suites measured to exceed the documented pre-push budget on their own, so
// they are excluded from the local pre-push selection and run in CI instead
// (#3426 H3432-1). Never a blanket skip: each entry carries a reason and a CI
// row, and `--include-ci-only` admits them in the CI job that owns them. The
// governance suite pins this table, the exclusion, and the CI invocation.
export const CI_ONLY_PRE_PUSH_TESTS = {
	"tests/scripts/guard-bash-hook.test.ts":
		"spawns ~1,270 real hook child processes: the transcript corpus alone measured 169s and the file measured 211s end to end, over the 120s pre-push budget. Runs in the Targeted tests (advisory) CI job via --include-ci-only and in the gating Unit tests job.",
};

// Tree scanners do not import the changed module, so path mirroring and
// import resolution cannot discover them. The governance suite pins this
// executable population against the scanner shape.
export const TREE_SCANNING_GOVERNANCE_TESTS = [
	"tests/clients/session-state-conformance.test.ts",
	"tests/config/glossary-synonym-sweep.test.ts",
	"tests/config/strictness-ratchet.test.ts",
	"tests/config/hook-await-bounds.test.ts",
	"tests/config/dmts-export-drift.test.ts",
	"tests/config/vi-mock-export-sweep.test.ts",
	"tests/config/vi-domock-undo.test.ts",
	"tests/config/degradation-kind-coverage.test.ts",
	"tests/config/degradation-kind-order.test.ts",
	"tests/config/sweep-floor-coverage.test.ts",
	"tests/config/tracked-control-bytes.test.ts",
];

// Suites that scan the TESTS tree for a test shape (a real spawn, a raw timer
// wait, a never-settling promise) instead of importing the changed module, so
// neither pass above selects them. Armed whenever a pushed change touches the
// tests tree. #3472's recurrence (#3492, 2026-09-26): a new test's real 60 s
// setTimeout pushed with the flake-shape ratchet red and failed CI's Unit
// tests. Measured locally at ~17-23 s alone, inside the 120 s budget.
export const TEST_TREE_GOVERNANCE_TESTS = [
	"tests/clients/flake-shape-ratchet.test.ts",
];

export function changesTestTreeFile(file) {
	return toPosix(file).startsWith("tests/");
}

const PRODUCTION_ROOTS = ["clients/", "tools/", "mcp/", "scripts/"];

export function changesProductionFile(file) {
	const normalized = toPosix(file);
	return (
		normalized === "index.ts" ||
		PRODUCTION_ROOTS.some((root) => normalized.startsWith(root))
	);
}

function writeStepSummary(summary) {
	const file = process.env.GITHUB_STEP_SUMMARY;
	if (!file) return;
	appendFileSync(file, `${summary}\n`, "utf8");
}

function writeSelectionSummary({
	changedCount,
	selectedCount,
	totalBeforeCap,
	status,
	excludedCiOnly = [],
}) {
	const lines = [
		"### Targeted test selection",
		"",
		`- Changed source files: ${changedCount}`,
		`- Selected test files: ${selectedCount}`,
		`- Matches before cap: ${totalBeforeCap}`,
		`- CI-only suites deferred: ${excludedCiOnly.length}`,
		`- Result: ${status}`,
	];
	for (const test of excludedCiOnly)
		lines.push(`- CI-only: ${test} (runs in CI)`);
	writeStepSummary(lines.join("\n"));
}

// Matches `from "…"`, `import("…")`, and `require("…")` — the three ways a
// vitest file (or a module it imports) pulls in another module.
const IMPORT_SPECIFIER_RE =
	/(?:from\s+|import\(|require\()\s*["']([^"']+)["']/g;

function toPosix(file) {
	return file.split(path.sep).join("/");
}

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

export function resolveDiffRange() {
	const stdin = readStdin().trim();
	if (stdin) {
		const firstLine = stdin.split("\n")[0]?.trim();
		const parts = firstLine ? firstLine.split(/\s+/) : [];
		const [, localSha, , remoteSha] = parts;
		if (localSha && remoteSha && !/^0+$/.test(remoteSha)) {
			return `${remoteSha}...${localSha}`;
		}
	}
	// New branch (no remote tracking ref yet) or unreadable stdin: diff
	// against origin/master, same baseline CI compares PRs against.
	return "origin/master...HEAD";
}

export function changedFiles(range) {
	try {
		const out = execFileSync("git", ["diff", "--name-only", range], {
			encoding: "utf8",
		});
		return out
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("dist/"));
	} catch (error) {
		console.warn(
			`[pre-push] could not compute diff range "${range}", falling back to a build-only pass: ${error instanceof Error ? error.message : error}`,
		);
		return null;
	}
}

export function collectTestFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectTestFiles(full, out);
		else if (entry.name.endsWith(".test.ts")) out.push(toPosix(full));
	}
	return out;
}

// `clients/foo/bar.ts` -> absolute path to `clients/foo/bar`, extension
// stripped, so a .ts source and the .js/.mjs it compiles to (or a test's
// import of either spelling) compare equal.
function toAbsNoExt(file) {
	return path.resolve(file).replace(/\.(ts|tsx|js|mjs|cjs)$/i, "");
}

function extractRelativeSpecifiers(content) {
	const specifiers = [];
	IMPORT_SPECIFIER_RE.lastIndex = 0;
	let match = IMPORT_SPECIFIER_RE.exec(content);
	while (match) {
		const specifier = match[1];
		if (specifier.startsWith(".")) specifiers.push(specifier);
		match = IMPORT_SPECIFIER_RE.exec(content);
	}
	return specifiers;
}

function readFileSafe(file) {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

// One pass over every test file: read it once, resolve every relative
// import specifier it contains to an absolute extension-stripped path (the
// same resolution Node's own module loader would do), and index the result.
// Built once and reused across every changed file, instead of re-reading
// every test file per changed file.
function buildTestImportIndex(allTests) {
	const index = new Map();
	for (const test of allTests) {
		const content = readFileSafe(test);
		if (content === null) continue;
		const abs = new Set();
		for (const specifier of extractRelativeSpecifiers(content)) {
			abs.add(toAbsNoExt(path.resolve(path.dirname(test), specifier)));
		}
		index.set(test, abs);
	}
	return index;
}

/**
 * @param {string[]} changed
 * @param {string[]} allTests
 * @param {{ includeCiOnly?: boolean }} [options] `includeCiOnly` admits the
 *   `CI_ONLY_PRE_PUSH_TESTS` tier (the CI job passes it); the local pre-push
 *   caller leaves it false so a budget-busting suite never runs there.
 * @returns {{ selected: string[], unmatched: string[], capped: boolean, totalBeforeCap: number, excludedCiOnly: string[] }}
 */
export function selectTargetedTests(changed, allTests, options = {}) {
	const testImportIndex = buildTestImportIndex(allTests);
	const perFile = new Map();

	for (const file of changed) {
		const matches = new Set();
		if (file.endsWith(".test.ts")) {
			if (existsSync(file)) matches.add(toPosix(file));
		} else {
			const mirror = `tests/${toPosix(file).replace(/\.ts$/, "")}.test.ts`;
			if (existsSync(mirror)) matches.add(toPosix(mirror));

			const changedAbsNoExt = toAbsNoExt(file);
			for (const [test, importedAbs] of testImportIndex) {
				if (importedAbs.has(changedAbsNoExt)) matches.add(test);
			}
		}
		perFile.set(file, matches);
	}

	// The heuristic passes above are what the cap bounds. The registries are
	// bounded by construction (their measured cost is in the budget note), so
	// they are kept apart and survive a capped selection: a change to a hub
	// module (clients/lsp/client.ts alone matches 71 test files) otherwise
	// caps and runs nothing at all (#3492, 2026-09-26).
	const heuristic = new Set();
	for (const matches of perFile.values()) {
		for (const test of matches) heuristic.add(test);
	}
	const available = new Set(allTests);
	const armed = new Set();
	const arm = (registry) => {
		for (const test of registry) if (available.has(test)) armed.add(test);
	};
	if (changed.some(changesProductionFile)) arm(TREE_SCANNING_GOVERNANCE_TESTS);
	if (changed.some(changesTestTreeFile)) arm(TEST_TREE_GOVERNANCE_TESTS);

	const selected = new Set([...heuristic, ...armed]);

	// CI-only tier (#3426 H3432-1): remove the suites measured to exceed the
	// pre-push budget unless the caller is the CI job that owns them. The
	// count is disclosed on the summary surface, never silently dropped.
	const excludedCiOnly = [];
	if (options.includeCiOnly !== true) {
		for (const test of selected) {
			if (Object.hasOwn(CI_ONLY_PRE_PUSH_TESTS, test))
				excludedCiOnly.push(test);
		}
		for (const test of excludedCiOnly) selected.delete(test);
	}
	excludedCiOnly.sort();

	const unmatched = changed.filter(
		(file) => !file.endsWith(".test.ts") && perFile.get(file).size === 0,
	);
	const totalBeforeCap = selected.size;
	const capped =
		[...heuristic].filter((test) => selected.has(test)).length >
		MAX_SELECTED_TESTS;

	return {
		selected: capped
			? [...selected].filter((test) => armed.has(test))
			: [...selected],
		unmatched,
		capped,
		totalBeforeCap,
		excludedCiOnly,
	};
}

// Windows CreateProcess can't exec .cmd shims (npm) directly, so those need
// `shell: true`; a real executable (node.exe) never does. Passing a separate
// `args` array alongside `shell: true` is deprecated (DEP0190) because Node
// just space-joins argv without quoting, so a shimmed command gets one
// CRT-quoted string instead — mirrors scripts/with-test-lock.mjs's own
// runCommand fallback.
function runInherit(command, args, { needsShimShell = false } = {}) {
	if (needsShimShell && process.platform === "win32") {
		execFileSync([command, ...args].map(quoteForWindowsCmd).join(" "), {
			stdio: "inherit",
			shell: true,
		});
	} else {
		execFileSync(command, args, { stdio: "inherit", shell: false });
	}
}

const LOCK_TIMEOUT_RE = /timed out after \d+ms waiting for test-suite lock/;

// Runs the targeted vitest selection through with-test-lock.mjs, streaming
// stdout live and mirroring stderr live while also buffering it — the
// buffer is only needed to tell "the shared machine-wide lock timed out"
// (with-test-lock.mjs's own message, PI_LENS_TEST_LOCK_TIMEOUT_MS in
// .husky/pre-push) apart from "the tests actually failed". A lock timeout
// must let the push proceed (the hook is a convenience layer, CI is
// authoritative, and a blocked push queue on a shared machine is worse than
// a skipped local run); a real test failure must still block the push.
function runTargetedTests(selected) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			["scripts/with-test-lock.mjs", "--", "vitest", "run", ...selected],
			{
				stdio: ["ignore", "inherit", "pipe"],
			},
		);
		let stderrBuffer = "";
		child.stderr.on("data", (chunk) => {
			process.stderr.write(chunk);
			stderrBuffer += chunk.toString();
		});
		child.on("error", (error) => {
			resolve({ code: 1, timedOut: false, error });
		});
		child.on("close", (code) => {
			const timedOut = code !== 0 && LOCK_TIMEOUT_RE.test(stderrBuffer);
			resolve({ code: code ?? 1, timedOut });
		});
	});
}

export async function main() {
	const range = resolveDiffRange();
	const changed = changedFiles(range);
	const skipBuild = process.argv.includes("--skip-build");

	if (skipBuild) {
		console.log(
			"[pre-push] build already completed; skipping duplicate build.",
		);
	} else {
		console.log("[pre-push] building...");
		runInherit("npm", ["run", "build"], { needsShimShell: true });
	}

	if (changed === null || changed.length === 0) {
		console.log(
			"[pre-push] no source changes to target; build-only pass complete.",
		);
		writeSelectionSummary({
			changedCount: changed?.length ?? 0,
			selectedCount: 0,
			totalBeforeCap: 0,
			status:
				changed === null
					? "selection unavailable; build-only"
					: "no TypeScript changes; build-only",
		});
		return 0;
	}

	const includeCiOnly = process.argv.includes("--include-ci-only");
	const allTests = collectTestFiles("tests");
	const { selected, unmatched, capped, totalBeforeCap, excludedCiOnly } =
		selectTargetedTests(changed, allTests, { includeCiOnly });

	for (const file of unmatched)
		console.log(`[pre-push] no tests matched ${file}`);

	// Disclosure, not silence (#3426 H3432-1 / defect shape 10): the caller
	// sees which suites were deferred to CI and why.
	for (const file of excludedCiOnly)
		console.log(
			`[pre-push] CI-only suite deferred to CI (${CI_ONLY_PRE_PUSH_TESTS[file]}): ${file}`,
		);
	if (includeCiOnly)
		console.log("[pre-push] --include-ci-only: admitting the CI-only tier.");

	if (capped) {
		console.warn(
			`[pre-push] selection too broad (${totalBeforeCap} test files matched ${changed.length} changed file(s), over the ${MAX_SELECTED_TESTS}-file cap); rely on CI${selected.length > 0 ? `, running only the ${selected.length} governance registry suite(s)` : ""}.`,
		);
		if (selected.length === 0) {
			writeSelectionSummary({
				changedCount: changed.length,
				selectedCount: 0,
				totalBeforeCap,
				status: `cap exceeded (${MAX_SELECTED_TESTS}); build-only`,
				excludedCiOnly,
			});
			return 0;
		}
	}

	if (selected.length === 0) {
		console.log(
			`[pre-push] no test files matched ${changed.length} changed .ts file(s); build-only pass complete.`,
		);
		writeSelectionSummary({
			changedCount: changed.length,
			selectedCount: 0,
			totalBeforeCap,
			status: "no matches; build-only",
			excludedCiOnly,
		});
		return 0;
	}

	writeSelectionSummary({
		changedCount: changed.length,
		selectedCount: selected.length,
		totalBeforeCap,
		status: capped
			? `cap exceeded (${MAX_SELECTED_TESTS}); governance registries only`
			: "selected",
		excludedCiOnly,
	});

	console.log(
		`[pre-push] running ${selected.length} targeted test file(s) for ${changed.length} changed source file(s):`,
	);
	for (const test of selected) console.log(`  - ${test}`);

	const { code, timedOut, error } = await runTargetedTests(selected);
	if (timedOut) {
		console.warn(
			"[pre-push] the shared machine-wide test-suite lock (#1101) timed out; letting the push proceed without the targeted run. CI runs the real gate.",
		);
		return 0;
	}
	if (error) {
		console.warn(
			`[pre-push] could not run targeted tests (${error.message}); letting the push proceed. CI runs the real gate.`,
		);
		return 0;
	}
	return code;
}

// Only run the CLI when this file is the entry point — not when a test
// imports it to exercise selectTargetedTests/etc. directly. Mirrors
// with-test-lock.mjs's own isEntryPoint (win32 case-insensitive fallback
// included for the same reason: a differently-cased invocation path still
// resolves to this file on Windows's default case-insensitive filesystem).
function isEntryPoint() {
	if (!process.argv[1]) return false;
	const invoked = path.resolve(process.argv[1]);
	const self = fileURLToPath(import.meta.url);
	if (invoked === self) return true;
	if (process.platform !== "win32") return false;
	return invoked.toLowerCase() === self.toLowerCase();
}

if (isEntryPoint()) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(
				`[pre-push] ${error instanceof Error ? error.stack || error.message : error}`,
			);
			process.exitCode = 1;
		});
}
