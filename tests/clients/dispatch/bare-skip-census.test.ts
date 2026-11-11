/**
 * #5258: a runner's skip states why. This census admits a short list of
 * known-good forms for a `RunnerResult`-shaped literal under `clients/dispatch/`
 * and refuses everything else.
 *
 * Recurrence prevented: the 2026-11-08 tool-alignment audit found 119 bare
 * `skipped` returns (`{ status: "skipped", diagnostics: [], semantic: "none" }`)
 * across the runners. The coverage notice could word each only as "a language
 * tool is missing, timed out, or failed to run", so a runner that needed a
 * config the project lacks read as a missing tool. This census keeps the count
 * that was folded folded, and pins the rest by name.
 *
 * STATE TABLE (written before the detector). An object literal under
 * `clients/dispatch/` is JUDGED when it has a `status` key, or a computed key
 * beside a `diagnostics` key or a spread. A judged literal is
 *
 * | form                                                              | read as  |
 * | ----------------------------------------------------------------- | -------- |
 * | has a `diagnosticCount` key (a `RunnerLatency` row)               | admitted |
 * | `status` is "succeeded", "failed" or "deferred"                   | admitted |
 * |   (or a ternary whose every arm is one)                           |          |
 * | `status` is "skipped" (or a ternary arm) and the literal holds    | admitted |
 * |   `skipReason` set to a literal in RUNNER_SKIP_REASONS, or        |          |
 * |   `skipFault` set to a literal fault                              |          |
 * | `status` is any other string literal (a different type)           | unjudged |
 * | everything else: "skipped" with no stated reason, a reason that   | HIT      |
 * |   is `undefined`, a variable or an unlisted string, a status that |          |
 * |   is an alias, a concatenation, another binding, a spread's field |          |
 * |   or a computed key                                               |          |
 *
 * Every HIT must be an exemption below with its reason; an exemption the scan
 * no longer flags is stale and reds, so the list only shrinks.
 */
import * as path from "node:path";
import { Lang, parse, type SgNode } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { RUNNER_SKIP_REASONS } from "../../../clients/dispatch/types.js";
import { censusSourceFiles } from "../../support/ast-census.js";
import {
	auditRegistry,
	readWalkedFile,
	relativePosix,
	stableOccurrenceKey,
} from "../../support/sweep-kit.js";

const REPO = path.resolve(import.meta.dirname, "../../..");
const SKIP_FAULTS: readonly string[] = [
	"did-not-run",
	"rejected-invocation",
	"report-missing",
];
const NON_SKIP: readonly string[] = ["succeeded", "failed", "deferred"];

interface Hit {
	/** 0-based line of the `status` entry (or of the literal's first line). */
	lineIndex: number;
	why: string;
}

/** The string a literal node spells, or undefined when it is not a plain one. */
function literalOf(node: SgNode | null): string | undefined {
	if (!node) return undefined;
	switch (node.kind()) {
		case "string":
			return node.text().slice(1, -1);
		case "template_string":
			return node.text().includes("${") ? undefined : node.text().slice(1, -1);
		case "as_expression":
		case "parenthesized_expression":
		case "satisfies_expression":
			return literalOf(
				node.children()[node.kind() === "parenthesized_expression" ? 1 : 0] ??
					null,
			);
		default:
			return undefined;
	}
}

/** Every literal a status expression can spell, or undefined when any arm is not a literal. */
function statusArms(node: SgNode | null): string[] | undefined {
	if (!node) return undefined;
	if (node.kind() === "ternary_expression") {
		const arms = [node.field("consequence"), node.field("alternative")].map(
			(arm) => statusArms(arm),
		);
		return arms.every((arm) => arm !== undefined)
			? arms.flatMap((arm) => arm ?? [])
			: undefined;
	}
	const literal = literalOf(node);
	return literal === undefined ? undefined : [literal];
}

interface Entries {
	values: Map<string, SgNode | null>;
	unresolvedKeys: number;
	spreads: number;
}

function entriesOf(obj: SgNode): Entries {
	const entries: Entries = {
		values: new Map(),
		unresolvedKeys: 0,
		spreads: 0,
	};
	for (const child of obj.children()) {
		switch (child.kind()) {
			case "spread_element":
				entries.spreads += 1;
				break;
			case "shorthand_property_identifier":
				entries.values.set(child.text(), null);
				break;
			case "pair": {
				const key = child.field("key");
				const name = key
					? key.kind() === "computed_property_name"
						? literalOf(key.children()[1] ?? null)
						: key.kind() === "string"
							? literalOf(key)
							: key.text()
					: undefined;
				if (name === undefined) entries.unresolvedKeys += 1;
				else entries.values.set(name, child.field("value"));
				break;
			}
			default:
				break;
		}
	}
	return entries;
}

function statesReason(entries: Entries): boolean {
	const reason = literalOf(entries.values.get("skipReason") ?? null);
	const fault = literalOf(entries.values.get("skipFault") ?? null);
	return (
		(reason !== undefined &&
			(RUNNER_SKIP_REASONS as readonly string[]).includes(reason)) ||
		(fault !== undefined && SKIP_FAULTS.includes(fault))
	);
}

/** The judged literals of one source text that are not admitted. */
export function bareSkipHits(source: string): Hit[] {
	const hits: Hit[] = [];
	for (const obj of parse(Lang.TypeScript, source)
		.root()
		.findAll({ rule: { kind: "object" } })) {
		const entries = entriesOf(obj);
		if (entries.values.has("diagnosticCount")) continue;
		const hasStatus = entries.values.has("status");
		const shaped = entries.values.has("diagnostics") || entries.spreads > 0;
		if (!hasStatus && !(entries.unresolvedKeys > 0 && shaped)) continue;
		const line = obj.range().start.line;
		if (!hasStatus) {
			hits.push({ lineIndex: line, why: "a status behind a computed key" });
			continue;
		}
		const arms = statusArms(entries.values.get("status") ?? null);
		if (arms === undefined) {
			// A status that is not a literal can only be judged by reading it:
			// refuse it where the literal is RunnerResult-shaped.
			if (shaped || entries.values.has("semantic"))
				hits.push({ lineIndex: line, why: "a status that is not a literal" });
			continue;
		}
		if (arms.every((arm) => NON_SKIP.includes(arm))) continue;
		if (!arms.includes("skipped")) continue;
		if (!statesReason(entries))
			hits.push({ lineIndex: line, why: "a skip that states no reason" });
	}
	return hits;
}

const ROOT = path.join(REPO, "clients", "dispatch");

/**
 * The named remainder of #5258, by `stableOccurrenceKey` (`~n` is the nth
 * occurrence of an identical line under one symbol). Each group stays bare for
 * one reason: the reason it needs is a verdict decision of its own
 * (`reachedNoVerdict`: a bare skip reads no verdict, and a stated reason can
 * flip that), not a tool-absent or config-absent cause.
 */
const DROPPED =
	"collect-later run dropped by a session reset: no tool was missing; its reason is a session-lifecycle decision";
const COOLDOWN =
	"spawn-timeout cooldown skip: the runner-spawn-timeout-cooldown record states the cause once; a reason is a failure-kind decision";
const ASTGREP =
	"ast-grep napi guards (unhandled language, addon not loaded, missing file, no grammar, size cap, edit-scope gates): an engine or cap reason that is a verdict decision";
const DOTNET =
	"no project or solution file found to build: nothing to check is a verdict decision, not a missing tool";
const SHARED =
	"shared SKIPPED constant (no chart found, chart outside the workspace): an applicability verdict decision, not a missing tool";
const JAVAC =
	"file inside a Maven/Gradle project: a categorical not-this-tool skip whose verdict reading needs its own decision";
const LSP =
	"language-server runner skips (--no-lsp, no content, over the sync limits, server unstarted, stale answer, or a reason stated through a conditional spread): the coverage notice reads primaryUnavailableCause and the verdict rules own them";
const PS =
	"a durably blocked PowerShell -File execution (execution policy): the interpreter latch, not a missing tool; a reason is a failure-kind decision";
const CLIPPY =
	"cargo/clippy skips (availability probe still cooling down, no Cargo.toml marker): transient and project-shape causes that need their own reasons";
const SPOT =
	"no compiled .class files to analyze: nothing to check is a verdict decision, not a missing tool";
const TRIVY =
	"trivy-config reads no manifest here (unreadable file, not a Kubernetes/CloudFormation manifest): an applicability verdict decision";
const TS_LOG =
	"a tree-sitter phase log row (`logTreeSitter`), not a RunnerResult; the census sees its status literal";
const TS_RUN =
	"tree-sitter engine skips (client or grammar unavailable, WASM aborted, query error): an engine reason that is a verdict decision";
const CTOR =
	"the constructor itself (`faultSkip`, `skipped`): its reason is a typed parameter, so the literal cannot be checked here";
const EXEMPT: Record<string, string> = {
	"clients/dispatch/collect-later-tier.ts#flights:af64528f": DROPPED,
	"clients/dispatch/dispatcher.ts#runRunner:564bfb9e": COOLDOWN,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:564bfb9e":
		ASTGREP,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:9a01c98c":
		ASTGREP,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:564bfb9e~2":
		ASTGREP,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:564bfb9e~3":
		ASTGREP,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:564bfb9e~4":
		ASTGREP,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:564bfb9e~5":
		ASTGREP,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:564bfb9e~6":
		ASTGREP,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:564bfb9e~7":
		ASTGREP,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:564bfb9e~8":
		ASTGREP,
	"clients/dispatch/runners/ast-grep-napi.ts#astGrepNapiRunner:564bfb9e~9":
		ASTGREP,
	"clients/dispatch/runners/dotnet-build.ts#dotnetBuildRunner:564bfb9e": DOTNET,
	"clients/dispatch/runners/helm-lint.ts#MAX_HELM_LINT_OUTPUT_BYTES:ebaa0dd5":
		SHARED,
	"clients/dispatch/runners/helm-render.ts#MAX_RENDER_OUTPUT_BYTES:ebaa0dd5":
		SHARED,
	"clients/dispatch/runners/javac.ts#javacRunner:564bfb9e": JAVAC,
	"clients/dispatch/runners/lsp.ts#lspRunner:564bfb9e": LSP,
	"clients/dispatch/runners/lsp.ts#lspRunner:9a01c98c": LSP,
	"clients/dispatch/runners/lsp.ts#lspRunner:564bfb9e~2": LSP,
	"clients/dispatch/runners/lsp.ts#lspRunner:564bfb9e~3": LSP,
	"clients/dispatch/runners/lsp.ts#lspRunner:9a01c98c~2": LSP,
	"clients/dispatch/runners/lsp.ts#lspRunner:9a01c98c~3": LSP,
	"clients/dispatch/runners/lsp.ts#lspRunner:9a01c98c~4": LSP,
	"clients/dispatch/runners/lsp.ts#lspRunner:9a01c98c~5": LSP,
	"clients/dispatch/runners/psscriptanalyzer.ts#psScriptAnalyzerRunner:564bfb9e":
		PS,
	"clients/dispatch/runners/rust-clippy.ts#rustClippyRunner:564bfb9e": CLIPPY,
	"clients/dispatch/runners/rust-clippy.ts#rustClippyRunner:564bfb9e~2": CLIPPY,
	"clients/dispatch/runners/spotbugs.ts#spotbugsRunner:564bfb9e": SPOT,
	"clients/dispatch/runners/tree-sitter.ts#treeSitterRunner:d1c20e83": TS_LOG,
	"clients/dispatch/runners/tree-sitter.ts#treeSitterRunner:564bfb9e": TS_RUN,
	"clients/dispatch/runners/tree-sitter.ts#treeSitterRunner:d1c20e83~2": TS_LOG,
	"clients/dispatch/runners/tree-sitter.ts#treeSitterRunner:564bfb9e~2": TS_RUN,
	"clients/dispatch/runners/tree-sitter.ts#treeSitterRunner:d1c20e83~3": TS_LOG,
	"clients/dispatch/runners/tree-sitter.ts#treeSitterRunner:564bfb9e~3": TS_RUN,
	"clients/dispatch/runners/tree-sitter.ts#treeSitterRunner:d1c20e83~4": TS_LOG,
	"clients/dispatch/runners/tree-sitter.ts#treeSitterRunner:9a01c98c": TS_RUN,
	"clients/dispatch/runners/trivy-config.ts#trivyConfigRunner:564bfb9e": TRIVY,
	"clients/dispatch/runners/trivy-config.ts#trivyConfigRunner:564bfb9e~2":
		TRIVY,
	"clients/dispatch/types.ts#faultSkip:9a01c98c": CTOR,
	"clients/dispatch/types.ts#skipped:9a01c98c": CTOR,
};

function liveHits(): Array<{ key: string; detail: string }> {
	const out: Array<{ key: string; detail: string }> = [];
	for (const file of censusSourceFiles([ROOT], { skipTests: true })) {
		const source = readWalkedFile(file);
		if (source === undefined) continue;
		const lines = source.split("\n");
		const relPath = relativePosix(REPO, file);
		const seen = new Map<string, number>();
		for (const hit of bareSkipHits(source)) {
			const base = stableOccurrenceKey(relPath, lines, hit.lineIndex);
			const ordinal = (seen.get(base) ?? 0) + 1;
			seen.set(base, ordinal);
			out.push({
				key: ordinal === 1 ? base : `${base}~${ordinal}`,
				detail: `${relPath}:${hit.lineIndex + 1} ${hit.why}`,
			});
		}
	}
	return out;
}

describe("a runner's skip states why (#5258)", () => {
	it("admits only stated skips under clients/dispatch, except the named remainder", () => {
		const files = censusSourceFiles([ROOT], { skipTests: true });
		const audit = auditRegistry({
			sweepName: "bare-skip census",
			flagged: liveHits(),
			registered: [],
			exemptions: EXEMPT,
			minFlagged: 0,
			scannedCount: files.length,
			minScanned: 50,
			remediation:
				"give the skip a reason: `skipped(reason)`, `toolAbsentSkip()` or `faultSkip(fault)` (clients/dispatch/types.ts); a new reason also needs SKIP_REASON_PHRASE and, if it is a verdict, VERDICT_SKIP_REASONS",
		});
		expect(audit.problems).toEqual([]);
	});

	describe("plants (spellings the census author did not design for)", () => {
		const wrap = (literal: string) => `export const r = ${literal};\n`;
		it.each([
			[
				"a double-quoted bare skip",
				`{ status: "skipped", diagnostics: [], semantic: "none" }`,
			],
			[
				"a single-quoted bare skip",
				`{ status: 'skipped', diagnostics: [], semantic: 'none' }`,
			],
			[
				"a template-literal bare skip",
				"{ status: `skipped`, diagnostics: [], semantic: 'none' }",
			],
			["a quoted status key", `{ "status": "skipped", diagnostics: [] }`],
			["a computed status key", `{ ["status"]: "skipped", diagnostics: [] }`],
			["a partial literal merged elsewhere", `{ status: "skipped" }`],
			[
				"an undefined reason",
				`{ status: "skipped", diagnostics: [], skipReason: undefined }`,
			],
			[
				"a variable reason",
				`{ status: "skipped", diagnostics: [], skipReason: reason }`,
			],
			[
				"a reason outside the taxonomy",
				`{ status: "skipped", diagnostics: [], skipReason: "bogus" }`,
			],
			[
				"a fault outside the list",
				`{ status: "skipped", diagnostics: [], skipFault: "bogus" }`,
			],
			[
				"a ternary with a skipped arm",
				`{ status: ok ? "succeeded" : "skipped", diagnostics: [] }`,
			],
		])("refuses %s", (_name, literal) => {
			expect(bareSkipHits(wrap(literal))).toHaveLength(1);
		});

		it("refuses an alias", () => {
			expect(
				bareSkipHits(
					`const S = "skipped";\nexport const r = { status: S, diagnostics: [], semantic: "none" };\n`,
				),
			).toHaveLength(1);
		});

		it("refuses a status built by concatenation beside a spread", () => {
			expect(
				bareSkipHits(
					`const base = { diagnostics: [], semantic: "none" };\nexport const r = { ...base, status: "skipp" + "ed" };\n`,
				),
			).toHaveLength(1);
		});

		it("refuses a status reached through another binding", () => {
			expect(
				bareSkipHits(
					`const prior = run();\nexport const r = { status: prior.status, diagnostics: [], semantic: "none" };\n`,
				),
			).toHaveLength(1);
		});

		it("refuses a status behind a computed key it cannot resolve", () => {
			expect(
				bareSkipHits(
					`const k = "status";\nexport const r = { [k]: "skipped", diagnostics: [] };\n`,
				),
			).toHaveLength(1);
		});

		it.each([
			[
				"a stated reason",
				`{ status: "skipped", diagnostics: [], semantic: "none", skipReason: "not-installed" }`,
			],
			[
				"a reason with as const",
				`{ status: "skipped", diagnostics: [], skipReason: "no-files-matched" as const }`,
			],
			[
				"a stated fault",
				`{ status: "skipped", diagnostics: [], skipFault: "did-not-run" }`,
			],
			[
				"a spread with a stated reason",
				`{ ...BASE, status: "skipped", skipReason: "not-enabled" }`,
			],
			[
				"a succeeded run",
				`{ status: "succeeded", diagnostics: [], semantic: "none" }`,
			],
			[
				"a failed or deferred ternary",
				`{ status: hasBlocking ? "failed" : "deferred", diagnostics: [] }`,
			],
			[
				"a latency row",
				`{ runnerId: "x", status: "skipped", diagnosticCount: 0 }`,
			],
			["a different type's status", `{ status: "ok", count: 1 }`],
		])("admits %s", (_name, literal) => {
			expect(bareSkipHits(wrap(literal))).toEqual([]);
		});
	});
});
