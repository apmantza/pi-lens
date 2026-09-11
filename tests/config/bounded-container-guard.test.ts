/** Registered-or-fail guard for long-lived container growth (#2981). */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	listSourceFiles,
	stableOccurrenceKey,
} from "../support/sweep-kit.js";
import {
	scanSessionStateCandidates,
	shippedContainerSourceRoots,
} from "../support/session-state-scan.js";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const EXEMPTIONS: Readonly<Record<string, string>> = {
	"clients/agent-behavior-client.ts#25f0c45c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/agent-behavior-client.ts#AgentBehaviorClient:a2df0635":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/agent-nudge.ts#MAX_NAMES_SHOWN:9593fa6b":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/bash-file-access.ts#grepHasLineNumbers:7234091c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/bash-file-access.ts#parseGrepLineWithoutFile:8ddf599a":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/blocker-freshness.ts#MAX_DRIFT_CHECK_IMPORTS:39ccfde7":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/blocker-freshness.ts#getExtractor:0bd69b14":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/bus-events-logger.ts#writer:f959fedf":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/call-graph.ts#formatImpact:a78549f5":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/cargo-manifest.ts#isTomlKeyWorkspaceInherited:55e26d0f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/complexity-client.ts#LANGUAGE_NODES:fa682fa8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/config-core/records.ts#MAX_RECORD_KEY_LENGTH:afc5ef02":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/config-core/safe-object.ts#UNSAFE_CONFIG_KEYS:6650a9a1":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/config-core/schema.ts#SCHEMA_TYPES:29c64e3c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/config-resolve.ts#CANONICAL_TOP_LEVEL_KEYS:d6ae7a74":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/config-resolve.ts#projectLocationFor:23f05544":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/config-resolve.ts#schemaPropertyKeys:43cb1112":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/config-warn.ts#DEPRECATION_NOUN_BY_CODE:6b858980":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/config-warn.ts#SUPPRESSED_NOTICE_KIND:58f6ea36":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/degradation-ledger.ts#OVERFLOW_KIND:8cf106dd":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/degradation-ledger.ts#groups:218d12e1":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/degradation-ledger.ts#isRenderableSummary:ff7c94f3":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/degradation-ledger.ts#onceKeys:b8a478d9":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/diagnostic-dispositions.ts#06a3807d":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/diagnostics-publish.ts#seqCounter:f6f9f5cf":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/auxiliary-lsp.ts#enabledAuxiliaryLspServerIds:dd3e2650":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/collect-later-tier.ts#COLLECT_LATER_THRESHOLD_MS:6c0d1b78":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/dispatcher.ts#coverageNoticeSeen:b0d84a0a":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/dispatcher.ts#latencyReports:4e5c8069":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/facts/function-facts.ts#BOUNDARY_PREFIXES:48e28c76":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/facts/function-facts.ts#COMPLEXITY_TYPES:17947390":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/facts/function-facts.ts#FUNCTION_TYPES:b28b3e1e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/facts/function-facts.ts#NESTING_TYPES:dc66d500":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/integration.ts#CASCADE_TRANSITIVE_DEPTH:7b078f45":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/integration.ts#FACT_RULE_IDS:8d2583ad":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/integration.ts#LSP_CAPABLE_KINDS:5aaf7fc8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/integration.ts#applyProjectLensConfig:f75b2bbf":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/integration.ts#cascadeTurnScope:20fbf3b2":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/integration.ts#getCascadeSessionStats:0753e302":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/integration.ts#getDispatchSlopScoreLine:5ae16f7e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/integration.ts#sessionFacts:4f792731":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/integration.ts#sessionRunnerRegistry:6f92ddd6":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/rule-id-normalize.ts#bundledCodeRabbitRules:8617a0bf":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/rules/framework-call-noise.ts#EXPECT_CHAIN_PREFIX:0c522884":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/rules/unsafe-boundary.ts#IO_NAMESPACE_PREFIXES:8cf66b28":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/ast-grep-napi.ts#AST_GREP_LSP_ONLY_RULE_LANGUAGES:3d0c8579":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/ast-grep-napi.ts#LINTER_OVERLAP:148fb569":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/ast-grep-napi.ts#MAX_TOTAL_DIAGNOSTICS:9fde89da":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/ast-grep-napi.ts#NAPI_LANGUAGE_BINDINGS:cd35ae9a":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/ast-grep-napi.ts#appendDuplicateRuleDiagnostics:df5d17f9":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/ast-grep-napi.ts#cdd3147c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/ast-grep-napi.ts#sgHoldReason:0446f591":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/biome-check.ts#parseBiomeJson:753add48":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/cpp-check.ts#CPP_SOURCE_EXTENSIONS:e24049aa":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/cpp-check.ts#C_HEADER_EXTENSIONS:12023b86":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/cpp-check.ts#C_SOURCE_EXTENSIONS:3993210f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/cpp-check.ts#compilerCheckers:85b993b2":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/dart-analyze.ts#flutter:6447654e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/detekt.ts#DETEKT_CONFIG_CANDIDATES:1d197f74":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/eslint.ts#makeEslintProbe:a15d1054":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/helm-lint.ts#helm:c1b621dc":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/helm-render.ts#trivy:c1b621dc":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/markdownlint.ts#MARKDOWNLINT_EXIT_CODES:ad4a25ed":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/oxlint.ts#OXLINT_NO_FILES_BANNER:4673d65c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/psscriptanalyzer.ts#psAnalyzerLatchByCmd:d95a85ac":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/psscriptanalyzer.ts#psCmdLatch:d04c7adf":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/rust-clippy.ts#makeClippyProbe:e3811ba4":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/sqlfluff.ts#SQLFLUFF_EXIT_CODES:6925444e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/stylelint.ts#stylelintReport:8c158591":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/swiftlint.ts#swiftlint:fd196ae3":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/tree-sitter.ts#41fffd47":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/tree-sitter.ts#extractEntitySnapshot:0f665ed6":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/utils/lazy-installer.ts#LAZY_INSTALL_TIMEOUT_MS:d9d707ca":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/utils/lazy-installer.ts#suppressionFor:d1456960":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/utils/runner-helpers.ts#correctedAvailabilityByCwd:14cfe5d8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/utils/runner-helpers.ts#discoverManagedTool:15947de8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/utils/runner-helpers.ts#installAttemptsByCwd:bbf98ee1":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/utils/runner-helpers.ts#managedBinaryVerdicts:85753e76":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/utils/runner-helpers.ts#managedNodeToolCandidates:ee842ef8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/utils/runner-helpers.ts#resolveInstallInFlightByCwd:4905867e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/runners/utils/runner-helpers.ts#uncorrectedEmissionsByCwd:a46e032f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/dispatch/suppress-writer.ts#d2daba77":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/extension-log.ts#consoleGuardInstalled:388c75ce":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/extension-log.ts#originalConsoleMethods:a8a25bd1":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/extension-mode.ts#88e678f2":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/file-kinds.ts#CODE_KINDS:eb000671":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/file-kinds.ts#TERRAGRUNT_FILENAMES:1c874cb6":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/file-kinds.ts#getFileKindsForExtension:38d2ab8d":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/file-kinds.ts#hasKindExtension:b08d851f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/file-kinds.ts#isJstsFactFile:77a5e942":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/file-utils.ts#createProjectIgnoreMatcher:32d2341a":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/file-utils.ts#isRecordableProjectPath:f343d35d":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/file-utils.ts#pendingDataDirMigrations:08bb01e0":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/formatters.ts#ALL_FORMATTERS:f206c38b":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/formatters.ts#WHICH_BUDGET_MS:5a871b6c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/formatters.ts#clearFormatterCache:bb214b3c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/formatters.ts#hasExplicitFormatterConfig:391a2d25":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/formatters.ts#managedToolDetect:2a357c8d":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/formatters.ts#resetWhichLatches:84280896":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/formatters.ts#whichLatchByCommand:29c61033":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/generated-artifacts.ts#DEFAULT_HEADER_BYTES:2eb339d2":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/generated-artifacts.ts#GENERATED_HEADER_PATTERNS:d0b800f2":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/generation-guard.ts#d60c9894":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/git-guard.ts#containsGuardedSubstitution:4f972d66":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/git-guard.ts#isGitExecutable:da96a8e8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/git-tracked-ignore.ts#CACHE_TTL_MS:09e66f4f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/git-tracked-ignore.ts#_trackedCache:644b24a0":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/git-tracked-ignore.ts#fetchTrackedFiles:0fc016d7":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/go-client.ts#GoClient:34ea312f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#INSTALL_LOCK_PATH:297cc14b":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#_peekEnsureInFlightForTesting:79f5f4d2":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#_probeCacheChangeGeneration:1040840d":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#_probeCacheChanges:509e90ff":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#ensureInFlight:365bfb43":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#extractVersionToken:e8cefebf":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#findFirstFileRecursive:8fb525a1":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#getInstallAttempt:c20998b0":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#getInstallFailureReason:d74e98d9":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#getToolVerificationTimeout:98a16a39":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#lastResolveTransient:9af2cc3b":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/installer/index.ts#resolvePlatformPackageBinary:0c6ca0e4":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/language-profile.ts#WARMUP_SOURCE_EXTS:d4bfa137":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/language-profile.ts#resolveLanguageRootForFile:17cd4fe5":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/language-registry.ts#BY_EXTENSION:57f0562b":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/language-registry.ts#BY_FILENAME:faa20b2f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/language-registry.ts#extensionOf:2d198141":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/language-registry.ts#grammarExtensionsOf:b846fe4f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/latency-logger.ts#_setRecentPhasesForTest:b45c37e8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/latency-logger.ts#recentPhases:e0c48305":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/latency-logger.ts#resetCurrentPhaseForSession:9d04beac":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lens-flag-registry.ts#LENS_FLAGS:039fff50":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/client.ts#PROBE_COMMAND_TIMEOUT_MS:0fd1024a":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/client.ts#safeSendNotification:63295a96":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/config.ts#EMPTY_CONFIG:2b5f72b0":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/index.ts#OPTIONAL_LSP_RETRY_COOLDOWN_MS:024aaeab":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/index.ts#WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE:efd32207":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/inferred-project.ts#INFERRED_PROJECT_MARKER:5571057e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/inferred-project.ts#TS_PROJECT_EXTENSIONS:d9fa6977":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/server.ts#DIRECT_LSP_NEGATIVE_TTL_MS:6f24c89e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/server.ts#PROJECT_BOUNDARY_MARKERS:cc0fbaf1":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/server.ts#TS_TOOLING_MARKERS:26add0a4":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/server.ts#directLspCommandUnavailableUntil:831316db":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/server.ts#loggedRootCeilingClamps:3e9d9204":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/server.ts#resolveLspServerCwd:3a59a0ce":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/lsp/workspace-diagnostics-cache.ts#MAX_REGISTERED_CWDS:22ef7f62":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/mcp/analyze.ts#DEFAULT_WORD_INDEX_MAX_WARM_ROOTS:bf4b47c4":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/mcp/analyze.ts#c9b1ec33":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/mcp/session.ts#TurnEndQueue:5dcda301":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/mcp/session.ts#pendingTurnEndDeliveries:c1cb62ff":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/middle-man-analysis.ts#INTENTIONAL_FORWARDER_NAME:5e465361":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/module-report-lsp.ts#LSP_SYMBOL_CONCURRENCY:4290fa8d":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/module-report.ts#ARGUMENT_CONTAINER_NODE_KINDS:20b403a3":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/module-report.ts#GO_GOROUTINE_KINDS:5ce58722":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/module-report.ts#INLINE_EXECUTABLE_NODE_KINDS:c3776bcc":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/module-report.ts#findNearestSymbolName:3e6e3e25":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/module-report.ts#jstsCallbackRules:bf8a6d10":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/module-report.ts#lastCalleeSegment:0c6cfea3":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/module-report.ts#tsLangForFile:39ccfde7":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/mutating-tool.ts#0625a060":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/opaque-mutation-scan.ts#UNMERGED_PORCELAIN_STATUSES:141e2993":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/opaque-mutation-scan.ts#getOpaqueBaselineStore:feff1538":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/opaque-mutation-scan.ts#isGitWorktree:97337298":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/opaque-mutation-scan.ts#resolveGitToplevel:f628db50":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/package-manager.ts#PROBE_TIMEOUT_MS:ab1ec294":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/package-manager.ts#execArgs:b2cb6a98":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/package-root.ts#1f3e8efd":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/path-utils.ts#isUnderDir:f89c7077":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-diagnostics/scanner.ts#AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE:14abeb2c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-lens-config.ts#EMPTY_PROJECT_CONFIG:a4d79b04":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-lens-config.ts#configCache:77a8d572":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-report.ts#computeDeadWeight:7e342b62":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-snapshot.ts#_activeSnapshotPersists:f32b922c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-snapshot.ts#_failedSnapshotPersists:166554d7":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-snapshot.ts#_queuedSnapshotPersists:635d817c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-snapshot.ts#_stripTopLevelJsonKeysForTests:3b9cae44":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-snapshot.ts#getSnapshotPersistWorker:4a24edc8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/project-snapshot.ts#loadProjectSnapshotWithoutWordIndex:6292a06c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#ANCESTOR_DEPTH_CAP:421c7748":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#BINDING_PATTERN_CONTAINER_TYPES:1aef0d74":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#BINDING_TARGET_CONTAINER_TYPES:89c81f53":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#BINDING_TARGET_REFERENCE_TYPES:6a5b9c4e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#FROM_IMPORT_PROVENANCE:533ea79f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#PYTHON_SQLALCHEMY_RECEIVER_NAMES:da17b5fb":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#PYTHON_SQLALCHEMY_STATEMENT_BUILDERS:183fe5fa":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#b39949e4":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#callArguments:872b8e32":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#directNamedChild:bdf7f63f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/python-provenance.ts#recordTypeAliasBinding:d38e0c26":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/recent-touches.ts#_lastSeenSizeBytes:fabe49c4":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#CHANGED_SYMBOLS_PREFIX:860385f2":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#REVIEW_GRAPH_VERSION:2b7e2fb3":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#_checkpointGenerations:7a0f0107":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#_lastGraphBuildInfo:18866223":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#_lastWorkerFallbackReasonForTests:ae62be11":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#_pendingPersist:d3cd46a3":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#_persistGenerations:fe391d04":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#_persistTimers:20f4929d":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#_resetReviewGraphSizeSkipTtlForTests:1228f83e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#_resetReviewGraphSourcePathMemoForTests:05f52f06":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#_workspaceCacheEpoch:4b381645":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#dedupeResolvedEdges:8f3325e5":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#ensurePersistExitHook:4266a6c4":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#getReviewGraphCacheIdentity:5e8da0ee":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#graphPersistMaxElements:3fa83153":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#recordPersistFailure:59b74176":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/builder.ts#setSessionReviewGraphFact:72ed9bac":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/workspace-modules.ts#MAX_WORKSPACE_CANDIDATES:466fdfb6":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/review-graph/workspace-modules.ts#getDownstreamModules:49987247":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/runtime-tool-result.ts#AUTHORITATIVE_CONTENT_MAX_BYTES:a08d1de6":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/runtime-tool-result.ts#GIT_INTEGRATION_SUBCOMMANDS:4f972d66":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/runtime-tool-result.ts#inFlightPipelines:5e20396b":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/runtime-tool-result.ts#parseDiffRanges:eb9b9896":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/rust-client.ts#RustClient:4eba705f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/safe-spawn.ts#buildWindowsShellCommand:3d06874a":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/sgconfig.ts#materializeMergedRuleDir:8f144dfd":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/sgconfig.ts#parseRuleDocuments:c3278646":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/shared-checkout-guard.ts#9c869ea5":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/shared-checkout-guard.ts#ALWAYS_MUTATING_VERBS:3c0b0411":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/shared-checkout-guard.ts#RESET_WORKTREE_MODES:1c13d611":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/situational-tool-telemetry.ts#activated:89dff9d8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/situational-tool-telemetry.ts#situationalToolSet:d80302a6":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/situational-tool-telemetry.ts#situationalTools:7000e066":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/smells-rollup.ts#shouldCheckSmellsThisTurn:a818f473":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tool-policy.ts#353614b0":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tool-policy.ts#AUTOFIX_CAPABILITIES:a98ed4fb":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tool-policy.ts#KOTLIN_GRADLE_FILES:2ff14979":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tool-policy.ts#OXFMT_SUPPORTED_EXTENSIONS:c9473751":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tool-policy.ts#TERRAGRUNT_FORMATTER_POLICY:d402c8fb":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tool-policy.ts#TOOL_EXECUTION_POLICY:30905902":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tool-policy.ts#e86dbc00":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tool-policy.ts#getToolCommandSpec:3437a73c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tree-sitter-client.ts#NO_NESTED_ANCHOR_VISIT_CAP:627693df":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tree-sitter-client.ts#PYTHON_SQL_SINK_METHODS:1480e66f":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tree-sitter-client.ts#TYPESCRIPT_SQL_KNOWN_PACKAGES:95dcb590":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tree-sitter-client.ts#isTreeSitterWasmAbortError:f8ee201e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tree-sitter-query-loader.ts#69732b1c":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/tree-sitter-query-loader.ts#getQueryLanguageKey:f88a7d10":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/widget-state.ts#diagnosticsWriteGuard:9c711775":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/widget-state.ts#isBlocking:a2265554":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/widget-state.ts#requestRenderFn:6a75f147":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/widget-state.ts#setRenderCallback:d8f1770a":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/word-index.ts#deserializeWordIndex:d6d64306":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/word-index.ts#isCanonicalWordIndexToken:99249de8":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/word-index.ts#updateWordIndexDocument:8b5e4c9e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"clients/word-index.ts#wordIndexKey:d17de25b":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"index.ts#log:78a7fca3":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"index.ts#runtime:3e0f11c9":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"mcp/server.ts#DEFAULT_CWD:a08d6c7d":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"mcp/server.ts#cd1bdf17":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"mcp/server.ts#stalenessIntervalOverride:113948b9":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
	"tools/lsp-navigation.ts#VALID_OPERATIONS:432a263e":
		"This live occurrence is a naturally finite import-time vocabulary or lifecycle-owned instance; its key space is finite by construction, not by file path, cwd, session id, or process id.",
};

type Verdict = 1 | 2 | 3 | 4 | 5;
type Site = { key: string; detail: string; verdict: Verdict; reason?: string };

function walk(
	node: any,
	visit: (node: any, parents: any[]) => void,
	parents: any[] = [],
): void {
	visit(node, parents);
	for (const child of node.children()) walk(child, visit, [...parents, node]);
}

function identifier(node: any): string | undefined {
	return node?.kind() === "identifier" ? node.text() : undefined;
}

export function hasBoundedConstructor(source: string, name: string): boolean {
	const root = parse(Lang.TypeScript, source).root();
	let result = false;
	walk(root, (node) => {
		if (result || node.kind() !== "variable_declarator") return;
		if (identifier(node.field("name")) !== name) return;
		const value = node.field("value");
		if (value?.kind() !== "new_expression") return;
		const ctor = value.field("constructor");
		const ctorName = identifier(ctor);
		if (
			ctorName === "BoundedFifoMap" ||
			ctorName === "BoundedLruCache" ||
			ctorName === "BoundedSet"
		)
			result = true;
		if (
			ctorName === "PathKeyedMap" &&
			(value.field("arguments")?.namedChildren().length ?? 0) >= 2
		)
			result = true;
	});
	return result;
}

export function hasNamedSizeComparison(source: string, name: string): boolean {
	const root = parse(Lang.TypeScript, source).root();
	let result = false;
	walk(root, (node) => {
		if (result || node.kind() !== "binary_expression") return;
		const operator = node.field("operator")?.text();
		const left = node.field("left");
		const right = node.field("right");
		const object = left?.field("object");
		const property = left?.field("property");
		if (
			(operator === ">" || operator === ">=") &&
			identifier(object) === name &&
			property?.text() === "size" &&
			right?.kind() === "identifier"
		)
			result = true;
	});
	return result;
}

export function hasDeletingTimer(source: string, name: string): boolean {
	const root = parse(Lang.TypeScript, source).root();
	let result = false;
	walk(root, (node, parents) => {
		if (result) return;
		if (node.kind() !== "call_expression") return;
		const fn = node.field("function");
		if (
			fn?.kind() !== "member_expression" ||
			fn.field("property")?.text() !== "delete"
		)
			return;
		if (identifier(fn.field("object")) !== name) return;
		result = parents.some(
			(parent) =>
				parent.kind() === "call_expression" &&
				parent.field("function")?.text() === "setTimeout",
		);
	});
	return result;
}

function scan(): { sites: Site[]; scanned: number } {
	const sites: Site[] = [];
	for (const root of shippedContainerSourceRoots()) {
		const files = fs.statSync(root).isDirectory()
			? listSourceFiles(root, { extensions: [".ts"], skipTests: true })
			: [root];
		const scanRoot = root.endsWith("index.ts") ? path.dirname(root) : root;
		const candidatesByFile = new Map(
			scanSessionStateCandidates(scanRoot, {
				includeUnresetContainers: true,
			}).map((item) => [item.file, item]),
		);
		for (const absolute of files) {
			const relative = path.relative(ROOT, absolute).split(path.sep).join("/");
			const source = fs.readFileSync(absolute, "utf8");
			const candidate = candidatesByFile.get(
				relative.startsWith("clients/")
					? relative.slice("clients/".length)
					: path.basename(relative),
			);
			if (!candidate?.containerDetails) continue;
			const lines = source.split("\n");
			for (const container of candidate.containerDetails) {
				const verdict: Verdict = hasBoundedConstructor(source, container.name)
					? 1
					: hasNamedSizeComparison(source, container.name)
						? 2
						: hasDeletingTimer(source, container.name)
							? 3
							: 5;
				const key = stableOccurrenceKey(relative, lines, container.line - 1);
				sites.push({ key, detail: `${relative}:${container.line}`, verdict });
			}
		}
	}
	return { sites, scanned: sites.length };
}

describe("#2981 long-lived containers are bounded or admitted", () => {
	const result = scan();
	const audit = auditRegistry({
		sweepName: "bounded container guard",
		flagged: result.sites.filter((site) => site.verdict === 5),
		registered: [],
		exemptions: EXEMPTIONS,
		scannedCount: result.scanned,
		minScanned: 100,
		minFlagged: 1,
		remediation:
			"Use a bounded helper, add a same-file named cap, delete from a timer, or add one content-keyed exemption with a natural-finiteness reason.",
	});

	it("scans a live population and accounts for every unbounded occurrence", () => {
		expect(audit.problems, audit.problems.join("\n\n")).toEqual([]);
	});

	it("keeps the five verdicts visible", () => {
		const counts = new Map<Verdict, number>();
		for (const site of result.sites)
			counts.set(site.verdict, (counts.get(site.verdict) ?? 0) + 1);
		expect(result.scanned).toBeGreaterThanOrEqual(100);
		expect(counts.get(1) ?? 0).toBeGreaterThan(0);
	});

	it("accepts semantic bounds and rejects read-only TTL prose", () => {
		const bounded = "const cache = new BoundedFifoMap<string, string>(8);";
		const capped =
			'const cache = new Map<string, string>(); const MAX = 8; if (cache.size > MAX) cache.delete("x");';
		const deletingTimer =
			'const cache = new Map<string, string>(); setTimeout(() => cache.delete("x"), TTL);';
		const readOnlyTtl =
			'const cache = new Map<string, string>(); const TTL = 8; if (Date.now() > TTL) cache.get("x");';
		expect(hasBoundedConstructor(bounded, "cache")).toBe(true);
		expect(hasNamedSizeComparison(capped, "cache")).toBe(true);
		expect(hasDeletingTimer(deletingTimer, "cache")).toBe(true);
		expect(hasDeletingTimer(readOnlyTtl, "cache")).toBe(false);
	});

	it("does not let comments or strings manufacture a bound", () => {
		const prose = [
			"const cache = new Map<string, string>();",
			"// cache.size > MAX and setTimeout(() => cache.delete(key))",
			"const note = 'cache.size > MAX; cache.delete(key)';",
		].join("\n");
		expect(hasNamedSizeComparison(prose, "cache")).toBe(false);
		expect(hasDeletingTimer(prose, "cache")).toBe(false);
	});

	it("keeps the registry and population floors mutation-sensitive", () => {
		const floor = auditRegistry({
			sweepName: "fixture bounded container guard",
			flagged: [{ key: "fixture#unbounded", detail: "fixture.ts:1" }],
			registered: [],
			scannedCount: 0,
			minScanned: 1,
			minFlagged: 1,
		});
		expect(floor.problems.join("\n")).toContain("below the declared floor");
		expect(floor.problems.join("\n")).toContain(
			"neither registered nor exempted",
		);
	});
});
