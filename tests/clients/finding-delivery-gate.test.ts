/**
 * Coverage guard for the #1634 finding-delivery gate.
 *
 * Review round F1/F2 findings on the first version of this file:
 *   - F1: `expect(src).toContain(gateName)` matched the IMPORT line and a doc
 *     comment mentioning the gate by name — stubbing the three real gate
 *     calls to identity and deleting the age interpolations left the guard
 *     19/19 green.
 *   - F2: `DELIVERY_SURFACES` and `EXPECTED_SURFACE_IDS` were two hand lists
 *     that only checked each other — a brand-new ungated `advisoryParts.push`
 *     seam passed silently.
 *
 * Fix: (1) every gate/label claim is checked against a literal, comment/
 * string-STRIPPED `evidence` substring declared per surface (see
 * clients/finding-delivery-gate.ts's `DeliverySurfaceEntry.evidence` doc) —
 * chosen to be surface-specific so a stub of a DIFFERENT surface's call to
 * the same shared gate function cannot satisfy it. (2) `clients/runtime-turn.ts`
 * and `tools/lens-diagnostics.ts` are REALLY scanned for their render-seam
 * shapes (`blockerParts.push`/`advisoryParts.push`/`staleSecretParts.push`,
 * and `format*Mode` function definitions) and every seam found must carry an
 * `@delivery-surface: <id>` tag naming a real registry entry — an untagged
 * seam fails the suite, exactly the session-state sweep's "registered or
 * fail" pattern.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	bindTagsToSeams,
	escapeRegExp,
	findSeams,
	listSourceFiles,
	matchingCloseIndex,
	relativePosix,
	scanTaggedSeams as scanTaggedSeamsWith,
	type SeamHit,
	stripSource,
	tagPattern,
} from "../support/sweep-kit.js";
import { removeTempDirSync } from "./test-utils.js";
import {
	assertNoDeliveryBypass,
	DELIVERY_SURFACES,
	formatCacheAgeLabel,
	type DeliverySurfaceEntry,
} from "../../clients/finding-delivery-gate.js";
import { LENS_TOOL_NAMES, TOOL_REGISTRY } from "../../clients/tool-config.js";

const REPO_ROOT = path.resolve(__dirname, "../..");

function readSource(relativeFile: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
}

const sourceCache = new Map<string, string>();
function source(file: string): string {
	let cached = sourceCache.get(file);
	if (cached === undefined) {
		cached = readSource(file);
		sourceCache.set(file, cached);
	}
	return cached;
}

const EXPECTED_SURFACE_IDS = [
	"runtime-turn:secrets-gitleaks",
	"runtime-turn:secrets-trivy",
	"runtime-turn:govulncheck-advisory",
	"runtime-turn:unresolved-inline-blocker",
	"runtime-turn:stale-secrets-tier",
	"runtime-turn:trivy-critical-blocker",
	"runtime-turn:trivy-cve-advisory",
	"runtime-turn:trivy-license-advisory",
	"runtime-turn:dead-code-advisory",
	"runtime-turn:knip-blocker",
	"runtime-turn:knip-advisory",
	"runtime-turn:actionable-warnings-advisory",
	"runtime-turn:code-quality-warnings-advisory",
	"runtime-turn:disposition-suppressed-notice",
	"runtime-turn:late-auxiliary-findings",
	"runtime-turn:late-runner-findings",
	"runtime-turn:cascade-blocker",
	// #4487: earlier-turn cascade errors not re-checked this turn.
	"runtime-turn:cascade-pending-errors",
	"runtime-turn:cascade-coverage-advisory",
	// #3102: the cold-neighbour cascade run's own build-time lane, a turn
	// earlier than the runtime-turn render that carries it.
	"cascade-format:resolved-found-run",
	// #3157: the IN-LANE cascade's four display sites, which never enter the
	// dispatcher's filter pipeline — a separate lane from the quiet-window run
	// above, and the one #3102's file-level sweep verdict cleared wrongly.
	"dispatch-integration:in-lane-cascade",
	"runtime-turn:call-graph-advisory",
	"lens-diagnostics:mode-full",
	"lens-diagnostics:mode-all",
	"lens-diagnostics:mode-delta",
	"widget-state:footer",
	"agent-nudge:context-message",
	"test-runner-delivery:custom-entry",
	"project-diagnostics:persisted-snapshot",
	// #2028: the remaining agent-facing surfaces.
	"tool-call:stop-blocker",
	"lsp-diagnostics:tool-output",
	"git-guard:commit-blocked",
	"read-guard-tool-lines:preflight-errors",
	"agent-behavior:thrashing-notice",
	"tool-call:duplicate-export-blocker",
	// #2423: the shape adapters promoted out of `read-guard-tool-lines.ts` carry
	// their blocking preflight text with them.
	"mutating-tool:adapter-preflight-errors",
	// #2007: the shared-checkout refusal, the same live-preflight shape as
	// `git-guard:commit-blocked`.
	"shared-checkout-guard:worktree-mutation-blocked",
	// #1634 enumeration round: the sinks the census found outside the list.
	"lsp-navigation:workspace-diagnostics-path",
	"lsp-navigation:tracked-snapshot",
	"runtime-context:persisted-findings",
	"index:turn-summary",
	"lens-engine:project-scan",
	"mcp-server:analyze",
	"mcp-analyze-cli:post-edit-report",
].sort();

// ── Render-seam scan (#1634 review F2, #3165) ───────────────────────────────
//
// Every production file is scanned, not a named list (#3165: the scan read two
// files, so a render seam anywhere else was structurally invisible). Seams are
// found in comment-and-string-blanked text, so a seam-shaped call quoted in a
// comment or a string never counts, and each one binds to the tag comment on
// the non-blank line directly above it (`bindTagsToSeams`). A tag must name a
// registered surface whose `file` is the seam's own file, so a new seam cannot
// borrow another file's entry.

const TAG = tagPattern("delivery-surface");

const SEAM_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
	{
		name: "turn-end tier push",
		pattern: /\b(blockerParts|advisoryParts|staleSecretParts)\.push\(/,
	},
	{
		name: "lens_diagnostics mode report",
		pattern: /^(?:export\s+)?(?:async\s+)?function\s+format\w*Mode\(/,
	},
	{
		// #3165: the cascade display render, called outside the two files the
		// scan used to read. Its own definition is not a seam.
		name: "cascade neighbour render",
		pattern: /(?<!\bfunction\s+)\bformatCascadeNeighborDiagnostics\(/,
	},
];

const RUNTIME_TURN_SEAM_PATTERN = SEAM_SHAPES[0].pattern;

const PRODUCTION_DIRS = ["clients", "tools", "mcp"];

/** Every production source under `root`, root-relative posix, sorted. */
function productionFiles(root: string): string[] {
	const files = PRODUCTION_DIRS.flatMap((dir) =>
		fs.existsSync(path.join(root, dir))
			? listSourceFiles(path.join(root, dir))
			: [],
	);
	const entry = path.join(root, "index.ts");
	if (fs.existsSync(entry)) files.push(entry);
	return files.map((file) => relativePosix(root, file)).sort();
}

/** `rawSource`'s tagged seams, with the kit's binding rules. */
function scanTaggedSeams(rawSource: string, pattern: RegExp) {
	return scanTaggedSeamsWith(rawSource, pattern, TAG);
}

/** Problems for one file's render seams; empty means each is registered. */
function seamProblems(
	file: string,
	rawSource: string,
	registry: Record<string, DeliverySurfaceEntry> = DELIVERY_SURFACES,
): string[] {
	const stripped = stripSource(rawSource);
	const problems: string[] = [];
	for (const shape of SEAM_SHAPES) {
		const hits = findSeams(stripped, shape.pattern);
		for (const { seam, ids, inlineTagOnSeamLine } of bindTagsToSeams(
			rawSource,
			hits,
			TAG,
		)) {
			const at = `${file}:${seam.line}`;
			if (inlineTagOnSeamLine || ids.length === 0) {
				problems.push(`${at}: untagged ${shape.name} seam — ${seam.text}`);
				continue;
			}
			for (const id of ids) {
				const entry = registry[id];
				if (!entry) {
					problems.push(
						`${at}: tagged "${id}", which is not in DELIVERY_SURFACES — ${seam.text}`,
					);
				} else if (entry.file !== file) {
					problems.push(
						`${at}: tagged "${id}", whose surface is registered in ${entry.file}`,
					);
				}
			}
		}
	}
	return problems;
}

/** Every render seam under `root`: the problems, and how many seams per shape. */
function scanRenderSeams(root: string): {
	problems: string[];
	seamsByShape: Record<string, string[]>;
	scanned: number;
} {
	const files = productionFiles(root);
	const problems: string[] = [];
	const seamsByShape: Record<string, string[]> = {};
	for (const file of files) {
		const raw = fs.readFileSync(path.join(root, file), "utf8");
		const stripped = stripSource(raw);
		for (const shape of SEAM_SHAPES) {
			for (const hit of findSeams(stripped, shape.pattern)) {
				(seamsByShape[shape.name] ??= []).push(`${file}:${hit.line}`);
			}
		}
		problems.push(...seamProblems(file, raw));
	}
	return { problems, seamsByShape, scanned: files.length };
}

/** A throwaway production tree holding only `files`, for the red proofs. */
function withSyntheticTree<T>(
	files: Record<string, string>,
	run: (root: string) => T,
): T {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1634-gate-"));
	try {
		for (const [file, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
			fs.writeFileSync(path.join(root, file), text);
		}
		return run(root);
	} finally {
		removeTempDirSync(root);
	}
}

describe("finding-delivery-gate render-seam scan (#1634 review F2, #3165)", () => {
	const repo = scanRenderSeams(REPO_ROOT);

	it("every render seam in every production file is tagged with its own file's surface", () => {
		expect(repo.problems, repo.problems.join("\n")).toEqual([]);
	});

	// The population, sized (#3165 item 4): the scan reads every production
	// file and finds each shape where it lives today. A floor per shape keeps a
	// broken pattern from passing as a clean tree.
	it("scans the whole production tree and finds every seam shape", () => {
		expect(repo.scanned).toBeGreaterThan(300);
		const filesOf = (shape: string) =>
			[
				...new Set(
					(repo.seamsByShape[shape] ?? []).map((at) => at.split(":")[0]),
				),
			].sort();
		expect(filesOf("turn-end tier push")).toEqual(["clients/runtime-turn.ts"]);
		expect(repo.seamsByShape["turn-end tier push"]?.length).toBeGreaterThan(15);
		expect(filesOf("lens_diagnostics mode report")).toEqual([
			"tools/lens-diagnostics.ts",
		]);
		expect(filesOf("cascade neighbour render")).toEqual([
			"clients/cascade-format.ts",
			"clients/dispatch/integration.ts",
			// #4487: the turn_end re-render of a partly-owned or labeled section.
			"clients/runtime-turn.ts",
		]);
	});

	// #3165 acceptance 1: the seam lives in a file nobody listed.
	it("RED PROOF: an untagged render seam in a NEW file is flagged", () => {
		const problems = withSyntheticTree(
			{
				"clients/cascade-preview.ts": `export function preview(cwd, neighbors) {
	return formatCascadeNeighborDiagnostics(cwd, neighbors, { noun: "neighbor" });
}
`,
			},
			(root) => scanRenderSeams(root).problems,
		);
		expect(problems).toEqual([
			expect.stringMatching(
				/^clients\/cascade-preview\.ts:2: untagged cascade neighbour render seam/,
			),
		]);
	});

	it("RED PROOF: a tag borrowing another file's surface is flagged", () => {
		const problems = seamProblems(
			"clients/cascade-preview.ts",
			`export function preview(cwd, neighbors) {
	// @delivery-surface: cascade-format:resolved-found-run
	return formatCascadeNeighborDiagnostics(cwd, neighbors, { noun: "neighbor" });
}
`,
		);
		expect(problems).toEqual([
			expect.stringContaining("registered in clients/cascade-format.ts"),
		]);
	});

	it("RED PROOF: a new untagged advisoryParts.push seam is flagged, not silently accepted", () => {
		const problems = seamProblems(
			"clients/runtime-turn.ts",
			`
function handleTurnEnd() {
	// a brand-new surface nobody registered
	advisoryParts.push("some new finding with no freshness gate");
}
`,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/untagged turn-end tier push seam/);
	});

	it("RED PROOF: a tag naming an id absent from the registry is flagged", () => {
		const problems = seamProblems(
			"clients/runtime-turn.ts",
			`
function handleTurnEnd() {
	// @delivery-surface: runtime-turn:totally-made-up-id
	advisoryParts.push(report);
}
`,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/not in DELIVERY_SURFACES/);
	});

	// #3165 acceptance 3: the scan reads code, not prose. Each seam shape
	// quoted in a comment and in a string is no seam at all.
	it("RED PROOF: a seam-shaped call inside a comment or a string is not mistaken for a real seam", () => {
		const problems = withSyntheticTree(
			{
				"clients/notes.ts": `// see advisoryParts.push(x) and formatCascadeNeighborDiagnostics(cwd, n)
/* function formatLegacyMode() was retired */
export const hint = "call formatCascadeNeighborDiagnostics(cwd, n) here";
`,
			},
			(root) => scanRenderSeams(root),
		);
		expect(problems.problems).toEqual([]);
		expect(problems.seamsByShape).toEqual({});
	});

	// RED PROOF (R1a): a second seam pasted right after an already-tagged one,
	// with no tag of its own, must NOT inherit the first seam's tag.
	it("RED PROOF: a second untagged seam right after a tagged one does not inherit its tag", () => {
		const problems = seamProblems(
			"clients/runtime-turn.ts",
			`
function handleTurnEnd() {
	// @delivery-surface: runtime-turn:knip-advisory
	advisoryParts.push("the real, registered finding");
	advisoryParts.push("a brand-new finding pasted right after it — unregistered");
}
`,
		);
		expect(problems).toEqual([
			expect.stringContaining("clients/runtime-turn.ts:5:"),
		]);
		expect(problems[0]).toMatch(/untagged/);
	});

	it("RED PROOF: a tag cannot bind two seams even across a blank-line gap", () => {
		const problems = seamProblems(
			"clients/runtime-turn.ts",
			`
function handleTurnEnd() {
	// @delivery-surface: runtime-turn:knip-advisory

	advisoryParts.push("the real, registered finding");

	advisoryParts.push("a second finding, blank-line-separated, still unregistered");
}
`,
		);
		expect(problems).toEqual([
			expect.stringContaining("clients/runtime-turn.ts:7:"),
		]);
	});
});

// ── Sink census (#1634 criterion 1) ─────────────────────────────────────────
//
// The render-seam scan covers seams with a known shape. The census covers the
// rest: every production file that holds an agent-facing SINK is either the
// `file` of a registered surface or classified here, with the surfaces it
// carries or why it carries none. A new sink file is unclassified and fails;
// a classified file whose sink is gone is stale and fails. Needle policy:
// `type: "text"` and `role: "user"` are found in comment-blanked text with
// strings kept, because their evidence IS a string literal; every other needle
// is found in comment-and-string-blanked text.
//
// #4459 review F1: needles name the IDENTIFIER, not one spelling of a call. An
// aliased import (`renderToolText as toolText`, the form `mcp/server.ts`
// uses) still names `renderToolText`; a tool result built with a `type`
// constant still has a `content: [` array, and a file-local constant bound to
// "text" is resolved. A constant imported from another file and a content
// array built away from its `content:` key are not resolved (named residual).
// Verify r2 plant (g): the host's message APIs are a sink of their own.

const SINK_SHAPES: ReadonlyArray<{
	name: string;
	pattern: RegExp;
	strings: "keep" | "blank";
}> = [
	{ name: "tool result text", pattern: /\btype:\s*"text"/, strings: "keep" },
	{
		name: "tool result content",
		pattern: /\bcontent:\s*\[/,
		strings: "blank",
	},
	{ name: "user-role message", pattern: /\brole:\s*"user"/, strings: "keep" },
	{ name: "tool_call block", pattern: /\bblock:\s*true\b/, strings: "blank" },
	{
		name: "hook context",
		pattern: /\b(?:additionalContext|hookSpecificOutput)\b/,
		strings: "blank",
	},
	{ name: "custom entry", pattern: /\bcustomType\s*:/, strings: "blank" },
	{
		name: "status or widget line",
		pattern: /\bset(?:Widget|Status)\b/,
		strings: "blank",
	},
	{ name: "host notification", pattern: /\.notify\(/, strings: "blank" },
	// #4459 verify r2 plant (g): the host's message APIs put text in the
	// agent's context; `sendMessage` built away from its `customType` key too.
	{
		name: "host message",
		pattern: /\bsend(?:User)?Message\b/,
		strings: "blank",
	},
	{
		name: "rendered tool text",
		pattern: /\brenderToolText\b/,
		strings: "blank",
	},
];

type Classification = { delivers: string[] } | { noFindings: string };

/**
 * Sink files that are no surface's `file`. `delivers` names the registered
 * surfaces whose output reaches the agent through this file's sink.
 */
const SINK_FILES: Record<string, Classification> = {
	"clients/runtime-session.ts": {
		noFindings:
			"session notices that background scans were skipped or limited; no finding rows",
	},
	"clients/runtime-tool-result.ts": {
		// #5120: a partial apply's preflight verdict reaches the agent on the
		// host edit's own result, wrapped here.
		delivers: [
			"tool-call:stop-blocker",
			"agent-behavior:thrashing-notice",
			"read-guard-tool-lines:preflight-errors",
		],
	},
	"tools/activate-tools.ts": {
		noFindings: "confirms which situational tools were activated",
	},
	"tools/ast-grep-outline.ts": {
		noFindings: "syntax outline of the files the caller named",
	},
	"tools/ast-grep-replace.ts": {
		noFindings: "the rewrite the caller's own pattern produced",
	},
	"tools/ast-grep-search.ts": {
		noFindings: "matches for the caller's own structural pattern",
	},
	"tools/effective-config.ts": {
		noFindings: "the resolved configuration and its provenance",
	},
	"tools/lens-diagnostic-mark.ts": {
		noFindings:
			"confirms the disposition the caller recorded for the finding it named",
	},
	"tools/module-report.ts": {
		noFindings: "module structure and exact symbol bodies, no diagnostics",
	},
	"tools/project-report.ts": {
		noFindings: "project structure overview, no diagnostics",
	},
	"tools/render-compact.ts": {
		noFindings:
			"formats text other tools hand it; each caller is censused on its own",
	},
	"tools/scan-progress.ts": {
		noFindings: "a progress line while a scan runs",
	},
	"tools/symbol-search.ts": {
		noFindings: "symbol matches for the caller's query",
	},
	"mcp/tool-arguments.ts": {
		noFindings: "MCP argument validation errors",
	},
};

/** `{file → sink names}` for every production file under `root`. */
function scanSinkFiles(root: string): {
	sinks: Record<string, string[]>;
	scanned: number;
} {
	const files = productionFiles(root);
	const sinks: Record<string, string[]> = {};
	for (const file of files) {
		const raw = fs.readFileSync(path.join(root, file), "utf8");
		const kept = stripSource(raw, { strings: "keep" });
		const blanked = stripSource(raw);
		for (const shape of SINK_SHAPES) {
			const text = shape.strings === "keep" ? kept : blanked;
			if (shape.pattern.test(text)) (sinks[file] ??= []).push(shape.name);
		}
		if (textConstantTypes(kept, blanked)) {
			(sinks[file] ??= []).push("tool result text constant");
		}
	}
	return { sinks, scanned: files.length };
}

/**
 * True when a file-local constant bound to the literal "text" is used as an
 * object's `type` (`const TEXT = "text"; … { type: TEXT, text }`).
 */
function textConstantTypes(kept: string, blanked: string): boolean {
	for (const [, name] of kept.matchAll(
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*"text"/g,
	)) {
		if (new RegExp(`\\btype:\\s*${escapeRegExp(name)}\\b`).test(blanked)) {
			return true;
		}
	}
	return false;
}

/** Problems with the census over `root`; empty means every sink file is accounted. */
function censusProblems(
	root: string,
	classified: Record<string, Classification> = SINK_FILES,
	registry: Record<string, DeliverySurfaceEntry> = DELIVERY_SURFACES,
	floors: { minFlagged: number; minScanned: number } = {
		minFlagged: 1,
		minScanned: 1,
	},
): string[] {
	const { sinks, scanned } = scanSinkFiles(root);
	const registeredFiles = new Set(Object.values(registry).map((e) => e.file));
	const audit = auditRegistry({
		sweepName: "agent-facing sink census (#1634)",
		flagged: Object.entries(sinks).map(([file, names]) => ({
			key: file,
			detail: names.join(", "),
		})),
		registered: registeredFiles,
		exemptions: Object.fromEntries(
			Object.entries(classified).map(([file, c]) => [
				file,
				"noFindings" in c ? c.noFindings : `delivers ${c.delivers.join(", ")}`,
			]),
		),
		minFlagged: floors.minFlagged,
		scannedCount: scanned,
		minScanned: floors.minScanned,
		remediation:
			"Register the surface in DELIVERY_SURFACES, or classify the file in SINK_FILES.",
	});
	const problems = [...audit.problems];
	for (const [file, c] of Object.entries(classified)) {
		if (registeredFiles.has(file)) {
			problems.push(
				`${file} is a registered surface file and also classified in SINK_FILES; keep one`,
			);
		}
		if ("delivers" in c) {
			for (const id of c.delivers) {
				if (!registry[id]) {
					problems.push(
						`${file} delivers "${id}", which is not in DELIVERY_SURFACES`,
					);
				}
			}
		}
	}
	return problems;
}

// ── noFindings proof (#4459 review F1) ─────────────────────────────────────
//
// A `noFindings` classification was prose nothing checked: raw findings
// appended to `tools/project-report.ts`, or a raw branch in `pilens_health`,
// stayed green. Each `noFindings` sink file, and the MCP handler of each
// `noFindings` tool, must now reference no finding READ: a store getter, a
// scanner, or a language server's diagnostics call. An exception is named
// with its reason; one nothing needs any more fails as stale.
//
// Verify r2: a handler region also takes in the same-file helpers it reaches
// and resolves renamed bindings (plants c and e), and the read list gained
// the stores it missed (plant f). Named residual: a helper imported from
// another module is not followed.

/** Finding reads by defining module; each name is ground-truthed below. */
const FINDING_READS: ReadonlyArray<{ module: string; names: string[] }> = [
	{
		module: "clients/widget-state.ts",
		names: [
			"exportWidgetState",
			"getFileDiagnosticSummaries",
			"getFileDiagnostics",
			"getSuppressedDiagnostics",
			"getWidgetBlockingFilesForSweep",
		],
	},
	{
		module: "clients/project-diagnostics/cache.ts",
		names: [
			"loadProjectDiagnosticsDeltaReport",
			"loadProjectDiagnosticsSnapshot",
		],
	},
	{
		module: "clients/project-diagnostics/scanner.ts",
		names: ["scanProjectDiagnostics"],
	},
	{ module: "clients/lens-engine.ts", names: ["projectScan"] },
	// #4459 verify r2 plant (f): stores the round-2 list missed.
	{
		module: "clients/lsp/workspace-diagnostics-cache.ts",
		names: ["loadWorkspaceDiagnosticsCache"],
	},
	{
		module: "clients/dispatch/pending-runner-findings.ts",
		names: ["drainPendingRunnerFindings", "peekSettledRunnerFindings"],
	},
	{ module: "clients/diagnostic-tracker.ts", names: ["getDiagnosticTracker"] },
	{
		module: "clients/test-runner-delivery.ts",
		names: ["consumeStagedTestRunnerFindings"],
	},
	{
		module: "clients/runtime-context.ts",
		names: [
			"consumeTestFindings",
			"consumeTurnEndFindings",
			"peekTestFindings",
			"peekTurnEndFindings",
		],
	},
];

/** Language-server diagnostics reads, called as methods on the service. */
const LSP_READ_METHODS = [
	"getAllDiagnostics",
	"getDiagnostics",
	"runWorkspaceDiagnostics",
];

/**
 * `region::read` → why this `noFindings` region may name that read. A region
 * is a file, or `mcp/server.ts#<tool>` for an MCP handler.
 */
const NO_FINDINGS_READ_EXEMPTIONS: Record<string, string> = {
	"tools/lens-diagnostic-mark.ts::getFileDiagnostics":
		"looks up the marked finding's live line to anchor the mark; the result " +
		"confirms the disposition and renders no finding rows",
	"clients/runtime-session.ts::getDiagnosticTracker":
		"resets the session tracker at session start; reads no rows",
};

/**
 * The body of the `if (… name === "<tool>" …) { … }` handler in
 * `mcp/server.ts` (one handler may serve two tools, as the ast-grep pair does),
 * with the same-file helpers it reaches and the original name of every
 * renamed binding it uses. A helper imported from another module is not
 * followed (named residual).
 */
function mcpHandlerBody(raw: string, tool: string): string | undefined {
	const kept = stripSource(raw, { strings: "keep" });
	const match = new RegExp(
		`\\bif\\s*\\([^{]*\\bname\\s*===\\s*"${tool}"[^{]*\\)\\s*\\{`,
	).exec(kept);
	if (!match) return undefined;
	const open = match.index + match[0].length - 1;
	const blanked = stripSource(raw);
	const close = matchingCloseIndex(blanked, open, "{", "}");
	if (close < 0) return undefined;
	return withOriginalNames(
		withSameFileHelpers(blanked, blanked.slice(open, close + 1)),
		renamedBindings(blanked),
	);
}

const IDENT = "[A-Za-z_$][\\w$]*";

/**
 * `local → original` for every renamed binding in blanked `text`:
 * `import { X as Y }` and `const { X: Y } = …` (a destructured dynamic import).
 * #4459 verify r2 plant (c): `pilens_health` read the snapshot through
 * `loadProjectDiagnosticsSnapshot as probeSnapshot`, and only the alias sits in
 * the handler body.
 */
function renamedBindings(text: string): Map<string, string> {
	const renames = new Map<string, string>();
	for (const [, list] of text.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/g)) {
		for (const [, from, to] of list.matchAll(
			new RegExp(`\\b(${IDENT})\\s+as\\s+(${IDENT})`, "g"),
		)) {
			renames.set(to, from);
		}
	}
	for (const [, list] of text.matchAll(
		/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g,
	)) {
		for (const [, from, to] of list.matchAll(
			new RegExp(`\\b(${IDENT})\\s*:\\s*(${IDENT})`, "g"),
		)) {
			renames.set(to, from);
		}
	}
	return renames;
}

/** `region` plus the original name of every rename it references. */
function withOriginalNames(region: string, renames: Map<string, string>) {
	const originals = [...renames]
		.filter(([local]) =>
			new RegExp(`\\b${escapeRegExp(local)}\\b`).test(region),
		)
		.map(([, original]) => original);
	return originals.length ? `${region}\n${originals.join(" ")}` : region;
}

/**
 * Column-0 declarations in blanked `text` (oxfmt keeps top-level statements
 * there), each spanning to the next column-0 statement.
 */
function topLevelDeclarations(
	text: string,
): Array<{ name: string; start: number; end: number }> {
	const lines = text.split("\n");
	const offsets: number[] = [];
	let at = 0;
	for (const line of lines) {
		offsets.push(at);
		at += line.length + 1;
	}
	const declaration = new RegExp(
		`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?\\s+(${IDENT})|(?:const|let|var|class)\\s+(${IDENT}))`,
	);
	const statementStarts = lines.flatMap((line, i) =>
		/^[^\s})\]]/.test(line) ? [i] : [],
	);
	return lines.flatMap((line, i) => {
		const m = declaration.exec(line);
		if (!m) return [];
		const next = statementStarts.find((j) => j > i);
		return [
			{
				name: m[1] ?? m[2],
				start: offsets[i],
				end: next === undefined ? text.length : offsets[next],
			},
		];
	});
}

/**
 * `body` plus every top-level declaration of blanked `text` (its file) that it
 * references, transitively. #4459 verify r2 plant (e):
 * `pilens_health` delegated the read to a module-level helper. A handler that
 * names its own dispatcher takes in every handler, since it can reach them.
 */
function withSameFileHelpers(text: string, body: string): string {
	const helpers = topLevelDeclarations(text);
	const taken = new Set<string>();
	let region = body;
	let frontier = body;
	for (;;) {
		const added = helpers.filter(
			(d) =>
				!taken.has(d.name) &&
				new RegExp(`\\b${escapeRegExp(d.name)}\\b`).test(frontier),
		);
		if (added.length === 0) return region;
		for (const d of added) taken.add(d.name);
		frontier = added.map((d) => text.slice(d.start, d.end)).join("\n");
		region += `\n${frontier}`;
	}
}

/** Every `noFindings` region under `root`, as comment-and-string-blanked text. */
function noFindingsRegions(
	root: string,
	classified: Record<string, Classification>,
	tools: Record<string, Classification>,
): { regions: Record<string, string>; problems: string[] } {
	const regions: Record<string, string> = {};
	const problems: string[] = [];
	for (const [file, c] of Object.entries(classified)) {
		if (!("noFindings" in c)) continue;
		const full = path.join(root, file);
		if (fs.existsSync(full)) {
			regions[file] = stripSource(fs.readFileSync(full, "utf8"));
		}
	}
	const serverFile = path.join(root, "mcp/server.ts");
	const server = fs.existsSync(serverFile)
		? fs.readFileSync(serverFile, "utf8")
		: undefined;
	for (const [tool, c] of Object.entries(tools)) {
		if (!("noFindings" in c)) continue;
		const mcpName = TOOL_REGISTRY.find((t) => t.name === tool)?.mcpName;
		if (!mcpName || server === undefined) continue;
		const body = mcpHandlerBody(server, mcpName);
		if (body === undefined) {
			problems.push(
				`${tool}: no \`if (name === "${mcpName}")\` handler found in mcp/server.ts, so its noFindings claim cannot be checked`,
			);
			continue;
		}
		regions[`mcp/server.ts#${mcpName}`] = body;
	}
	return { regions, problems };
}

/** Problems for `noFindings` regions that name a finding read. */
function noFindingsReadProblems(
	root: string,
	classified: Record<string, Classification> = SINK_FILES,
	tools: Record<string, Classification> = TOOL_CENSUS,
	exemptions: Record<string, string> = NO_FINDINGS_READ_EXEMPTIONS,
): string[] {
	const { regions, problems } = noFindingsRegions(root, classified, tools);
	const used = new Set<string>();
	const reads = [
		...FINDING_READS.flatMap(({ names }) =>
			names.map((name) => ({ name, pattern: new RegExp(`\\b${name}\\b`) })),
		),
		...LSP_READ_METHODS.map((name) => ({
			name,
			pattern: new RegExp(`\\.${name}\\s*\\(`),
		})),
	];
	for (const [region, text] of Object.entries(regions)) {
		for (const { name, pattern } of reads) {
			if (!pattern.test(text)) continue;
			const key = `${region}::${name}`;
			if (exemptions[key]) {
				used.add(key);
				continue;
			}
			problems.push(
				`${region} is classified noFindings but reads findings through ${name}; classify what it delivers, or name the exception in NO_FINDINGS_READ_EXEMPTIONS`,
			);
		}
	}
	for (const key of Object.keys(exemptions)) {
		if (!used.has(key)) {
			problems.push(`${key}: stale NO_FINDINGS_READ_EXEMPTIONS entry`);
		}
	}
	return problems;
}

describe("finding-delivery-gate sink census (#1634)", () => {
	it("every production file with an agent-facing sink is a surface file or classified", () => {
		const problems = censusProblems(REPO_ROOT, SINK_FILES, DELIVERY_SURFACES, {
			minFlagged: 20,
			minScanned: 300,
		});
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("RED PROOF: a NEW file with a tool-result sink is unclassified", () => {
		const problems = withSyntheticTree(
			{
				"tools/finding-digest.ts": `export function digest(text: string) {
	return { content: [{ type: "text", text }] };
}
`,
			},
			(root) => censusProblems(root, {}, DELIVERY_SURFACES),
		);
		expect(problems.join("\n")).toContain(
			"tools/finding-digest.ts (tool result text, tool result content)",
		);
	});

	it("RED PROOF: a sink named only in a comment is no sink", () => {
		const { sinks } = withSyntheticTree(
			{
				"tools/notes.ts": `// returns { type: "text" } and sets block: true
export const unrelated = 1;
`,
			},
			(root) => scanSinkFiles(root),
		);
		expect(sinks).toEqual({});
	});

	it("RED PROOF: a classified file whose sink is gone is stale", () => {
		const problems = withSyntheticTree(
			{ "tools/quiet.ts": "export const unrelated = 1;\n" },
			(root) =>
				censusProblems(
					root,
					{
						"tools/quiet.ts": {
							noFindings: "it used to print a progress line",
						},
					},
					DELIVERY_SURFACES,
					{ minFlagged: 0, minScanned: 1 },
				),
		);
		expect(problems.join("\n")).toContain("tools/quiet.ts");
	});

	it("RED PROOF: a surface file classified a second time is flagged", () => {
		const problems = withSyntheticTree(
			{
				"tools/lsp-navigation.ts":
					'export const r = { content: [{ type: "text", text: "" }] };\n',
			},
			(root) =>
				censusProblems(root, {
					"tools/lsp-navigation.ts": {
						noFindings: "a second home for one file",
					},
				}),
		);
		expect(problems).toContainEqual(
			expect.stringContaining(
				"tools/lsp-navigation.ts is a registered surface file",
			),
		);
	});

	it("RED PROOF: a classification naming an unknown surface is flagged", () => {
		const problems = withSyntheticTree(
			{
				"tools/digest.ts":
					'export const r = { content: [{ type: "text", text: "" }] };\n',
			},
			(root) =>
				censusProblems(root, {
					"tools/digest.ts": { delivers: ["digest:made-up"] },
				}),
		);
		expect(problems).toContainEqual(
			expect.stringContaining('"digest:made-up"'),
		);
	});

	// #4459 review F1 plant (a): the alias `mcp/server.ts` itself uses.
	it("RED PROOF: a NEW file rendering through an aliased renderToolText is unclassified", () => {
		const problems = withSyntheticTree(
			{
				"tools/finding-digest.ts": `import { renderToolText as toolText } from "./render-compact.js";
export const digest = (text: string) => toolText(text);
`,
			},
			(root) => censusProblems(root, {}, DELIVERY_SURFACES),
		);
		expect(problems.join("\n")).toContain(
			"tools/finding-digest.ts (rendered tool text)",
		);
	});

	// #4459 review F1 plant (b): no `type: "text"` literal anywhere.
	it("RED PROOF: a NEW file whose tool result types its text through a constant is unclassified", () => {
		const problems = withSyntheticTree(
			{
				"tools/finding-digest.ts": `const TEXT = "text" as const;
export function digest(text: string) {
	const block = { type: TEXT, text };
	return block;
}
`,
			},
			(root) => censusProblems(root, {}, DELIVERY_SURFACES),
		);
		expect(problems.join("\n")).toContain(
			"tools/finding-digest.ts (tool result text constant)",
		);
	});

	it("every noFindings sink file and noFindings MCP handler reads no findings", () => {
		const problems = noFindingsReadProblems(REPO_ROOT);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	// A renamed or moved read would make the proof above vacuous.
	it("every finding read the proof looks for still exists where it is listed", () => {
		const missing = [
			...FINDING_READS.flatMap(({ module, names }) => {
				const text = stripSource(readSource(module));
				return names
					.filter(
						(name) =>
							!new RegExp(
								`\\bexport\\s+(?:async\\s+)?(?:function\\s+|const\\s+)${name}\\b`,
							).test(text),
					)
					.map((name) => `${module}: ${name}`);
			}),
			...LSP_READ_METHODS.filter(
				(name) =>
					!new RegExp(`^\\s*async\\s+${name}\\s*\\(`, "m").test(
						stripSource(readSource("clients/lsp/index.ts")),
					),
			).map((name) => `clients/lsp/index.ts: ${name}`),
		];
		expect(missing).toEqual([]);
	});

	// #4459 review F1 plant (d).
	it("RED PROOF: a noFindings file that reads the persisted snapshot is flagged", () => {
		const problems = withSyntheticTree(
			{
				"tools/project-report.ts": `import { loadProjectDiagnosticsSnapshot } from "../clients/project-diagnostics/cache.js";
export const report = (cwd: string) => ({ content: [{ type: "text", text: String(loadProjectDiagnosticsSnapshot(cwd)?.diagnostics) }] });
`,
			},
			(root) => noFindingsReadProblems(root, SINK_FILES, {}, {}),
		);
		expect(problems).toEqual([
			expect.stringContaining(
				"tools/project-report.ts is classified noFindings but reads findings through loadProjectDiagnosticsSnapshot",
			),
		]);
	});

	// #4459 review F1 plant (c): the file is a registered surface file, so only
	// the handler's own body can carry the proof.
	it("RED PROOF: a noFindings MCP handler that reads the widget store is flagged", () => {
		const problems = withSyntheticTree(
			{
				"mcp/server.ts": `async function call(name: string) {
	if (name === "pilens_health") {
		const rows = getFileDiagnosticSummaries();
		return toolText(String(rows.length));
	}
	if (name === "pilens_latency") {
		return toolText("ok");
	}
}
`,
			},
			(root) =>
				noFindingsReadProblems(
					root,
					{},
					{ health: TOOL_CENSUS.health, latency: TOOL_CENSUS.latency },
					{},
				),
		);
		expect(problems).toEqual([
			expect.stringContaining(
				"mcp/server.ts#pilens_health is classified noFindings but reads findings through getFileDiagnosticSummaries",
			),
		]);
	});

	// #4459 verify r2 plant (c), verbatim: only the alias is in the handler.
	it("RED PROOF: a noFindings MCP handler reading through an import alias is flagged", () => {
		const problems = withSyntheticTree(
			{
				"mcp/server.ts": `import { loadProjectDiagnosticsSnapshot as probeSnapshot } from "../clients/project-diagnostics/cache.js";
async function call(name: string) {
	if (name === "pilens_health") {
		const snap = probeSnapshot(DEFAULT_CWD);
		return toolText(String(snap?.diagnostics.length));
	}
}
`,
			},
			(root) =>
				noFindingsReadProblems(root, {}, { health: TOOL_CENSUS.health }, {}),
		);
		expect(problems).toEqual([
			expect.stringContaining(
				"mcp/server.ts#pilens_health is classified noFindings but reads findings through loadProjectDiagnosticsSnapshot",
			),
		]);
	});

	// Same shape as plant (c), renamed by a module-level destructure instead.
	it("RED PROOF: a noFindings MCP handler reading through a destructured rename is flagged", () => {
		const problems = withSyntheticTree(
			{
				"mcp/server.ts": `const { loadProjectDiagnosticsSnapshot: snap } = await import("../clients/project-diagnostics/cache.js");
async function call(name: string) {
	if (name === "pilens_health") {
		return toolText(String(snap(DEFAULT_CWD)));
	}
}
`,
			},
			(root) =>
				noFindingsReadProblems(root, {}, { health: TOOL_CENSUS.health }, {}),
		);
		expect(problems).toEqual([
			expect.stringContaining(
				"mcp/server.ts#pilens_health is classified noFindings but reads findings through loadProjectDiagnosticsSnapshot",
			),
		]);
	});

	// #4459 verify r2 plant (e): the read sits in a helper two calls away, and
	// the sibling handler in the same dispatcher stays clean.
	it("RED PROOF: a noFindings MCP handler reading through same-file helpers is flagged", () => {
		const problems = withSyntheticTree(
			{
				"mcp/server.ts": `function findingRows() {
	return getFileDiagnosticSummaries();
}

function healthFindingsLine(): string {
	return String(findingRows().length);
}

async function call(name: string) {
	if (name === "pilens_health") {
		return toolText(healthFindingsLine());
	}
	if (name === "pilens_latency") {
		return toolText("ok");
	}
}
`,
			},
			(root) =>
				noFindingsReadProblems(
					root,
					{},
					{ health: TOOL_CENSUS.health, latency: TOOL_CENSUS.latency },
					{},
				),
		);
		expect(problems).toEqual([
			expect.stringContaining(
				"mcp/server.ts#pilens_health is classified noFindings but reads findings through getFileDiagnosticSummaries",
			),
		]);
	});

	// #4459 verify r2 plant (f).
	it("RED PROOF: a noFindings file that reads the workspace diagnostics cache is flagged", () => {
		const problems = withSyntheticTree(
			{
				"tools/project-report.ts": `import { loadWorkspaceDiagnosticsCache } from "../clients/lsp/workspace-diagnostics-cache.js";
export const report = (cwd: string) => ({ content: [{ type: "text", text: JSON.stringify(loadWorkspaceDiagnosticsCache(cwd)) }] });
`,
			},
			(root) => noFindingsReadProblems(root, SINK_FILES, {}, {}),
		);
		expect(problems).toEqual([
			expect.stringContaining(
				"tools/project-report.ts is classified noFindings but reads findings through loadWorkspaceDiagnosticsCache",
			),
		]);
	});

	// #4459 verify r2 plant (g).
	it("RED PROOF: a NEW file sending findings through the host's user message is unclassified", () => {
		const problems = withSyntheticTree(
			{
				"clients/finding-steer.ts": `export function steer(pi: { sendUserMessage(text: string): void }, rawFindings: string) {
	pi.sendUserMessage(rawFindings);
}
`,
			},
			(root) => censusProblems(root, {}, DELIVERY_SURFACES),
		);
		expect(problems.join("\n")).toContain(
			"clients/finding-steer.ts (host message)",
		);
	});

	it("RED PROOF: a read named only in a comment or a string is no read", () => {
		const problems = withSyntheticTree(
			{
				"tools/project-report.ts": `// never calls loadProjectDiagnosticsSnapshot or lsp.getDiagnostics()
export const hint = "see getFileDiagnosticSummaries";
`,
			},
			(root) => noFindingsReadProblems(root, SINK_FILES, {}, {}),
		);
		expect(problems).toEqual([]);
	});

	it("RED PROOF: a noFindings tool whose MCP handler cannot be found is flagged", () => {
		const problems = withSyntheticTree(
			{ "mcp/server.ts": "export const nothing = 1;\n" },
			(root) =>
				noFindingsReadProblems(root, {}, { health: TOOL_CENSUS.health }, {}),
		);
		expect(problems).toEqual([
			expect.stringContaining('no `if (name === "pilens_health")` handler'),
		]);
	});

	it("RED PROOF: an exemption nothing needs is stale", () => {
		const problems = withSyntheticTree(
			{ "tools/project-report.ts": "export const quiet = 1;\n" },
			(root) =>
				noFindingsReadProblems(
					root,
					SINK_FILES,
					{},
					{
						"tools/project-report.ts::projectScan": "it used to scan",
					},
				),
		);
		expect(problems).toEqual([
			"tools/project-report.ts::projectScan: stale NO_FINDINGS_READ_EXEMPTIONS entry",
		]);
	});
});

// ── Tool census (#1634 criterion 1) ─────────────────────────────────────────
//
// Every tool in TOOL_REGISTRY names the surfaces it renders, or why it renders
// no findings. A new tool has no row and fails.

const TOOL_CENSUS: Record<string, Classification> = {
	ast_grep_search: {
		noFindings: "structural matches for the caller's pattern",
	},
	ast_grep_replace: { noFindings: "the rewrite the caller's pattern produced" },
	ast_grep_outline: { noFindings: "syntax outline, no index or diagnostics" },
	lsp_navigation: {
		delivers: [
			"lsp-navigation:workspace-diagnostics-path",
			"lsp-navigation:tracked-snapshot",
		],
	},
	lens_diagnostics: {
		delivers: [
			"lens-diagnostics:mode-full",
			"lens-diagnostics:mode-all",
			"lens-diagnostics:mode-delta",
			"project-diagnostics:persisted-snapshot",
			"lsp-diagnostics:tool-output",
		],
	},
	lens_diagnostic_mark: {
		noFindings: "confirms the disposition recorded for the finding named",
	},
	symbol_search: { noFindings: "symbol matches for the caller's query" },
	module_report: { noFindings: "module structure, no diagnostics" },
	project_report: { noFindings: "project structure, no diagnostics" },
	read_symbol: { noFindings: "an exact symbol body" },
	read_enclosing: { noFindings: "the exact body enclosing a line" },
	effective_config: { noFindings: "resolved configuration and provenance" },
	pi_lens_activate_tools: { noFindings: "which tools were activated" },
	analyze: { delivers: ["mcp-server:analyze"] },
	health: { noFindings: "runtime health counters" },
	latency: { noFindings: "dispatch timing records" },
	rebuild: { noFindings: "the build command's outcome" },
	project_scan: { delivers: ["lens-engine:project-scan"] },
	session_start: {
		noFindings: "session guidance and the error-debt baseline's status line",
	},
	turn_end: {
		delivers: [
			"runtime-context:persisted-findings",
			...Object.keys(DELIVERY_SURFACES).filter((id) =>
				id.startsWith("runtime-turn:"),
			),
		],
	},
	session_end: { noFindings: "a session-ended acknowledgement" },
};

describe("finding-delivery-gate tool census (#1634)", () => {
	it("classifies exactly the tools in TOOL_REGISTRY", () => {
		expect(Object.keys(TOOL_CENSUS).sort()).toEqual(
			[...LENS_TOOL_NAMES].sort(),
		);
	});

	it("every surface a tool names is registered", () => {
		const unknown = Object.entries(TOOL_CENSUS).flatMap(([tool, c]) =>
			"delivers" in c
				? c.delivers
						.filter((id) => !DELIVERY_SURFACES[id])
						.map((id) => `${tool}: ${id}`)
				: [],
		);
		expect(unknown).toEqual([]);
	});
});

describe("finding-delivery-gate enumeration (#1634)", () => {
	it("registers exactly the surfaces enumerated from the render seams", () => {
		expect(Object.keys(DELIVERY_SURFACES).sort()).toEqual(EXPECTED_SURFACE_IDS);
	});

	it("every registered surface passes the no-bypass validator", () => {
		expect(() => assertNoDeliveryBypass()).not.toThrow();
	});

	it("RED PROOF: a surface with a third mode is rejected, not silently accepted", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			// Deliberately malformed for the red-proof. The @ts-expect-error sits
			// on the offending property, not on the object literal: a formatter
			// that wraps this literal across lines moves the reported error to
			// the `mode` line and turns an object-level directive into TS2578.
			"synthetic:bypass": {
				// @ts-expect-error "bypass" is not a valid delivery mode
				mode: "bypass",
				file: "nowhere.ts",
				description: "x",
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/synthetic:bypass/,
		);
	});

	it("RED PROOF: a gated surface that names zero gates is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:empty-gate": {
				mode: "gated",
				file: "nowhere.ts",
				description: "x",
				gates: [],
				evidence: ["x"],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/synthetic:empty-gate/,
		);
	});

	it("RED PROOF: a gated surface that names zero evidence is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:no-evidence": {
				mode: "gated",
				file: "nowhere.ts",
				description: "x",
				gates: ["someGate"],
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/names no evidence/,
		);
	});

	it("RED PROOF: a labeled surface missing reason/ageSource is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:bare-label": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "",
				ageSource: "",
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/synthetic:bare-label/,
		);
	});

	it("RED PROOF: a non-live labeled surface with no evidence is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:label-no-evidence": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "some reason",
				ageSource: "SomeCache.scannedAt",
				evidence: [],
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/names no evidence/,
		);
	});

	it("RED PROOF: status=partial with no partialReason is rejected", () => {
		const bypassRegistry: Record<string, DeliverySurfaceEntry> = {
			...DELIVERY_SURFACES,
			"synthetic:partial-no-reason": {
				mode: "labeled",
				file: "nowhere.ts",
				description: "x",
				reason: "some reason",
				ageSource: "live",
				evidence: [],
				status: "partial",
			},
		};
		expect(() => assertNoDeliveryBypass(bypassRegistry)).toThrow(
			/status=partial/,
		);
	});
});

// ── Evidence ground-truth (#1634 review F1, R1b, R2) ────────────────────────
//
// For each surface with `evidence.length > 0`, every declared string must
// occur — as a literal substring of the COMMENT-stripped source (STRINGS are
// kept verbatim, unlike the seam scan above, since a surface's evidence is
// often itself a string/template argument like `store: "gitleaks"` or the
// interpolated `${trivyAgeLabel}` fragment) — at least `evidenceMin` times,
// WITHIN THE RIGHT SCOPE:
//
//   - R1b ("valid-tag laundering"): for a `clients/runtime-turn.ts` surface
//     with its own tagged seam(s), the scope is that seam's OWN region
//     (a bounded window around the tag), not the whole file. Checking the
//     whole file let an ungated seam tagged with an EXISTING gated id pass,
//     because that id's real evidence exists somewhere else entirely — this
//     ties the proof to the SPECIFIC seam the tag claims to cover.
//   - R2 ("identity-stub laundering"): for a `gated` surface, an evidence
//     occurrence must sit within a tight line window of a CALL-SHAPED
//     occurrence of one of its declared `gates` (`name(`) — not just the
//     argument literal, which survives swapping the callee for an identity
//     stub while leaving `store: "gitleaks"` untouched.
//
// `lens-diagnostics.ts`'s function-tagged surfaces and the two hand-
// registered surfaces (widget-state footer, agent-nudge) keep a whole-file
// scope: their evidence genuinely lives inside a helper function called from
// (not merely near) the tagged line, and there are only a handful of such
// surfaces, so a file-wide search doesn't have the runtime-turn.ts push-seam
// pattern's "many one-line entries" laundering risk R1b targets.

/** Comments blanked in place, string contents kept: a surface's evidence is
 * often itself a string or template argument. */
function stripCommentsOnly(source: string): string {
	return stripSource(source, { strings: "keep" });
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** 0-based line indexes in `lines` where `needle` occurs. */
function findLineIndexes(lines: string[], needle: string): number[] {
	const out: number[] = [];
	lines.forEach((l, i) => {
		if (l.includes(needle)) out.push(i);
	});
	return out;
}

/**
 * True when some line within `proximity` of `lineIdx` (0-based) contains a
 * call-shaped occurrence of `calleeName` — R2's defense: the evidence
 * ARGUMENT alone (e.g. `store: "gitleaks"`) survives an identity-stubbed
 * callee; requiring the callee within a tight window of that SPECIFIC
 * argument occurrence is what a stub cannot fake without un-stubbing.
 */
function hasNearbyCallSite(
	lines: string[],
	lineIdx: number,
	calleeName: string,
	proximity: number,
): boolean {
	const start = Math.max(0, lineIdx - proximity);
	const end = Math.min(lines.length, lineIdx + proximity + 1);
	for (let i = start; i < end; i++) {
		if (lines[i].includes(`${calleeName}(`)) return true;
	}
	return false;
}

const REGION_BACK_WINDOW = 150;
const REGION_FORWARD_WINDOW = 10;
const CALLEE_PROXIMITY_LINES = 3;
const BINDING_CHAIN_HOPS = 3;

/** Leading identifier of an argument-shaped needle: `gitleaksGate.live,` → `gitleaksGate`. */
function rootIdentifier(text: string): string | undefined {
	return /^[A-Za-z_$][\w$]*/.exec(text.trim())?.[0];
}

/**
 * EVERY `const <ident> = …` line in the file that binds `ident`.
 *
 * #3264 review F1: taking the FIRST match ignores lexical scope, so an outer
 * gate-bound name shadowed by an inner hand-built object laundered through it.
 * Round 2 answered that by rejecting any duplicated name outright, and the
 * verify round found the false negative that creates: a nested function or block
 * may legitimately bind its OWN gate result under the same name, and rejecting
 * that reds code which is correctly gated — the opposite of this detector's
 * contract (#3264 verify F1-A).
 *
 * So the candidates are all returned and `identifierReachesGate` requires EVERY
 * one of them to reach a gate. Whichever binding the use site meant, the arm
 * came from a gate; one ungated candidate and it is laundering again. This is
 * deliberately not resolve-by-brace-depth: a brace walk over
 * `stripCommentsOnly` text counts braces inside string literals too (this
 * file's own fixtures contain them), so it would be a second, fool-able parser
 * deciding a security question.
 */
function bindingLinesOf(lines: string[], ident: string): number[] {
	const re = new RegExp(`\\bconst\\b[^=]*\\b${ident}\\b[^=]*=`);
	const found: number[] = [];
	for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) found.push(i);
	return found;
}

/**
 * Does every declaration of `ident` reach a call-shaped gate, directly through
 * its own initializer or through a bounded chain of aliases?
 */
function identifierReachesGate(
	lines: string[],
	ident: string,
	gates: readonly string[],
	hopsLeft: number,
): boolean {
	if (hopsLeft <= 0) return false;
	const declarations = bindingLinesOf(lines, ident);
	if (declarations.length === 0) return false;
	return declarations.every((declaration) => {
		if (bindingRhsIsGateCall(lines, declaration, gates)) return true;
		const line = lines[declaration];
		const next = rootIdentifier(line.slice(line.indexOf("=") + 1));
		return (
			next !== undefined &&
			identifierReachesGate(lines, next, gates, hopsLeft - 1)
		);
	});
}

/**
 * R2, generalized for a gate call SHARED by several stores (#1892). A surface
 * that renders one ARM of such a call (`gitleaksGate.live,`) cannot be
 * textually adjacent to `gateFindingsByPathFreshness(` — the other stores'
 * sources sit between them. So follow the `const` binding chain from the arm
 * back to the call, at most `BINDING_CHAIN_HOPS` hops.
 *
 * The identity-stub guarantee is unchanged, and that is the point: an arm read
 * bound to anything that is not a call-shaped gate — an identity stub, a
 * hand-built `{ live, stale }` object — still reds. Only the ROUTE from
 * evidence to gate got longer, never the set of things that count as a gate.
 *
 * #3264 review F1 sharpened two halves of that route. A binding is certified by
 * its OWN right-hand side (`bindingRhsIsGateCall`), never by a gate call that
 * merely sits within three lines of it — otherwise a hand-built object declared
 * just below a real gate call inherits its certification. And a name the file
 * declares more than once is certified only when EVERY declaration reaches a
 * gate (`identifierReachesGate`) — otherwise a distant outer binding certifies
 * an inner shadow, while a nested scope that legitimately re-binds its own gate
 * result under the same name is still accepted (#3264 verify F1-A).
 * #3266: proximity only selects a call-shaped gate to inspect; it never
 * certifies an unrelated occurrence before this binding check runs.
 */
function evidenceReachesGateCall(
	lines: string[],
	occurrenceIdx: number,
	needle: string,
	gates: readonly string[],
): boolean {
	const inlineGateResult = (idx: number) =>
		gates.some((gate) => {
			const line = lines[idx] ?? "";
			const callStart = line.indexOf(`${gate}(`);
			const occurrenceStart = line.indexOf(needle);
			if (callStart < 0 || occurrenceStart <= callStart) return false;
			return /\)\s*(?:\?\.|\.)\s*$/.test(
				line.slice(callStart + gate.length + 1, occurrenceStart),
			);
		});
	if (inlineGateResult(occurrenceIdx)) return true;
	const ident = rootIdentifier(needle);
	// #3266: an arm occurrence must use its own binding chain; a nearby gate
	// cannot certify it. Non-identifier evidence is a call-site label rather
	// than an arm read, so retain its existing nearby-call proof.
	if (ident !== undefined) {
		return identifierReachesGate(lines, ident, gates, BINDING_CHAIN_HOPS);
	}
	return gates.some((gate) =>
		hasNearbyCallSite(lines, occurrenceIdx, gate, CALLEE_PROXIMITY_LINES),
	);
}

/**
 * Is the gate call this binding's OWN initializer? Proximity is not enough: a
 * hand-built `{ live, stale }` object declared three lines under a real gate
 * call would otherwise inherit its certification (#3264 review F1's instance).
 * A wrapped assignment (`const { x } =` with the call on the following line) is
 * the one continuation accepted, because that is how the formatter breaks it.
 */
function bindingRhsIsGateCall(
	lines: string[],
	bound: number,
	gates: readonly string[],
): boolean {
	const hasGate = (text: string) =>
		gates.some((gate) => text.includes(`${gate}(`));
	const rhs = lines[bound].slice(lines[bound].indexOf("=") + 1);
	if (hasGate(rhs)) return true;
	if (rhs.trim() !== "") return false;
	for (let i = bound + 1; i < lines.length; i++) {
		if (lines[i].trim() === "") continue;
		return hasGate(lines[i]);
	}
	return false;
}

/** 1-based line numbers in `strippedWholeSource` where `needle` occurs. */
function occurrenceLinesOf(
	strippedWholeSource: string,
	needle: string,
): number[] {
	const out: number[] = [];
	strippedWholeSource.split("\n").forEach((l, i) => {
		if (l.includes(needle)) out.push(i + 1);
	});
	return out;
}

/**
 * Nearest-neighbor, EXCLUSIVE assignment of evidence occurrences to the
 * seams competing for them (#1634 review round R1c — "close-range
 * laundering": a rogue seam placed INSIDE a real gate's lookback window,
 * closer than or comparable to the legitimate seam, used to pass just by
 * existing in the same window as the real evidence — the per-region check
 * asked "is evidence somewhere in MY window", not "is this evidence actually
 * MINE and nobody else's").
 *
 * Only seams tagged with the SAME id compete in one call — a DIFFERENT id's
 * seam legitimately reusing the identical call (e.g. `stale-secrets-tier`
 * reusing `secrets-gitleaks`'s gate) runs its OWN assignment and never
 * competes here, so sharing across ids stays intact.
 *
 * Candidates are (seam, occurrence) pairs within the lookback/lookahead
 * window, sorted by ascending distance; greedy assignment takes the closest
 * pair first and removes both sides from the pool — standard greedy nearest-
 * neighbor matching. A seam left without a claim failed to prove ITS OWN
 * evidence, even when some other (closer) seam of the same id legitimately
 * claimed the one real occurrence — which is exactly the outcome we want
 * when two same-id seams compete for evidence only one of them should have.
 */
function assignNearestExclusive(
	seamLines: number[],
	occurrenceLines: number[],
	back: number,
	forward: number,
	capacity: number,
): Map<number, number> {
	const pairs: Array<{ seamLine: number; occLine: number; dist: number }> = [];
	for (const seamLine of seamLines) {
		for (const occLine of occurrenceLines) {
			if (occLine >= seamLine - back && occLine <= seamLine + forward) {
				pairs.push({ seamLine, occLine, dist: Math.abs(seamLine - occLine) });
			}
		}
	}
	pairs.sort((a, b) => a.dist - b.dist);
	const occClaimCount = new Map<number, number>();
	const claimedSeam = new Set<number>();
	const assignment = new Map<number, number>();
	for (const p of pairs) {
		if (claimedSeam.has(p.seamLine)) continue;
		const used = occClaimCount.get(p.occLine) ?? 0;
		if (used >= capacity) continue;
		occClaimCount.set(p.occLine, used + 1);
		claimedSeam.add(p.seamLine);
		assignment.set(p.seamLine, p.occLine);
	}
	return assignment;
}

/**
 * Checks one `clients/runtime-turn.ts` surface's evidence via exclusive
 * nearest-neighbor assignment against ALL of that file's tagged seams (not
 * just the ones tagged with `id` — every seam is a potential COMPETITOR for
 * an occurrence). Returns problem strings, empty when every seam tagged
 * with `id` claimed every needle.
 */
function checkRuntimeTurnSeamEvidenceExclusive(
	id: string,
	entry: DeliverySurfaceEntry,
	allTaggedSeams: Array<{ seam: SeamHit; ids: string[] }>,
	wholeStrippedLines: string[],
): string[] {
	const problems: string[] = [];
	const seamsForId = allTaggedSeams
		.filter(({ ids }) => ids.includes(id))
		.map(({ seam }) => seam.line);
	if (seamsForId.length === 0) return problems;
	// Per-occurrence claim capacity — see `evidenceMin`'s doc in
	// clients/finding-delivery-gate.ts. Default 1 (one seam per occurrence);
	// a surface with N legitimate seams sharing one upstream call sets
	// evidenceMin: N so all N can claim it without contesting each other.
	const capacity = entry.evidenceMin ?? 1;
	const wholeStripped = wholeStrippedLines.join("\n");
	for (const needle of entry.evidence) {
		const occurrenceLines = occurrenceLinesOf(wholeStripped, needle);
		const assignment = assignNearestExclusive(
			seamsForId,
			occurrenceLines,
			REGION_BACK_WINDOW,
			REGION_FORWARD_WINDOW,
			capacity,
		);
		for (const seamLine of seamsForId) {
			const claimed = assignment.get(seamLine);
			if (claimed === undefined) {
				problems.push(
					`"${id}": the seam at line ${seamLine} could not exclusively claim an occurrence of ` +
						`"${needle}" within ${REGION_BACK_WINDOW}/${REGION_FORWARD_WINDOW} lines — either no ` +
						`occurrence is that close, or a competing seam claimed the nearest one first`,
				);
				continue;
			}
			// R2 applies only to ARGUMENT-shaped evidence (no "(" of its own) —
			// a needle that's already call-shaped (e.g. "applyDeltaFreshnessGate(")
			// is its own callee proof.
			if (entry.mode === "gated" && !needle.includes("(")) {
				const satisfied = evidenceReachesGateCall(
					wholeStrippedLines,
					claimed - 1,
					needle,
					entry.gates,
				);
				if (!satisfied) {
					problems.push(
						`"${id}": the occurrence of "${needle}" claimed by the seam at line ${seamLine} ` +
							`(line ${claimed}) is not within ${CALLEE_PROXIMITY_LINES} lines of a call-shaped ` +
							`${entry.gates.join("/")}( — possible identity-stub`,
					);
				}
			}
		}
	}
	return problems;
}

/**
 * Whole-file evidence check for surfaces with no push/function seam scan of
 * their own (`widget-state.ts`, `agent-nudge.ts`) and for the
 * `tools/lens-diagnostics.ts` function-tagged surfaces, where the evidence
 * genuinely lives inside a HELPER function called from the tagged line, not
 * necessarily near it — see the module doc above for why those keep a
 * whole-file scope instead of R1c's seam-exclusive assignment.
 */
function checkEvidenceInScope(
	id: string,
	entry: DeliverySurfaceEntry,
	scopeRawLines: string[],
	scopeLabel: string,
): string[] {
	const problems: string[] = [];
	const scopeStripped = stripCommentsOnly(scopeRawLines.join("\n"));
	const scopeStrippedLines = scopeStripped.split("\n");
	const min = entry.evidenceMin ?? 1;
	for (const needle of entry.evidence) {
		const count = countOccurrences(scopeStripped, needle);
		if (count < min) {
			problems.push(
				`"${id}": expected ${scopeLabel} to contain "${needle}" at least ${min}x (comment-stripped), found ${count}`,
			);
			continue;
		}
		if (entry.mode === "gated" && !needle.includes("(")) {
			const occurrenceLines = findLineIndexes(scopeStrippedLines, needle);
			const satisfied = occurrenceLines.some((lineIdx) =>
				entry.gates.some((gate) =>
					hasNearbyCallSite(
						scopeStrippedLines,
						lineIdx,
						gate,
						CALLEE_PROXIMITY_LINES,
					),
				),
			);
			if (!satisfied) {
				problems.push(
					`"${id}": expected "${needle}" to sit within ${CALLEE_PROXIMITY_LINES} lines of ` +
						`a call-shaped ${entry.gates.join("/")}( in ${scopeLabel} — found the argument ` +
						`but not the callee (possible identity-stub)`,
				);
			}
		}
	}
	return problems;
}

describe("finding-delivery-gate evidence ground-truth (#1634 review F1/R1b/R1c/R2)", () => {
	const runtimeTurnRaw = source("clients/runtime-turn.ts");
	const runtimeTurnStrippedLines =
		stripCommentsOnly(runtimeTurnRaw).split("\n");
	const allRuntimeTurnSeams = scanTaggedSeams(
		runtimeTurnRaw,
		RUNTIME_TURN_SEAM_PATTERN,
	);

	for (const [id, entry] of Object.entries(DELIVERY_SURFACES)) {
		if (entry.evidence.length === 0) continue;
		const isRuntimeTurn = entry.file === "clients/runtime-turn.ts";

		it(
			isRuntimeTurn
				? `"${id}" evidence is exclusively claimed by its own tagged seam(s) (R1b/R1c/R2)`
				: `"${id}" evidence is present in ${entry.file} (comments stripped)`,
			() => {
				const problems = isRuntimeTurn
					? checkRuntimeTurnSeamEvidenceExclusive(
							id,
							entry,
							allRuntimeTurnSeams,
							runtimeTurnStrippedLines,
						)
					: checkEvidenceInScope(
							id,
							entry,
							source(entry.file).split("\n"),
							entry.file,
						);
				expect(problems, problems.join("\n")).toEqual([]);
			},
		);
	}

	// Explicit, named proof that exclusivity is scoped PER ID, not global —
	// two DIFFERENT ids legitimately sharing the SAME gate call (the render
	// for `stale-secrets-tier` reuses `secrets-gitleaks`'s/`secrets-trivy`'s
	// gate output) must BOTH still pass; they are never competitors of each
	// other since each runs its own `assignNearestExclusive` call.
	it("shared-gate surfaces (secrets-gitleaks + stale-secrets-tier) both pass — exclusivity does not cross ids", () => {
		const gitleaksProblems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			allRuntimeTurnSeams,
			runtimeTurnStrippedLines,
		);
		const trivyProblems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-trivy",
			DELIVERY_SURFACES["runtime-turn:secrets-trivy"],
			allRuntimeTurnSeams,
			runtimeTurnStrippedLines,
		);
		const staleTierProblems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:stale-secrets-tier",
			DELIVERY_SURFACES["runtime-turn:stale-secrets-tier"],
			allRuntimeTurnSeams,
			runtimeTurnStrippedLines,
		);
		expect(gitleaksProblems, gitleaksProblems.join("\n")).toEqual([]);
		expect(trivyProblems, trivyProblems.join("\n")).toEqual([]);
		expect(staleTierProblems, staleTierProblems.join("\n")).toEqual([]);
	});

	// RED PROOF (F1): the reviewer's exact stub — the real evidence-bearing
	// code is gone, but a DOC COMMENT still mentions the gate's name with an
	// open paren, e.g. "the code calls gateFindingsByPathFreshness(...) here".
	// Against a fixture: strip-then-search must NOT find it.
	it("RED PROOF: a stub that removes the real call but keeps a comment mention is caught", () => {
		const stubbedFixture = `
// this surface used to call formatCacheAgeLabel(scannedAt) but no longer does
const trivyAgeLabel = "";
let report = "CRITICAL dependency CVEs (trivy). Upgrade before shipping:\\n";
`;
		const strippedFixture = stripCommentsOnly(stubbedFixture);
		const evidence = "CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}";
		expect(countOccurrences(strippedFixture, evidence)).toBe(0);
	});

	it("control: the SAME evidence string is found once real interpolation is present", () => {
		const fixedFixture = `
const trivyAgeLabel = formatCacheAgeLabel(scannedAt);
let report = \`CRITICAL dependency CVEs (trivy, \${trivyAgeLabel}). Upgrade before shipping:\\n\`;
`;
		const strippedFixture = stripCommentsOnly(fixedFixture);
		const evidence = "CRITICAL dependency CVEs (trivy, ${trivyAgeLabel}";
		expect(countOccurrences(strippedFixture, evidence)).toBeGreaterThanOrEqual(
			1,
		);
	});

	// RED PROOF (R1b, far case): an ungated seam tagged with a real id, FAR
	// (beyond the lookback window) from that id's real evidence, must still
	// be caught — no candidate pair exists at all.
	it("RED PROOF (far): a rogue seam tagged with a real id, beyond the lookback window, is caught", () => {
		const filler = Array.from(
			{ length: REGION_BACK_WINDOW + 20 },
			(_, i) => `// filler ${i}`,
		);
		const rogueLines = [
			"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			...filler,
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("a rogue finding wearing a real tag, far away");',
		];
		const rogueSource = rogueLines.join("\n");
		const strippedLines = stripCommentsOnly(rogueSource).split("\n");
		const seams = scanTaggedSeams(rogueSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain("could not exclusively claim");
	});

	// RED PROOF (R1c, NEAR case — review round R1c's actual finding): a rogue
	// seam placed INSIDE the lookback window, closer to the real evidence
	// than the legitimate seam is, must still be caught — the per-region
	// check (round 3's shipped fix) passed this exact shape, because both the
	// rogue seam's OWN window and the real seam's OWN window each
	// independently contained the one real occurrence. Exclusive assignment
	// gives the occurrence to whichever seam is closer and leaves the OTHER
	// seam — real or rogue — unsatisfied, so the overall check still reds
	// whenever two same-id seams compete for one occurrence.
	it("RED PROOF (near): a rogue seam placed CLOSER than the real seam to the same evidence is caught", () => {
		const realGateLines = [
			"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
		];
		const spacer = (n: number) =>
			Array.from({ length: n }, (_, i) => `// spacer ${i}`);
		const rogueLines = [
			...realGateLines,
			...spacer(69), // rogue sits 69 lines from the real gate — inside the window
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("a rogue finding, CLOSER to the real gate than the legit seam");',
			...spacer(29), // the "legitimate" seam sits further still (98 lines total)
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("the finding that would have been the real one");',
		];
		const rogueSource = rogueLines.join("\n");
		const strippedLines = stripCommentsOnly(rogueSource).split("\n");
		const seams = scanTaggedSeams(rogueSource, RUNTIME_TURN_SEAM_PATTERN);
		expect(seams.length).toBe(2); // sanity: both seams parsed and tagged
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		// Exactly one of the two same-id seams wins the single real occurrence;
		// the other is left unsatisfied — the check must red either way.
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toContain("could not exclusively claim");
	});

	// RED PROOF (R2): "identity-stub laundering" — the reviewer's exact
	// mutant: keep `store: "gitleaks"` (the argument) but replace the callee
	// `gateFindingsByPathFreshness` with an identity stub. The argument
	// literal alone must NOT satisfy a `gated` surface's evidence.
	it("RED PROOF: identity-stubbing the callee while keeping the argument literal is caught", () => {
		const stubbedSource = [
			"function identityStub(x) { return x; }",
			"const scannerGates = identityStub({ sources: {} });",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const strippedLines = stripCommentsOnly(stubbedSource).split("\n");
		const seams = scanTaggedSeams(stubbedSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	// RED PROOF (#1892): the binding chain must not become a laundering route.
	// The recurrence it prevents: the scanner lanes now render ARMS of one
	// shared gate call, so evidence like `gitleaksGate.live,` is several hops
	// from `gateFindingsByPathFreshness(`. A surface that hand-builds the same
	// arm shape and skips the gate entirely — exactly what a future edit
	// "simplifying" the fold would produce — must still red.
	it("RED PROOF: an arm read bound to a hand-built object, never to the gate, is caught", () => {
		const ungatedSource = [
			"const scannerGates = { gitleaks: { live: rawFindings, stale: [] } };",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const strippedLines = stripCommentsOnly(ungatedSource).split("\n");
		const seams = scanTaggedSeams(ungatedSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	// RED PROOF (#3266): proximity is evidence for which call to inspect, not
	// certification. A no-spacer hand-built shadow beside an unrelated gate
	// must not inherit that call's identity.
	it("RED PROOF (#3266): a no-spacer hand-built arm cannot borrow a nearby gate", () => {
		const shadowedSource = [
			"const unrelatedGate = gateFindingsByPathFreshness({ sources: {} });",
			"const gitleaksGate = { live: rawFindings, stale: [] };",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(shadowedSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(shadowedSource).split("\n"),
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	it("control (#3266): an arm near its own gate call remains accepted", () => {
		const ownGateSource = [
			"const gitleaksGate = gateFindingsByPathFreshness({ sources: {} });",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(ownGateSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(ownGateSource).split("\n"),
		);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	// RED PROOF (#3264 review F1): the binding chain must resolve the identifier
	// the USE SITE means, not the first one in the file. An outer gate-bound name
	// shadowed by an inner hand-built object used to launder: the detector
	// resolved the inner `outerArms` to the outer gate call and accepted an arm
	// that never passed through a gate.
	it("RED PROOF: a shadowed hand-built arm does not launder through an outer gate binding", () => {
		const shadowedSource = [
			"const outerArms = gateFindingsByPathFreshness({ sources: {} });",
			"{",
			"  const outerArms = { gitleaks: { live: raw, stale: [] } };",
			"  const gitleaksGate = outerArms.gitleaks;",
			"  const keptLive = filterFindingsByDisposition(",
			"    gitleaksGate,",
			"  );",
			"  // @delivery-surface: runtime-turn:secrets-gitleaks",
			'  advisoryParts.push("finding");',
			"}",
		].join("\n");
		const strippedLines = stripCommentsOnly(shadowedSource).split("\n");
		const seams = scanTaggedSeams(shadowedSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	// RED PROOF (#3264 review F1, distant case): the shadow does not have to be
	// near the real gate call. Reject-on-ambiguity is what catches this one —
	// `bindingRhsIsGateCall` alone would happily certify the outer binding.
	it("RED PROOF: a shadow far from the real gate call does not launder either", () => {
		const spacer = Array.from({ length: 40 }, (_, i) => `// spacer ${i}`);
		const shadowedSource = [
			"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
			...spacer,
			"const scannerGates = { gitleaks: { live: raw, stale: [] } };",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(shadowedSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(shadowedSource).split("\n"),
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	const spacer = (n: number) =>
		Array.from({ length: n }, (_, i) => `  // shadow spacer ${i}`);

	// #3264 verify F1-A: reject-on-ambiguity must not red code that IS gated.
	// A nested function, or a block, may legitimately bind its own gate result
	// under the same name as an outer one — both initializers are gate calls, so
	// whichever binding the use site means, the arm came from a gate.
	it("control: a same-name shadow whose every declaration is a gate call is accepted", () => {
		// The spacers are load-bearing: without them the arm read sits within
		// `CALLEE_PROXIMITY_LINES` of the INNER gate call and the occurrence-level
		// check accepts it before the binding chain is ever consulted, so the
		// fixture would pass for a reason that has nothing to do with F1-A.
		const shadowedGateSource = (open: string) =>
			[
				"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
				open,
				"  const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
				...spacer(10),
				"  const gitleaksGate = scannerGates.gitleaks;",
				...spacer(10),
				"  const keptLive = filterFindingsByDisposition(",
				"    gitleaksGate,",
				"  );",
				"  // @delivery-surface: runtime-turn:secrets-gitleaks",
				'  advisoryParts.push("finding");',
				"}",
			].join("\n");
		const nestedFunction = shadowedGateSource("function nested() {");
		const nestedBlock = shadowedGateSource("{");
		for (const source of [nestedFunction, nestedBlock]) {
			const problems = checkRuntimeTurnSeamEvidenceExclusive(
				"runtime-turn:secrets-gitleaks",
				DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
				scanTaggedSeams(source, RUNTIME_TURN_SEAM_PATTERN),
				stripCommentsOnly(source).split("\n"),
			);
			expect(problems, problems.join("\n")).toEqual([]);
		}
	});

	// The other half of F1-A's refinement: "every declaration is a gate call" is
	// the accepting condition, so a duplicate where ONE declaration is
	// hand-built is still laundering — the detector cannot tell which binding
	// the use site meant, and one of the candidates never saw a gate.
	it("RED PROOF: a duplicated name is rejected when any one declaration is not gated", () => {
		const mixedSource = [
			"const scannerGates = gateFindingsByPathFreshness({ sources: {} });",
			"function nested() {",
			"  const scannerGates = { gitleaks: { live: raw, stale: [] } };",
			...spacer(10),
			"  const gitleaksGate = scannerGates.gitleaks;",
			...spacer(10),
			"  const keptLive = filterFindingsByDisposition(",
			"    gitleaksGate,",
			"  );",
			"  // @delivery-surface: runtime-turn:secrets-gitleaks",
			'  advisoryParts.push("finding");',
			"}",
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(mixedSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(mixedSource).split("\n"),
		);
		expect(problems.length).toBeGreaterThan(0);
		expect(problems[0]).toMatch(/possible identity-stub/);
	});

	it("control: a two-hop alias and a destructuring rename both still resolve to the gate", () => {
		const aliasSource = [
			"const scannerGates = gateFindingsByPathFreshness({",
			"  cwd,",
			"  sources: { gitleaks: { findings: [] } },",
			"});",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const renameSource = [
			"const { gitleaks: gitleaksGate } = gateFindingsByPathFreshness({",
			"  cwd,",
			"  sources: { gitleaks: { findings: [] } },",
			"});",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		for (const source of [aliasSource, renameSource]) {
			const problems = checkRuntimeTurnSeamEvidenceExclusive(
				"runtime-turn:secrets-gitleaks",
				DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
				scanTaggedSeams(source, RUNTIME_TURN_SEAM_PATTERN),
				stripCommentsOnly(source).split("\n"),
			);
			expect(problems, problems.join("\n")).toEqual([]);
		}
	});

	it("RED PROOF (#3266): a cyclic alias terminates and is rejected", () => {
		const cyclicSource = [
			"const gitleaksGate = scannerGates;",
			"const scannerGates = gitleaksGate;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(cyclicSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(cyclicSource).split("\n"),
		);
		expect(problems.length).toBeGreaterThan(0);
	});

	it("control (#3266): an inline gate result on the same line is accepted", () => {
		const inlineSource = [
			"const keptLive = filterFindingsByDisposition(gateFindingsByPathFreshness({}).gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			scanTaggedSeams(inlineSource, RUNTIME_TURN_SEAM_PATTERN),
			stripCommentsOnly(inlineSource).split("\n"),
		);
		expect(problems, problems.join("\n")).toEqual([]);
	});

	it("control: the real (un-stubbed) call site satisfies both the argument and the callee-proximity check", () => {
		const realSource = [
			"const scannerGates = gateFindingsByPathFreshness({",
			"  cwd,",
			"  sources: { gitleaks: { findings: [] } },",
			"});",
			"const gitleaksGate = scannerGates.gitleaks;",
			"const keptLive = filterFindingsByDisposition(",
			"  gitleaksGate,",
			");",
			"// @delivery-surface: runtime-turn:secrets-gitleaks",
			'advisoryParts.push("finding");',
		].join("\n");
		const strippedLines = stripCommentsOnly(realSource).split("\n");
		const seams = scanTaggedSeams(realSource, RUNTIME_TURN_SEAM_PATTERN);
		const problems = checkRuntimeTurnSeamEvidenceExclusive(
			"runtime-turn:secrets-gitleaks",
			DELIVERY_SURFACES["runtime-turn:secrets-gitleaks"],
			seams,
			strippedLines,
		);
		expect(problems).toEqual([]);
	});
});

describe("formatCacheAgeLabel (#1634)", () => {
	it("renders a whole-minute age for a recent scan", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 7, 12, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 12m ago");
	});

	it("renders an exact-hour age past 60 minutes", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 4, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 7, 0, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 3h ago");
	});

	// F5: a naive Math.round(minutes / 60) reported "1h" at 89 minutes.
	it("does not round UP to the next hour before the hour is complete (F5)", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 8, 29, 0); // 89 minutes later
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned 1h 29m ago");
	});

	it("degrades to an honest unknown label on an empty/unparseable timestamp", () => {
		expect(formatCacheAgeLabel("")).toBe("scan age unknown");
		expect(formatCacheAgeLabel(undefined)).toBe("scan age unknown");
		expect(formatCacheAgeLabel("not-a-date")).toBe("scan age unknown");
	});

	it("never reports a negative age on clock skew", () => {
		const scannedAt = new Date(Date.UTC(2026, 7, 18, 7, 0, 0)).toISOString();
		const now = Date.UTC(2026, 7, 18, 6, 59, 0);
		expect(formatCacheAgeLabel(scannedAt, now)).toBe("scanned <1m ago");
	});
});
