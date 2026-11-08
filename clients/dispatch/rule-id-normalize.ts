/**
 * Normalize a rule id to the form a user typically writes in a
 * `pi-lens-ignore` comment, an inline suppression, or a project-level
 * `disable`/`select` list. Strips the LSP source prefixes (`ast-grep:`;
 * `shuck:` for the shuck LSP's native `C/S/P/X/K` codes, #3968; `Pyright:` and
 * `basedpyright:` for the Pyright language servers, whose analyzer the
 * `pyright` CLI runner also runs, #4629) and the language suffix used by the
 * rule catalogs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAstGrepRuleSources } from "../sgconfig.js";
import type { Diagnostic } from "./types.js";

/** Derive language tags from shipped rule filenames, rather than a list. */
export function deriveRuleIdLanguageSuffixes(ruleRoot: string): Set<string> {
	const suffixes = new Set<string>();
	const visit = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else {
				const match = /-([a-z0-9]+)\.ya?ml$/i.exec(entry.name);
				if (match) suffixes.add(match[1].toLowerCase());
			}
		}
	};
	visit(ruleRoot);
	return suffixes;
}

const bundledCodeRabbitRules = getAstGrepRuleSources().find(
	(source) => source.origin === "bundled" && source.tier === "secondary",
);
const RULE_ID_LANGUAGE_SUFFIXES = new Set(["js"]);
if (bundledCodeRabbitRules) {
	for (const suffix of deriveRuleIdLanguageSuffixes(
		bundledCodeRabbitRules.dir,
	)) {
		RULE_ID_LANGUAGE_SUFFIXES.add(suffix);
	}
}

/**
 * LSP diagnostic source prefixes that a user's suppressed spelling omits.
 * LSP-sourced diagnostics render `rule` as `"<source>:<code>"`
 * (`clients/dispatch/utils/lsp-diagnostics.ts`), but the user lists the BARE
 * code in `pi-lens-ignore` comments and `rules.<id>.disable` — so those
 * namespaces (plus `shuck`'s native `C/S/P/X/K` codes, whose diagnostics the
 * shuck LSP sources as `shuck:C001`; #3968) strip the prefix before the
 * policy, inline-suppression and matcher comparisons run. Anchored at the
 * start (only the rendered `<source>:` form), so a code that merely CONTAINS
 * the token keeps matching raw.
 *
 * The list is closed, and each entry is spelled as its server publishes it
 * (`pyright-langserver`: `source: "Pyright"`; `basedpyright-langserver`:
 * `source: "basedpyright"`). A server not on it keeps its prefix: another
 * analyzer's same-named code is another finding, and stripping every
 * `<source>:` would merge them (#4629).
 */
const LSP_SOURCE_PREFIXES = [
	"ast-grep:",
	"shuck:",
	"Pyright:",
	"basedpyright:",
];

export function normalizeRuleId(ruleId: string): string {
	let normalized = ruleId;
	for (const prefix of LSP_SOURCE_PREFIXES) {
		if (normalized.startsWith(prefix)) {
			normalized = normalized.slice(prefix.length);
			break;
		}
	}
	for (const suffix of RULE_ID_LANGUAGE_SUFFIXES) {
		if (normalized.endsWith(`-${suffix}`)) {
			normalized = normalized.slice(0, -(suffix.length + 1));
		}
	}
	return normalized;
}

/**
 * Cross-tool finding classes (#5416): the issues several linters name with
 * their own rule ids. `const unused = 1;` is oxlint `no-unused-vars` (a
 * warning), biome `noUnusedVariables` (an error) and ruff `F841`; one
 * undefined name is ruff `F821` and pyright `reportUndefinedVariable`. A
 * class gives its members one dedupe key (`findingClassKey`, read by the
 * dispatcher's dedupe and delta) and one severity (`withClassSeverity`, read
 * where a runner's answer enters dispatch), so the verdict no longer depends on
 * which tool of a fallback chain answered, and a tool that runs beside another
 * reports the finding once.
 *
 * The table is closed and keyed by the EMITTED `tool` and the rule exactly as
 * that tool spells it. A pair not listed is no member: it keeps its own key and
 * its own severity, so another analyzer's same-named rule is never merged
 * (the `LSP_SOURCE_PREFIXES` rule, #4629). A language server's rule reads
 * `<source>:<code>`; only the two Pyright servers' spellings are members.
 */
export type FindingClass =
	| "unused-variable"
	| "unused-import"
	| "undefined-name";

const FINDING_CLASS_RULES: ReadonlyMap<
	string,
	ReadonlyMap<string, FindingClass>
> = new Map([
	[
		"eslint",
		new Map<string, FindingClass>([
			["no-unused-vars", "unused-variable"],
			["@typescript-eslint/no-unused-vars", "unused-variable"],
			["no-undef", "undefined-name"],
		]),
	],
	[
		"oxlint",
		new Map<string, FindingClass>([
			["no-unused-vars", "unused-variable"],
			["no-undef", "undefined-name"],
		]),
	],
	[
		"biome",
		new Map<string, FindingClass>([
			["lint/correctness/noUnusedVariables", "unused-variable"],
			["lint/correctness/noUnusedImports", "unused-import"],
			["lint/correctness/noUndeclaredVariables", "undefined-name"],
		]),
	],
	[
		"ruff",
		new Map<string, FindingClass>([
			["F841", "unused-variable"],
			["F401", "unused-import"],
			["F821", "undefined-name"],
		]),
	],
	[
		"pyright",
		new Map<string, FindingClass>([
			["reportUnusedVariable", "unused-variable"],
			["reportUnusedImport", "unused-import"],
			["reportUndefinedVariable", "undefined-name"],
		]),
	],
	["mypy", new Map<string, FindingClass>([["name-defined", "undefined-name"]])],
]);

/** The two servers whose analyzer the `pyright` CLI runner also runs. */
const PYRIGHT_LSP_SOURCE = /^(?:Pyright|basedpyright):(.+)$/;

/** The class a finding belongs to, or `undefined` for any pair not listed. */
export function findingClassOf(
	d: Pick<Diagnostic, "tool" | "rule">,
): FindingClass | undefined {
	const rule = d.rule;
	if (!rule) return undefined;
	const tool = d.tool.toLowerCase();
	if (tool === "lsp") {
		const code = PYRIGHT_LSP_SOURCE.exec(rule)?.[1];
		return code === undefined
			? undefined
			: FINDING_CLASS_RULES.get("pyright")?.get(code);
	}
	return FINDING_CLASS_RULES.get(tool)?.get(rule);
}

/**
 * The dedupe key of a class member at one place, or `undefined` for a finding
 * outside every class. The tool and the rule are not part of it: that is what
 * makes two tools' copies one finding.
 */
export function findingClassKey(
	d: Pick<Diagnostic, "tool" | "rule" | "filePath" | "line" | "column">,
): string | undefined {
	const cls = findingClassOf(d);
	return cls === undefined
		? undefined
		: `${d.filePath}:${d.line ?? 1}:${d.column ?? 1}:class:${cls}`;
}

/**
 * A class member at a non-blocking tier, raised to the class's one severity:
 * `error`, a blocker. The delta already blocks a new unused value whatever its
 * tool says (`promoteDeltaUnusedToBlockers`); this makes the first dispatch of
 * a file, and `--no-delta`, answer the same way for every tool. A blocker, a
 * runner fault and any other tier (`fixed`, `silent`) pass unchanged.
 */
export function withClassSeverity<T extends Diagnostic>(d: T): T {
	if (d.runnerFault === true) return d;
	if (d.semantic !== "warning" && d.semantic !== "none") return d;
	if (findingClassOf(d) === undefined) return d;
	return { ...d, severity: "error", semantic: "blocking" };
}
