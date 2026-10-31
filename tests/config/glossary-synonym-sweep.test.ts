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
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

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
	"path identity",
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
		// 3 -> 10 (#4718): the prompt-cache read every shortfall is measured
		// against, named once in `nextCacheBaseline` and carried on the record as
		// `cacheBaseline`. This is the cached-prefix sense, not the governance
		// sense `ratchet` retires (`baseline` as an admitted population), and no
		// use here admits, exempts or caps anything.
		"clients/cache-observability.ts": 10,
		"clients/lsp/diagnostic-binding.ts": 4,
		"clients/lsp/index.ts": 13,
		"clients/lsp/server.ts": 3,
		"clients/mcp/session.ts": 4,
		"clients/metrics-client.ts": 7,
		"clients/observed-mutation.ts": 7,
		// 12 -> 11 (#2050): the prescan's `let baseline` local moved into
		// `captureOpaqueBaseline`'s returned `state`, so one identifier use is
		// gone. Every remaining use is the pending opaque baseline, which the
		// glossary does not retire (it retires `baseline` where a freshness
		// reference is meant).
		"clients/runtime-tool-call.ts": 11,
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
		"clients/lsp/workspace-diagnostics-cache.ts": 13,
		"clients/project-diagnostics/runner-adapters/runner-findings.ts": 8,
		"clients/review-graph/builder.ts": 4,
		"clients/review-graph/tsconfig-paths.ts": 6,
		"clients/source-filter.ts": 4,
		"clients/tree-sitter-cache.ts": 16,
		// #4129 adds cache terminology for the persist-owned serialized view.
		"clients/word-index.ts": 15,
	},
	channel: {
		"clients/agent-nudge.ts": 1,
		"clients/host-ports.ts": 1,
		"clients/live-bus-emitter.ts": 1,
		"clients/widget-state.ts": 1,
		"index.ts": 2,
	},
	consumer: {
		// #3654: the unified bridge's frozen `BridgeEntry.consumer` field (RFC §3)
		// and the v1 shim reads that forward it (D14). Caller-identity sense; the
		// lexical census cannot tell it apart from the retired delivery-surface
		// sense. New internal code in `clients/io-bridge.ts` says `caller`; only
		// the frozen public/RFC field reads remain.
		"clients/ast-grep-client.ts": 1,
		"clients/io-bridge-contract.ts": 1,
		"clients/lsp-mutation.ts": 1,
		"clients/mutating-tool.ts": 2,
		"clients/observed-mutation.ts": 3,
		"tools/lens-diagnostic-mark.ts": 1,
		"clients/read-bridge.ts": 5,
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
		"clients/bounded-pid-file-lock.ts": 9,
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
		"clients/dispatch/runners/helm-lint.ts": 2,
		"clients/dispatch/runners/helm-render.ts": 7,
		"clients/dispatch/runners/oxlint.ts": 3,
		"clients/dispatch/runners/psscriptanalyzer.ts": 3,
		"clients/dispatch/runners/rust-clippy.ts": 1,
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
		"clients/format-events-publish.ts": 4,
		"clients/format-service.ts": 11,
		"clients/formatters.ts": 26,
		"clients/generation-lock.ts": 7,
		"clients/git-tracked-ignore.ts": 2,
		"clients/govulncheck-client.ts": 6,
		// 2 -> 4 (#4402): the worker loop's catch answers with an `error`, and
		// readGzipStageWorkerResult reads the wire field `error` (the worker
		// protocol's own field name, not a delivery tier).
		"clients/gzip-stage-write.ts": 4,
		"clients/install-diagnostics.ts": 4,
		// 26 -> 28 (#4530), and the new launch.ts row:
		// starts that moved onto the spawn seam read the spawn result's `error`
		// field (SpawnResult.error), not a delivery tier.
		"clients/installer/index.ts": 28,
		"clients/installer/managed-tool-refresh.ts": 2,
		"clients/instance-reaper.ts": 4,
		"clients/instance-registry-lock.ts": 3,
		"clients/jscpd-client.ts": 2,
		"clients/knip-client.ts": 3,
		"clients/lens-config.ts": 4,
		"clients/lens-events.ts": 1,
		"clients/live-bus-emitter.ts": 2,
		"clients/lsp/cascade-tier.ts": 1,
		"clients/lsp/client-registry.ts": 4,
		"clients/lsp/client.ts": 13,
		"clients/lsp/index.ts": 24,
		"clients/lsp/jvm-runtime.ts": 1,
		"clients/lsp/launch.ts": 1,
		"clients/lsp/server.ts": 13,
		"clients/mcp/ipc.ts": 8,
		"clients/mcp/review.ts": 8,
		"clients/mcp/session.ts": 1,
		"clients/module-report.ts": 27,
		// 3 -> 5 (#4493): readGitHead and listGitHeadDelta read the spawn
		// result's `error` field (SpawnResult.error), not a delivery tier.
		"clients/opaque-mutation-scan.ts": 5,
		"clients/opengrep-client.ts": 11,
		"clients/package-manager.ts": 2,
		"clients/partial-edit-apply.ts": 7,
		"clients/performance-report.ts": 3,
		"clients/pipeline.ts": 13,
		"clients/project-diagnostics/fresh-fetch.ts": 4,
		"clients/project-diagnostics/runner-adapters/call-graph-impact.ts": 1,
		"clients/project-diagnostics/runner-adapters/runner-findings.ts": 4,
		"clients/project-lens-config.ts": 3,
		"clients/project-snapshot-persist-worker.ts": 1,
		"clients/project-snapshot.ts": 7,
		"clients/project-trust.ts": 1,
		"clients/review-graph-logger.ts": 1,
		"clients/review-graph/builder.ts": 16,
		"clients/ruff-client.ts": 7,
		"clients/runtime-agent-end.ts": 6,
		"clients/runtime-tool-call.ts": 7,
		"clients/runtime-turn.ts": 10,
		// 52 -> 53 (#4530): a lookup refusal builds its SpawnResult's `error`.
		"clients/safe-spawn.ts": 53,
		// 2 -> 6: the report-scan seam (`runReportScan`) carries the `result.error` reads
		// gitleaks (3) and trivy (3) each had, plus the failure record; net 8 -> 6.
		"clients/security-scan-client.ts": 6,
		"clients/sg-runner.ts": 32,
		"clients/shared-checkout-guard.ts": 1,
		"clients/single-flight.ts": 3,
		"clients/smells-rollup.ts": 2,
		"clients/test-runner-client.ts": 21,
		"clients/test-runner-delivery.ts": 6,
		"clients/tool-agreement.ts": 2,
		"clients/tree-sitter-cache.ts": 4,
		// #3605: 18 -> 6. The rewritten wasm classifier, `reportWasmAbort` and
		// the `parseFileAndUse` consume catch name their parameter `thrown`.
		"clients/tree-sitter-client.ts": 6,
		"clients/tree-sitter-logger.ts": 1,
		"clients/tree-sitter-symbol-extractor.ts": 3,
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
		"tools/lsp-diagnostics.ts": 8,
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
		// 2 -> 3 (#4250): the secondary turn-state partition adds one bounded
		// read/filter path; retain the semantic census rather than hiding it.
		"clients/cache-manager.ts": 3,
		"clients/cache-observability.ts": 2,
		"clients/call-graph.ts": 4,
		// 4 -> 5 (#4403): `renderCascadeResult` keeps the notes whose servers
		// are undelivered, an `Array.prototype.filter` call, not a delivery
		// filter. 5 -> 6 (#4532 round 5): `applyCascadeDisplayPolicy` keeps
		// the rows still at error severity after the environment-gap demotion,
		// the same `Array.prototype.filter` shape.
		"clients/cascade-format.ts": 6,
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
		// 0 -> 1 (#3218): the demotion path now drops the promotion-note row as
		// part of degrading a demoted body, one `Array.prototype.filter` use.
		"clients/demoted-finding-render.ts": 1,
		// 9 -> 7 (#3436): deleting `parseMadgeSkips` removed its two
		// `Array.prototype.filter` uses; `localSkips`/the skip channel it served
		// were structurally always zero under `--json`.
		"clients/dependency-checker.ts": 7,
		"clients/diagnostic-dispositions.ts": 3,
		"clients/diagnostic-tracker.ts": 1,
		"clients/diagnostics-publish.ts": 2,
		// 3 -> 5 (#4944): `dropExcludedServers` keeps the rows and the
		// coverage-gap names of servers that are not switched off, two
		// `Array.prototype.filter` calls, not a delivery filter.
		"clients/dispatch/auxiliary-lsp.ts": 5,
		// 16 -> 17 (#4484): `heldBackBlockers` keeps the blocking findings the
		// delta calls not new, an `Array.prototype.filter` call, not a delivery
		// filter.
		// 17 -> 21 (#4483): the pre-edit seed classification keeps the
		// blocking findings it reports and removes its matches from the visible
		// and held-back lists, `Array.prototype.filter` calls, not a delivery
		// filter.
		// 21 -> 22 (#5010): `buildCoverageNotice` keeps the rows
		// `dispatch.disabledRunners` skipped, an `Array.prototype.filter` call,
		// not a delivery filter.
		"clients/dispatch/dispatcher.ts": 22,
		"clients/dispatch/fact-runner.ts": 1,
		"clients/dispatch/fact-scheduler.ts": 2,
		"clients/dispatch/facts/function-facts.ts": 2,
		"clients/dispatch/facts/import-facts.ts": 1,
		"clients/dispatch/finding-policy.ts": 3,
		"clients/dispatch/indent-detect.ts": 4,
		"clients/dispatch/inline-suppressions.ts": 2,
		// 18 -> 20 (#4438): the cascade's implicit-scope dependents keep the Go
		// peers and the ranked JS/TS files a change reaches, two
		// `Array.prototype.filter` calls, not a delivery filter.
		// 20 -> 19 (#4485): the rolling delta's per-neighbour diagnostics
		// `Array.prototype.filter` is deleted with the delta.
		// 19 -> 20 (#4483): the pre-edit capture keeps a dispatch group's
		// linter runner ids, an `Array.prototype.filter` call.
		// 20 -> 21 (#5055): the unplaced-referrer check drops the files edited this
		// turn with one `Array.prototype.filter`.
		"clients/dispatch/integration.ts": 21,
		// #4483: the seed's runner and line selection, `Array.prototype.filter`
		// calls, not a delivery filter.
		"clients/dispatch/pre-edit-seed.ts": 4,
		"clients/dispatch/rule-policy.ts": 1,
		"clients/dispatch/rules/high-fan-out.ts": 1,
		"clients/dispatch/rules/missing-error-propagation.ts": 3,
		// New (#4496): drops `true` parts from a literal requirement, an
		// `Array.prototype.filter` call, not a delivery gate.
		"clients/dispatch/runners/ast-grep-literal-anchors.ts": 1,
		"clients/dispatch/runners/ast-grep-napi.ts": 2,
		"clients/dispatch/runners/cue-vet.ts": 2,
		"clients/dispatch/runners/go-vet.ts": 2,
		"clients/dispatch/runners/golangci-lint.ts": 1,
		"clients/dispatch/runners/helm-lint.ts": 1,
		"clients/dispatch/runners/helm-render.ts": 3,
		// 4 -> 5 (#4481), 5 -> 4 (#4484 r2): the per-edit pass partitions an
		// ast-grep LSP blocker on an unchanged line into `outOfEditScope` instead
		// of dropping it, so the scope decides delivery only.
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
		"clients/file-utils.ts": 3,
		"clients/fix-worklog.ts": 1,
		"clients/format-service.ts": 2,
		"clients/formatters.ts": 6,
		"clients/generated-artifacts.ts": 1,
		// 9 -> 10 (#4725): `syncGitGuardRecord` keeps a record's blocker
		// sections other than the re-checked file's, an `Array.prototype.filter`
		// call, not a delivery filter.
		// 10 -> 14 (#4738): four more `Array.prototype.filter` calls, not a
		// delivery filter: the per-session partition trim, the turn-end
		// composer's read of the other sessions' sections, and the settled turn
		// end's rewrite keep the sections and files nothing re-checked.
		"clients/git-guard.ts": 14,
		"clients/gitleaks-client.ts": 1,
		"clients/govulncheck-client.ts": 1,
		"clients/gradle-ktfmt-style.ts": 1,
		"clients/inline-blocker-dispositions.ts": 1,
		// `clients/inline-blocker-fields.ts`'s row is GONE (#5008 r3): the 2
		// (#3814 r2) pinned `.filter(` calls — the own-file line filter and its
		// number filter — became one classification loop in
		// `inlineBlockerPlacement`, which returns the places AND the counts of what
		// it could not place. No delivery filter left the tree; the file has no
		// `filter` use left to pin.
		"clients/installer/index.ts": 4,
		"clients/installer/managed-tool-refresh.ts": 2,
		"clients/instance-reaper.ts": 3,
		// 11 → 10 (#3587): deregisterInstanceRootNow's whole-entry removal now
		// shares withoutOwnEntry's own `.filter(` instead of inlining a second
		// one; the net `.filter(` count in the file drops by one.
		// 10 → 15 (#3849): `readRootHolders` and `settleRootHolders` narrow the
		// holder records to strings and to the capped root set, and
		// `planRootRemoval` ends one holder's record; all are
		// `Array.prototype.filter` over roots, none a delivery filter.
		"clients/instance-registry.ts": 15,
		"clients/knip-client.ts": 3,
		"clients/language-policy.ts": 2,
		"clients/language-profile.ts": 2,
		"clients/language-registry.ts": 1,
		"clients/lens-config.ts": 1,
		// 3 -> 2 (#5047 F5): the engine's own blank-entry filter is deleted; the
		// shared reader in tools/shared.ts owns the rule.
		"clients/lens-engine.ts": 2,
		"clients/lens-flag-registry.ts": 2,
		"clients/lens-map.ts": 2,
		"clients/lsp-budget.ts": 1,
		"clients/lsp/aggregation.ts": 6,
		"clients/lsp/client-registry.ts": 2,
		"clients/lsp/client.ts": 18,
		"clients/lsp/config.ts": 3,
		"clients/lsp/diagnostic-binding.ts": 1,
		// 1 -> 2 (#3734 r3): the rename capture selects the contributing
		// clients that hold no comparable send record.
		"clients/lsp/edits.ts": 2,
		// 48 → 50 (#3828 r3): `resyncGitChangedFiles` splits its held targets
		// into the changed paths (queued as a save) and their importers (not).
		// 50 -> 51 (#3734): rename-file provenance selects contributing clients.
		// 49 -> 50 (#4323): a read that excludes a switched-off server drops
		// that server's rows from the last known answer it falls back to.
		// 51 -> 50 (#4944): the stored-rows filter above moved into
		// `dropExcludedServers` (`clients/dispatch/auxiliary-lsp.ts`).
		"clients/lsp/index.ts": 50,
		"clients/lsp/inferred-project.ts": 2,
		"clients/lsp/jvm-runtime.ts": 3,
		"clients/lsp/language.ts": 1,
		// 2 -> 1 (#4532 round 3): the in-process PATH scan replaced the
		// `which` output chain whose `.filter(Boolean)` was the second use.
		"clients/lsp/launch.ts": 1,
		"clients/lsp/ruby-drive-dirs.ts": 1,
		"clients/lsp/server.ts": 5,
		// 1 (#4403): `disabledPrimaryServerIds` is an `Array.prototype.filter`
		// over registered servers, not a delivery filter.
		// 1 -> 3 (#4403 round 4): `disabledPrimaries` selects the file's
		// primaries once, then splits them into disabled ones and the
		// `fallbackFor` alternates standing in for a disabled owner.
		"clients/lsp/session-roots.ts": 3,
		"clients/lsp/tsserver-sync.ts": 1,
		"clients/lsp/wait-policy/classification.ts": 1,
		// 1 -> 2 (#3752): the count-vs-list merge adds one `result.warnings.filter`
		// to fold the dispatcher's warnings bucket into the serialized list.
		"clients/mcp/analyze.ts": 2,
		"clients/middle-man-analysis.ts": 4,
		"clients/model-provider.ts": 1,
		"clients/module-report.ts": 17,
		"clients/mutation-attribution.ts": 2,
		"clients/ndjson-logger.ts": 1,
		"clients/observed-mutation.ts": 2,
		// 0 -> 1 (#4493): listGitHeadDelta drops the empty NUL-split entries,
		// an `Array.prototype.filter` call, not a delivery filter.
		// 1 -> 2 (#4502): readSameHeadDiscards keeps the paths that were dirty
		// before a command and are clean after it, another
		// `Array.prototype.filter` call.
		"clients/opaque-mutation-scan.ts": 2,
		"clients/opengrep-client.ts": 2,
		// 1 (#5009): the venv interpreter candidates are filtered to directories
		// and symlinks BEFORE the cap, an `Array.prototype.filter` call, not a
		// delivery filter.
		"clients/out-of-band-changes.ts": 1,
		"clients/path-utils.ts": 1,
		"clients/persistent-reverify.ts": 4,
		// 4 -> 6 (#4484): `liveBlockers.filter` and `recordBlockers.filter` split the
		// live blocking set into the delta's and the held-back ones, two
		// `Array.prototype.filter` calls, not a delivery filter.
		// 6 -> 8 (#4483): the seeded findings split into pre-existing and
		// recorded ones, two `Array.prototype.filter` calls.
		"clients/pipeline.ts": 8,
		"clients/process-snapshot.ts": 5,
		"clients/project-changes.ts": 3,
		"clients/project-diagnostics/cache.ts": 2,
		"clients/project-diagnostics/fresh-fetch.ts": 2,
		"clients/project-diagnostics/runner-adapters/runner-findings.ts": 2,
		"clients/project-diagnostics/scanner.ts": 1,
		// 5 -> 6 (#4226): the shared `rules.<id>.ignorePaths` field is parsed by
		// this loader during the compatibility projection; the identifier is the
		// public setting name, not a second ignore policy.
		"clients/project-lens-config.ts": 7,
		"clients/project-report.ts": 10,
		"clients/project-snapshot.ts": 3,
		"clients/python-provenance.ts": 4,
		"clients/read-guard-logger.ts": 3,
		"clients/read-guard-tool-lines.ts": 6,
		"clients/read-guard.ts": 9,
		"clients/recent-touches.ts": 2,
		"clients/resource-sampler.ts": 2,
		"clients/reverse-deps.ts": 1,
		// 10 -> 12 (#4346): the update selects the files new to the graph.
		"clients/review-graph/builder.ts": 12,
		"clients/review-graph/import-resolvers.ts": 3,
		"clients/review-graph/query.ts": 5,
		"clients/review-graph/service.ts": 1,
		"clients/review-graph/tsconfig-paths.ts": 4,
		"clients/review-graph/workspace-modules.ts": 6,
		"clients/ruff-client.ts": 1,
		"clients/runtime-agent-end.ts": 7,
		// 3 -> 4 (#4921): `getInlineBlockersSnapshot` keeps one turn session's
		// records, an `Array.prototype.filter` call, not a delivery gate.
		// 4 -> 5 (#4990): the per-source row retirement keeps the rows the clean
		// verdict did not cover, the same array call, not a delivery gate.
		// 5 -> 6 (#5020): `retireForeignRows` keeps the rows no retire judged, the
		// same array call, not a delivery gate.
		"clients/runtime-coordinator.ts": 6,
		"clients/runtime-session.ts": 4,
		// 3 -> 5 -> 3 (#4187): round 4's tool-call authorship retirement filtered
		// the owned in-process mutation paths; round 5 folds two of its three
		// branches onto the observational net's arm, and the surviving ast-grep
		// site walks its `paths` array instead of filtering it.
		"clients/runtime-tool-call.ts": 3,
		// #4535 slice 2: the LSP consumer narrows a publish's population to the
		// documents a live client holds and keeps the stale ones among them —
		// two `Array.prototype.filter` calls that moved here from
		// `runtime-tool-result.ts` with the held-primary pass, not a delivery
		// filter.
		"clients/disk-change-subscribers.ts": 2,
		// 5 -> 8 (#4493): the HEAD-move look keeps the held documents of the
		// delta and the stale ones among them, and counts the dispositions;
		// three `Array.prototype.filter` calls, not a delivery filter.
		// 8 -> 6 (#4535 slice 2): two of those calls moved into
		// `clients/disk-change-subscribers.ts` with the held-primary pass; the
		// disposition count stays here.
		// 6 -> 5 (#2050): the recognized paths are judged by their own root's
		// verdict in a loop, so `recognizedAuthored = scanned.filter(...)` is gone.
		// The bash drift pass buckets its opaque paths in a `Map` (the
		// `sendsByRoot` idiom beside it) rather than filtering per root.
		// 5 -> 6 (#4732): the opaque paths drop the ones an armed observation
		// of the same call answers for; one `Array.prototype.filter`.
		"clients/runtime-tool-result.ts": 6,
		// 31 -> 33 (#3901): the cut-advisory hold keeps the fresh items of a part
		// (one `Array.prototype.filter`), and the call-graph lane drops a parked
		// file it already walks as fresh (one). The knip and dead-code re-offers
		// share one helper in turn-end/delivery-holds.ts instead of two copies.
		// 33 -> 31 (#2542 ask 3): the deferred-target merge and bound moved to
		// clients/deferred-test-targets.ts, taking its two `Array.prototype.filter`
		// passes with it.
		// 30 -> 33 (#4485/#4487): the turn_end cascade delivery keeps the
		// neighbours a run owns, the pending entries this turn did not observe
		// and the runs that carry an unconfirmed bucket, three
		// `Array.prototype.filter` calls, not a delivery filter.
		// 33 -> 34 (#5055): the unresolved-reference advisory bucket selects its
		// runs with one `Array.prototype.filter`, like the binding and budget buckets.
		"clients/runtime-turn.ts": 34,
		"clients/safe-spawn.ts": 5,
		"clients/scratch-tree-policy.ts": 2,
		"clients/session-repository.ts": 1,
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
		// 0 -> 1 (#3901): `stillReportedParked`, the one re-check of a parked item
		// against a fresh run, shared by the knip and dead-code lanes.
		"clients/turn-end/delivery-holds.ts": 1,
		"clients/turn-end/lanes/secrets.ts": 3,
		"clients/turn-summary-render.ts": 3,
		"clients/vanished-instance-marker.ts": 1,
		"clients/widget-state.ts": 16,
		"clients/word-index.ts": 14,
		"clients/workspace-topology.ts": 1,
		"tools/activate-tools.ts": 2,
		"tools/effective-config.ts": 4,
		"tools/lens-diagnostic-mark.ts": 1,
		// Six array projections scope and count request-local session evidence;
		// these are Array.prototype.filter calls, not new delivery-policy seams.
		// 43 -> 42 (#5041): the `paths` entry filter moved into tools/shared.ts's
		// one reader, which every tool now calls.
		"tools/lens-diagnostics.ts": 42,
		// 12 -> 13 (#4346): the batch selects its finding-bearing files to resolve.
		// 13 -> 14 (#4322): the batch counts its files with auxiliary findings
		// only, one `Array.prototype.filter` use, not a delivery filter.
		"tools/lsp-diagnostics.ts": 14,
		"tools/lsp-navigation.ts": 6,
		"tools/render-compact.ts": 3,
		"mcp/analyze-cli.ts": 1,
		// 9 -> 8 (#5041): pilens_symbol_search's own entry filter is deleted; the
		// shared reader in tools/shared.ts applies the rule now.
		"mcp/server.ts": 8,
		"mcp/tool-arguments.ts": 4,
		// #1416: /lens-health's effective tool projection adds two semantic
		// filters; keep the existing census entry pinned to the live population.
		"index.ts": 23,
	},
	ignore: {
		"clients/file-utils.ts": 2,
		// 0 -> 2 (#4117): jscpd's own config key, read (`config.ignore`) and typed
		// (`{ ignore?: unknown }`) to merge the project's list with the worktree
		// exclusion; the name is jscpd's, not one this tree coined.
		"clients/jscpd-client.ts": 2,
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
		"clients/security-scan-client.ts": 9,
		"clients/sg-runner.ts": 5,
		"clients/test-runner-client.ts": 17,
		"clients/tool-cwd.ts": 2,
		"clients/tree-sitter-logger.ts": 1,
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
		"clients/custom-rule-locations.ts": 2,
		"clients/actionable-warnings-logger.ts": 3,
		"clients/actionable-warnings.ts": 13,
		"clients/advisory-provenance.ts": 12,
		"clients/agent-nudge.ts": 3,
		"clients/ast-grep-client.ts": 10,
		"clients/ast-grep-rule-manager.ts": 4,
		"clients/ast-grep-tool-logger.ts": 3,
		"clients/atomic-write-staging.ts": 2,
		// 7 -> 10 (#4577 M1): `resolveCandidate` follows SHELL rules again
		// (bash expands `~` itself), so it keeps its own `path.isAbsolute` /
		// `path.resolve` pair instead of the host-tool resolver, which applied
		// host-argument stages a shell word never sees.
		// 10 -> 9 (#4577 R4): an absolute operand keeps the spelling the command
		// carried, so the re-resolving `path.resolve(operand)` is gone.
		// 9 -> 11 (#2050): `resolveCdOperand` follows the same shell rules for a
		// `cd` target (its own `normalizeHostToolPath` branch and its
		// `path.isAbsolute` / `path.resolve` pair), so a relative write operand
		// after `cd` lands in that directory.
		"clients/bash-file-access.ts": 11,
		// 10 -> 7 (#4268): the hand-built `path.join` candidate list folds onto the
		// shared `findLocalBinAt` trust seam, one construction site for the shim.
		"clients/biome-client.ts": 7,
		"clients/blocker-freshness.ts": 4,
		// 5 -> 6 (#3594): the remembered-holder skip's degradation `subject`,
		// `path.resolve(dir)`, mirroring `withGenerationLockSync`'s own (#3578).
		"clients/bounded-pid-file-lock.ts": 6,
		"clients/build-identity.ts": 3,
		"clients/bus-events-logger.ts": 2,
		"clients/bus-publish.ts": 3,
		// 17 -> 19 (#3274): `readCacheAsync` builds the same two store paths its
		// synchronous sibling does (`cachePath`, `metaPath`). Same sense, one more
		// reader of the same two files.
		"clients/cache-manager.ts": 18,
		// 7 -> 5 (#3930 r2): the shared fingerprint replaces the cache's
		// duplicated path operations with one owner.
		"clients/cache/rule-cache.ts": 5,
		"clients/call-graph.ts": 4,
		// 6 -> 5 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/cargo-manifest.ts": 5,
		"clients/cascade-logger.ts": 2,
		"clients/code-quality-warnings.ts": 5,
		// 5 -> 4 (#4689 r2): the entry's file is rendered by
		// `toProjectRelativePath`, not a `path.relative` of two axes.
		"clients/codebase-model.ts": 4,
		"clients/complexity-client.ts": 3,
		"clients/config-core/normalize.ts": 22,
		"clients/config-locations.ts": 26,
		"clients/config-resolve.ts": 8,
		"clients/dead-code-client.ts": 5,
		"clients/dead-code-logger.ts": 3,
		"clients/debug-handles.ts": 2,
		"clients/debug-heap.ts": 7,
		// 0 -> 2 (#2542 ask 3): the deferred-target set algebra moved out of
		// runtime-turn.ts into its own owner module; this row carries the
		// `node:path` import and the one `path.resolve` the key derivation needs.
		"clients/deferred-test-targets.ts": 2,
		// 32 -> 29 (#3428): the two hand-rolled madge cycle parses (three
		// `path.resolve` calls and two `path:` members between them) folded into
		// one shared `parseMadgeCycles` reader with one of each. Same senses,
		// one reader of the contract instead of two.
		// 29 -> 30 (#3435): the single-file lane now derives its base with
		// `path.dirname(target)` instead of passing `projectRoot` through — one
		// more `path` use, same sense (a path operation).
		"clients/dependency-checker.ts": 28,
		"clients/diagnostic-dispositions.ts": 10,
		"clients/diagnostic-logger.ts": 3,
		"clients/diagnostics-publish.ts": 6,
		// 6 -> 7 (#4638 r3 N2): the inline withheld-compile notice names its file
		// with one more `path.basename`, the same sense as the two coverage notices.
		"clients/dispatch/dispatcher.ts": 7,
		"clients/dispatch/integration.ts": 1,
		"clients/dispatch/rule-id-normalize.ts": 2,
		"clients/dispatch/rule-ignores.ts": 3,
		// 11 -> 10 (#4689 batch 7): the absolute runner path is `realpathOrResolve`,
		// not a `path.resolve` of the spelling the tool reported.
		"clients/dispatch/runner-context.ts": 9,
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
		"clients/dispatch/runners/helm-lint.ts": 8,
		"clients/dispatch/runners/helm-render.ts": 12,
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
		// 7 -> 8 (#3968): `path.extname` inside `resolveShellFileDialect` — one
		// more `path` use, same sense (a path operation).
		// 8 -> 4 (#4689 item 6): `findShellcheckConfig` delegates to
		// `findLocalToolConfig`, dropping its `path.join` / `path.resolve` /
		// `path.dirname` loop and the `fs` pre-check.
		"clients/dispatch/runners/shellcheck.ts": 4,
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
		// 23 -> 30 (#2660): the resolver now carries its selected `path` and
		// `resolution.path` through the evidence seam, adding seven same-sense
		// path identifiers while preserving the four-rung lookup ladder.
		// 30 -> 28 (#4268): `resolveNodeToolCommand` and `resolveLocalFirstAsync`
		// stop building `.bin` paths by hand and route through the shared lookup.
		"clients/dispatch/runners/utils/runner-helpers.ts": 28,
		// 7 -> 3 (#4689 item 6): `findValeConfig` delegates to
		// `findLocalToolConfig`, dropping its hand-rolled `path` loop.
		"clients/dispatch/runners/vale.ts": 3,
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
		// 18 -> 13 (#4689): the private nearest-existing realpath walk folded
		// onto path-utils' `realpathOrResolve`.
		// 13 -> 11 (#4689 batch 7): the git-marker climb is `walkUpDirs`, so its
		// two `path.dirname` steps are the seam's.
		"clients/ephemeral-root.ts": 11,
		// 61 -> 68 (#4689 r4): the data-dir adoption joins its walk with the
		// node `path` module (no `path` binding of its own). 68 -> 70 (r5): the
		// done-marker's path and its parent. 70 -> 68 (#4530): machineStateDir
		// moved to probe-home-state.ts, below the spawn seam. 68 -> 72 (#4689
		// batch 5): the ignore matcher's off-root namespace joins the identity of
		// a directory with the node `path` module (`path.join`, `dirname`,
		// `basename`, `sep`); no `path` binding of its own.
		// 72 -> 65 (#4689 batch 7): the ignore matcher's containment tests are the
		// owner predicate on one path form, so four `path.relative` /
		// `path.isAbsolute` folds and the `rootPrefix`'s `path.sep` are gone.
		// 65 -> 68 (#4876 r2): `projectPathKey` keys a dot-segment spelling by its
		// DIRECTORY's identity (`path.dirname` + `path.basename` of the caller's
		// own spelling), so the kernel — not `path.resolve` — folds the `..`.
		// 68 -> 67 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/file-utils.ts": 67,
		"clients/finding-identity.ts": 2,
		"clients/fix-worklog.ts": 3,
		// 3 -> 2, 16 -> 15 (#4689): the formatter is handed `realpathOrResolve`,
		// not a `path.resolve` of the spelling it was given. 2 -> 3 (#4675 F2):
		// the widget row kept the caller's spelling, a `path.resolve` again;
		// 3 -> 2 (#4689 item 3): the row is written under the identity.
		"clients/format-service.ts": 2,
		// 15 -> 14 (#4689 batch 7): `findUp` climbs `walkUpDirs`, so its own
		// `path.dirname` step is the seam's.
		"clients/formatters.ts": 14,
		"clients/generated-artifacts.ts": 4,
		"clients/generation-lock.ts": 7,
		"clients/git-guard.ts": 7,
		"clients/git-tracked-ignore.ts": 3,
		// 20 -> 19 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/gitleaks-client.ts": 19,
		"clients/go-client.ts": 2,
		"clients/govulncheck-client.ts": 7,
		// 5 -> 4 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/gradle-ktfmt-style.ts": 4,
		"clients/grammar-source.ts": 4,
		"clients/gzip-stage-write.ts": 2,
		"clients/inline-blocker-dispositions.ts": 2,
		"clients/install-diagnostics.ts": 11,
		"clients/installer/index.ts": 108,
		// 4 -> 9 (#4765): refreshOpengrepRulePack computes the candidate's
		// scratch directory, cwd and sweep with `path.dirname`/`path.join`.
		"clients/installer/managed-tool-refresh.ts": 9,
		"clients/instance-reaper.ts": 4,
		// 8 -> 9 (#3498): the own-hold skip's degradation `subject`,
		// `path.resolve(target)`, as its sibling records in this file spell it.
		"clients/instance-registry-lock.ts": 9,
		"clients/instance-registry.ts": 2,
		"clients/jscpd-client.ts": 8,
		"clients/json-cache-read.ts": 4,
		"clients/knip-client.ts": 24,
		// 14 -> 12 (#4689 r2): the language-root clamp asks `isUnderDir`
		// instead of taking a `path.relative` of two spellings.
		"clients/language-profile.ts": 12,
		"clients/latency-logger.ts": 2,
		"clients/lens-config.ts": 3,
		// 8 -> 9 (#5047 F1): the path-glob matcher relativizes an entry under cwd.
		"clients/lens-engine.ts": 9,
		"clients/lens-flag-registry.ts": 13,
		"clients/lens-map.ts": 14,
		"clients/log-cleanup.ts": 9,
		"clients/lsp-mutation.ts": 3,
		"clients/lsp/client-registry.ts": 2,
		// 0 -> 1 (#4615): the `[lsp-pub]` debug row's `path` member carries the
		// client's own normalized document key into extension.log. One more
		// `path` use, same sense (a path value written to a sink), and it is an
		// object member name, not a path operation the glossary retires.
		"clients/lsp/client.ts": 1,
		// 9 -> 3 (#4403): the file gates' `path.extname`/`basename` moved to
		// clients/lsp/file-server-match.ts (3, with its own import) and the
		// session-root walk to clients/lsp/session-roots.ts (6 -> 8).
		"clients/lsp/config.ts": 3,
		// #4346: resolves a Go importer's package directory to announce its peers.
		"clients/lsp/created-import-targets.ts": 3,
		// 23 -> 19 (#4689 batch 10): `resolveExistingAncestor`'s own upward walk
		// (`path.resolve` / `path.dirname` / `path.basename` / `path.join`) is
		// deleted; the confinement asks `realpathOrResolveAsync` for the root and
		// each URI's identity, so four `path` uses leave the module.
		// 19 -> 18 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/lsp/edits.ts": 18,
		// #4532: the environment-gap gate resolves its walk-up from the file's
		// own directory, so these are real filesystem `path` calls. 5 -> 8
		// (#4532 round 5): the manifest walk-up reads `package.json` at each
		// level on the same bounded ancestry.
		// 8 -> 5 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/lsp/environment-gap.ts": 5,
		"clients/lsp/file-server-match.ts": 3,
		"clients/lsp/index.ts": 15,
		// #4346: Go package directories and TS/JS extensions of the implicit
		// dependency scope (same-package files, ambient declarations).
		// 7 -> 8 (#4438 r2): a Go file name's `_GOOS`/`_GOARCH` suffix, read
		// with `path.basename`, a filesystem path.
		"clients/lsp/implicit-scope.ts": 8,
		"clients/lsp/inferred-project.ts": 3,
		"clients/lsp/jvm-runtime.ts": 19,
		"clients/lsp/language.ts": 3,
		// 30 -> 31 (#4248): the project-local binary refusal records the
		// resolved command basename through the existing path vocabulary.
		// 31 -> 34 (#4532): the bare-command probe is an in-process PATH scan —
		// `path.delimiter`, `path.resolve` against the spawn cwd, and
		// `path.join` for each candidate; not the retired `path` domain term.
		// 34 -> 32 (#4532 round 4): the three copies of the bare-spelling test
		// (`!isFullyQualified && !includes(path.sep) && !includes("/")`) became
		// one `isBareCommand`, so two of the three `path.sep` reads are gone.
		"clients/lsp/launch.ts": 29,
		"clients/lsp/lombok.ts": 14,
		// #4299: 121 -> 124; OS path namespace calls for canonical compiler
		// validation replace the wrapper-relative guess. No path-key owner changes.
		// 124 -> 125 (#4414): the Windows npm-global layout adds one `path.join` to
		// `typescriptDirsForTsc`, the list of package dirs beside a resolved `tsc`.
		// 125 -> 127 (#4760): `declinesLooseFileRoot` compared the loose file's
		// own directory to the home ceiling (`path.resolve`/`path.dirname`).
		// 127 -> 125 (#4769 round 2): it now takes the resolved root and compares
		// real paths through `realpathOrResolve`, so both uses are gone.
		// #4728: 125 -> 123; the fallback walk starts at the candidate itself,
		// removing the early-return resolve and the parent-directory lookup.
		// 123 -> 124 (#4806): the bounded project-file search joins each
		// subdirectory with `path.join`, a filesystem path call.
		// 124 -> 121 (#4689 item 6): the root walks take their start, stop and
		// refused home through `realpathOrResolve`, replacing three
		// `path.resolve` calls; the extensions walk keeps its count.
		// 121 -> 124 (#4914): `findEffectTsgoLsp` joins the `@effect/tsgo` manifest
		// path, the `.bin/effect-tsgo` path, and `findNativeTypeScriptLsp` hands
		// back its `node_modules` directory: three `path.join` filesystem calls.
		// 122 -> 111 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/lsp/server.ts": 111,
		"clients/lsp/session-roots.ts": 8,
		// 13 -> 15 (#4346): a creation's path joins the entry's dependency
		// scope test (Go package directory, created-file stem/directory names).
		// 12 -> 11 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/lsp/workspace-diagnostics-cache.ts": 11,
		// #4346: a creation record carries the created file's path.
		"clients/lsp/workspace-diagnostics-session.ts": 2,
		// 6 -> 5 (#3643): removed the obsolete ring path-comparison branch;
		// dispatch identity now arrives on DispatchResult.
		// 5 -> 6 (#4583): the adopted warm entry keys its map lookup through
		// `path.resolve(cwd)`, the same sense (a path operation) the entry's own
		// creation site already uses.
		"clients/mcp/analyze.ts": 6,
		// 4 -> 7 (#4376): OS path namespace calls build the pid-first endpoint
		// name and the stale-socket owner marker. No path-key owner changes.
		"clients/mcp/ipc.ts": 7,
		"clients/mcp/session.ts": 3,
		"clients/metrics-client.ts": 6,
		// 7 -> 6 (#4966): the two `path.dirname(filePath)` starts of the commit lookup become one inside `getCurrentCommit`.
		"clients/metrics-history.ts": 6,
		"clients/module-report.ts": 30,
		// 6 -> 9 (#3650): MutationLineResult.path field, the adapter-declared
		// preference, and the readToolResultPathField return.
		"clients/mutating-tool.ts": 9,
		"clients/mutation-attribution.ts": 3,
		"clients/ndjson-logger.ts": 5,
		"clients/observed-mutation.ts": 6,
		// 6 -> 7 (#4493): listGitHeadDelta resolves git's relative names with
		// the OS `path` namespace; the keys still go through normalizeMapKey.
		// 7 -> 9 (#4493 r2): gitPathBase joins the `.git` entry and its HEAD
		// with the same namespace to check the walk found a repository.
		// 9 -> 10 (#4502): readGitStatusEntries resolves each porcelain path
		// against the checkout base with the same namespace.
		// 10 -> 11 (#4612 r4): it also resolves a rename's source token, so
		// the discard baseline names both sides of the entry.
		// 11 -> 9 (#4508): the walk in resolveGitCheckout skips a HEAD-less
		// `.git`, so gitPathBase no longer joins the `.git` entry and its HEAD.
		// 9 -> 12 (#2050): resolveOpaqueRecoveryRoots resolves each candidate
		// (a `cd` target, and a recognised write's `path.dirname`) before asking
		// which checkout owns it, and keys the admission set on the resolved root.
		"clients/opaque-mutation-scan.ts": 12,
		"clients/opengrep-client.ts": 8,
		"clients/opengrep-config.ts": 3,
		// New (#4765): the cached pack path and the CLI id-prefix strip.
		"clients/opengrep-rule-pack.ts": 3,
		// 21 -> 23 (#4515 r2): commandSearchReachesProject splits PATH on
		// `path.delimiter` and tests each entry with `path.isAbsolute`.
		// 23 -> 16 (#4530): the bin layouts and their walk moved to
		// session-repository.ts, below the spawn seam.
		"clients/package-manager.ts": 16,
		"clients/package-root.ts": 4,
		"clients/path-keyed-map.ts": 11,
		// 30 -> 34: findNearestMarkerRootDetailed (#3691) adds its own marker/root
		// path locals; the legacy walker body is back to its pre-#3649 text.
		// 34 -> 40 (#4689): the path-identity walk (`kernelRealPath`) and its
		// two callers split, join and normalize with the OS `path` namespace.
		// 40 -> 38 (#4689 r2): `realpathOrResolve` hands a relative spelling to
		// the kernel as it is, with no `path.isAbsolute`/`path.resolve` first.
		// 38 -> 34 (#4689 item 6): the two marker walks start at
		// `realpathOrResolve(startDir)` and `realpathOrResolve(homeDir)`.
		// 33 -> 37 (#4689 batch 10): the async twin of the identity walk adds
		// its own `path` uses (the `typeof path.posix` parameter, the `path`
		// argument `identityCandidates` parses with, the missing tail's
		// `path.join` and the `path.resolve` fallback). Three are the same
		// senses the sync walk already carries; the fourth is the seam's own
		// fallback.
		// 37 -> 39 (#4689 r2 F-CR1): each driver's attempt now folds its tail
		// through the shared `foldMissingTail` (one `path` argument for the
		// `typeof path.posix` parser), and `kernelAttemptAsync` carries the same
		// argument its sync twin does; the fold and fallback calls are the same
		// senses counted above.
		// 39 -> 41 (#2556): `relativeInside` takes a `pathImpl: typeof path = path`
		// argument so callers can pass the win32 dialect; the default and its
		// annotation are the two senses.
		// 41 -> 40 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/path-utils.ts": 40,
		"clients/php-cs-fixer-config.ts": 4,
		// 26 -> 24 (#4689 batch 3): the changed-file set is a PathKeyedMap, so two
		// `path.resolve` calls are gone. 24 -> 22: the postMutation gate compares
		// through `normalizeMapKey`, two more.
		"clients/pipeline.ts": 22,
		// 10 -> 12 (#4530): machineStateDir moved here from file-utils.ts.
		"clients/probe-home-state.ts": 12,
		"clients/project-changes.ts": 5,
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
		"clients/project-lens-config.ts": 17,
		"clients/project-report.ts": 5,
		"clients/project-snapshot.ts": 15,
		// 18 -> 22 (#3871 r2, r3): ambient-environment containment uses four
		// path operations at the shared Python resolver seam; r3 restored the
		// `path.isAbsolute` leg that rejects another Windows drive (V1).
		// 19 -> 18 (#5009): the two root-level venv candidates became one
		// `path.join` inside the list the resolver and the install stamp share.
		"clients/python-environment.ts": 13,
		"clients/read-guard-logger.ts": 3,
		"clients/recent-touches.ts": 5,
		"clients/reverse-deps.ts": 8,
		"clients/review-graph-logger.ts": 2,
		// 33 -> 36 (#4346): the importer pass names a created file by its stem
		// and directory; 36 -> 33 (#4346 final lane): that name test moved to
		// import-resolvers.ts `fileAnswerNames`, shared with the LSP cache.
		"clients/review-graph/builder.ts": 32,
		"clients/review-graph/format.ts": 4,
		// 10 -> 11 (#4508): the walk joins the `.git` entry and its HEAD.
		"clients/review-graph/git-identity.ts": 11,
		// 61 -> 64 (#4346 final lane): `fileAnswerNames`, moved from builder.ts.
		// 64 -> 61 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/review-graph/import-resolvers.ts": 61,
		"clients/review-graph/tsconfig-paths.ts": 35,
		"clients/review-graph/workspace-modules.ts": 27,
		"clients/ruff-client.ts": 4,
		"clients/rules-scanner.ts": 8,
		"clients/runtime-agent-end.ts": 12,
		// 27 -> 28 (#3218): the retire seam reads the removed record with
		// `path.resolve(filePath)` before naming it resolved.
		// 28 -> 29 (#3814): the deferred-blocker merge derives the map key with
		// `path.resolve(filePath)`, the expression every sibling method uses.
		// 29 -> 30 (#4213): the lifecycle identity lookup uses the same map key.
		// 30 -> 32 (#4484 r2): the record read for the carry and the settled-run
		// retire derive the same map key.
		// 32 -> 33 (#4484 round 4): the anchor moves onto its record, re-set
		// under the display key every record writer uses; its reads route
		// through the keyed map.
		// 33 -> 34 (#4535): the bulk mutation writer resolves each path into the
		// durable change-log entry, the same `path.resolve` the single writer
		// uses, so the log's spelling does not depend on which form recorded it.
		// 34 -> 28 (#4689 batch 1): the six no-op `path.resolve` wrappers on the
		// PathKeyedMap keys go (inline blockers, deferred format).
		// 28 -> 16 (#4689 batch 1 r2): the other eleven inline-store accessors and
		// the deferMutation key drop their `path.resolve` too; every accessor keys
		// the raw spelling through normalizeMapKey (review F1).
		// 16 -> 17 (#5020): `retireForeignRowsOfMissingFiles` asks `path.isAbsolute`
		// before it judges a cited file, so a relative cite is never retired.
		"clients/runtime-coordinator.ts": 17,
		"clients/runtime-session.ts": 15,
		// 22 -> 21 (#4137): the baseline slot's `path.resolve` moved into
		// `opaqueBaselineSlot` (clients/opaque-mutation-scan.ts).
		// 21 -> 23 (#4187): tool-call authorship retirement resolves each
		// owned mutation path through the shared path helper.
		// 23 -> 22 (#4187 R5): the fold onto the observational net's arm drops
		// the single-path branches, and with them the `input.path` read.
		// 22 -> 21 (#2657): the LSP config root for an edit is no longer a
		// `path.dirname(filePath)`; `resolveSessionConfigRoot` answers it.
		// 21 -> 23 (#3650): the `lsp_navigation` branch reads the `path` field
		// the tool declares, in its condition and its return.
		"clients/runtime-tool-call.ts": 23,
		// 22 -> 20 (#3650): the tool_result path read is routed through
		// readToolResultPathField; the open-coded input.path cast is gone.
		// 19 -> 18 (#4576): the tool_result path resolves through
		// `resolveToolCallFilePath`, dropping the bare `path.*` pair.
		// 18 -> 20 (#4504 r1): the recognized set is partitioned by the checkout
		// the scan ran in, and the held-primary send groups the written set by
		// the root that holds each file; three `path.resolve` reads where there
		// were one, no new delivery path.
		// 20 -> 17 (#4713 F3): ownership, the observed-identity lookup and the
		// recognized-set subtraction compare REAL paths (`realpathOrResolve`), so
		// a symlinked spelling of a worktree file matches the identity git
		// reported. Three `path.resolve` reads became realpath reads.
		"clients/runtime-tool-result.ts": 17,
		// 25 -> 27 (#3218): the resolved-blocker filter keys both the current
		// blocker set and each resolved entry with `path.resolve`.
		// 27 -> 26 (#2542 ask 3): `deferralEntryKey` moved to
		// clients/deferred-test-targets.ts, taking its one `path.resolve` with it.
		// 26 -> 27 (#4487): the turn_end cascade delivery resolves each edited
		// file with `path.resolve` to forget its pending cascade errors.
		// 27 -> 19 (#4689): the eight test-target `path.relative(cwd, …)`
		// renderings go through `toRunnerDisplayPath`, which relates path
		// identities.
		// 19 -> 20 (#4954 r3): the turn-end stamp's entry type names its
		// `path` field beside the role it carries.
		"clients/runtime-turn.ts": 20,
		"clients/rust-client.ts": 5,
		// 26 -> 32 (#4530): the search-path scoping and lookup split PATH on
		// `path.delimiter` and resolve each entry with `path` namespace calls.
		"clients/safe-spawn.ts": 32,
		"clients/search-read-registration.ts": 3,
		"clients/security-scan-client.ts": 6,
		// #4530: the bin layouts moved here from package-manager.ts.
		"clients/session-repository.ts": 9,
		"clients/session-state-store.ts": 3,
		"clients/sessionstart-logger.ts": 2,
		"clients/sg-runner.ts": 11,
		// 26 -> 25 (#3930 r2): the shared user rule-root seam removes one
		// duplicated path construction.
		// 25 -> 26 (#3930 r4): the cycle-memo key is derived with
		// `path.resolve(projectRoot)`, the normalization every sibling map key
		// in this file already uses (`cachedBaselines`, `rootArtifactKey`).
		"clients/sgconfig.ts": 25,
		"clients/skills-resolver.ts": 3,
		"clients/slow-fs.ts": 4,
		"clients/smells-rollup.ts": 3,
		"clients/source-filter.ts": 11,
		// 3 -> 4 (#1979): `DirectoryListing.mayContain` takes the final segment of
		// the target with `path.basename`, the same call every walker path uses.
		"clients/source-walker.ts": 4,
		"clients/spawn-timeout-cooldown.ts": 3,
		"clients/startup-scan.ts": 7,
		// 61 -> 66: filesystem ownership/discovery operations plus the alias
		// exception's physical policy-relative path (R4). These remain filesystem
		// operations, not delivery lanes; the census measures every use.
		// 66 -> 74 (#3871 r2): text-runner display rebasing uses path operations
		// for pytest, PHPUnit, Mix, and generic runner locations.
		// 74 -> 72 (#4689 batch 2): two `path.resolve` locals dropped from the root and
		// failed-target keys.
		"clients/test-runner-client.ts": 68,
		"clients/todo-scanner.ts": 3,
		// 4 -> 10 (#3655): the Node lockfile walk-up and supplier selection
		// resolve pnpm/yarn evidence through `path.join`, `path.relative`,
		// and `path.resolve` — six more `path` operations, same sense
		// (a path operation).
		"clients/tool-agreement.ts": 10,
		// 13 -> 12 (#4689 item 6): the file is resolved by `realpathOrResolve`.
		// 12 -> 10 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/tool-cwd.ts": 10,
		// 64 -> 62 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"clients/tool-policy.ts": 62,
		// 19 -> 18 (#4689 batch 7): the grammar write probe climbs `walkUpDirs`, so
		// its own `path.dirname` step is the seam's.
		"clients/tree-sitter-client.ts": 18,
		"clients/tree-sitter-logger.ts": 2,
		// 11 -> 18 (#3930 r2): the loader's complete rule fingerprint walks
		// language rule directories and normalizes their paths.
		"clients/tree-sitter-query-loader.ts": 18,
		"clients/tree-sitter-shared.ts": 2,
		"clients/tree-sitter-symbol-extractor.ts": 3,
		// 4 -> 5 (#4617 review F1): a rendered trivy report cites its own rows'
		// `target` resolved against the scan root, one more `path` operation, same
		// sense as the four above (a filesystem path operation).
		"clients/trivy-client.ts": 5,
		"clients/warm-attach.ts": 3,
		"clients/widget-state.ts": 7,
		"clients/word-index-logger.ts": 2,
		"clients/word-index.ts": 51,
		"clients/workspace-topology.ts": 7,
		"clients/zizmor-config.ts": 4,
		// 8 -> 5 (#4233): the ast-grep tools fold their relative-path resolution
		// onto the shared `resolveHostToolPath` seam, so ast-grep-outline.ts drops
		// its own `path` import and two `path.*` calls.
		"tools/ast-grep-outline.ts": 5,
		"tools/ast-grep-search.ts": 2,
		"tools/effective-config.ts": 6,
		// 6 -> 4 (#4577 M2): the `path` argument folds onto
		// `resolveHostToolPath`, dropping the `path.isAbsolute`/`path.resolve`
		// pair.
		"tools/lens-diagnostic-mark.ts": 6,
		// 30 -> 27 (#4576): `resolvePathsScope` folds onto
		// `resolveHostToolPath`, dropping three `path.*` calls.
		// 27 -> 26 (#4689 r2): mode=all renders a row's file through
		// `toProjectRelativePath`, not a `path.relative` of two axes.
		// 26 -> 25 (#4689 r3): mode=delta's group renders through
		// `toProjectRelativePath` too.
		// 25 -> 19 (#4689 batch 4): mode=full's merge keys its Sets, dedup key and
		// per-file map by `normalizeMapKey`, dropping six `path.resolve` calls.
		"tools/lens-diagnostics.ts": 22,
		// 10 -> 8 (#4577 M2): the scalar and batch `path`/`paths` arguments fold
		// onto `resolveHostToolPath`, dropping one `path.resolve` each.
		"tools/lsp-diagnostics.ts": 8,
		// 14 -> 15 (#4403 round 5): `noServerAnsweredText` names the file by
		// its `path.basename`, beside the install hint's own.
		// 15 -> 11: both concurrent folds land here. #4578 takes the `rename_file`
		// destination, #4577 M2 the navigation `path` argument, so each pair of
		// `path.isAbsolute`/`path.resolve` calls goes and the merged file keeps
		// path OPERATIONS only (`path.basename`, `path.resolve` of a read target),
		// the sense the glossary does not retire.
		"tools/lsp-navigation.ts": 14,
		// 29 -> 27 (#4577 M2): `resolveFile` folds onto `resolveHostToolPath`,
		// dropping the `path.isAbsolute`/`path.resolve` pair.
		"tools/module-report.ts": 27,
		"tools/render-compact.ts": 3,
		// 0 -> 2 (#4577 R2-2): the defaulted (no `paths`) target is now built by
		// `path.resolve(base)` alone instead of going through
		// `resolveHostToolPath`, because that generated path is pi-lens's own and
		// must keep its bytes.
		"tools/shared.ts": 8,
		"tools/symbol-search.ts": 5,
		"mcp/analyze-cli.ts": 4,
		"mcp/cli.ts": 2,
		// 31 -> 30 (#4966): the upward climb folds onto `walkUpDirs`, so a `path.dirname` / `path.resolve` use leaves the module.
		"mcp/server.ts": 41,
		"index.ts": 20,
	},
	record: {
		"clients/actionable-warnings.ts": 14,
		// 8 -> 9 (#4617): the well-formed check reads the new `filelessParts`
		// flag on the record it validates, so one more `record.` use exists.
		"clients/advisory-provenance.ts": 9,
		"clients/cache-observability.ts": 2,
		"clients/config-core/merge.ts": 3,
		"clients/config-core/normalize.ts": 12,
		"clients/config-core/records.ts": 6,
		"clients/config-resolve.ts": 16,
		"clients/degradation-ledger.ts": 16,
		// #3968 PR 2: +1 — `redactServerSpec` reads `record.covers` (the
		// rendered claim beside the existing redacted fields).
		"clients/effective-config.ts": 11,
		// 44 -> 59 (#4725): the any-age read, the retire and the refusal's
		// remedy each name the `turn-end-findings` row, the durable cache row the
		// glossary keeps `record` for. 53 -> 65 (#4738): the partition reads, the
		// carried-blocker shape check and the gate's owner check name the same
		// `turn-end-findings` row. 65 -> 67 (#4750): the top partition's write
		// stamp and its shape check read the same row.
		"clients/git-guard.ts": 67,
		"clients/govulncheck-client.ts": 4,
		"clients/inline-blocker-dispositions.ts": 4,
		// #3654: the unified bridge's own `record()` API (RFC §3) — a method
		// name, not the retired finding-record noun; the lexical census cannot
		// tell the two senses apart.
		"clients/io-bridge-contract.ts": 2,
		"clients/io-bridge.ts": 2,
		"clients/lsp/document-drift.ts": 19,
		"clients/lsp/index.ts": 36,
		// #2416: migration records are the public config diagnostic rows; the
		// glossary's retired noun is intentional in this record-owning module.
		"clients/lsp/resolved-config.ts": 4,
		"clients/lsp/workspace-diagnostics-cache.ts": 2,
		"clients/mcp/analyze.ts": 2,
		"clients/observed-mutation.ts": 4,
		"clients/opaque-mutation-scan.ts": 1,
		"clients/partial-edit-apply.ts": 5,
		"clients/persistent-reverify.ts": 3,
		"clients/project-diagnostics/fresh-fetch.ts": 12,
		"clients/project-lens-config.ts": 8,
		"clients/project-snapshot.ts": 10,
		"clients/read-guard-tool-lines.ts": 4,
		"clients/read-guard.ts": 23,
		"clients/runtime-agent-end.ts": 56,
		"clients/runtime-context.ts": 2,
		// 17 -> 23 (#3218): `noteResolvedBlockerFile` reads the removed
		// `InlineBlockerRecord` (param, path, count, write index).
		// 23 -> 29 (#4213): the deferred lifecycle identity reads its queued
		// record and returns its ownership fields.
		// 29 -> 31 (#4921): `noteResolvedBlockerFile` carries the removed
		// record's owning session onto its Resolved note.
		// 31 -> 33 (#4943): a secondary's owned-only claim reads the queued
		// record's owner and leaves another session's record queued.
		"clients/runtime-coordinator.ts": 33,
		"clients/runtime-tool-call.ts": 1,
		"clients/runtime-tool-result.ts": 5,
		// 6 -> 8 (#3218): the resolved-blocker filter keys each current blocker
		// record.
		// 8 -> 9 (#4990): the demoted channel names the mark's demoted record.
		"clients/runtime-turn.ts": 9,
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
		"clients/agent-nudge.ts": 1,
		"clients/dispatch/runners/tree-sitter.ts": 5,
		"clients/file-utils.ts": 3,
		"clients/lens-engine.ts": 11,
		// 2 -> 3 (#4485): the command-pull tier reads the primary's capability
		// `snapshot` for the tsserver request command.
		"clients/lsp/cascade-tier.ts": 3,
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
		// #4129 adds the word-index splice and worker heap slot's snapshot uses.
		"clients/project-snapshot.ts": 130,
		"clients/read-guard-branch.ts": 2,
		"clients/read-guard-tool-lines.ts": 3,
		"clients/read-guard.ts": 2,
		"clients/reverse-deps.ts": 14,
		"clients/runtime-session.ts": 38,
		"clients/runtime-tool-call.ts": 2,
		"clients/runtime-tool-result.ts": 2,
		"clients/session-scope.ts": 2,
		"clients/sgconfig.ts": 3,
		"clients/tool-policy.ts": 2,
		"clients/tool-set-policy.ts": 1,
		"clients/widget-state.ts": 1,
		"clients/word-index.ts": 8,
		"tools/lens-diagnostics.ts": 12,
		"tools/lsp-navigation.ts": 9,
		// 22 -> 23 (#1634): `pilens_project_scan` reads the policy's suppressed
		// count off the scan result its handler already names `snapshot`.
		"mcp/server.ts": 23,
	},
	status: {
		// #3867 moved the coverage decision onto `hasUsableResult`: dispatcher.ts
		// no longer compares the bare `status` field at four sites (37 -> 32), and
		// the claimSource admission guard (#3968 F2) reads it once more (32 -> 33).
		// The `dispatch.disabledRunners` skip names the field twice, in the latency
		// row and in its log row, as the applies_to skip beside it does (33 -> 35).
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
		"clients/dispatch/dispatcher.ts": 35,
		"clients/dispatch/integration.ts": 1,
		"clients/dispatch/pending-runner-findings.ts": 1,
		"clients/dispatch/runners/actionlint.ts": 2,
		"clients/dispatch/runners/ast-grep-napi.ts": 11,
		"clients/dispatch/runners/biome-check.ts": 8,
		"clients/dispatch/runners/cpp-check.ts": 3,
		"clients/dispatch/runners/credo.ts": 2,
		"clients/dispatch/runners/cue-vet.ts": 6,
		"clients/dispatch/runners/dart-analyze.ts": 1,
		"clients/dispatch/runners/detekt.ts": 6,
		"clients/dispatch/runners/dotnet-build.ts": 4,
		"clients/dispatch/runners/elixir-check.ts": 2,
		"clients/dispatch/runners/eslint.ts": 3,
		"clients/dispatch/runners/fact-rules.ts": 2,
		// #4309: folded unavailable/absent-command exits remove one status use.
		// 5 -> 6 (#4522): the exitless-run guard reads the exit status once.
		"clients/dispatch/runners/fish-indent.ts": 6,
		"clients/dispatch/runners/gleam-check.ts": 5,
		"clients/dispatch/runners/go-vet.ts": 5,
		"clients/dispatch/runners/golangci-lint.ts": 4,
		"clients/dispatch/runners/hadolint.ts": 3,
		"clients/dispatch/runners/helm-lint.ts": 5,
		"clients/dispatch/runners/helm-render.ts": 7,
		"clients/dispatch/runners/htmlhint.ts": 3,
		"clients/dispatch/runners/javac.ts": 4,
		"clients/dispatch/runners/ktlint.ts": 2,
		// 10 -> 11 (#5008 review r2): the all-clear arm's stale-bound answer
		// returns `status: "skipped"` instead of `succeeded` — the same
		// `RunnerResult.status` member sense as every other row here.
		"clients/dispatch/runners/lsp.ts": 11,
		"clients/dispatch/runners/markdownlint.ts": 4,
		"clients/dispatch/runners/mypy.ts": 2,
		"clients/dispatch/runners/oxlint.ts": 11,
		"clients/dispatch/runners/php-lint.ts": 2,
		"clients/dispatch/runners/phpstan.ts": 4,
		"clients/dispatch/runners/prisma-validate.ts": 4,
		"clients/dispatch/runners/psscriptanalyzer.ts": 14,
		"clients/dispatch/runners/pyright.ts": 3,
		"clients/dispatch/runners/rubocop.ts": 2,
		"clients/dispatch/runners/ruff.ts": 2,
		"clients/dispatch/runners/rust-clippy.ts": 10,
		// 4 -> 5 (#3968): one more skip branch (`covered-by-primary`) beside the
		// existing skipped/no-cmd returns — the same `status:` member sense.
		"clients/dispatch/runners/shellcheck.ts": 5,
		"clients/dispatch/runners/shfmt.ts": 8,
		"clients/dispatch/runners/spellcheck.ts": 3,
		"clients/dispatch/runners/spotbugs.ts": 8,
		"clients/dispatch/runners/sqlfluff.ts": 3,
		"clients/dispatch/runners/stylelint.ts": 2,
		"clients/dispatch/runners/swiftlint.ts": 3,
		"clients/dispatch/runners/taplo.ts": 5,
		"clients/dispatch/runners/terragrunt.ts": 2,
		"clients/dispatch/runners/tflint.ts": 3,
		// 14 -> 15 (#4226): the early-return runner result preserves the existing
		// status field while disclosing a fully path-excluded query set.
		"clients/dispatch/runners/tree-sitter.ts": 15,
		// 10 -> 9 (#4130 r2): the shared classifier replaces a status test.
		"clients/dispatch/runners/trivy-config.ts": 9,
		"clients/dispatch/runners/utils/availability-policy.ts": 5,
		"clients/dispatch/runners/utils/candidate-probe.ts": 1,
		"clients/dispatch/runners/utils/lazy-installer.ts": 3,
		"clients/dispatch/runners/utils/runner-helpers.ts": 8,
		// 9 -> 10 (#4130 r2): `processCutShort` reads the exit status once.
		"clients/dispatch/runners/utils/spawn-outcome.ts": 10,
		// 19 -> 20 (#4130 r2): `faultIfCutShort` builds the one partial-findings `failed` result.
		"clients/dispatch/runners/utils/tool-failure.ts": 20,
		"clients/dispatch/runners/vale.ts": 4,
		"clients/dispatch/runners/yamllint.ts": 2,
		"clients/dispatch/runners/zig-check.ts": 2,
		// 5 -> 6 (#4484 r2): `reachedNoVerdict` reads the runner result's status.
		// 6 -> 7 (#4733 r2): `checkedWholeFile` reads each latency row's status.
		// 7 -> 8 (#4130): `faultResult` builds the one `failed` runner result.
		"clients/dispatch/types.ts": 9,
		"clients/file-utils.ts": 2,
		"clients/finding-delivery-gate.ts": 3,
		"clients/formatters.ts": 8,
		"clients/git-tracked-ignore.ts": 2,
		"clients/govulncheck-client.ts": 5,
		"clients/grammar-source.ts": 2,
		"clients/host-ports.ts": 2,
		// 42 -> 44 (#4530), and the new launch.ts row:
		// starts that moved onto the spawn seam read SpawnResult.status.
		"clients/installer/index.ts": 44,
		// 9 -> 14 (#4765): refreshOpengrepRulePack reads the fetch `res.status`, the
		// validate spawn's `status` (twice) and the refresh-state read's `status`
		// discriminant: host fields, not a pi-lens status vocabulary.
		"clients/installer/managed-tool-refresh.ts": 14,
		"clients/instance-reaper.ts": 15,
		"clients/jscpd-client.ts": 3,
		"clients/knip-client.ts": 4,
		"clients/latency-logger.ts": 1,
		"clients/lens-config.ts": 2,
		"clients/lens-engine.ts": 4,
		"clients/lsp-mutation.ts": 7,
		"clients/lsp/client-registry.ts": 1,
		"clients/lsp/client.ts": 31,
		"clients/lsp/edits.ts": 2,
		"clients/lsp/index.ts": 4,
		"clients/lsp/jvm-runtime.ts": 1,
		"clients/lsp/launch.ts": 1,
		"clients/lsp/server.ts": 4,
		"clients/mcp/analyze.ts": 9,
		"clients/mcp/review.ts": 1,
		"clients/module-report.ts": 6,
		// 24 -> 26 (#4493): readGitHead and listGitHeadDelta read the spawn
		// result's exit `status`, not a delivery status.
		// 26 -> 27 (#4502): readGitStatusEntries checks the spawn result's exit
		// `status` once for every porcelain read it now serves.
		"clients/opaque-mutation-scan.ts": 27,
		"clients/opengrep-client.ts": 9,
		"clients/package-manager.ts": 2,
		"clients/pipeline.ts": 4,
		"clients/process-snapshot.ts": 14,
		"clients/project-diagnostics/runner-adapters/runner-findings.ts": 2,
		"clients/project-diagnostics/scanner.ts": 1,
		"clients/project-lens-config.ts": 4,
		"clients/read-guard.ts": 10,
		"clients/resource-sampler.ts": 7,
		"clients/review-graph-logger.ts": 1,
		"clients/review-graph/builder.ts": 12,
		"clients/runtime-context.ts": 4,
		"clients/runtime-coordinator.ts": 4,
		"clients/runtime-turn.ts": 6,
		"clients/safe-spawn.ts": 25,
		"clients/security-scan-client.ts": 5,
		"clients/sg-runner.ts": 32,
		"clients/shared-checkout-guard.ts": 2,
		"clients/skills-resolver.ts": 6,
		"clients/spawn-timeout-cooldown.ts": 1,
		"clients/test-runner-client.ts": 15,
		"clients/tree-sitter-logger.ts": 2,
		// 1 -> 4 (#2678): the health-check record reads the resource status
		// twice and writes metadata.status; none denotes a delivery status.
		"clients/tree-sitter-query-loader.ts": 4,
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
		// #3540 r2: 26 -> 27, the cascade reads `ctx.telemetry?.orderTurn`
		// beside the `turnSeq`/`writeSeq` it already reads from the same field.
		// 27 -> 28 (#4250): runner provenance carries the session id through
		// the existing telemetry context.
		"clients/pipeline.ts": 28,
		"clients/runtime-tool-result.ts": 1,
	},
	version: {
		"clients/build-identity.ts": 5,
		"clients/cache-observability.ts": 2,
		"clients/cache/rule-cache.ts": 3,
		"clients/call-graph.ts": 4,
		"clients/codebase-model.ts": 3,
		"clients/dispatch/runners/oxlint.ts": 3,
		"clients/grammar-source.ts": 5,
		"clients/install-diagnostics.ts": 3,
		"clients/installer/index.ts": 60,
		// 24 -> 29 (#4765): the pack refresh stamps the cached pack with a digest
		// `version` in the refresh-state entry (the stamp's existing field) and passes
		// `--disable-version-check` to the validate spawn: stamp/CLI vocabulary.
		"clients/installer/managed-tool-refresh.ts": 29,
		// #3654: the unified bridge protocol's own `version` field (RFC §3) — a
		// protocol name that cannot be renamed.
		"clients/io-bridge-contract.ts": 1,
		"clients/io-bridge.ts": 1,
		"clients/knip-client.ts": 8,
		"clients/lens-events.ts": 4,
		// #3505 (b): the workspace pull binds an item by the LSP report's own
		// `version` field (35 -> 38), a protocol name that cannot be renamed.
		"clients/lsp/client.ts": 38,
		"clients/lsp/diagnostic-binding.ts": 1,
		"clients/lsp/edits.ts": 24,
		"clients/lsp/index.ts": 6,
		"clients/lsp/lombok.ts": 6,
		// #4299: 16 -> 18; two reads of the external TypeScript package
		// manifest's literal version field, not a pi-lens generation identity.
		// 18 -> 20 (#4914): the same read of `@effect/tsgo`'s manifest field, and
		// the session-start line that prints the TypeScript package version.
		"clients/lsp/server.ts": 20,
		"clients/lsp/workspace-diagnostics-cache.ts": 6,
		"clients/mcp/ipc.ts": 15,
		"clients/metrics-history.ts": 3,
		"clients/module-report.ts": 1,
		"clients/mutation-attribution.ts": 5,
		"clients/mutation-bridge.ts": 2,
		"clients/ndjson-logger.ts": 7,
		// #4169: 4 -> 6. The rebind helper adds a `version` parameter and its
		// `getProcessSingleton(family, version, …)` argument — the singleton
		// family's shape version, not a monotonic generation.
		"clients/process-bridge.ts": 6,
		"clients/process-singletons.ts": 10,
		"clients/project-diagnostics/cache.ts": 2,
		"clients/project-diagnostics/runner-adapters/trivy.ts": 2,
		"clients/project-diagnostics/scanner.ts": 2,
		"clients/project-diagnostics/types.ts": 2,
		"clients/project-snapshot.ts": 17,
		"clients/read-bridge.ts": 2,
		// #3873: the persisted read-set's own schema `version` on the
		// `read_guard_branch_retained` row (`payloadVersion`), not a generation.
		"clients/read-guard-branch.ts": 5,
		"clients/read-guard.ts": 3,
		"clients/review-graph/builder.ts": 27,
		"clients/review-graph/types.ts": 1,
		"clients/runtime-session.ts": 8,
		"clients/runtime-turn.ts": 1,
		// #3873: the sidecar envelope's schema `version` (and the version a
		// migrated file was written at) on `session_handoff_adopt`, not a
		// generation.
		"clients/session-scope.ts": 5,
		"clients/session-state-store.ts": 6,
		// 19 -> 52 (#3655): the pnpm/yarn lockfile readers thread each
		// supplier's resolved `version` (params, `.version` fields, and the
		// shared version verdict) through the same agreement comparison.
		// Same sense — lockfile resolved versions, not generations.
		// 52 -> 64 (#3656 review): `stripPnpmPeerSuffix` scans a lockfile
		// resolved version string for its peer-context suffix; same sense.
		"clients/tool-agreement.ts": 64,
		"clients/turn-summary.ts": 2,
		"clients/warm-attach.ts": 4,
		"clients/widget-state.ts": 5,
		"clients/word-index.ts": 5,
		"tools/lens-diagnostics.ts": 1,
		"mcp/server.ts": 7,
		"index.ts": 4,
	},
	warning: {
		// #3576: 63 -> 65. The quickfix pass's session check skips the loop's
		// `warning` like its sibling skips (its id and its file as the ledger
		// subject); the loop variable is not this fix's to rename.
		// #3541: 65 -> 69. The actionable fix keys its expected content by
		// `warning.filePath`, and reports a stale fix, a multi-file fix and a
		// resource-operation fix under `warning.id`; all four read the loop's
		// actionable-warning record, which the file names throughout.
		"clients/actionable-warnings.ts": 69,
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
		// 16 -> 18 (#4617): the code-quality advisory cites the `filePath` of each
		// kept `warning` the report was built from, so the loop variable is read
		// twice more.
		"clients/runtime-turn.ts": 18,
		"clients/secret-findings.ts": 3,
		"clients/widget-state.ts": 1,
		"tools/ast-grep-search.ts": 6,
		"tools/lens-diagnostics.ts": 7,
		"tools/lsp-diagnostics.ts": 1,
	},
};

describe("glossary synonym-retirement sweep (#3259)", () => {
	it(
		"parses the complete glossary and pins its identifier population",
		() => {
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
		},
		TREE_WALK_TIMEOUT_MS,
	);

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
