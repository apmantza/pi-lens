import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDispatchContext } from "../dispatch/dispatcher.js";
import { evaluateRules } from "../dispatch/fact-rule-runner.js";
import { runProviders } from "../dispatch/fact-runner.js";
import { FactStore } from "../dispatch/fact-store.js";
import {
	canHandle as astGrepCanHandle,
	getLang as astGrepGetLang,
	evaluateAstGrepRules,
	loadSg,
} from "../dispatch/runners/ast-grep-napi.js";
import type { Diagnostic } from "../dispatch/types.js";
import { detectFileKind, isJstsFactFile } from "../file-kinds.js";
import { isTestFile } from "../file-utils.js";
import { isAtOrAboveHomeDir, realpathOrResolve } from "../path-utils.js";
import { getProjectDiagnosticsScannerMaxFiles } from "../project-scale.js";
import { captureReviewGraphStructuralIr } from "../review-graph/builder.js";
import {
	publishReviewGraphFileIr,
	reviewGraphIrContentHash,
} from "../review-graph/shared-extraction-ir.js";
import {
	collectSourceFilesWithBudgetAsync,
	type SourceCollectionResult,
} from "../source-filter.js";
import {
	logTreeSitter,
	logTreeSitterCacheStats,
} from "../tree-sitter-logger.js";
import {
	queriesForLanguage,
	queryLoader,
} from "../tree-sitter-query-loader.js";
import {
	EXT_TO_LANG,
	getSharedTreeSitterClient,
	isTreeSitterWasmAborted,
} from "../tree-sitter-shared.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	saveProjectDiagnosticsSnapshot,
} from "./cache.js";
import { hashDiagnosticContent } from "../lsp/diagnostic-binding.js";
import type {
	ProjectDiagnostic,
	ProjectDiagnosticsScanOptions,
	ProjectDiagnosticsSnapshot,
	ProjectScanFileFingerprint,
} from "./types.js";
// Side-effect import: registers fact providers and fact rules.
import "../dispatch/integration.js";

// Skip files this large: matches the per-edit ast-grep runner's guard so a single
// generated megafile can't dominate a project scan.
const AST_GREP_MAX_FILE_BYTES = 1024 * 1024;
// Project-audit budgets — looser than the per-edit runner's 10/50 (which exist to
// keep inline output bounded), since a project scan is an explicit, expensive call.
const AST_GREP_SCAN_MAX_MATCHES_PER_RULE = 25;
const AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE = 100;
// Which languages the scan runs tree-sitter rules for. Identical to the shared
// per-edit resolver (EXT_TO_LANG), which since #2424 is itself a projection of
// the canonical language registry — so the scan and the per-edit path cannot
// disagree about `.tsx`→tsx / `.jsx`→javascript / the c-vs-cpp header split.
// (`.tsx` resolves to the tsx grammar, not typescript: the typescript grammar
// ERRORs on JSX; typescript RULES still apply because `queriesForLanguage(...)`
// below merges the typescript rule set onto tsx.)
//
// java + kotlin used to be layered on here because EXT_TO_LANG lacked them:
// they have loadable grammars and rule dirs (java: 24 rules, kotlin: 1) but no
// per-edit runner `appliesTo` entry, so only this broad project scan runs them.
// The registry now owns their extensions, so the spread is gone and this is a
// plain alias. scanner.test.ts asserts this map covers every non-disabled rule
// dir whose grammar is loadable, so adding a language dir fails a test until
// its extension is registered in the registry.
//
// This map is the scan's language RESOLVER, not its eligibility gate: it now
// answers for grammars with no rule dir too (bash/dart/elixir/lua/ocaml/swift/
// zig), and the pass gates each file on `hasTreeSitterRules` so a grammar
// without rules costs no read (#2424 review, F2).
// `Readonly` because the projection is `Object.freeze`d at the source (#2424
// review, S4) — the mutable `Record` type is what let the pre-#2424 spread
// layer java/kotlin on by hand in the first place.
export const TREE_SITTER_EXT_TO_LANG: Readonly<Record<string, string>> =
	EXT_TO_LANG;

function normalizeSeverity(
	severity: string | undefined,
): ProjectDiagnostic["severity"] {
	if (severity === "error" || severity === "warning" || severity === "hint") {
		return severity;
	}
	return severity === "info" ? "info" : "warning";
}

function normalizeSemantic(
	diagnostic: Diagnostic,
): ProjectDiagnostic["semantic"] {
	if (diagnostic.semantic === "blocking") return "blocking";
	if (diagnostic.semantic === "warning") return "warning";
	return "none";
}

function fromDispatchDiagnostic(
	diagnostic: Diagnostic,
	runner: string,
): ProjectDiagnostic {
	return {
		filePath: path.resolve(diagnostic.filePath),
		line: diagnostic.line,
		column: diagnostic.column,
		severity: normalizeSeverity(diagnostic.severity),
		semantic: normalizeSemantic(diagnostic),
		tool: diagnostic.tool,
		runner,
		rule: diagnostic.rule,
		code: diagnostic.code,
		message: diagnostic.message,
		source: "project-scan",
	};
}

interface FileMajorScan {
	treeSitter: ProjectDiagnostic[];
	factRules: ProjectDiagnostic[];
	astGrep: ProjectDiagnostic[];
	filesScanned: number;
	wasmAborted: boolean;
	/**
	 * #2154: the bytes each file was READ with, for every file this pass
	 * produced at least one diagnostic from. Captured inside the loop, from the
	 * same `content` string the rules ran over — never re-read afterwards, or
	 * an edit landing between the scan and the re-read would be fingerprinted
	 * as if the rules had seen it, which is the very defect this closes.
	 */
	fingerprints: Record<string, ProjectScanFileFingerprint>;
}

/**
 * One FILE-major pass for every in-process syntax consumer (#675/#896).
 * Per-consumer gates preserve their distinct language and size eligibility,
 * while separate result lists preserve the historical phase-major diagnostic
 * ordering.
 */
async function scanFileMajorRules(
	cwd: string,
	files: string[],
	signal?: AbortSignal,
): Promise<FileMajorScan> {
	const client = getSharedTreeSitterClient();
	// #1715: grow the tree cache to span this scan's working set BEFORE
	// parsing starts, so a project bigger than the interactive default (50
	// entries) still gets cross-scan reuse instead of every file re-parsing
	// on every scan.
	client?.ensureTreeCacheCapacity(files.length);
	const treeSitterReady =
		!!client && client.isAvailable() && (await client.init());
	// Same singleton the dispatch runner uses (tree-sitter.ts:444) — memoized
	// per root, so repeated scans stop re-reading the ~180 query YAMLs.
	const queryMap = treeSitterReady
		? await queryLoader.loadQueries(cwd)
		: undefined;

	// Subject labels this store's capacity-eviction telemetry distinctly from
	// the other five production FactStore instances (#2243 review round 3, F1).
	const facts = new FactStore("project-diagnostics-scanner");
	const pi = { getFlag: () => undefined };
	const treeSitter: ProjectDiagnostic[] = [];
	const factRules: ProjectDiagnostic[] = [];
	const astGrep: ProjectDiagnostic[] = [];
	const fingerprints: Record<string, ProjectScanFileFingerprint> = {};
	const sgModule = await loadSg();
	let phaseOneFilesScanned = 0;
	let astGrepFilesScanned = 0;
	let astGrepDurationMs = 0;
	// #891: only fully completed files count — a wasm abort mid-file leaves that
	// file out, so the caller can report a truncated filesScanned honestly.
	let filesScanned = 0;
	let wasmAborted = isTreeSitterWasmAborted();

	/**
	 * Does this project actually have ENABLED tree-sitter rules for `langId`?
	 *
	 * The gate below used to read "does the extension have a grammar", which was
	 * the same question only because the ext -> grammar map hand-listed exactly
	 * the twelve grammars that also ship a `rules/tree-sitter-queries/<lang>/`
	 * dir. #2424 projected that map from the registry's full grammar column, so
	 * bash/dart/elixir/lua/ocaml/swift/zig arrived WITHOUT rules and every such
	 * file started being read, walked and counted for a rule set that is empty
	 * (#2424 review, F2). Memoized per language: `queriesForLanguage` rebuilds
	 * and filters its array on every call, and the scan asks once per file.
	 */
	const ruleCoverage = new Map<string, boolean>();
	const hasTreeSitterRules = (langId: string): boolean => {
		if (!queryMap || !client) return false;
		const memo = ruleCoverage.get(langId);
		if (memo !== undefined) return memo;
		const covered = queriesForLanguage(queryMap, langId).length > 0;
		ruleCoverage.set(langId, covered);
		return covered;
	};

	const scanTreeSitterFile = async (
		filePath: string,
		langId: string | undefined,
		content: string | null,
	): Promise<void> => {
		if (!queryMap || !langId || !client || content === null) return;
		const queries = queriesForLanguage(queryMap, langId);
		try {
			const found = await client.runQueriesOnFile(
				queries,
				filePath,
				langId,
				{ maxResults: 50 },
				content,
			);
			for (const { queryDef: query, match } of found) {
				treeSitter.push({
					filePath,
					line: match.line ?? 1,
					column: match.column,
					severity: query.severity === "error" ? "error" : query.severity,
					semantic:
						query.inline_tier === "blocking" || query.severity === "error"
							? "blocking"
							: "warning",
					tool: "tree-sitter",
					runner: "tree-sitter",
					rule: query.id,
					message: query.message,
					source: "project-scan",
				});
			}
		} catch {
			// Continue scanning other rules/files.
		}
	};

	const scanFactRulesFile = async (
		filePath: string,
		content: string | null,
	): Promise<void> => {
		facts.dropFileFacts(filePath);
		// Seed the exact bytes already supplied to tree-sitter so the file-content
		// provider is skipped by runProviders.
		facts.setFileFact(filePath, "file.content", content);
		const ctx = createDispatchContext(filePath, cwd, pi, facts, false);
		try {
			await runProviders(ctx);
			for (const diagnostic of evaluateRules(ctx)) {
				factRules.push(fromDispatchDiagnostic(diagnostic, "fact-rules"));
			}
		} catch {
			// Project scans are best-effort; one unparsable file should not abort the tool.
		}
	};

	const scanAstGrepFile = (
		filePath: string,
		content: string,
		lang: NonNullable<ReturnType<typeof astGrepGetLang>>,
	): void => {
		const startedAt = Date.now();
		try {
			const rootNode = lang.parse(content).root();
			const fileDiagnostics = evaluateAstGrepRules(
				filePath,
				rootNode,
				cwd,
				detectFileKind(filePath),
				{
					maxMatchesPerRule: AST_GREP_SCAN_MAX_MATCHES_PER_RULE,
					maxTotalDiagnostics: AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE,
					content,
					sgModule,
				},
			);
			for (const diagnostic of fileDiagnostics) {
				astGrep.push(fromDispatchDiagnostic(diagnostic, "ast-grep-napi"));
			}
		} catch {
			// Project scans are best-effort; one unparsable file must not abort the tool.
		} finally {
			astGrepFilesScanned++;
			astGrepDurationMs += Date.now() - startedAt;
		}
	};

	const scan = async (): Promise<void> => {
		for (const filePath of files) {
			// #891: a wasm-level abort poisons the shared parser for the rest of the
			// process — stop the whole pass, don't keep feeding it files.
			if (signal?.aborted || isTreeSitterWasmAborted()) {
				wasmAborted ||= isTreeSitterWasmAborted();
				break;
			}
			if (isTestFile(filePath)) continue;
			const ext = path.extname(filePath);
			// A grammar is not a consumer: only a language this project has
			// ENABLED rules for can turn this file's bytes into a finding.
			const grammarId = TREE_SITTER_EXT_TO_LANG[ext];
			const langId =
				grammarId && hasTreeSitterRules(grammarId) ? grammarId : undefined;
			const factEligible = isJstsFactFile(filePath);
			let astGrepLang: ReturnType<typeof astGrepGetLang> | undefined;
			if (sgModule && astGrepCanHandle(filePath)) {
				try {
					if (fs.statSync(filePath).size <= AST_GREP_MAX_FILE_BYTES) {
						astGrepLang = astGrepGetLang(filePath, sgModule);
					}
				} catch {
					// A missing file is ineligible for every content consumer below.
				}
			}
			if (!langId && !factEligible && !astGrepLang) continue;
			if (langId || factEligible) phaseOneFilesScanned++;

			// #2154 (#3060 round 2 F1): read the BYTES once, then decode. The
			// fingerprint below must record the file's ON-DISK length, because
			// that is what the reader compares against `statSync().size`. A
			// length taken from the decoded STRING disagrees for every file
			// holding a byte that is not valid UTF-8 — one such byte decodes to
			// a 3-byte U+FFFD — so the size check could never match and every
			// row from that file was retired on every cached read, for a file
			// nobody touched. That is the DROP direction this store's own
			// reconcile doc calls the worse one. `buf.length` equals
			// `stat.size` for every file; both sides then hash the same lossy
			// decode, so an unchanged file still matches exactly.
			let content: string | null;
			let contentBytes: number | undefined;
			try {
				const buf = fs.readFileSync(filePath);
				contentBytes = buf.length;
				content = buf.toString("utf-8");
			} catch {
				content = null;
				contentBytes = undefined;
			}

			// #2154: how many rows existed BEFORE this file was scanned, so the
			// fingerprint below is written only for files that actually produced
			// one — the snapshot keeps no row for any other file, and an entry
			// for a file with no row is dead weight in a record that is read on
			// every `refreshRunners=cached` call.
			const rowsBeforeFile =
				treeSitter.length + factRules.length + astGrep.length;

			try {
				await scanTreeSitterFile(filePath, langId, content);
				if (isTreeSitterWasmAborted()) {
					wasmAborted = true;
					break;
				}

				if (factEligible) {
					await scanFactRulesFile(filePath, content);
					if (isTreeSitterWasmAborted()) {
						wasmAborted = true;
						break;
					}
				}

				let graphIr:
					| Awaited<ReturnType<typeof captureReviewGraphStructuralIr>>
					| undefined;
				if (content !== null) {
					try {
						graphIr = await captureReviewGraphStructuralIr(
							filePath,
							cwd,
							content,
							facts,
						);
					} catch {
						graphIr = { complete: false };
					}
					if (isTreeSitterWasmAborted()) {
						wasmAborted = true;
						break;
					}
				}

				if (signal?.aborted) {
					// The former phase-major scan never started ast-grep after a
					// phase-one abort. Discard earlier ast-grep work from this merged
					// pass to preserve that partial-result contract.
					astGrep.length = 0;
					break;
				}
				if (astGrepLang && content !== null) {
					scanAstGrepFile(filePath, content, astGrepLang);
				}
				if (signal?.aborted) break;
				if (content !== null && graphIr?.complete && graphIr.structural) {
					// Publish only consumable entries (the registry also enforces
					// this) — and hash via the shared contract so producer and
					// consumer can never diverge (#955 review).
					publishReviewGraphFileIr(cwd, {
						filePath,
						contentHash: reviewGraphIrContentHash(content),
						...graphIr,
					});
				}
				// #2154: bind this file's rows to the bytes they were computed
				// from. Only reachable with `content` in hand, which is the point
				// — the fingerprint must describe what the rules READ, never what
				// disk holds by the time the scan ends.
				if (
					content !== null &&
					contentBytes !== undefined &&
					treeSitter.length + factRules.length + astGrep.length > rowsBeforeFile
				) {
					fingerprints[filePath] = {
						sizeBytes: contentBytes,
						contentHash: hashDiagnosticContent(content),
					};
				}
				filesScanned++;
			} finally {
				// This store belongs to the scan, and every consumer of this file's
				// content and derived facts has completed by the end of the iteration.
				// Drop without pinning: the scan is sequential and owns this store, so
				// there is no concurrent walk to guard against, and pinning every
				// scanned file would exempt it from the capacity cap (#2243).
				facts.dropFileFacts(filePath);
			}
			// Ready parser/provider promises do not drain host callbacks. Yield
			// only after this file's facts are released; the next iteration checks
			// cancellation before consuming another file (#1740).
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		if (wasmAborted) {
			// Mirror the phase-major #891 contract: the ast-grep phase never ran
			// after a wasm abort, so this merged pass discards its buffer too.
			astGrep.length = 0;
		}
	};

	if (!client) {
		await scan();
		return {
			treeSitter,
			factRules,
			astGrep,
			filesScanned,
			wasmAborted,
			fingerprints,
		};
	}

	const startedAt = Date.now();
	await client.withParseCacheMeasurement(scan, (stats) => {
		logTreeSitterCacheStats({
			scope: "project_diagnostics_scan",
			filePath: cwd,
			fileCount: phaseOneFilesScanned,
			// The merged pass interleaves ast-grep with the phase-one consumers;
			// subtract its share so this metric stays comparable to the historical
			// phase-major scans.
			durationMs: Date.now() - startedAt - astGrepDurationMs,
			stats,
			// #1935 review: ast-grep's own cost is often a scan's most expensive
			// phase (production evidence: 13168ms over 86 files, the single
			// biggest contributor). Its duration is subtracted above so it stays
			// comparable to the historical phase-major scans; carry it here too
			// so it stays visible SOMEWHERE instead of disappearing when the
			// vacuous `project_diagnostics_ast_grep_scan` cache_stats record
			// (below) was removed.
			astGrep: {
				durationMs: astGrepDurationMs,
				fileCount: astGrepFilesScanned,
			},
		});
	});
	// #1935: no `project_diagnostics_ast_grep_scan` cache_stats record here.
	// `scanAstGrepFile` parses through ast-grep-napi's own `lang.parse()` — a
	// separate native engine, not `TreeSitterClient`'s WASM `TreeCache` — so a
	// cache_stats record for this scope would always read all-zero (0
	// lookups, 0 hits, every counter 0) no matter how the scan behaves. That
	// was a vacuous observability record, not a real one: it looked like a
	// signal but could never carry information. `astGrepDurationMs` and
	// `astGrepFilesScanned` still feed the `project_diagnostics_scan` record
	// above (`astGrep` sub-field), so this cost stays observable without a
	// second, always-zero record to carry it.
	return {
		treeSitter,
		factRules,
		astGrep,
		filesScanned,
		wasmAborted,
		fingerprints,
	};
}

export async function scanProjectDiagnostics(
	options: ProjectDiagnosticsScanOptions,
): Promise<ProjectDiagnosticsSnapshot> {
	const cwd = path.resolve(options.cwd);
	const { signal } = options;
	// #747/#250: refuse to WALK from a cwd at — or above — the home directory.
	// The cheap tier is bounded by DEFAULT_MAX_FILES, but from $HOME it still
	// traverses a huge unrelated tree until it happens to keep that many source
	// files. An explicit `files` list (#461) is a caller-chosen subset, not a
	// walk, so it is never refused here. Same ceiling as fresh-fetch.ts, by
	// real path on both sides (#4911).
	if (
		!options.files &&
		isAtOrAboveHomeDir(
			realpathOrResolve(cwd),
			realpathOrResolve(options.homeDir ?? os.homedir()),
		)
	) {
		return {
			version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
			cwd,
			tier: options.tier,
			scannedAt: new Date().toISOString(),
			diagnostics: [],
			filesScanned: 0,
			runners: [],
			unsafeRoot: true,
		};
	}
	const maxFiles = Math.max(
		1,
		options.maxFiles ?? getProjectDiagnosticsScannerMaxFiles(cwd),
	);
	// #760: bound the walk by entries VISITED, not just files kept — a mixed
	// tree with few source files among a huge pile of non-source files never
	// trips `maxFiles`. Unlike `unsafeRoot` this is not a refusal: when the
	// budget trips we scan the truncated best-effort list and flag the snapshot
	// so callers don't read the partial result as a complete sweep.
	// #1107 phase 2: typed as the full `SourceCollectionResult` (not just its
	// `{files, entryBudgetExceeded}` shape) so the generated-skip counters
	// below are readable through the ternary — the `options.files` branch
	// legitimately never walked, so it leaves them `undefined`, same
	// convention as `entryBudgetExceeded: false` above it.
	const collected: SourceCollectionResult = options.files
		? { files: options.files.slice(0, maxFiles), entryBudgetExceeded: false }
		: await collectSourceFilesWithBudgetAsync(cwd, {
				maxFiles,
				maxScanEntries: options.maxScanEntries,
				// #1107 phase 2 review: the actionable opt-out generatedSkipNotice
				// points a user at.
				includeGenerated: options.includeGenerated === true,
			});
	const files = collected.files;
	// Check cancellation before and during the file-major pass so a full-mode
	// scan stops promptly when the agent/user aborts (#341).
	const runners: string[] = [];
	const diagnostics: ProjectDiagnostic[] = [];
	let fileFingerprints: Record<string, ProjectScanFileFingerprint> = {};
	let wasmAborted = false;
	let filesScanned = files.length;
	if (!signal?.aborted) {
		// All in-process syntax consumers share one file-major pass (#675/#896).
		const scanned = await scanFileMajorRules(cwd, files, signal);
		diagnostics.push(...scanned.treeSitter, ...scanned.factRules);
		runners.push("tree-sitter", "fact-rules");
		wasmAborted = scanned.wasmAborted;
		if (wasmAborted) filesScanned = scanned.filesScanned;
		if (!signal?.aborted && !wasmAborted) {
			diagnostics.push(...scanned.astGrep);
			runners.push("ast-grep-napi");
		}
		// #2154: keep a fingerprint only for a file that still has a row after
		// the ast-grep discard above, so the record cannot claim to describe a
		// file whose only rows were dropped.
		const rowFiles = new Set(diagnostics.map((d) => d.filePath));
		fileFingerprints = Object.fromEntries(
			Object.entries(scanned.fingerprints).filter(([file]) =>
				rowFiles.has(file),
			),
		);
	}
	const snapshot: ProjectDiagnosticsSnapshot = {
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
		cwd,
		tier: options.tier,
		scannedAt: new Date().toISOString(),
		diagnostics,
		filesScanned,
		runners,
		fileFingerprints,
	};
	// #760: only present when true — keeps existing snapshots/serializations
	// byte-identical for the untruncated (normal) case.
	if (collected.entryBudgetExceeded) snapshot.scanTruncated = true;
	// #1107 phase 2: only present when nonzero, same convention as the
	// truncation flag above — a healthy scan with no generated-name skips
	// produces a byte-identical snapshot to before this change.
	if (collected.generatedOrArtifactSkips) {
		snapshot.generatedFileSkips = collected.generatedOrArtifactSkips;
	}
	if (collected.generatedNameOnlySkips) {
		snapshot.generatedNameOnlySkips = collected.generatedNameOnlySkips;
	}
	if (collected.generatedDirSkips) {
		snapshot.generatedDirSkips = collected.generatedDirSkips;
	}
	if (wasmAborted) {
		snapshot.scanTruncated = true;
		snapshot.treeSitterStatus = "wasm_aborted_restart_required";
		logTreeSitter({
			phase: "runner_skip",
			filePath: cwd,
			status: "aborted",
			reason: "wasm_aborted_mid_scan",
			metadata: {
				scope: "project_diagnostics_scan",
				filesScanned,
				totalFiles: files.length,
				abortPoint: filesScanned + 1,
			},
		});
	}
	// A cancelled scan yields a partial snapshot; don't persist it as the
	// authoritative cross-session cache — only a complete run is cacheable.
	// Likewise, an explicit `files` scan (#461) only covers a caller-chosen
	// subset (e.g. git-staged files), not the whole project — persisting it
	// would poison the cross-session cache with a partial view that a later
	// unscoped `refreshRunners=cached` read would wrongly trust as complete.
	if (signal?.aborted || options.files || wasmAborted) return snapshot;
	saveProjectDiagnosticsSnapshot(cwd, snapshot);
	return snapshot;
}
