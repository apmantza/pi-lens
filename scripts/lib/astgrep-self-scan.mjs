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
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { safeSpawn } from "../../clients/safe-spawn.js";
import { escapeRegExp } from "../../clients/string-utils.js";

export const SELF_SCAN_CATEGORY = "pi-lens-self-scan";

/** Repo root, derived from this file's own on-disk location -- never a
 * hardcoded machine path (the #1718 defect). */
export function repoRoot() {
	return path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
}

export function rulesDir(root = repoRoot()) {
	return path.join(root, "rules", "ast-grep-rules", "rules");
}

export function sgConfigPath(root = repoRoot()) {
	return path.join(root, "rules", "ast-grep-rules", ".sgconfig.yml");
}

export function baselinePath(root = repoRoot()) {
	return path.join(root, "rules", "ast-grep-rules", "self-scan-baseline.json");
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

/** Every rule ID whose YAML declares `metadata: { category: pi-lens-self-scan }`.
 * Reads the shipped rule catalog directly -- no hand-maintained parallel list. */
export function selfScanRuleIds(root = repoRoot()) {
	const dir = rulesDir(root);
	if (!fs.existsSync(dir)) {
		throw new Error(`[astgrep-self-scan] rules dir not found: ${dir}`);
	}
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml"));
	const ids = [];
	for (const file of files) {
		const text = fs.readFileSync(path.join(dir, file), "utf8");
		if (readMetadataCategory(text) === SELF_SCAN_CATEGORY) {
			const id = readYamlField(text, "id");
			if (id) ids.push(id);
		}
	}
	return ids.sort();
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
	scanPaths = ["clients", "tests"],
	ruleIds,
	// Override hook for the wrapper-level failure test (#1729 review round):
	// point the scan at a broken/nonexistent sgconfig to prove the CLI
	// wrapper exits nonzero on a genuine scan failure, not just an untriaged
	// finding.
	sgConfigPath: sgConfigPathOverride,
} = {}) {
	const ids = ruleIds ?? selfScanRuleIds(root);
	if (ids.length === 0) {
		throw new Error(
			`[astgrep-self-scan] no rules tagged category: ${SELF_SCAN_CATEGORY} under ${rulesDir(root)} -- nothing to run. If every self-scan rule was intentionally removed, delete this script and its CI wiring instead of letting it report a silent "clean" scan.`,
		);
	}
	const filterRegex = `^(${ids.map(escapeRegExp).join("|")})$`;
	const result = safeSpawn(
		"ast-grep",
		[
			"scan",
			"-c",
			sgConfigPathOverride ?? sgConfigPath(root),
			"--filter",
			filterRegex,
			...scanPaths,
			"--json=compact",
			"--inspect",
			"summary",
		],
		{ cwd: root },
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
		findings,
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

export function findingSignature(finding) {
	const file = String(finding.file ?? "?").replace(/\\/g, "/");
	const line = finding.range?.start?.line ?? 0;
	return `${finding.ruleId ?? "unknown"}::${file}::${line}`;
}

export function loadBaseline(root = repoRoot()) {
	const p = baselinePath(root);
	if (!fs.existsSync(p)) return new Set();
	const raw = JSON.parse(fs.readFileSync(p, "utf8"));
	return new Set(Array.isArray(raw.allowed) ? raw.allowed : []);
}

/** Regenerates the baseline from a live scan. Run via
 * `npm run astgrep:self-scan -- --update-baseline` after triaging every new
 * hit (fix it, or confirm it's legitimate and belongs here) -- never as a
 * way to make a real finding disappear unexamined. */
export function writeBaseline(signatures, root = repoRoot()) {
	const p = baselinePath(root);
	const sorted = [...new Set(signatures)].sort();
	const payload = {
		_comment:
			"Regenerate with `npm run astgrep:self-scan -- --update-baseline` AFTER triaging every new entry (fix the underlying finding, or confirm it's a legitimate exception and document why in the same PR). Never regenerate to silently swallow an unreviewed hit.",
		generatedAt: new Date().toISOString(),
		allowed: sorted,
	};
	fs.writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	return p;
}
