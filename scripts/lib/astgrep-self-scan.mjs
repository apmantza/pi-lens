// Shared core for the pi-lens self-scan (#1718). Split from
// scripts/run-astgrep-pi-lens.mjs so the scan logic is directly unit- and
// integration-testable (tests/support/astgrep-self-scan.test.ts) without
// shelling out to the CLI wrapper.
//
// The self-scan runs ONLY the ast-grep-rules catalog rules tagged
// `category: pi-lens-self-scan` in their YAML front matter -- the dogfooded
// recurring-defect-shape rules from #1158 (raw JSON store writes, win32
// path-qualification misuse, bare host-path ops inside a Windows-committed
// branch). The catalog also ships ~260 general-purpose product rules (the
// rules the LSP runs against END USERS' code); running that full set against
// pi-lens's own tree produces thousands of style-preference hits unrelated
// to this issue (no-any-type, no-non-null-assertion, ...) that would force
// either a silent mega-baseline or an unrelated style migration. The
// category tag is the single source of truth for "which rules are the
// self-scan's job" -- add the tag to a rule's YAML to opt it in, no parallel
// list to keep in sync (AGENTS.md single-source-of-truth rule).
//
// #4865: the same runner and baseline machinery also run the governance
// suite, `scripts/governance-rules/` (code-pattern checks over pi-lens's own
// tests that never ship to users). A suite is a directory with an sgconfig, a
// rule set and a baseline; `SUITES` below is the only list of them.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { safeSpawn } from "../../clients/safe-spawn.js";
import { escapeRegExp } from "../../clients/string-utils.js";
import { gitExecFileSync } from "./git-fixture-env.mjs";

const SELF_SCAN_CATEGORY = "pi-lens-self-scan";

/** A self-scan rule that declares `severity: info` is advisory (#3684): its
 * hits are reported but never gate and never enter the baseline. The rule's
 * own declared severity is the single source of truth -- no parallel list. */
const ADVISORY_SEVERITY = "info";

/**
 * The scan suites, keyed by `--suite` name.
 * - `self-scan`: the shipped catalog's rules tagged `category:
 *   pi-lens-self-scan`, baselined by `file:line` (the #1718 format).
 * - `governance` (#4865): every rule in `scripts/governance-rules/rules/`,
 *   nothing of which ships. Its baseline rows carry a reason each and are keyed
 *   by the finding's content, not its line, so an edit above a baselined member
 *   does not resurface it as new.
 */
export const SUITES = {
	"self-scan": {
		dir: ["rules", "ast-grep-rules"],
		sgConfig: ".sgconfig.yml",
		baseline: "self-scan-baseline.json",
		category: SELF_SCAN_CATEGORY,
		scanPaths: ["clients", "tests"],
		contentKeyed: false,
	},
	governance: {
		dir: ["scripts", "governance-rules"],
		sgConfig: "sgconfig.yml",
		baseline: "baseline.json",
		category: undefined,
		scanPaths: ["clients", "tests"],
		contentKeyed: true,
		reasonedIgnores: true,
	},
};

const DEFAULT_SUITE = SUITES["self-scan"];

/** The suite named `name`; throws on an unknown name (never falls back). */
export function suiteByName(name) {
	const suite = Object.hasOwn(SUITES, name) ? SUITES[name] : undefined;
	if (!suite) {
		throw new Error(
			`[astgrep-self-scan] unknown suite ${JSON.stringify(name)}; known: ${Object.keys(SUITES).join(", ")}`,
		);
	}
	return suite;
}

/** Repo root, derived from this file's own on-disk location -- never a
 * hardcoded machine path (the #1718 defect). */
export function repoRoot() {
	return path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
}

export function rulesDir(root = repoRoot(), suite = DEFAULT_SUITE) {
	return path.join(root, ...suite.dir, "rules");
}

function sgConfigPath(root = repoRoot(), suite = DEFAULT_SUITE) {
	return path.join(root, ...suite.dir, suite.sgConfig);
}

function baselinePath(root = repoRoot(), suite = DEFAULT_SUITE) {
	return path.join(root, ...suite.dir, suite.baseline);
}

function readYamlField(text, key) {
	const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : undefined;
}

/** Reads `metadata.category`, the schema-documented location (see
 * rules/ast-grep-rules/rule-schema.json's `metadata` property) -- not a
 * bespoke top-level field. */
function readMetadataCategory(text) {
	const m = text.match(/^metadata:\s*\n((?:[ \t]+.*\n?)*)/m);
	if (!m) return undefined;
	const inner = m[1].match(/^[ \t]*category:\s*(.+)$/m);
	return inner ? inner[1].trim().replace(/^['"]|['"]$/g, "") : undefined;
}

/** Every rule ID whose YAML declares `metadata: { category: pi-lens-self-scan }`
 * (or, for a suite with no category, every rule in its directory).
 * Reads the rule files directly -- no hand-maintained parallel list. */
export function selfScanRuleIds(root = repoRoot(), suite = DEFAULT_SUITE) {
	const dir = rulesDir(root, suite);
	if (!fs.existsSync(dir)) {
		throw new Error(`[astgrep-self-scan] rules dir not found: ${dir}`);
	}
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
	const ids = [];
	for (const file of files) {
		const text = fs.readFileSync(path.join(dir, file), "utf8");
		if (
			suite.category === undefined ||
			readMetadataCategory(text) === suite.category
		) {
			const id = readYamlField(text, "id");
			if (id) ids.push(id);
		}
	}
	return ids.sort();
}

/**
 * The ast-grep CLI, run with `root` as its cwd. A relative search-path entry
 * (husky's pre-push hook prepends `node_modules/.bin`) resolves against the
 * child's cwd, `root`; the same entry resolved against this process's cwd
 * follows it, so a scan rooted outside the checkout still finds the CLI
 * instead of failing with ENOENT (#4865). The entry is rewritten under the key
 * the environment already uses.
 */
function spawnAstGrep(args, root) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() !== "PATH" || typeof env[key] !== "string") continue;
		env[key] = env[key]
			.split(path.delimiter)
			.flatMap((entry) =>
				entry && !path.isAbsolute(entry)
					? [entry, path.resolve(entry)]
					: [entry],
			)
			.join(path.delimiter);
	}
	return safeSpawn("ast-grep", args, { cwd: root, env });
}

/**
 * Runs the self-scan rule set (or an explicit `ruleIds` override, used by
 * the registered-or-fail fixture test) against `scanPaths` under `root`.
 *
 * Throws if the ast-grep CLI itself fails to spawn, or if `ruleIds` resolves
 * to an empty set -- an accidental empty rule set must fail loud, not read as
 * "clean scan, 0 findings" (AGENTS.md defect-shape 10).
 */
export function runSelfScan({
	root = repoRoot(),
	suite = DEFAULT_SUITE,
	scanPaths = suite.scanPaths,
	ruleIds,
	// Override hook for the wrapper-level failure test (#1729 review round):
	// point the scan at a broken/nonexistent sgconfig to prove the CLI
	// wrapper exits nonzero on a genuine scan failure, not just an untriaged
	// finding.
	sgConfigPath: sgConfigPathOverride,
} = {}) {
	const ids = ruleIds ?? selfScanRuleIds(root, suite);
	if (ids.length === 0) {
		throw new Error(
			`[astgrep-self-scan] no rules tagged category: ${suite.category ?? "(any)"} under ${rulesDir(root, suite)} -- nothing to run. If every self-scan rule was intentionally removed, delete this script and its CI wiring instead of letting it report a silent "clean" scan.`,
		);
	}
	const filterRegex = `^(${ids.map(escapeRegExp).join("|")})$`;
	const result = spawnAstGrep(
		[
			"scan",
			"-c",
			sgConfigPathOverride ?? sgConfigPath(root, suite),
			"--filter",
			filterRegex,
			...scanPaths,
			"--json=compact",
			"--inspect",
			"summary",
		],
		root,
	);
	if (result.error) {
		throw result.error;
	}

	const stderrText = result.stderr ?? "";
	const scannedMatch = stderrText.match(/scannedFileCount=(\d+)/);
	const effectiveRuleMatch = stderrText.match(/effectiveRuleCount=(\d+)/);

	// A genuinely clean scan still emits a literal `[]` on stdout (verified:
	// a 0-finding run over 369 files prints "[]", 3 bytes, exit 0) -- never
	// zero bytes. Zero bytes means ast-grep itself failed before it could
	// emit JSON (bad -c config path, malformed rule YAML, etc.), which
	// previously fell through silently as `findings = []`, indistinguishable
	// from a real clean scan. That must throw, not report "clean".
	const stdout = (result.stdout ?? "").trim();
	if (!stdout) {
		throw new Error(
			`[astgrep-self-scan] ast-grep produced no output (exit status ${result.status ?? "unknown"}) -- treating as a FAILED scan, not a clean one. stderr:\n${stderrText}`,
		);
	}
	let findings;
	try {
		findings = JSON.parse(stdout);
	} catch (e) {
		throw new Error(
			`[astgrep-self-scan] failed to parse ast-grep JSON output: ${e?.message ?? e}\nstdout:\n${stdout}`,
			{ cause: e },
		);
	}

	return {
		ruleIds: ids,
		findings: findings.filter((f) => f.severity !== ADVISORY_SEVERITY),
		advisoryFindings: findings.filter((f) => f.severity === ADVISORY_SEVERITY),
		// undefined (not 0) when ast-grep's --inspect output shape changes
		// underneath us -- an unparsed count must not silently read as
		// "scanned zero files" and trip the dead-scan guard for the wrong
		// reason.
		scannedFileCount: scannedMatch ? Number(scannedMatch[1]) : undefined,
		effectiveRuleCount: effectiveRuleMatch
			? Number(effectiveRuleMatch[1])
			: undefined,
		stderr: stderrText,
	};
}

/** Runs the suite's rule tests (`testConfigs` in its sgconfig: planted
 * members and admitted forms) through `ast-grep test`; returns the spawn
 * result, whose `status` is 0 only when every case passed (#4865). */
export function runRuleTests(root = repoRoot(), suite = DEFAULT_SUITE) {
	return spawnAstGrep(
		["test", "-c", sgConfigPath(root, suite), "--skip-snapshot-tests"],
		root,
	);
}

export function findingSignature(finding) {
	const file = String(finding.file ?? "?").replace(/\\/g, "/");
	const line = finding.range?.start?.line ?? 0;
	return `${finding.ruleId ?? "unknown"}::${file}::${line}`;
}

/**
 * One signature per finding, in order. A line-keyed suite uses
 * `findingSignature`. A content-keyed suite (#4865) uses
 * `rule::file::<hash of the whitespace-collapsed match>#<n>`, where `n` counts
 * earlier findings with the same rule, file and hash, so three identical loops
 * in one file are three rows and a fourth copy is new.
 */
export function findingSignatures(findings, suite = DEFAULT_SUITE) {
	if (!suite.contentKeyed) return findings.map(findingSignature);
	const sorted = [...findings].sort(
		(a, b) =>
			String(a.file).localeCompare(String(b.file)) ||
			(a.range?.byteOffset?.start ?? 0) - (b.range?.byteOffset?.start ?? 0),
	);
	const seen = new Map();
	const byFinding = new Map();
	for (const f of sorted) {
		const file = String(f.file ?? "?").replace(/\\/g, "/");
		const hash = createHash("sha256")
			.update(
				String(f.text ?? "")
					.replace(/\s+/g, " ")
					.trim(),
			)
			.digest("hex")
			.slice(0, 12);
		const key = `${f.ruleId ?? "unknown"}::${file}::${hash}`;
		const n = seen.get(key) ?? 0;
		seen.set(key, n + 1);
		byFinding.set(f, `${key}#${n}`);
	}
	return findings.map((f) => byFinding.get(f));
}

/**
 * The allowed signatures. A content-keyed suite's rows are
 * `{ signature, reason, ... }` and every row must carry a non-empty reason: a
 * row without one throws, so a regenerated baseline cannot pass until each new
 * row is triaged (#4865).
 */
export function loadBaseline(root = repoRoot(), suite = DEFAULT_SUITE) {
	const p = baselinePath(root, suite);
	if (!fs.existsSync(p)) return new Set();
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(p, "utf8"));
	} catch (e) {
		// A malformed baseline must stay loud: an empty set would resurface
		// every triaged finding as new instead of naming the bad file.
		throw new Error(
			`[astgrep-self-scan] baseline ${p} is not valid JSON: ${e?.message ?? e}`,
			{ cause: e },
		);
	}
	const rows = Array.isArray(raw.allowed) ? raw.allowed : [];
	if (!suite.contentKeyed) return new Set(rows);
	const unexplained = rows.filter(
		(row) =>
			typeof row?.signature !== "string" ||
			typeof row.reason !== "string" ||
			row.reason.trim() === "",
	);
	if (unexplained.length > 0) {
		throw new Error(
			`[astgrep-self-scan] baseline ${p}: ${unexplained.length} row(s) without a signature and a reason; triage each one: ${JSON.stringify(unexplained)}`,
		);
	}
	return new Set(rows.map((row) => row.signature));
}

/** Regenerates the baseline from a live scan. Run via
 * `npm run astgrep:<suite>:update-baseline` (one suite each) after triaging every new
 * hit (fix it, or confirm it's legitimate and belongs here) -- never as a
 * way to make a real finding disappear unexamined. */
export function writeBaseline(
	signatures,
	root = repoRoot(),
	suite = DEFAULT_SUITE,
	findings = [],
) {
	const p = baselinePath(root, suite);
	if (suite.contentKeyed) return writeReasonedBaseline(p, signatures, findings);
	const sorted = [...new Set(signatures)].sort();
	const payload = {
		_comment:
			"Regenerate with `npm run astgrep:self-scan:update-baseline` (this suite only; the governance suite has `npm run astgrep:governance:update-baseline`) AFTER triaging every new entry (fix the underlying finding, or confirm it's a legitimate exception and document why in the same PR). Never regenerate to silently swallow an unreviewed hit.",
		generatedAt: new Date().toISOString(),
		allowed: sorted,
	};
	fs.writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	return p;
}

/** A content-keyed baseline keeps the reason of every row whose signature is
 * still found and writes `reason: ""` for a new one, which `loadBaseline`
 * refuses until someone triages it. `head` (the match's first line) and `line`
 * are for the reader only. */
function writeReasonedBaseline(p, signatures, findings) {
	let previous = [];
	if (fs.existsSync(p)) {
		const raw = JSON.parse(fs.readFileSync(p, "utf8"));
		previous = Array.isArray(raw.allowed) ? raw.allowed : [];
	}
	const reasons = new Map(
		previous
			.filter((row) => typeof row?.signature === "string")
			.map((row) => [row.signature, row.reason ?? ""]),
	);
	const rows = signatures
		.map((signature, i) => ({
			signature,
			head: String(findings[i]?.lines ?? findings[i]?.text ?? "")
				.split("\n")[0]
				.trim(),
			reason: reasons.get(signature) ?? "",
		}))
		.sort((a, b) => a.signature.localeCompare(b.signature));
	const payload = {
		_comment:
			"Governance baseline (#4865). Each row is a known member with the reason it stays. Regenerate with `npm run astgrep:governance:update-baseline`; a new row is written with an empty reason and the scan refuses it until the reason is filled in. Prefer fixing the member.",
		allowed: rows,
	};
	fs.writeFileSync(p, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
	return p;
}

/**
 * The one admitted exemption spelling (#4865):
 * `// ast-grep-ignore: <rule-id>[, <rule-id>] -- <reason>` (or the block-comment
 * form). Every other comment that names ast-grep-ignore is refused: a bare
 * ignore, one for every rule, or ids with no reason.
 */
export const REASONED_IGNORE =
	/^(\/\/|\/\*)\s*ast-grep-ignore:\s*[\w-]+(\s*,\s*[\w-]+)*\s+--\s+\S/;

const COMMENT_LANGUAGES = [
	["ts", /\.[cm]?ts$/],
	["tsx", /\.tsx$/],
	["js", /\.[cm]?jsx?$/],
];

/**
 * Every `ast-grep-ignore` comment in `files` that is not `REASONED_IGNORE`, as
 * `{ file, line, text }`. A scan rule cannot do this: `ast-grep scan` applies a
 * suppression to the comment's own line, so a trailing bare
 * `// ast-grep-ignore` hides its own diagnostic. `ast-grep run` honours no
 * suppression, so the comments are listed with it. Only comment nodes count:
 * a string that mentions the directive is not one. `files` are paths relative
 * to `root` (or absolute); throws when ast-grep fails.
 */
export function findUnreasonedIgnores(files, root = repoRoot()) {
	const offenders = [];
	for (const [lang, extension] of COMMENT_LANGUAGES) {
		const group = files.filter(
			(f) => extension.test(f) || isDirectory(path.resolve(root, f)),
		);
		if (group.length === 0) continue;
		const result = spawnAstGrep(
			["run", "-l", lang, "-k", "comment", "--json=compact", ...group],
			root,
		);
		if (result.error) throw result.error;
		// `ast-grep run` exits 1 with `[]` when nothing matched.
		const stdout = (result.stdout ?? "").trim();
		if ((result.status !== 0 && result.status !== 1) || !stdout) {
			throw new Error(
				`[astgrep-self-scan] listing comments failed (exit ${result.status ?? "unknown"}): ${result.stderr ?? ""}`,
			);
		}
		for (const node of JSON.parse(stdout)) {
			const text = String(node.text ?? "");
			if (!text.includes("ast-grep-ignore") || REASONED_IGNORE.test(text)) {
				continue;
			}
			offenders.push({
				file: String(node.file ?? "?").replace(/\\/g, "/"),
				line: (node.range?.start?.line ?? 0) + 1,
				text,
			});
		}
	}
	return offenders;
}

function isDirectory(p) {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Tracked files under `roots` whose text mentions ast-grep-ignore (the
 * candidates for `findUnreasonedIgnores`), from `git grep`. */
export function filesMentioningIgnore(
	root = repoRoot(),
	roots = ["clients", "tests"],
) {
	try {
		return String(
			gitExecFileSync(
				["grep", "-l", "--fixed-strings", "ast-grep-ignore", "--", ...roots],
				{
					cwd: root,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				},
			),
		)
			.split("\n")
			.filter(Boolean);
	} catch (e) {
		// git grep exits 1 when nothing matches; anything else is a failure.
		if (e?.status === 1) return [];
		throw e;
	}
}

/** The set of tracked files under the scan roots, from `git ls-files`, or
 * `undefined` when git cannot list them (not a work tree, git unavailable).
 * The self-scan still runs over the directory roots -- the same argv CI uses --
 * and drops findings outside this set, so an untracked working-tree scratch file
 * cannot gate a push CI would never run it in and no file list reaches
 * ast-grep's argv (Windows cmd.exe/CreateProcess line limits, #3886 r3). A
 * caller that sees `undefined` keeps the whole directory result. */
export function trackedSelfScanFileSet(
	root = repoRoot(),
	roots = ["clients", "tests"],
) {
	try {
		const out = String(
			gitExecFileSync(["ls-files", "-z", "--", ...roots], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		const files = out
			.split("\0")
			.map((line) => line.trim())
			.filter(Boolean);
		// git ls-files emits forward-slash repo-relative paths on every
		// platform, so only the finding side needs normalization.
		return new Set(files);
	} catch {
		// Not a git work tree (or git unavailable): fall back to no filter.
		return undefined;
	}
}

/** Drops findings whose file is not in `tracked` (a set from
 * `trackedSelfScanFileSet`); an undefined set is a no-op, so a scan that
 * cannot enumerate tracked files keeps its whole directory result. Finding
 * paths are normalized so a Windows-shaped finding from ast-grep still
 * matches git's forward-slash path. (#3886) */
export function findingsInTrackedFiles(findings, tracked) {
	if (!tracked) return findings;
	return findings.filter((f) =>
		tracked.has(normalizeFindingPath(String(f.file ?? ""))),
	);
}

function normalizeFindingPath(file) {
	return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Absolute (real) paths of files changed between
 * `base` and the working tree, from `git diff` run in `cwd` (the repo root). Throws when git
 * cannot resolve `base` -- the caller decides how loud that is. (#3684) */
export function changedFilesSince(base, cwd = process.cwd()) {
	const out = String(
		gitExecFileSync(["diff", "--name-only", base], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	return new Set(
		out
			.split("\n")
			.filter(Boolean)
			.map((name) => realPathOrResolved(path.resolve(cwd, name))),
	);
}

/** The subset of `findings` whose file is in `changed` (a set from
 * `changedFilesSince`); finding paths are resolved against `root`, where
 * ast-grep ran. (#3684) */
export function findingsInChangedFiles(findings, changed, root = repoRoot()) {
	return findings.filter((f) =>
		changed.has(realPathOrResolved(path.resolve(root, String(f.file ?? "")))),
	);
}

function realPathOrResolved(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}
