/**
 * Cross-source secret-finding dedup (acceptance gate for #131 Mode 3).
 *
 * Hardcoded / committed secrets can be reported by up to three independent
 * pi-lens sources for the *same* line:
 *   - gitleaks       (session scan, #130) — rule id e.g. `aws-access-token`
 *   - trivy secret   (session scan, #131) — rule id e.g. `aws-access-key-id`
 *   - ast-grep rules (per-edit dispatch)  — rule id e.g. `*-hardcoded-secret-*`
 *
 * The existing diagnostic dedup keys on `filePath:line:rule`, so these three
 * have *different* rule ids and would NOT collapse — exactly the triple-report
 * noise that got the old regex secrets-scanner removed (b8f368d). This module
 * collapses by **location** (normalized file + line), keeping the rule/source
 * provenance, so a secret is surfaced once with "detected by gitleaks + trivy +
 * ast-grep" rather than three times.
 *
 * Pure + side-effect-free so the acceptance gate ("one surfaced finding, not
 * three") is a unit test, independent of the turn_end plumbing that consumes it.
 *
 * Refs: #131 (Mode 3), #130
 */

import type { ActionableWarningRecord } from "./actionable-warnings.js";
import type { GitleaksFinding } from "./gitleaks-client.js";
import { normalizeFilePath } from "./path-utils.js";

/** The scanners that can flag a secret, in display/priority order. */
export type SecretSource = "gitleaks" | "trivy" | "ast-grep";

/** Minimal normalized secret from trivy's `Results[].Secrets[]` report rows. */
export interface TrivySecretFinding {
	ruleId: string;
	file: string;
	line: number;
	title?: string;
}

export interface SecretFinding {
	/** Raw path as reported by the source (display happens downstream). */
	file: string;
	line: number;
	/** Scanners that flagged this location — sorted + deduped. */
	sources: SecretSource[];
	/** Representative rule id (from the highest-priority source present). */
	rule: string;
	description?: string;
}

/**
 * Rule-id shape that marks a dispatch warning as a hardcoded-secret finding.
 * Deliberately conservative — the bundled ast-grep secret rules all carry one
 * of these tokens (`*-hardcoded-secret-*`, `*-hardcoded-password-*`,
 * `*-hardcoded-session-key-*`, `*-hardcoded-connection-password-*`, …) so we
 * don't sweep unrelated rules (e.g. a parser rule that merely mentions "token")
 * into the secrets channel.
 */
const SECRET_RULE_PATTERN = /hardcoded|secret|password|credential/i;

/** Does this dispatch warning look like a hardcoded-secret finding? */
export function isSecretWarning(warning: ActionableWarningRecord): boolean {
	const id = `${warning.rule ?? ""} ${warning.code ?? ""}`;
	return SECRET_RULE_PATTERN.test(id);
}

/** Location key used to collapse the same secret across sources. */
export function secretLocationKey(file: string, line: number): string {
	return `${normalizeFilePath(file)}:${line}`;
}

export function fromGitleaks(findings: GitleaksFinding[]): SecretFinding[] {
	return findings.map((f) => ({
		file: f.file,
		line: f.startLine,
		sources: ["gitleaks"],
		rule: f.ruleId,
		description: f.description,
	}));
}

export function fromTrivySecrets(findings: TrivySecretFinding[]): SecretFinding[] {
	return findings.map((f) => ({
		file: f.file,
		line: f.line,
		sources: ["trivy"],
		rule: f.ruleId,
		description: f.title,
	}));
}

export function fromAstGrepWarnings(
	warnings: ActionableWarningRecord[],
): SecretFinding[] {
	const out: SecretFinding[] = [];
	for (const w of warnings) {
		if (!isSecretWarning(w) || typeof w.line !== "number") continue;
		out.push({
			file: w.filePath,
			line: w.line,
			sources: ["ast-grep"],
			rule: w.rule ?? w.code ?? "hardcoded-secret",
			description: w.message,
		});
	}
	return out;
}

// gitleaks > trivy > ast-grep: when the same location is flagged by several
// scanners we keep the most-specific committed-secret rule id for display.
const SOURCE_PRIORITY: Record<SecretSource, number> = {
	gitleaks: 0,
	trivy: 1,
	"ast-grep": 2,
};

function sortSources(sources: SecretSource[]): SecretSource[] {
	return [...new Set(sources)].sort(
		(a, b) => SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b],
	);
}

/**
 * Collapse secret findings that share a location (normalized file + line) into
 * one, merging their `sources` and keeping the highest-priority source's rule.
 * Output preserves first-appearance order so surfacing is stable across turns.
 *
 * This is THE cross-source collapse the #131 Mode 3 acceptance gate verifies:
 * the same secret fed in from gitleaks + trivy + ast-grep yields a single
 * finding, not three.
 */
export function dedupeSecretFindings(
	findings: SecretFinding[],
): SecretFinding[] {
	const byKey = new Map<string, SecretFinding>();
	for (const f of findings) {
		const key = secretLocationKey(f.file, f.line);
		const incoming = sortSources(f.sources);
		const existed = byKey.get(key);
		if (!existed) {
			byKey.set(key, { ...f, sources: incoming });
			continue;
		}
		// `existed.sources` is kept sorted, so [0] is its current rule's source.
		const existingTop = SOURCE_PRIORITY[existed.sources[0]];
		existed.sources = sortSources([...existed.sources, ...incoming]);
		// Keep the rule from the highest-priority source now present.
		if (SOURCE_PRIORITY[incoming[0]] < existingTop) {
			existed.rule = f.rule;
		}
		// Fill a missing description from any source.
		existed.description ??= f.description;
	}
	return [...byKey.values()];
}
