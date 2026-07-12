/**
 * Middle-man / delegate-only class detection (#325, split from #305).
 *
 * ast-grep can match *existence* ("this class has a delegate method") but not
 * *universal quantification* ("EVERY method of this class is a pure forward to
 * one held field") — that whole-class judgment is a structural pass over the
 * already-extracted outline, not a pattern rule (see #325 for the full
 * rationale). This module computes, per class, a "delegation ratio" — the
 * share of real methods whose ENTIRE body is a single pure-forwarding call to
 * one held field — and flags the class only when that ratio is near 100% AND
 * the class isn't a named facade/adapter/proxy/wrapper/decorator, and doesn't
 * structurally implement an interface (a legitimate reason for near-total
 * forwarding).
 *
 * Deliberately precision-first: every ambiguous case (destructured params,
 * multi-statement bodies, mixed delegate fields, too few methods to judge)
 * resolves to "not flagged" rather than guessing. False negatives are cheap;
 * flooding legitimate forwarding layers (the risk #325 repeatedly calls out)
 * is not.
 *
 * Scope (v1): languages with a simple, deterministic "self" token and a `.`
 * (or PHP's `->`) member-access operator — typescript/tsx/javascript, java,
 * kotlin, csharp, swift, dart, python, ruby, rust, php. Go/C++ are skipped —
 * Go has no `this`-equivalent token in the method text (the receiver name is
 * arbitrary) and C++ mixes `.`/`->` depending on whether the held field is a
 * pointer, both of which need real AST access to resolve soundly; a future
 * slice can add them once middle-man analysis has an AST-node entry point
 * rather than this text-based one.
 */

import type { ModuleSymbolEntry } from "./module-report.js";

/** Self-reference token + member-access separator, per languageId. Both the
 * self→field and field→method hops use the SAME separator in every language
 * covered here (true even for PHP's `$this->field->method()`). */
const SELF_TOKEN: Record<string, { token: string; sep: string }> = {
	typescript: { token: "this", sep: "." },
	tsx: { token: "this", sep: "." },
	javascript: { token: "this", sep: "." },
	java: { token: "this", sep: "." },
	kotlin: { token: "this", sep: "." },
	csharp: { token: "this", sep: "." },
	swift: { token: "this", sep: "." },
	dart: { token: "this", sep: "." },
	rust: { token: "self", sep: "." },
	python: { token: "self", sep: "." },
	ruby: { token: "self", sep: "." },
	php: { token: "$this", sep: "->" },
};

/** Guard: a class named after an intentional forwarding pattern is never the
 * Fowler "Middle Man" smell — that's its whole job. Substring match, so
 * `LegacyApiAdapter`/`ConfigFacade`/`LoggingProxy`/`HttpWrapper` all guard out. */
const INTENTIONAL_FORWARDER_NAME = /adapter|facade|proxy|wrapper|decorator/i;

/** Names that are constructors/destructors (never delegation candidates) in at
 * least one covered language. */
const CONSTRUCTOR_NAMES = new Set(["constructor", "__init__", "__new__", "initialize"]);

/** Below this many real (non-accessor, non-constructor) methods, a delegation
 * ratio isn't a meaningful judgment — a one-method utility class forwarding
 * that one call is not "the class only ever delegates", it's just a small
 * class (#325 FP concern: don't flood on tiny legitimate wrappers). */
const MIN_CANDIDATE_METHODS = 2;

/** How close to "every method forwards" counts as the smell. Near-100%, not
 * "mostly" — a class with a couple of forwarding convenience methods among
 * real logic must NOT flag (the exact distinction #325 asks for). */
const DELEGATION_RATIO_THRESHOLD = 0.9;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildForwardRegex(token: string, sep: string): RegExp {
	const t = escapeRegExp(token);
	const s = escapeRegExp(sep);
	// `(?:return\s+)?(?:await\s+)?` — value-returning and void forwards both
	// count (issue explicitly includes the no-`return` void-method form).
	return new RegExp(
		`^(?:return\\s+)?(?:await\\s+)?${t}${s}(\\w+)${s}(\\w+)\\(([^()]*)\\)\\s*;?$`,
	);
}

/** Splits a parameter/argument list on top-level commas only (naive but
 * sufficient — a nested paren pair would already have failed the outer
 * `[^()]*` capture in `buildForwardRegex`, so args here never contain `(`). */
function splitArgs(s: string): string[] {
	const trimmed = s.trim();
	if (!trimmed) return [];
	return trimmed.split(",").map((a) => a.trim());
}

/** Parameter names from a method's captured `(a: T, b = 1)`-shaped signature
 * text. Returns `undefined` (ineligible — don't guess) for destructured
 * params, since arg-identity comparison can't be done textually for those. */
function paramNamesFromSignature(
	signature: string | undefined,
	languageId: string,
): string[] | undefined {
	const inner = (signature ?? "").trim().replace(/^\(/, "").replace(/\)$/, "");
	if (inner.trim() === "") return [];
	if (inner.includes("{") || inner.includes("[")) return undefined;
	const names = splitArgs(inner)
		.filter((p) => p.length > 0)
		.map((raw) => {
			let name = raw;
			// Rest/spread params forward as themselves textually (`...args`).
			const isRest = /^\.\.\./.test(name);
			name = name.replace(/^\.\.\./, "");
			name = name.split("=")[0].trim(); // strip default value
			name = name.split(":")[0].trim(); // strip type annotation
			name = name.replace(/\?$/, ""); // strip optional marker
			return isRest ? `...${name}` : name;
		});
	if (languageId === "python" && names[0] === "self") return names.slice(1);
	if (languageId === "python" && names[0] === "cls") return names.slice(1);
	return names;
}

/** Extracts the statement(s) inside a method body as a list of non-blank,
 * comment-stripped, trimmed lines. Brace languages: content between the
 * FIRST `{` and LAST `}` in the member's source range (sound as long as the
 * body itself contains no nested `{…}` — true by construction for the
 * single-statement forward pattern we're checking for; anything with nested
 * braces has >1 meaningful line anyway and correctly fails the single-
 * statement check below). Python: everything after the `def …:` line,
 * dedented is unnecessary since we only care about non-blank line count. */
function bodyStatementLines(
	lines: string[],
	entry: ModuleSymbolEntry,
	isPython: boolean,
): string[] {
	const raw = lines.slice(entry.startLine - 1, entry.endLine).join("\n");
	let body: string;
	if (isPython) {
		const nlIdx = raw.indexOf("\n");
		if (nlIdx === -1) return [];
		body = raw.slice(nlIdx + 1);
	} else {
		const braceIdx = raw.indexOf("{");
		const lastBrace = raw.lastIndexOf("}");
		if (braceIdx === -1 || lastBrace === -1 || lastBrace <= braceIdx) return [];
		body = raw.slice(braceIdx + 1, lastBrace);
	}
	return body
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((l) => l.replace(/\/\/.*$/, ""))
		.map((l) => (isPython ? l.replace(/#.*$/, "") : l))
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		// A lone triple-quoted docstring line in python isn't executable, but
		// distinguishing it textually is unreliable — treat any leading `"""`/`'''`
		// line as noise so a documented one-liner forward still qualifies.
		.filter((l) => !/^("""|''')/.test(l));
}

/** Detects an accessor (getter/setter) declaration from its raw source line —
 * accessors are a DIFFERENT smell (anemic class) and excluded from both the
 * numerator and denominator here so property-heavy adapters/DTOs don't skew
 * the ratio either way. */
function isAccessorLine(rawLine: string): boolean {
	return /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|override\s+|readonly\s+)*(?:get|set)\s+\w+\s*[/(]/.test(
		rawLine,
	);
}

export interface MiddleManSignal {
	delegationRatio: number;
	candidateCount: number;
	forwardingCount: number;
	delegateField: string;
}

/**
 * Computes the middle-man signal for a single class entry, or `undefined`
 * when there isn't enough signal to judge (too few candidate methods, no
 * language support, mixed delegate fields, etc). Pure function over already-
 * extracted data — no re-parsing, no file I/O beyond the lines already read
 * by the caller.
 */
export function analyzeMiddleMan(
	classEntry: ModuleSymbolEntry,
	lines: string[],
	languageId: string | undefined,
): MiddleManSignal | undefined {
	if (!languageId) return undefined;
	const selfSpec = SELF_TOKEN[languageId];
	if (!selfSpec) return undefined;
	if (!classEntry.members || classEntry.members.length === 0) return undefined;

	const isPython = languageId === "python";
	const forwardRe = buildForwardRegex(selfSpec.token, selfSpec.sep);
	const className = classEntry.name;

	const candidates = classEntry.members.filter((m) => {
		if (m.kind !== "method") return false;
		if (CONSTRUCTOR_NAMES.has(m.name)) return false;
		if (m.name === className || m.name === `~${className}`) return false; // C++/C# ctor/dtor-by-name
		const rawLine = lines[m.startLine - 1] ?? "";
		if (isAccessorLine(rawLine)) return false;
		return true;
	});
	if (candidates.length < MIN_CANDIDATE_METHODS) return undefined;

	let forwardingCount = 0;
	const fieldCounts = new Map<string, number>();

	for (const member of candidates) {
		const bodyLines = bodyStatementLines(lines, member, isPython);
		if (bodyLines.length !== 1) continue;
		const match = forwardRe.exec(bodyLines[0]);
		if (!match) continue;
		const [, field, calledMethod, argsText] = match;
		const paramNames = paramNamesFromSignature(member.signature, languageId);
		if (paramNames === undefined) continue; // destructured params — ineligible
		const args = splitArgs(argsText);
		if (args.length !== paramNames.length) continue;
		if (!args.every((a, i) => a === paramNames[i])) continue;
		void calledMethod;
		forwardingCount += 1;
		fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
	}

	if (forwardingCount === 0) return undefined;

	// "One held field" (#325) — require every forward to target the SAME
	// field. Two-or-more distinct delegate fields is a different shape
	// (multi-target wrapper) and out of scope for this flag; be conservative.
	if (fieldCounts.size !== 1) return undefined;
	const [delegateField] = [...fieldCounts.keys()];

	return {
		delegationRatio: forwardingCount / candidates.length,
		candidateCount: candidates.length,
		forwardingCount,
		delegateField,
	};
}

/** True when the class structurally looks like an intentional interface-
 * forwarding shape — `implements X` on the declaration line(s), which is
 * a legitimate, common reason for a class to be "all delegation" (a typed
 * adapter satisfying an interface). Scans the declaration line plus one
 * continuation line to tolerate simple wraps. */
function implementsInterface(lines: string[], classEntry: ModuleSymbolEntry): boolean {
	const declText = lines
		.slice(classEntry.startLine - 1, Math.min(classEntry.startLine + 1, lines.length))
		.join(" ");
	return /\bimplements\b/.test(declText);
}

/**
 * Mutates `entries` in place (same convention as the rest of module-report's
 * flag computation): every class-kind entry that clears the delegation-ratio
 * threshold, isn't a named facade/adapter/proxy/wrapper/decorator, and isn't
 * a structural interface-forwarder gets `flags: [..., "middle man"]` and a
 * `delegationRatio` field. Operates on the FLAT entries list (post-nesting,
 * so `members` is populated) — nested/inner classes are analyzed the same as
 * top-level ones.
 */
export function annotateMiddleMan(
	entries: ModuleSymbolEntry[],
	content: string,
	languageId: string | undefined,
): void {
	if (!languageId || !SELF_TOKEN[languageId]) return;
	const lines = content.split(/\r?\n/);
	for (const entry of entries) {
		if (entry.kind !== "class") continue;
		if (INTENTIONAL_FORWARDER_NAME.test(entry.name)) continue;
		if (implementsInterface(lines, entry)) continue;
		const signal = analyzeMiddleMan(entry, lines, languageId);
		if (!signal) continue;
		if (signal.delegationRatio < DELEGATION_RATIO_THRESHOLD) continue;
		entry.delegationRatio = signal.delegationRatio;
		entry.flags = entry.flags ? [...entry.flags, "middle man"] : ["middle man"];
	}
}
