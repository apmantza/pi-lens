/**
 * Shape 42 enforcer: a registered consumer answers one way for every extension
 * of one language.
 *
 * The registry (`clients/language-registry.ts`) says which extensions are one
 * language. A consumer that lists extensions by hand drifts from it, and the
 * drift is silent: the file reads as unchecked. #5300 found seventeen
 * consumers that spelled the TypeScript family as `/\.tsx?$/` or as a six-item
 * JS/TS list and so refused `.mts` and `.cts`, the files the registry,
 * the formatter policy and the LSP all treat as TypeScript.
 *
 * This reads the live population, not source text, so a spelling nobody
 * planned for still reds: every provider and rule `integration.ts` registers,
 * and the three tool-policy lookups, are asked about every extension of every
 * registry language. Within one language (and within the TypeScript and
 * JavaScript families, which the registry splits in two for the JSX grammar)
 * the answer must not change. A pair that is allowed to differ sits in
 * `EXEMPT` with its reason, and the table is checked in both directions: an
 * exemption the code no longer needs reds as stale.
 *
 * Recurrence guarded: `.mts`/`.cts` refused by 14 fact providers and rules, two
 * policy lookups and the project scan's extension set (`ts-family-alias-members`
 * holds the cells through each production caller).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import "../../clients/dispatch/integration.js";
import type {
	FactProvider,
	FactRule,
} from "../../clients/dispatch/fact-provider-types.js";
import { commentFactProvider } from "../../clients/dispatch/facts/comment-facts.js";
import { fileContentProvider } from "../../clients/dispatch/facts/file-content.js";
import { functionFactProvider } from "../../clients/dispatch/facts/function-facts.js";
import { importFactProvider } from "../../clients/dispatch/facts/import-facts.js";
import { tryCatchFactProvider } from "../../clients/dispatch/facts/try-catch-facts.js";
import { asyncNoiseRule } from "../../clients/dispatch/rules/async-noise.js";
import { asyncUnnecessaryWrapperRule } from "../../clients/dispatch/rules/async-unnecessary-wrapper.js";
import { corsWildcardRule } from "../../clients/dispatch/rules/cors-wildcard.js";
import { errorObscuringRule } from "../../clients/dispatch/rules/error-obscuring.js";
import { errorSwallowingRule } from "../../clients/dispatch/rules/error-swallowing.js";
import { highComplexityRule } from "../../clients/dispatch/rules/high-complexity.js";
import { highFanOutRule } from "../../clients/dispatch/rules/high-fan-out.js";
import { highImportCouplingRule } from "../../clients/dispatch/rules/high-import-coupling.js";
import { missingErrorPropagationRule } from "../../clients/dispatch/rules/missing-error-propagation.js";
import { commentedCredentialsRule } from "../../clients/dispatch/rules/no-commented-credentials.js";
import { passThroughWrappersRule } from "../../clients/dispatch/rules/pass-through-wrappers.js";
import { placeholderCommentsRule } from "../../clients/dispatch/rules/placeholder-comments.js";
import { unsafeBoundaryRule } from "../../clients/dispatch/rules/unsafe-boundary.js";
import type { DispatchContext } from "../../clients/dispatch/types.js";
import { detectFileKind } from "../../clients/file-kinds.js";
import { LANGUAGES } from "../../clients/language-registry.js";
import {
	getAutofixPolicyForFile,
	getFormatterPolicyForFile,
	getLinterPolicyForFile,
} from "../../clients/tool-policy.js";
import { stripSource } from "../support/sweep-kit.js";

const PROVIDERS: readonly FactProvider[] = [
	fileContentProvider,
	tryCatchFactProvider,
	functionFactProvider,
	commentFactProvider,
	importFactProvider,
];

const RULES: readonly FactRule[] = [
	errorObscuringRule,
	errorSwallowingRule,
	asyncNoiseRule,
	passThroughWrappersRule,
	placeholderCommentsRule,
	highComplexityRule,
	unsafeBoundaryRule,
	asyncUnnecessaryWrapperRule,
	missingErrorPropagationRule,
	highFanOutRule,
	highImportCouplingRule,
	corsWildcardRule,
	commentedCredentialsRule,
];

/** Languages the registry splits in two for a grammar, one family to a reader. */
const FAMILIES: ReadonlyArray<readonly string[]> = [
	["typescript", "typescriptreact"],
	["javascript", "javascriptreact"],
];

interface Consumer {
	readonly name: string;
	readonly answers: (filePath: string) => boolean;
}

function context(filePath: string): DispatchContext {
	return {
		filePath,
		cwd: "/tmp",
		kind: detectFileKind(filePath),
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts: {},
		hasTool: async () => false,
		log: () => {},
	} as unknown as DispatchContext;
}

const CONSUMERS: readonly Consumer[] = [
	...[...PROVIDERS, ...RULES].map((member) => ({
		name: member.id,
		answers: (filePath: string) => member.appliesTo(context(filePath)),
	})),
	{
		name: "linter-policy",
		answers: (filePath) => getLinterPolicyForFile(filePath) !== undefined,
	},
	{
		name: "autofix-policy",
		answers: (filePath) => getAutofixPolicyForFile(filePath) !== undefined,
	},
	{
		name: "formatter-policy",
		answers: (filePath) => getFormatterPolicyForFile(filePath) !== undefined,
	},
];

const UNMEASURED =
	"the registry owns alias extensions the lookup never lists; whether the tool accepts each one is unmeasured (a consolidation candidate, not an intent)";

/** `<consumer>|<language>` pairs allowed to answer differently, with why. */
const EXEMPT: Readonly<Record<string, string>> = {
	"linter-policy|cpp": UNMEASURED,
	"linter-policy|php": UNMEASURED,
	"linter-policy|shell": UNMEASURED,
	"formatter-policy|cpp": UNMEASURED,
	"formatter-policy|php": UNMEASURED,
	"formatter-policy|shell": UNMEASURED,
	"formatter-policy|json": UNMEASURED,
	"formatter-policy|clojure": UNMEASURED,
	"cors-wildcard|python": "`.pyi` is a type stub: it holds no request handler",
	"no-commented-credentials|python":
		"`.pyi` is a type stub: it holds no credential assignment",
	"no-commented-credentials|json": UNMEASURED,
	"no-commented-credentials|ruby": UNMEASURED,
};

function splits(consumer: Consumer, extensions: readonly string[]): string[] {
	const answers = extensions.map((ext) =>
		consumer.answers(`/repo/src/a${ext}`),
	);
	return new Set(answers).size > 1
		? extensions.map((ext, i) => `${ext}=${answers[i]}`)
		: [];
}

/** Every (consumer, language-or-family) pair whose extensions split. */
function splitPairs(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const consumer of CONSUMERS) {
		for (const entry of LANGUAGES) {
			const detail = splits(consumer, entry.extensions);
			if (detail.length > 0) found.set(`${consumer.name}|${entry.id}`, detail);
		}
		for (const family of FAMILIES) {
			const extensions = LANGUAGES.filter((entry) =>
				family.includes(entry.id),
			).flatMap((entry) => entry.extensions);
			const detail = splits(consumer, extensions);
			if (detail.length > 0)
				found.set(`${consumer.name}|${family.join("+")}`, detail);
		}
	}
	return found;
}

describe("a registered consumer answers one way per language (shape 42)", () => {
	it("covers every provider and rule integration.ts registers", () => {
		const source = stripSource(
			fs.readFileSync(
				path.join(process.cwd(), "clients/dispatch/integration.ts"),
				"utf8",
			),
		);
		const registered = [...source.matchAll(/\bregister(?:Rule|Provider)\(/g)]
			.length;
		expect(registered).toBe(PROVIDERS.length + RULES.length);
		expect(new Set(CONSUMERS.map((c) => c.name)).size).toBe(CONSUMERS.length);
	});

	it("never splits a language's extensions without an exemption", () => {
		const unexplained = [...splitPairs()]
			.filter(([pair]) => EXEMPT[pair] === undefined)
			.map(([pair, detail]) => `${pair}: ${detail.join(" ")}`);
		expect(unexplained).toEqual([]);
	});

	it("keeps no exemption the code has stopped needing", () => {
		const live = splitPairs();
		expect(Object.keys(EXEMPT).filter((pair) => !live.has(pair))).toEqual([]);
	});
});
