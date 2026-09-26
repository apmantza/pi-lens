/**
 * #3259 synonym-retirement sweep.
 *
 * The glossary is the source of truth. This census reads it at test time,
 * blanks comments and strings, and counts only whole TypeScript identifier
 * tokens in the runtime source population. A retired synonym in prose, a
 * string (including template text), or a larger identifier such as
 * `blockerCount` is not a code-vocabulary use. `${...}` remains code because
 * the shared stripper lexes template interpolations as ordinary source.
 *
 * Multi-word retired phrases and hyphenated phrases are deliberately listed
 * below as non-identifiers. They cannot be declaration/member identifiers;
 * any evidence for them is prose or a string literal and is therefore outside
 * this lexical sweep. There are no identifier needles with string-only
 * evidence in this population, so no `codeMatches` exception is needed.
 *
 * The pins are the rename inventory for #3259, held to EXACT equality per
 * `(term, file)`. `auditSymbolCounts` alone cannot do that: `auditRegistry`
 * is deliberately asymmetric, so a REGISTERED `file@count` row the scan no
 * longer flags passes. Round 2 shipped exactly that hole — deleting five live
 * `warning` identifiers from `clients/runtime-turn.ts` left the suite green
 * (#3279 G-3279-4), which is the #3256 M3c stale-pin failure again. Equality
 * is therefore audited as TWO calls with the roles swapped, each carrying its
 * own message, so a rename slice knows which direction it hit:
 *   - `UNPINNED live uses` — live rows the pin does not name (grow).
 *   - `STALE pins` — pinned rows the live census no longer produces (shrink).
 * Both clean means the two `file@count` key sets are equal.
 *
 * Glossary retirement grammar: each declaration is a bullet whose bold term
 * is followed by `retires` plus one or more backtick-delimited synonyms,
 * ending at the declaration's period. A bullet mentioning `retires` that
 * does not match this grammar is malformed and must fail loudly.
 *
 * A spelling can be BOTH canonical for its own concept and retired by another
 * concept (`finding` retires `diagnostic`, while `diagnostic` is canonical at
 * `clients/dispatch/types.ts`). Those `retired-in-one-sense` terms are
 * excluded from the global census — a lexical spelling count cannot tell the
 * two senses apart — so the exclusion itself is pinned as a DERIVED list of
 * `term -> owning module -> retiring concept`, read out of the glossary's own
 * `owned by` clause. Every per-concept rename slice under #3259 works from
 * that list, and a new collision reds it instead of vanishing silently
 * (#3279 G-3279-2).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	auditSymbolCounts,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function agentsText(): string {
	return fs.readFileSync(
		process.env.PI_LENS_AGENTS_PATH ?? path.join(REPO_ROOT, "AGENTS.md"),
		"utf8",
	);
}

/** One parsed glossary declaration: the module that owns it, and what it retires. */
interface GlossaryEntry {
	/** The module named by the bullet's `owned by` clause. */
	owner: string;
	retires: string[];
}

function parseGlossary(source = agentsText()): Map<string, GlossaryEntry> {
	const glossary = source
		.split("## Glossary", 2)[1]
		?.split("Where two spellings", 2)[0];
	if (!glossary) throw new Error("AGENTS.md glossary is missing");

	const parsed = new Map<string, GlossaryEntry>();
	for (const line of glossary.split("\n")) {
		const match = /^- \*\*([^*]+)\*\* .*?\bretires\s+(.+?)(?=\.\s|$)/.exec(
			line,
		);
		if (!match) {
			if (/\bretires\b/.test(line)) {
				throw new Error(`malformed glossary retirement declaration: ${line}`);
			}
			continue;
		}
		const synonyms = [...match[2].matchAll(/`([^`]+)`/g)].map(
			([, synonym]) => synonym,
		);
		if (synonyms.length === 0) {
			throw new Error(
				`glossary term has no parsed retired synonyms: ${match[1]}`,
			);
		}
		// An absent `owned by` clause needs no guard of its own: the owner lands
		// in the pinned `retired-in-one-sense` list, so it reds there.
		parsed.set(match[1], {
			owner: /\bowned by `([^`]+)`/.exec(line)?.[1] ?? "",
			retires: synonyms,
		});
	}
	return parsed;
}

function identifierTerms(glossary: Map<string, GlossaryEntry>): string[] {
	const canonicalTerms = new Set(glossary.keys());
	return [
		...new Set(
			[...glossary.values()]
				.flatMap((entry) => entry.retires)
				.filter((term) => IDENTIFIER.test(term) && !canonicalTerms.has(term)),
		),
	].sort();
}

/** A spelling that is canonical for one concept and retired by another. */
interface OneSenseRow {
	term: string;
	/** The module the glossary says owns the CANONICAL sense. */
	owner: string;
	/** The canonical concept(s) whose declaration retires this spelling. */
	retiredBy: string[];
}

/**
 * The exclusion the global census applies, as a machine-derived report.
 *
 * `identifierTerms` drops these spellings because one lexical count cannot
 * separate the canonical sense from the retired one. That exclusion is the
 * widest hole in the sweep, so it is enumerated from the glossary rather than
 * described in prose: each row names the module that owns the canonical sense
 * and the concept that retires the other sense, which is what a per-concept
 * rename slice needs to do the work the census cannot.
 */
function retiredInOneSense(
	glossary: Map<string, GlossaryEntry>,
): OneSenseRow[] {
	const rows: OneSenseRow[] = [];
	for (const [term, entry] of glossary) {
		const retiredBy = [...glossary]
			.filter(([, other]) => other.retires.includes(term))
			.map(([canonical]) => canonical);
		if (retiredBy.length > 0)
			rows.push({ term, owner: entry.owner, retiredBy });
	}
	return rows.sort((a, b) => a.term.localeCompare(b.term));
}

function sourceFiles(): string[] {
	const files: string[] = [];
	for (const dir of ["clients", "tools", "mcp"]) {
		const found = listSourceFiles(path.join(REPO_ROOT, dir), {
			extensions: [".ts"],
			skipDeclarations: true,
		});
		assertNonEmptyScan(`${dir}/ source population`, found.length, 1);
		files.push(...found);
	}
	files.push(path.join(REPO_ROOT, "index.ts"));
	return files;
}

function countIdentifier(source: string, term: string): number {
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [
		...source.matchAll(
			new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "g"),
		),
	].length;
}

function census(
	terms: readonly string[],
): Record<string, Record<string, number>> {
	const counts: Record<string, Record<string, number>> = {};
	const files = sourceFiles();
	assertNonEmptyScan(
		"clients/tools/mcp/index.ts source population",
		files.length,
		400,
	);
	for (const file of files) {
		const raw = readWalkedFile(file);
		if (raw === undefined) continue;
		const stripped = stripSource(raw, { strings: "blank" });
		const relative = relativePosix(REPO_ROOT, file);
		for (const term of terms) {
			const count = countIdentifier(stripped, term);
			if (count > 0) (counts[term] ??= {})[relative] = count;
		}
	}
	return counts;
}

// A parsed-term pin makes a glossary format or spelling edit red before it
// can silently change the governed population.
const EXPECTED_IDENTIFIER_TERMS = [
	"age",
	"allowlist",
	"baseline",
	"cache",
	"channel",
	"consumer",
	"epoch",
	"error",
	"exception",
	"filter",
	"helper",
	"ignore",
	"log",
	"mark",
	"path",
	"record",
	"replica",
	"shadow",
	"snapshot",
	"status",
	"telemetry",
	"validity",
	"version",
	"warning",
] as const;

const EXPECTED_GLOSSARY_TERMS = [
	"finding",
	"diagnostic",
	"blocker",
	"advisory",
	"disposition",
	"strict anchor",
	"weak anchor",
	"freshness",
	"delivery surface",
	"delivery gate",
	"lane",
	"seam",
	"store",
	"mirror",
	"path spelling",
	"path key",
	"canonical path",
	"rendezvous id",
	"generation",
	"degradation record",
	"ratchet",
	"sweep",
	"pin",
	"admission",
	"exemption",
	"runner outcome",
] as const;

/**
 * The census's canonical-collision exclusions, pinned with their owners.
 *
 * Derived by {@link retiredInOneSense}; this pin is the executable form of the
 * hand-written table round 2 put in the PR body (#3279 G-3279-2), which had
 * both the wrong owner for `exemption` and no row for `canonical path`. A new
 * collision, a removed one, or a moved `owned by` module reds here.
 */
const EXPECTED_RETIRED_IN_ONE_SENSE: readonly OneSenseRow[] = [
	{
		term: "advisory",
		owner: "clients/finding-delivery-gate.ts",
		retiredBy: ["finding"],
	},
	{
		term: "blocker",
		owner: "clients/dispatch/types.ts",
		retiredBy: ["finding"],
	},
	{
		term: "canonical path",
		owner: "clients/path-utils.ts",
		retiredBy: ["path key"],
	},
	{
		term: "diagnostic",
		owner: "clients/dispatch/types.ts",
		retiredBy: ["finding"],
	},
	{
		term: "exemption",
		owner: "tests/support/sweep-kit.ts",
		retiredBy: ["admission"],
	},
	{
		term: "finding",
		owner: "clients/finding-delivery-gate.ts",
		retiredBy: ["diagnostic"],
	},
];

/**
 * Population at the synonym-retirement sweep's authoring head. Each nested
 * row is `retired identifier -> file -> count`; update only when a rename or
 * an intentional source change changes the live population.
 */
const PINS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	age: {
		// 10 -> 16 (#3274): `readCacheAsync` beside `readCache` and the shared
		// `freshAgeMs` they both apply the TTL through. Every use is the literal
		// elapsed-time sense (`maxAgeMs`, the envelope's `age`), which the
		// glossary does NOT retire — `freshness` retires `age` only where
		// REFERENCE DRIFT is meant, and none of these compare evidence against a
		// reference. Renaming them would spell a TTL as a freshness verdict,
		// which is the confusion the glossary exists to prevent.
		"clients/cache-manager.ts": 16,
		"clients/project-diagnostics/extractors.ts": 3,
		"clients/runtime-coordinator.ts": 2,
	},
	baseline: {
		"clients/cache-observability.ts": 3,
		"clients/lsp/diagnostic-binding.ts": 4,
		"clients/lsp/index.ts": 13,
		"clients/lsp/server.ts": 3,
		"clients/mcp/session.ts": 4,
		"clients/metrics-client.ts": 7,
		"clients/observed-mutation.ts": 7,
		"clients/opaque-mutation-scan.ts": 4,
		"clients/runtime-tool-call.ts": 13,
		"clients/sgconfig.ts": 6,
		"clients/widget-state.ts": 2,
	},
	cache: {
		"clients/diagnostic-line-freshness.ts": 5,
		"clients/dispatch/runners/tree-sitter.ts": 3,
		"clients/dispatch/runners/utils/runner-helpers.ts": 41,
		"clients/dispatch/runners/yaml-rule-parser.ts": 6,
		"clients/installer/index.ts": 8,
		"clients/lsp/inferred-project.ts": 4,
		"clients/lsp/server.ts": 3,
		"clients/lsp/workspace-diagnostics-cache.ts": 14,
		"clients/project-diagnostics/runner-adapters/runner-findings.ts": 8,
		"clients/review-graph/builder.ts": 4,
		"clients/review-graph/tsconfig-paths.ts": 6,
		"clients/source-filter.ts": 4,
		"clients/tree-sitter-cache.ts": 16,
		"clients/word-index.ts": 11,
	},
	channel: {
		"clients/agent-nudge.ts": 1,
		"clients/host-ports.ts": 1,
		"clients/live-bus-emitter.ts": 1,
		"clients/widget-state.ts": 1,
		"index.ts": 2,
	},
	consumer: {
		"clients/ast-grep-client.ts": 1,
		"clients/lsp-mutation.ts": 1,
		"clients/mutating-tool.ts": 2,
		"clients/observed-mutation.ts": 3,
		"clients/read-bridge.ts": 2,
		"clients/zizmor-config.ts": 13,
	},
	epoch: {
		"clients/lsp/workspace-diagnostics-cache.ts": 3,
		"clients/review-graph/builder.ts": 5,
	},
	error: {
		"clients/actionable-warnings.ts": 1,
		"clients/advisory-provenance.ts": 8,
		"clients/ast-grep-client.ts": 47,
		"clients/ast-grep-rule-manager.ts": 4,
		"clients/biome-client.ts": 8,
		"clients/bounded-pid-file-lock.ts": 13,
		"clients/bundled-resource-health.ts": 2,
		"clients/bus-events-logger.ts": 1,
		"clients/bus-publish.ts": 1,
		"clients/cascade-logger.ts": 1,
		"clients/child-unref.ts": 5,
		"clients/config-core/normalize.ts": 2,
		"clients/config-core/resolve.ts": 2,
		"clients/config-locations.ts": 5,
		"clients/config-resolve.ts": 14,
		"clients/config-warn.ts": 18,
		"clients/dead-code-client.ts": 4,
		"clients/degradation-ledger.ts": 10,
		"clients/dependency-checker.ts": 4,
		"clients/diagnostics-publish.ts": 1,
		"clients/dispatch/dispatcher.ts": 7,
		"clients/dispatch/integration.ts": 2,
		"clients/dispatch/pending-runner-findings.ts": 2,
		"clients/dispatch/runners/biome-check.ts": 4,
		"clients/dispatch/runners/cpp-check.ts": 1,
		"clients/dispatch/runners/cue-vet.ts": 9,
		"clients/dispatch/runners/gleam-check.ts": 1,
		"clients/dispatch/runners/helm-lint.ts": 2,
		"clients/dispatch/runners/helm-render.ts": 7,
		"clients/dispatch/runners/oxlint.ts": 3,
		"clients/dispatch/runners/prisma-validate.ts": 1,
		"clients/dispatch/runners/psscriptanalyzer.ts": 3,
		"clients/dispatch/runners/pyright.ts": 1,
		"clients/dispatch/runners/rubocop.ts": 1,
		"clients/dispatch/runners/shellcheck.ts": 1,
		"clients/dispatch/runners/spotbugs.ts": 1,
		"clients/dispatch/runners/swiftlint.ts": 1,
		"clients/dispatch/runners/tree-sitter.ts": 2,
		"clients/dispatch/runners/trivy-config.ts": 2,
		"clients/dispatch/runners/utils/availability-policy.ts": 3,
		"clients/dispatch/runners/utils/candidate-probe.ts": 1,
		"clients/dispatch/runners/utils/lazy-installer.ts": 3,
		"clients/dispatch/runners/utils/runner-helpers.ts": 9,
		"clients/dispatch/runners/utils/spawn-outcome.ts": 2,
		"clients/dispatch/runners/vale.ts": 1,
		"clients/dispatch/runners/zig-check.ts": 1,
		"clients/disposition-publish.ts": 1,
		"clients/durable-store.ts": 3,
		"clients/effective-config.ts": 2,
		"clients/error-class.ts": 3,
		"clients/extension-log.ts": 3,
		"clients/file-utils.ts": 3,
		"clients/format-events-publish.ts": 3,
		"clients/format-service.ts": 11,
		"clients/formatters.ts": 26,
		"clients/generation-lock.ts": 7,
		"clients/git-tracked-ignore.ts": 2,
		"clients/gitleaks-client.ts": 3,
		"clients/govulncheck-client.ts": 6,
		"clients/gzip-stage-write.ts": 2,
		"clients/install-diagnostics.ts": 4,
		"clients/installer/index.ts": 29,
		"clients/installer/managed-tool-refresh.ts": 2,
		"clients/instance-reaper.ts": 4,
		"clients/instance-registry-lock.ts": 3,
		"clients/jscpd-client.ts": 2,
		"clients/knip-client.ts": 3,
		"clients/lens-config.ts": 4,
		"clients/lens-events.ts": 1,
		"clients/live-bus-emitter.ts": 2,
		"clients/lsp/cascade-tier.ts": 1,
		"clients/lsp/client.ts": 13,
		"clients/lsp/index.ts": 24,
		"clients/lsp/jvm-runtime.ts": 1,
		"clients/lsp/server.ts": 13,
		"clients/mcp/ipc.ts": 8,
		"clients/mcp/review.ts": 8,
		"clients/mcp/session.ts": 1,
		"clients/module-report.ts": 29,
		"clients/opaque-mutation-scan.ts": 3,
		"clients/opengrep-client.ts": 11,
		"clients/package-manager.ts": 2,
		"clients/partial-edit-apply.ts": 7,
		"clients/performance-report.ts": 3,
		"clients/pipeline.ts": 14,
		"clients/project-diagnostics/fresh-fetch.ts": 4,
		"clients/project-diagnostics/runner-adapters/call-graph-impact.ts": 1,
		"clients/project-diagnostics/runner-adapters/runner-findings.ts": 4,
		"clients/project-lens-config.ts": 3,
		"clients/project-snapshot.ts": 7,
		"clients/project-trust.ts": 1,
		"clients/review-graph-logger.ts": 1,
		"clients/review-graph/builder.ts": 16,
		"clients/ruff-client.ts": 7,
		"clients/runtime-agent-end.ts": 6,
		"clients/runtime-tool-call.ts": 7,
		"clients/runtime-turn.ts": 10,
		"clients/safe-spawn.ts": 52,
		"clients/security-scan-client.ts": 2,
		"clients/sg-runner.ts": 32,
		"clients/shared-checkout-guard.ts": 1,
		"clients/single-flight.ts": 3,
		"clients/smells-rollup.ts": 2,
		"clients/test-runner-client.ts": 21,
		"clients/test-runner-delivery.ts": 6,
		"clients/tool-agreement.ts": 2,
		"clients/tree-sitter-cache.ts": 4,
		"clients/tree-sitter-client.ts": 18,
		"clients/tree-sitter-logger.ts": 1,
		"clients/tree-sitter-symbol-extractor.ts": 3,
		"clients/trivy-client.ts": 3,
		"clients/warm-attach.ts": 14,
		"clients/word-index-logger.ts": 1,
		"clients/word-index.ts": 2,
		"clients/zizmor-config.ts": 2,
		"tools/ast-grep-outline.ts": 3,
		"tools/ast-grep-replace.ts": 6,
		"tools/ast-grep-search.ts": 12,
		"tools/effective-config.ts": 2,
		"tools/lens-diagnostic-mark.ts": 4,
		"tools/lens-diagnostics.ts": 6,
		"tools/lsp-diagnostics.ts": 10,
		"tools/module-report.ts": 11,
		"mcp/analyze-cli.ts": 1,
		"mcp/server.ts": 32,
	},
	filter: {
		"clients/actionable-warnings.ts": 10,
		"clients/agent-behavior-client.ts": 1,
		"clients/agent-nudge.ts": 2,
		"clients/ast-grep-client.ts": 5,
		"clients/ast-grep-rule-manager.ts": 4,
		"clients/atomic-write-staging.ts": 1,
		"clients/bash-file-access.ts": 5,
		"clients/blocker-past-eof.ts": 2,
		"clients/cache-manager.ts": 2,
		"clients/cache-observability.ts": 2,
		"clients/call-graph.ts": 4,
		"clients/cascade-format.ts": 4,
		"clients/code-quality-warnings.ts": 5,
		"clients/codebase-model.ts": 4,
		"clients/complexity-client.ts": 3,
		"clients/config-core/deny.ts": 1,
		"clients/config-core/merge.ts": 2,
		"clients/config-locations.ts": 4,
		"clients/config-resolve.ts": 1,
		"clients/deadline-utils.ts": 1,
		"clients/debug-handles.ts": 1,
		"clients/debug-heap.ts": 1,
		"clients/degradation-ledger.ts": 2,
		// 9 -> 7 (#3436): deleting `parseMadgeSkips` removed its two
		// `Array.prototype.filter` uses; `localSkips`/the skip channel it served
		// were structurally always zero under `--json`.
		"clients/dependency-checker.ts": 7,
		"clients/diagnostic-dispositions.ts": 3,
		"clients/diagnostic-tracker.ts": 1,
		"clients/diagnostics-publish.ts": 2,
		"clients/dispatch/auxiliary-lsp.ts": 3,
		"clients/dispatch/dispatcher.ts": 16,
		"clients/dispatch/fact-runner.ts": 1,
		"clients/dispatch/fact-scheduler.ts": 2,
		"clients/dispatch/facts/function-facts.ts": 2,
		"clients/dispatch/facts/import-facts.ts": 1,
		"clients/dispatch/finding-policy.ts": 3,
		"clients/dispatch/indent-detect.ts": 4,
		"clients/dispatch/inline-suppressions.ts": 2,
		"clients/dispatch/integration.ts": 18,
		"clients/dispatch/rule-policy.ts": 1,
		"clients/dispatch/rules/high-fan-out.ts": 1,
		"clients/dispatch/rules/missing-error-propagation.ts": 3,
		"clients/dispatch/runners/ast-grep-napi.ts": 2,
		"clients/dispatch/runners/cue-vet.ts": 2,
		"clients/dispatch/runners/go-vet.ts": 2,
		"clients/dispatch/runners/golangci-lint.ts": 1,
		"clients/dispatch/runners/helm-lint.ts": 1,
		"clients/dispatch/runners/helm-render.ts": 3,
		"clients/dispatch/runners/lsp.ts": 4,
		"clients/dispatch/runners/oxlint.ts": 1,
		"clients/dispatch/runners/prisma-validate.ts": 3,
		"clients/dispatch/runners/psscriptanalyzer.ts": 1,
		"clients/dispatch/runners/rust-clippy.ts": 2,
		"clients/dispatch/runners/spellcheck.ts": 1,
		"clients/dispatch/runners/tree-sitter.ts": 4,
		"clients/dispatch/runners/utils/diagnostic-parsers.ts": 1,
		"clients/dispatch/runners/utils/tool-failure.ts": 2,
		"clients/dispatch/runners/yaml-rule-parser.ts": 1,
		"clients/dispatch/suppress-writer.ts": 1,
		"clients/dispatch/utils/lsp-diagnostics.ts": 1,
		"clients/file-kinds.ts": 1,
		"clients/file-role.ts": 3,
		"clients/file-utils.ts": 4,
		"clients/fix-worklog.ts": 1,
		"clients/format-service.ts": 2,
		"clients/formatters.ts": 6,
		"clients/generated-artifacts.ts": 1,
		"clients/git-guard.ts": 9,
		"clients/gitleaks-client.ts": 1,
		"clients/govulncheck-client.ts": 1,
		"clients/gradle-ktfmt-style.ts": 1,
		"clients/inline-blocker-dispositions.ts": 1,
		"clients/installer/index.ts": 4,
		"clients/installer/managed-tool-refresh.ts": 2,
		"clients/instance-reaper.ts": 5,
		"clients/instance-registry.ts": 11,
		"clients/knip-client.ts": 3,
		"clients/language-policy.ts": 2,
		"clients/language-profile.ts": 2,
		"clients/language-registry.ts": 1,
		"clients/lens-config.ts": 1,
		"clients/lens-engine.ts": 3,
		"clients/lens-flag-registry.ts": 2,
		"clients/lens-map.ts": 2,
		"clients/lsp-budget.ts": 1,
		"clients/lsp/aggregation.ts": 6,
		"clients/lsp/client.ts": 18,
		"clients/lsp/config.ts": 3,
		"clients/lsp/diagnostic-binding.ts": 1,
		"clients/lsp/edits.ts": 1,
		"clients/lsp/index.ts": 48,
		"clients/lsp/inferred-project.ts": 2,
		"clients/lsp/jvm-runtime.ts": 3,
		"clients/lsp/language.ts": 1,
		"clients/lsp/launch.ts": 2,
		"clients/lsp/ruby-drive-dirs.ts": 1,
		"clients/lsp/server.ts": 5,
		"clients/lsp/tsserver-sync.ts": 1,
		"clients/lsp/wait-policy/classification.ts": 1,
		"clients/mcp/analyze.ts": 1,
		"clients/middle-man-analysis.ts": 4,
		"clients/model-provider.ts": 1,
		"clients/module-report.ts": 17,
		"clients/mutation-attribution.ts": 2,
		"clients/ndjson-logger.ts": 1,
		"clients/observed-mutation.ts": 2,
		"clients/opengrep-client.ts": 2,
		"clients/path-utils.ts": 1,
		"clients/persistent-reverify.ts": 4,
		"clients/pipeline.ts": 6,
		"clients/process-snapshot.ts": 3,
		"clients/project-changes.ts": 5,
		"clients/project-diagnostics/cache.ts": 2,
		"clients/project-diagnostics/fresh-fetch.ts": 2,
		"clients/project-diagnostics/runner-adapters/runner-findings.ts": 2,
		"clients/project-diagnostics/scanner.ts": 1,
		"clients/project-lens-config.ts": 5,
		"clients/project-report.ts": 10,
		"clients/project-snapshot.ts": 3,
		"clients/python-provenance.ts": 4,
		"clients/read-guard-logger.ts": 3,
		"clients/read-guard-tool-lines.ts": 6,
		"clients/read-guard.ts": 9,
		"clients/recent-touches.ts": 2,
		"clients/resource-sampler.ts": 2,
		"clients/reverse-deps.ts": 1,
		"clients/review-graph/builder.ts": 10,
		"clients/review-graph/import-resolvers.ts": 3,
		"clients/review-graph/query.ts": 5,
		"clients/review-graph/service.ts": 1,
		"clients/review-graph/tsconfig-paths.ts": 4,
		"clients/review-graph/workspace-modules.ts": 6,
		"clients/ruff-client.ts": 1,
		"clients/runtime-agent-end.ts": 7,
		"clients/runtime-coordinator.ts": 3,
		"clients/runtime-session.ts": 4,
		"clients/runtime-tool-call.ts": 3,
		"clients/runtime-tool-result.ts": 5,
		"clients/runtime-turn.ts": 31,
		"clients/safe-spawn.ts": 4,
		"clients/sanitize.ts": 9,
		"clients/scratch-tree-policy.ts": 2,
		"clients/session-state-store.ts": 1,
		"clients/sgconfig.ts": 3,
		"clients/situational-tool-telemetry.ts": 2,
		"clients/test-runner-client.ts": 8,
		"clients/tool-cwd.ts": 1,
		"clients/tool-policy.ts": 2,
		"clients/tool-render.ts": 1,
		"clients/tool-set-policy.ts": 3,
		"clients/tree-sitter-client.ts": 13,
		"clients/tree-sitter-navigator.ts": 2,
		"clients/tree-sitter-query-loader.ts": 5,
		"clients/tree-sitter-shared.ts": 1,
		"clients/tree-sitter-symbol-extractor.ts": 2,
		"clients/trivy-client.ts": 1,
		"clients/turn-end/lanes/secrets.ts": 3,
		"clients/turn-summary-render.ts": 3,
		"clients/vanished-instance-marker.ts": 1,
		"clients/widget-state.ts": 16,
		"clients/word-index.ts": 14,
		"clients/workspace-topology.ts": 1,
		"tools/activate-tools.ts": 2,
		"tools/ast-grep-outline.ts": 1,
		"tools/effective-config.ts": 4,
		"tools/lens-diagnostic-mark.ts": 1,
		"tools/lens-diagnostics.ts": 37,
		"tools/lsp-diagnostics.ts": 12,
		"tools/lsp-navigation.ts": 6,
		"tools/render-compact.ts": 3,
		"mcp/analyze-cli.ts": 1,
		"mcp/server.ts": 9,
		"index.ts": 21,
	},
	ignore: {
		"clients/file-utils.ts": 2,
		"clients/lens-config.ts": 9,
		"clients/project-lens-config.ts": 6,
	},
	log: {
		"clients/actionable-warnings-logger.ts": 1,
		"clients/ast-grep-client.ts": 5,
		"clients/ast-grep-rule-manager.ts": 4,
		"clients/ast-grep-tool-logger.ts": 1,
		"clients/biome-client.ts": 4,
		"clients/bus-events-logger.ts": 1,
		// 10 -> 12 (#3274): `readCacheAsync` and the shared `freshAgeMs` each log
		// their own verdict through the manager's existing verbose logger. Same
		// sense as the ten beside them; no new logging concept.
		"clients/cache-manager.ts": 12,
		"clients/cascade-logger.ts": 1,
		"clients/complexity-client.ts": 5,
		"clients/dead-code-client.ts": 7,
		"clients/dead-code-logger.ts": 1,
		"clients/debug-handles.ts": 1,
		"clients/debug-heap.ts": 1,
		// 9 -> 8 (#3436): the `this.log(...)` line that reported madge's
		// (always-zero) local skip count is deleted with the skip channel.
		"clients/dependency-checker.ts": 8,
		"clients/diagnostic-logger.ts": 4,
		"clients/dispatch/dispatcher.ts": 4,
		"clients/dispatch/runners/ast-grep-napi.ts": 6,
		"clients/dispatch/runners/javac.ts": 1,
		"clients/dispatch/runners/spotbugs.ts": 1,
		"clients/dispatch/runners/utils/toolchain-availability.ts": 2,
		"clients/dispatch/types.ts": 1,
		"clients/disposition-logger.ts": 1,
		"clients/extension-log.ts": 1,
		"clients/gitleaks-client.ts": 1,
		"clients/go-client.ts": 4,
		"clients/govulncheck-client.ts": 12,
		"clients/host-ports.ts": 2,
		"clients/jscpd-client.ts": 7,
		"clients/knip-client.ts": 14,
		"clients/latency-logger.ts": 1,
		"clients/mcp/session.ts": 1,
		"clients/metrics-client.ts": 4,
		"clients/module-report.ts": 17,
		"clients/ndjson-logger.ts": 2,
		"clients/opengrep-client.ts": 1,
		"clients/process-singletons.ts": 4,
		"clients/read-guard-logger.ts": 1,
		"clients/review-graph-logger.ts": 1,
		"clients/review-graph/builder.ts": 1,
		"clients/ruff-client.ts": 4,
		"clients/runtime-session.ts": 4,
		"clients/rust-client.ts": 4,
		"clients/security-scan-client.ts": 8,
		"clients/sg-runner.ts": 5,
		"clients/test-runner-client.ts": 17,
		"clients/tool-cwd.ts": 2,
		"clients/tree-sitter-logger.ts": 1,
		"clients/trivy-client.ts": 1,
		"clients/word-index-logger.ts": 1,
		"clients/word-index.ts": 2,
		"mcp/analyze-cli.ts": 1,
		"mcp/server.ts": 1,
		"index.ts": 3,
	},
	mark: {
		"mcp/server.ts": 3,
	},
	path: {
		"clients/actionable-warnings-logger.ts": 3,
		"clients/actionable-warnings.ts": 13,
		"clients/advisory-provenance.ts": 12,
		"clients/agent-nudge.ts": 3,
		"clients/ast-grep-client.ts": 9,
		"clients/ast-grep-rule-manager.ts": 4,
		"clients/ast-grep-tool-logger.ts": 3,
		"clients/atomic-write-staging.ts": 2,
		"clients/bash-file-access.ts": 9,
		"clients/biome-client.ts": 10,
		"clients/blocker-freshness.ts": 4,
		"clients/bounded-pid-file-lock.ts": 5,
		"clients/build-identity.ts": 3,
		"clients/bus-events-logger.ts": 2,
		"clients/bus-publish.ts": 3,
		// 17 -> 19 (#3274): `readCacheAsync` builds the same two store paths its
		// synchronous sibling does (`cachePath`, `metaPath`). Same sense, one more
		// reader of the same two files.
		"clients/cache-manager.ts": 19,
		"clients/cache/rule-cache.ts": 7,
		"clients/call-graph.ts": 4,
		"clients/cargo-manifest.ts": 7,
		"clients/cascade-logger.ts": 2,
		"clients/code-quality-warnings.ts": 5,
		"clients/codebase-model.ts": 5,
		"clients/complexity-client.ts": 3,
		"clients/config-core/normalize.ts": 21,
		"clients/config-locations.ts": 26,
		"clients/config-resolve.ts": 8,
		"clients/dead-code-client.ts": 5,
		"clients/dead-code-logger.ts": 3,
		"clients/debug-handles.ts": 2,
		"clients/debug-heap.ts": 7,
		// 32 -> 29 (#3428): the two hand-rolled madge cycle parses (three
		// `path.resolve` calls and two `path:` members between them) folded into
		// one shared `parseMadgeCycles` reader with one of each. Same senses,
		// one reader of the contract instead of two.
		// 29 -> 30 (#3435): the single-file lane now derives its base with
		// `path.dirname(target)` instead of passing `projectRoot` through — one
		// more `path` use, same sense (a path operation).
		"clients/dependency-checker.ts": 30,
		"clients/diagnostic-dispositions.ts": 10,
		"clients/diagnostic-logger.ts": 3,
		"clients/diagnostics-publish.ts": 6,
		"clients/dispatch/dispatcher.ts": 6,
		"clients/dispatch/integration.ts": 1,
		"clients/dispatch/rule-id-normalize.ts": 2,
		"clients/dispatch/rule-ignores.ts": 3,
		"clients/dispatch/runner-context.ts": 14,
		"clients/dispatch/runners/actionlint.ts": 4,
		"clients/dispatch/runners/ast-grep-napi.ts": 4,
		"clients/dispatch/runners/biome-check.ts": 6,
		"clients/dispatch/runners/cpp-check.ts": 7,
		"clients/dispatch/runners/credo.ts": 5,
		"clients/dispatch/runners/cue-vet.ts": 6,
		"clients/dispatch/runners/dart-analyze.ts": 4,
		"clients/dispatch/runners/detekt.ts": 7,
		"clients/dispatch/runners/dotnet-build.ts": 3,
		"clients/dispatch/runners/elixir-check.ts": 6,
		"clients/dispatch/runners/eslint.ts": 3,
		"clients/dispatch/runners/gleam-check.ts": 3,
		"clients/dispatch/runners/golangci-lint.ts": 3,
		"clients/dispatch/runners/hadolint.ts": 4,
		"clients/dispatch/runners/helm-lint.ts": 11,
		"clients/dispatch/runners/helm-render.ts": 16,
		"clients/dispatch/runners/htmlhint.ts": 4,
		"clients/dispatch/runners/javac.ts": 5,
		"clients/dispatch/runners/ktlint.ts": 4,
		"clients/dispatch/runners/markdownlint.ts": 3,
		"clients/dispatch/runners/mypy.ts": 3,
		"clients/dispatch/runners/oxlint.ts": 5,
		"clients/dispatch/runners/php-lint.ts": 4,
		"clients/dispatch/runners/phpstan.ts": 4,
		"clients/dispatch/runners/prisma-validate.ts": 2,
		"clients/dispatch/runners/psscriptanalyzer.ts": 3,
		"clients/dispatch/runners/rubocop.ts": 6,
		"clients/dispatch/runners/shellcheck.ts": 7,
		"clients/dispatch/runners/spellcheck.ts": 6,
		"clients/dispatch/runners/spotbugs.ts": 4,
		"clients/dispatch/runners/sqlfluff.ts": 3,
		"clients/dispatch/runners/stylelint.ts": 5,
		"clients/dispatch/runners/swiftlint.ts": 4,
		"clients/dispatch/runners/taplo.ts": 4,
		"clients/dispatch/runners/terragrunt.ts": 6,
		"clients/dispatch/runners/tflint.ts": 7,
		"clients/dispatch/runners/tree-sitter.ts": 2,
		"clients/dispatch/runners/trivy-config.ts": 4,
		"clients/dispatch/runners/utils/diagnostic-parsers.ts": 3,
		"clients/dispatch/runners/utils/runner-helpers.ts": 23,
		"clients/dispatch/runners/vale.ts": 7,
		"clients/dispatch/runners/yaml-rule-parser.ts": 7,
		"clients/dispatch/runners/yamllint.ts": 3,
		"clients/dispatch/runners/zig-check.ts": 4,
		"clients/dispatch/suppress-writer.ts": 2,
		"clients/disposition-logger.ts": 3,
		"clients/durable-store.ts": 13,
		"clients/effective-config.ts": 5,
		"clients/extension-log.ts": 2,
		"clients/file-kinds.ts": 2,
		"clients/file-time.ts": 7,
		"clients/file-utils.ts": 53,
		"clients/finding-identity.ts": 2,
		"clients/fix-worklog.ts": 3,
		"clients/format-service.ts": 3,
		"clients/formatters.ts": 16,
		"clients/generated-artifacts.ts": 4,
		"clients/generation-lock.ts": 4,
		"clients/git-guard.ts": 7,
		"clients/git-tracked-ignore.ts": 3,
		"clients/gitleaks-client.ts": 24,
		"clients/go-client.ts": 2,
		"clients/govulncheck-client.ts": 7,
		"clients/gradle-ktfmt-style.ts": 5,
		"clients/grammar-source.ts": 4,
		"clients/gzip-stage-write.ts": 2,
		"clients/inline-blocker-dispositions.ts": 2,
		"clients/install-diagnostics.ts": 12,
		"clients/installer/index.ts": 106,
		"clients/installer/managed-tool-refresh.ts": 4,
		"clients/instance-reaper.ts": 4,
		"clients/instance-registry-lock.ts": 8,
		"clients/instance-registry.ts": 2,
		"clients/jscpd-client.ts": 8,
		"clients/json-cache-read.ts": 4,
		"clients/knip-client.ts": 26,
		"clients/language-profile.ts": 14,
		"clients/latency-logger.ts": 2,
		"clients/lens-config.ts": 7,
		"clients/lens-engine.ts": 6,
		"clients/lens-flag-registry.ts": 13,
		"clients/lens-map.ts": 14,
		"clients/log-cleanup.ts": 9,
		"clients/lsp-mutation.ts": 3,
		"clients/lsp/config.ts": 9,
		"clients/lsp/edits.ts": 23,
		"clients/lsp/index.ts": 17,
		"clients/lsp/inferred-project.ts": 3,
		"clients/lsp/jvm-runtime.ts": 19,
		"clients/lsp/language.ts": 3,
		"clients/lsp/launch.ts": 30,
		"clients/lsp/lombok.ts": 14,
		"clients/lsp/server.ts": 121,
		"clients/lsp/session-roots.ts": 6,
		"clients/lsp/workspace-diagnostics-cache.ts": 13,
		"clients/mcp/analyze.ts": 6,
		"clients/mcp/ipc.ts": 4,
		"clients/mcp/session.ts": 3,
		"clients/metrics-client.ts": 6,
		"clients/metrics-history.ts": 12,
		"clients/module-report.ts": 30,
		"clients/mutating-tool.ts": 6,
		"clients/mutation-attribution.ts": 3,
		"clients/ndjson-logger.ts": 5,
		"clients/observed-mutation.ts": 6,
		"clients/opaque-mutation-scan.ts": 5,
		"clients/opengrep-client.ts": 8,
		"clients/opengrep-config.ts": 3,
		"clients/package-manager.ts": 20,
		"clients/package-root.ts": 5,
		"clients/path-keyed-map.ts": 11,
		"clients/path-utils.ts": 30,
		"clients/php-cs-fixer-config.ts": 4,
		"clients/pipeline.ts": 28,
		"clients/probe-home-state.ts": 7,
		"clients/project-changes.ts": 4,
		"clients/project-conventions.ts": 5,
		"clients/project-diagnostics/cache.ts": 4,
		"clients/project-diagnostics/fresh-fetch.ts": 3,
		"clients/project-diagnostics/runner-adapters/call-graph-impact.ts": 3,
		"clients/project-diagnostics/runner-adapters/dead-code.ts": 3,
		"clients/project-diagnostics/runner-adapters/gitleaks.ts": 3,
		"clients/project-diagnostics/runner-adapters/govulncheck.ts": 3,
		"clients/project-diagnostics/runner-adapters/jscpd.ts": 4,
		"clients/project-diagnostics/runner-adapters/knip.ts": 3,
		"clients/project-diagnostics/runner-adapters/madge.ts": 7,
		"clients/project-diagnostics/runner-adapters/opengrep.ts": 6,
		"clients/project-diagnostics/runner-adapters/runner-findings.ts": 4,
		"clients/project-diagnostics/runner-adapters/trivy.ts": 5,
		"clients/project-diagnostics/scanner.ts": 4,
		"clients/project-lens-config.ts": 21,
		"clients/project-report.ts": 5,
		"clients/project-snapshot.ts": 15,
		"clients/python-environment.ts": 18,
		"clients/read-guard-logger.ts": 3,
		"clients/recent-touches.ts": 5,
		"clients/reverse-deps.ts": 8,
		"clients/review-graph-logger.ts": 2,
		"clients/review-graph/builder.ts": 36,
		"clients/review-graph/format.ts": 4,
		"clients/review-graph/git-identity.ts": 10,
		"clients/review-graph/import-resolvers.ts": 62,
		"clients/review-graph/tsconfig-paths.ts": 35,
		"clients/review-graph/workspace-modules.ts": 27,
		"clients/ruff-client.ts": 4,
		"clients/rules-scanner.ts": 8,
		"clients/runtime-agent-end.ts": 12,
		"clients/runtime-coordinator.ts": 25,
		"clients/runtime-session.ts": 15,
		"clients/runtime-tool-call.ts": 22,
		"clients/runtime-tool-result.ts": 22,
		"clients/runtime-turn.ts": 25,
		"clients/rust-client.ts": 5,
		"clients/safe-spawn.ts": 26,
		"clients/sanitize.ts": 2,
		"clients/search-read-registration.ts": 3,
		"clients/security-scan-client.ts": 4,
		"clients/session-state-store.ts": 3,
		"clients/sessionstart-logger.ts": 2,
		"clients/sg-runner.ts": 12,
		"clients/sgconfig.ts": 23,
		"clients/skills-resolver.ts": 3,
		"clients/slow-fs.ts": 4,
		"clients/smells-rollup.ts": 3,
		"clients/source-filter.ts": 11,
		"clients/source-walker.ts": 3,
		"clients/spawn-timeout-cooldown.ts": 3,
		"clients/startup-scan.ts": 11,
		"clients/test-runner-client.ts": 61,
		"clients/todo-scanner.ts": 3,
		"clients/tool-agreement.ts": 4,
		"clients/tool-cwd.ts": 13,
		"clients/tool-policy.ts": 64,
		"clients/tree-sitter-client.ts": 19,
		"clients/tree-sitter-logger.ts": 2,
		"clients/tree-sitter-query-loader.ts": 9,
		"clients/tree-sitter-shared.ts": 2,
		"clients/tree-sitter-symbol-extractor.ts": 3,
		"clients/trivy-client.ts": 5,
		"clients/warm-attach.ts": 3,
		"clients/widget-state.ts": 7,
		"clients/word-index-logger.ts": 2,
		"clients/word-index.ts": 51,
		"clients/workspace-topology.ts": 7,
		"clients/zizmor-config.ts": 4,
		"tools/ast-grep-outline.ts": 8,
		"tools/ast-grep-search.ts": 2,
		"tools/effective-config.ts": 2,
		"tools/lens-diagnostic-mark.ts": 6,
		"tools/lens-diagnostics.ts": 30,
		"tools/lsp-diagnostics.ts": 10,
		"tools/lsp-navigation.ts": 14,
		"tools/module-report.ts": 29,
		"tools/render-compact.ts": 3,
		"tools/symbol-search.ts": 5,
		"mcp/analyze-cli.ts": 4,
		"mcp/cli.ts": 2,
		"mcp/server.ts": 33,
		"index.ts": 20,
	},
	record: {
		"clients/actionable-warnings.ts": 14,
		"clients/advisory-provenance.ts": 8,
		"clients/cache-observability.ts": 2,
		"clients/config-core/merge.ts": 3,
		"clients/config-core/normalize.ts": 11,
		"clients/config-core/records.ts": 6,
		"clients/config-resolve.ts": 16,
		"clients/degradation-ledger.ts": 16,
		"clients/effective-config.ts": 10,
		"clients/git-guard.ts": 44,
		"clients/govulncheck-client.ts": 4,
		"clients/inline-blocker-dispositions.ts": 4,
		"clients/lsp/document-drift.ts": 19,
		"clients/lsp/index.ts": 36,
		"clients/lsp/workspace-diagnostics-cache.ts": 2,
		"clients/mcp/analyze.ts": 2,
		"clients/observed-mutation.ts": 4,
		"clients/opaque-mutation-scan.ts": 1,
		"clients/partial-edit-apply.ts": 5,
		"clients/persistent-reverify.ts": 3,
		"clients/project-diagnostics/fresh-fetch.ts": 12,
		"clients/project-lens-config.ts": 6,
		"clients/project-snapshot.ts": 8,
		"clients/read-bridge.ts": 1,
		"clients/read-guard-tool-lines.ts": 4,
		"clients/read-guard.ts": 22,
		"clients/runtime-agent-end.ts": 54,
		"clients/runtime-context.ts": 2,
		"clients/runtime-coordinator.ts": 16,
		"clients/runtime-tool-call.ts": 1,
		"clients/runtime-tool-result.ts": 5,
		"clients/runtime-turn.ts": 6,
		"clients/search-read-registration.ts": 1,
		"clients/test-runner-client.ts": 4,
		"clients/test-runner-delivery.ts": 15,
		"clients/turn-summary.ts": 4,
		"clients/warm-attach.ts": 9,
		"tools/lsp-diagnostics.ts": 1,
		"tools/lsp-navigation.ts": 12,
		"tools/lsp-structured-output.ts": 13,
		"mcp/analyze-cli.ts": 1,
		"index.ts": 3,
	},
	snapshot: {
		"clients/dispatch/runners/tree-sitter.ts": 5,
		"clients/file-utils.ts": 3,
		"clients/lens-engine.ts": 11,
		"clients/lsp/cascade-tier.ts": 2,
		"clients/lsp/index.ts": 6,
		"clients/lsp/wait-policy/classification.ts": 11,
		"clients/mcp/analyze.ts": 2,
		"clients/metrics-history.ts": 11,
		"clients/observed-mutation.ts": 7,
		"clients/opaque-mutation-scan.ts": 8,
		"clients/partial-edit-apply.ts": 6,
		"clients/pipeline.ts": 6,
		"clients/project-diagnostics/cache.ts": 16,
		"clients/project-diagnostics/scanner.ts": 10,
		"clients/project-report.ts": 3,
		"clients/project-snapshot.ts": 110,
		"clients/read-guard-tool-lines.ts": 3,
		"clients/read-guard.ts": 2,
		"clients/reverse-deps.ts": 14,
		"clients/runtime-session.ts": 41,
		"clients/runtime-tool-call.ts": 2,
		"clients/runtime-tool-result.ts": 2,
		"clients/sgconfig.ts": 3,
		"clients/tool-policy.ts": 2,
		"clients/word-index.ts": 8,
		"tools/lens-diagnostics.ts": 12,
		"tools/lsp-navigation.ts": 9,
		"mcp/server.ts": 22,
	},
	status: {
		"clients/actionable-warnings.ts": 5,
		"clients/advisory-provenance.ts": 5,
		"clients/ast-grep-client.ts": 7,
		"clients/ast-grep-rule-manager.ts": 5,
		"clients/biome-client.ts": 1,
		"clients/bundled-resource-health.ts": 11,
		"clients/cache-observability.ts": 18,
		"clients/call-graph.ts": 6,
		"clients/child-unref.ts": 6,
		"clients/config-resolve.ts": 11,
		"clients/dead-code-client.ts": 3,
		"clients/dispatch/dispatcher.ts": 37,
		"clients/dispatch/integration.ts": 1,
		"clients/dispatch/pending-runner-findings.ts": 1,
		"clients/dispatch/runners/actionlint.ts": 2,
		"clients/dispatch/runners/ast-grep-napi.ts": 11,
		"clients/dispatch/runners/biome-check.ts": 10,
		"clients/dispatch/runners/cpp-check.ts": 3,
		"clients/dispatch/runners/credo.ts": 2,
		"clients/dispatch/runners/cue-vet.ts": 8,
		"clients/dispatch/runners/dart-analyze.ts": 1,
		"clients/dispatch/runners/detekt.ts": 5,
		"clients/dispatch/runners/dotnet-build.ts": 4,
		"clients/dispatch/runners/elixir-check.ts": 2,
		"clients/dispatch/runners/eslint.ts": 3,
		"clients/dispatch/runners/fact-rules.ts": 2,
		"clients/dispatch/runners/fish-indent.ts": 6,
		"clients/dispatch/runners/gleam-check.ts": 7,
		"clients/dispatch/runners/go-vet.ts": 5,
		"clients/dispatch/runners/golangci-lint.ts": 4,
		"clients/dispatch/runners/hadolint.ts": 3,
		"clients/dispatch/runners/helm-lint.ts": 5,
		"clients/dispatch/runners/helm-render.ts": 7,
		"clients/dispatch/runners/htmlhint.ts": 3,
		"clients/dispatch/runners/javac.ts": 4,
		"clients/dispatch/runners/ktlint.ts": 2,
		"clients/dispatch/runners/lsp.ts": 11,
		"clients/dispatch/runners/markdownlint.ts": 4,
		"clients/dispatch/runners/mypy.ts": 2,
		"clients/dispatch/runners/oxlint.ts": 12,
		"clients/dispatch/runners/php-lint.ts": 3,
		"clients/dispatch/runners/phpstan.ts": 4,
		"clients/dispatch/runners/prisma-validate.ts": 5,
		"clients/dispatch/runners/psscriptanalyzer.ts": 14,
		"clients/dispatch/runners/pyright.ts": 4,
		"clients/dispatch/runners/rubocop.ts": 2,
		"clients/dispatch/runners/ruff.ts": 2,
		"clients/dispatch/runners/rust-clippy.ts": 8,
		"clients/dispatch/runners/shellcheck.ts": 4,
		"clients/dispatch/runners/shfmt.ts": 8,
		"clients/dispatch/runners/spellcheck.ts": 3,
		"clients/dispatch/runners/spotbugs.ts": 8,
		"clients/dispatch/runners/sqlfluff.ts": 3,
		"clients/dispatch/runners/stylelint.ts": 2,
		"clients/dispatch/runners/swiftlint.ts": 3,
		"clients/dispatch/runners/taplo.ts": 5,
		"clients/dispatch/runners/terragrunt.ts": 2,
		"clients/dispatch/runners/tflint.ts": 3,
		"clients/dispatch/runners/tree-sitter.ts": 14,
		"clients/dispatch/runners/trivy-config.ts": 10,
		"clients/dispatch/runners/utils/availability-policy.ts": 5,
		"clients/dispatch/runners/utils/candidate-probe.ts": 1,
		"clients/dispatch/runners/utils/lazy-installer.ts": 3,
		"clients/dispatch/runners/utils/runner-helpers.ts": 8,
		"clients/dispatch/runners/utils/spawn-outcome.ts": 9,
		"clients/dispatch/runners/utils/tool-failure.ts": 21,
		"clients/dispatch/runners/vale.ts": 4,
		"clients/dispatch/runners/yamllint.ts": 2,
		"clients/dispatch/runners/zig-check.ts": 3,
		"clients/dispatch/types.ts": 1,
		"clients/file-utils.ts": 2,
		"clients/finding-delivery-gate.ts": 3,
		"clients/formatters.ts": 8,
		"clients/git-tracked-ignore.ts": 2,
		"clients/govulncheck-client.ts": 5,
		"clients/grammar-source.ts": 2,
		"clients/host-ports.ts": 2,
		"clients/installer/index.ts": 42,
		"clients/installer/managed-tool-refresh.ts": 9,
		"clients/instance-reaper.ts": 13,
		"clients/jscpd-client.ts": 3,
		"clients/knip-client.ts": 4,
		"clients/latency-logger.ts": 1,
		"clients/lens-config.ts": 2,
		"clients/lens-engine.ts": 4,
		"clients/lsp-mutation.ts": 7,
		"clients/lsp/client.ts": 31,
		"clients/lsp/edits.ts": 2,
		"clients/lsp/index.ts": 5,
		"clients/lsp/jvm-runtime.ts": 1,
		"clients/lsp/server.ts": 4,
		"clients/mcp/analyze.ts": 9,
		"clients/mcp/review.ts": 1,
		"clients/module-report.ts": 6,
		"clients/opaque-mutation-scan.ts": 24,
		"clients/opengrep-client.ts": 9,
		"clients/package-manager.ts": 2,
		"clients/pipeline.ts": 5,
		"clients/process-snapshot.ts": 4,
		"clients/project-diagnostics/runner-adapters/runner-findings.ts": 2,
		"clients/project-diagnostics/scanner.ts": 1,
		"clients/project-lens-config.ts": 4,
		"clients/read-guard.ts": 13,
		"clients/resource-sampler.ts": 7,
		"clients/review-graph-logger.ts": 1,
		"clients/review-graph/builder.ts": 11,
		"clients/runtime-context.ts": 4,
		"clients/runtime-coordinator.ts": 4,
		"clients/runtime-turn.ts": 6,
		"clients/safe-spawn.ts": 24,
		"clients/security-scan-client.ts": 2,
		"clients/sg-runner.ts": 32,
		"clients/shared-checkout-guard.ts": 2,
		"clients/skills-resolver.ts": 6,
		"clients/spawn-timeout-cooldown.ts": 1,
		"clients/test-runner-client.ts": 15,
		"clients/tree-sitter-logger.ts": 2,
		"clients/tree-sitter-query-loader.ts": 1,
		"clients/tree-sitter-shared.ts": 1,
		"clients/widget-state.ts": 12,
		"clients/word-index.ts": 6,
		"clients/zizmor-config.ts": 3,
		"tools/lsp-structured-output.ts": 3,
		"mcp/analyze-cli.ts": 2,
		"mcp/server.ts": 1,
		"index.ts": 2,
	},
	telemetry: {
		"clients/lsp-mutation.ts": 11,
		"clients/lsp/client.ts": 2,
		// #3506: the re-token rewrites `ctx.telemetry` (22 -> 26); the field
		// is the context's own name, so it is routed, not renamed, here.
		"clients/pipeline.ts": 26,
		"clients/runtime-tool-result.ts": 1,
	},
	version: {
		"clients/build-identity.ts": 5,
		"clients/cache-observability.ts": 2,
		"clients/cache/rule-cache.ts": 3,
		"clients/call-graph.ts": 4,
		"clients/codebase-model.ts": 3,
		"clients/dispatch/runners/oxlint.ts": 3,
		"clients/grammar-source.ts": 4,
		"clients/install-diagnostics.ts": 3,
		"clients/installer/index.ts": 60,
		"clients/installer/managed-tool-refresh.ts": 24,
		"clients/knip-client.ts": 8,
		"clients/lens-events.ts": 4,
		"clients/lsp/client.ts": 35,
		"clients/lsp/diagnostic-binding.ts": 1,
		"clients/lsp/edits.ts": 24,
		"clients/lsp/index.ts": 6,
		"clients/lsp/lombok.ts": 6,
		"clients/lsp/server.ts": 16,
		"clients/lsp/workspace-diagnostics-cache.ts": 7,
		"clients/mcp/ipc.ts": 15,
		"clients/metrics-history.ts": 3,
		"clients/module-report.ts": 1,
		"clients/mutation-attribution.ts": 5,
		"clients/mutation-bridge.ts": 2,
		"clients/ndjson-logger.ts": 7,
		"clients/process-bridge.ts": 4,
		"clients/process-singletons.ts": 10,
		"clients/project-diagnostics/cache.ts": 2,
		"clients/project-diagnostics/runner-adapters/trivy.ts": 2,
		"clients/project-diagnostics/scanner.ts": 2,
		"clients/project-diagnostics/types.ts": 2,
		"clients/project-snapshot.ts": 17,
		"clients/read-bridge.ts": 2,
		"clients/read-guard.ts": 3,
		"clients/review-graph/builder.ts": 27,
		"clients/review-graph/types.ts": 1,
		"clients/runtime-session.ts": 8,
		"clients/runtime-turn.ts": 1,
		"clients/session-state-store.ts": 3,
		"clients/tool-agreement.ts": 19,
		"clients/turn-summary.ts": 2,
		"clients/warm-attach.ts": 4,
		"clients/widget-state.ts": 5,
		"clients/word-index.ts": 5,
		"tools/lens-diagnostics.ts": 1,
		"mcp/server.ts": 7,
		"index.ts": 4,
	},
	warning: {
		"clients/actionable-warnings.ts": 63,
		"clients/ast-grep-client.ts": 4,
		"clients/code-quality-warnings.ts": 32,
		"clients/dispatch/runners/rubocop.ts": 1,
		"clients/dispatch/runners/shellcheck.ts": 1,
		"clients/dispatch/runners/swiftlint.ts": 1,
		"clients/dispatch/runners/vale.ts": 1,
		"clients/dispatch/utils/format-utils.ts": 2,
		"clients/module-report.ts": 2,
		"clients/persistent-reverify.ts": 3,
		"clients/pipeline.ts": 6,
		"clients/project-diagnostics/runner-adapters/call-graph-impact.ts": 1,
		"clients/runtime-agent-end.ts": 6,
		"clients/runtime-coordinator.ts": 6,
		"clients/runtime-turn.ts": 21,
		"clients/secret-findings.ts": 3,
		"clients/widget-state.ts": 1,
		"tools/ast-grep-search.ts": 6,
		"tools/lens-diagnostics.ts": 7,
		"tools/lsp-diagnostics.ts": 1,
	},
};

describe("glossary synonym-retirement sweep (#3259)", () => {
	it("parses the complete glossary and pins its identifier population", () => {
		const glossary = parseGlossary();
		expect([...glossary.keys()]).toEqual(EXPECTED_GLOSSARY_TERMS);
		const terms = identifierTerms(glossary);
		expect(terms).toEqual(EXPECTED_IDENTIFIER_TERMS);
		expect(terms).toHaveLength(24);
		const counts = census(terms);
		expect(Object.keys(counts)).toHaveLength(18);
		expect(terms.filter((term) => !(term in counts))).toHaveLength(6);
		for (const term of terms) {
			const live = counts[term] ?? {};
			const pinned = PINS[term] ?? {};
			// GROW arm: every live `file@count` must be pinned.
			const grow = auditSymbolCounts({
				sweepName: `glossary retired identifier ${term} — UNPINNED live uses (#3259)`,
				counts: live,
				pinned,
				remediation: `A new or changed use of retired glossary identifier ${term} is not pinned. Rename or route it; only then raise its per-file pin. Refs #3259.`,
			});
			// SHRINK arm: the same call with the roles SWAPPED, because
			// `auditRegistry` deliberately permits a registered id the scan no
			// longer flags. Feeding the PINS as the flagged population and the
			// live census as the registry turns a vanished row into an ordinary
			// unaccounted item, so the two key sets must be equal for both arms
			// to be clean (#3279 G-3279-4, the #3256 M3c shape).
			const shrink = auditSymbolCounts({
				sweepName: `glossary retired identifier ${term} — STALE pins (#3259)`,
				counts: pinned,
				pinned: live,
				remediation: `A pinned use of retired glossary identifier ${term} is gone from the live census. SHRINK the pin to the live count (or delete the row) so the inventory cannot hold a retired use that no longer exists. Refs #3259.`,
			});
			// Asserted TOGETHER, never one arm at a time: a count that MOVED
			// (rather than appeared or vanished) is unaccounted in both arms, and
			// a short-circuit on the grow assertion would report only the
			// `UNPINNED live uses` half and mislabel a shrink as a new use.
			expect({ grow: grow.problems, shrink: shrink.problems }, term).toEqual({
				grow: [],
				shrink: [],
			});
		}
	});

	it("pins the retired-in-one-sense terms with their glossary owners", () => {
		// Prevents #3279 G-3279-2: the canonical-collision exclusion is the
		// census's widest hole, so it must be a derived, pinned list with an
		// owning module per term — not a prose table in a PR body that can
		// carry a wrong owner or miss a row.
		expect(retiredInOneSense(parseGlossary())).toEqual(
			EXPECTED_RETIRED_IN_ONE_SENSE,
		);
		// That every pinned row is actually excluded from the census is asserted
		// once, by `excludes canonical spellings from the global retirement
		// census`, which loops this same pin.
	});

	it("derives a new canonical collision and its owner from the glossary", () => {
		// The derivation is real logic, not a restatement of the pin: a scratch
		// glossary that promotes a currently retired-only spelling to a
		// canonical bullet must appear in the report with that bullet's owner.
		const scratch = [
			"## Glossary",
			"- **advisory** — tier; owned by `clients/finding-delivery-gate.ts`; retires `warning`.",
			"- **warning** — promoted; owned by `clients/actionable-warnings.ts`; retires `note`.",
			"Where two spellings",
		].join("\n");
		expect(retiredInOneSense(parseGlossary(scratch))).toEqual([
			{
				term: "warning",
				owner: "clients/actionable-warnings.ts",
				retiredBy: ["advisory"],
			},
		]);
	});

	it("rejects malformed retirement declarations loudly", () => {
		// Prevents #3279 G-3279-1: a typo such as `retires:` must not
		// self-excuse a glossary family from the governed population.
		const malformed =
			"## Glossary\n- **scratch** — probe; retires: `phantom`.\nWhere two spellings";
		expect(() => parseGlossary(malformed)).toThrow(
			/malformed glossary retirement declaration/,
		);
		// The sibling direction: a declaration that matches the grammar but
		// names no backticked synonym would contribute an empty family.
		const synonymless =
			"## Glossary\n- **scratch** — probe; retires nothing at all.\nWhere two spellings";
		expect(() => parseGlossary(synonymless)).toThrow(
			/no parsed retired synonyms/,
		);
	});

	it("excludes canonical spellings from the global retirement census", () => {
		// Prevents #3279 G-3279-2: a canonical `diagnostic` identifier must
		// remain valid even when another concept retires that spelling. The
		// control below proves the counter itself still sees such a token, so
		// the exclusion is a policy choice and not a broken detector.
		const glossary = parseGlossary();
		const terms = identifierTerms(glossary);
		for (const { term } of EXPECTED_RETIRED_IN_ONE_SENSE) {
			expect(terms, term).not.toContain(term);
		}
		expect(countIdentifier("const diagnostic = 1;", "diagnostic")).toBe(1);
	});

	it("uses identifier boundaries, not substring matching", () => {
		const source = stripSource(
			"const blockerCount = 1; const blocker = blockerCount; obj.blocker;",
			{ strings: "blank" },
		);
		expect(countIdentifier(source, "blocker")).toBe(2);
	});

	it("ignores comments, strings, and template text but counts interpolation code", () => {
		const source = stripSource(
			"// warning\n/* warning */ const a = 'warning'; const b = `warning`; const c = `\${warning}`;",
			{ strings: "blank" },
		);
		expect(countIdentifier(source, "warning")).toBe(1);
	});
});
