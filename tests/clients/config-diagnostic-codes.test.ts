import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CONFIG_DIAGNOSTIC_CODE_PATTERN,
	CONFIG_DIAGNOSTIC_CODES,
	CONFIG_DIAGNOSTIC_MARKER_PATTERN,
	configDiagnosticMarker,
	getConfigDiagnosticCode,
	isConfigDiagnosticCode,
	withConfigDiagnosticCode,
} from "../../clients/config-diagnostic-codes.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/**
 * #2418 policy point 2. The namespace is APPEND-ONLY: prose may be rewritten,
 * codes may not be renumbered or removed. The pinned list below is the
 * enforcement — a renumber or a deletion turns this file red, and the only
 * legal edit is appending a new entry at the end.
 */
const PINNED_CODES = [
	"PILENS_CFG_0001",
	"PILENS_CFG_0002",
	"PILENS_CFG_0003",
] as const;

describe("config diagnostic code namespace (#2418)", () => {
	it("is append-only: every pinned code still exists, in order", () => {
		const actual = Object.keys(CONFIG_DIAGNOSTIC_CODES);
		expect(actual.slice(0, PINNED_CODES.length)).toEqual([...PINNED_CODES]);
	});

	it("only ever grows", () => {
		expect(Object.keys(CONFIG_DIAGNOSTIC_CODES).length).toBeGreaterThanOrEqual(
			PINNED_CODES.length,
		);
	});

	it("uses one code format and unique, monotonic numbers", () => {
		const codes = Object.keys(CONFIG_DIAGNOSTIC_CODES);
		expect(codes.length).toBeGreaterThan(0);
		for (const code of codes) {
			expect(code).toMatch(CONFIG_DIAGNOSTIC_CODE_PATTERN);
		}
		expect(new Set(codes).size).toBe(codes.length);
		const numbers = codes.map((code) =>
			Number(code.slice("PILENS_CFG_".length)),
		);
		for (let i = 1; i < numbers.length; i += 1) {
			expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
		}
		expect(numbers[0]).toBe(1);
	});

	it("gives every code a non-empty description", () => {
		for (const [code, description] of Object.entries(CONFIG_DIAGNOSTIC_CODES)) {
			expect(description, code).toBeTruthy();
			expect(getConfigDiagnosticCode(code)).toBe(description);
		}
	});

	it("recognizes registered codes and rejects everything else", () => {
		expect(isConfigDiagnosticCode("PILENS_CFG_0001")).toBe(true);
		expect(isConfigDiagnosticCode("PILENS_CFG_9999")).toBe(false);
		expect(isConfigDiagnosticCode("toString")).toBe(false);
		expect(isConfigDiagnosticCode(undefined)).toBe(false);
		expect(getConfigDiagnosticCode("PILENS_CFG_9999")).toBeUndefined();
	});
});

describe("config diagnostic markers (#2418)", () => {
	it("appends a greppable bracketed suffix", () => {
		const message = withConfigDiagnosticCode(
			"pi-lens: ignoring invalid LSP config a.json: bad",
			"PILENS_CFG_0001",
		);
		expect(message).toBe(
			"pi-lens: ignoring invalid LSP config a.json: bad [PILENS_CFG_0001]",
		);
		expect(message.endsWith(configDiagnosticMarker("PILENS_CFG_0001"))).toBe(
			true,
		);
	});

	it("is idempotent", () => {
		const once = withConfigDiagnosticCode("msg", "PILENS_CFG_0002");
		expect(withConfigDiagnosticCode(once, "PILENS_CFG_0002")).toBe(once);
	});

	it("round-trips through the extraction pattern", () => {
		const message = withConfigDiagnosticCode("msg", "PILENS_CFG_0003");
		const matched = CONFIG_DIAGNOSTIC_MARKER_PATTERN.exec(message);
		expect(matched?.[1]).toBe("PILENS_CFG_0003");
		expect(isConfigDiagnosticCode(matched?.[1])).toBe(true);
	});

	it("does not match a message with no marker", () => {
		expect(CONFIG_DIAGNOSTIC_MARKER_PATTERN.test("plain prose")).toBe(false);
	});
});

/**
 * The drift half: every user-facing degradation raised from a CONFIG surface
 * must carry a registered code, otherwise a user is back to matching prose.
 * Scans the config loaders themselves rather than a hand-maintained list of
 * call sites, so a new `*config*.ts` notifier is caught the day it lands.
 */
interface ConfigSurfaceSource {
	readonly file: string;
	/**
	 * Comments blanked, string bodies KEPT. What the `notifyUserDegradation`
	 * audit below reads: its evidence IS a string literal
	 * (`"PILENS_CFG_0001"`), and a commented-out call must not read as a real
	 * one.
	 */
	readonly source: string;
	/**
	 * The file verbatim. What the doc-reference leg reads (#2418 review round 3,
	 * F2): a policy surface points users at `docs/…md` from a DOC COMMENT —
	 * `clients/config-diagnostic-codes.ts`, `clients/config-warn.ts` and this
	 * repo’s other config modules all do — so scanning the stripped text made
	 * the tracked-doc gate blind to exactly the references that caused round 1’s
	 * F1. Comments are the right input there and the wrong input above, so both
	 * forms are carried rather than one being reused for a leg it cannot serve.
	 */
	readonly raw: string;
}

function configSurfaceSources(): ConfigSurfaceSource[] {
	const found: ConfigSurfaceSource[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			const relative = path.relative(REPO_ROOT, full).split(path.sep).join("/");
			// The RELATIVE PATH, not the basename (#2425). `clients/config-core/`
			// holds the shared config pipeline in files called `merge.ts`,
			// `deny.ts`, `normalize.ts` — none of which a basename test can see, so
			// a basename scan would have declared the whole config core audited
			// while auditing none of it.
			if (!/config/i.test(relative)) continue;
			const raw = fs.readFileSync(full, "utf-8");
			found.push({
				file: relative,
				source: stripSource(raw, { strings: "keep" }),
				raw,
			});
		}
	};
	walk(path.join(REPO_ROOT, "clients"));
	return found;
}

/** Every `notifyUserDegradation(...)` call body in a source, paren-balanced. */
function notifyCalls(source: string): string[] {
	const calls: string[] = [];
	const needle = "notifyUserDegradation(";
	let index = source.indexOf(needle);
	while (index !== -1) {
		let depth = 0;
		let end = index + needle.length - 1;
		for (; end < source.length; end += 1) {
			if (source[end] === "(") depth += 1;
			else if (source[end] === ")") {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		calls.push(source.slice(index, end + 1));
		index = source.indexOf(needle, end + 1);
	}
	return calls;
}

/**
 * Split a balanced call's arguments at TOP-LEVEL commas.
 *
 * Nested calls, object/array literals and quoted text all suppress the split,
 * so the third argument comes back whole. Known limit, stated rather than
 * hidden: a top-level comma inside a template literal's `${...}` would split
 * wrongly — no call site in this repo has one, and a wrong split fails CLOSED
 * (the options argument stops parsing as an object, and the call is reported).
 */
export function callArguments(call: string): string[] {
	const open = call.indexOf("(");
	const inner = call.slice(open + 1, call.length - 1);
	const args: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let current = "";
	for (let i = 0; i < inner.length; i += 1) {
		const ch = inner[i];
		if (quote) {
			if (ch === "\\") {
				current += ch + (inner[i + 1] ?? "");
				i += 1;
				continue;
			}
			if (ch === quote) quote = undefined;
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
		if (ch === "," && depth === 0) {
			args.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim().length > 0) args.push(current.trim());
	return args;
}

/**
 * The `code` property's VALUE EXPRESSION inside an options object literal, or
 * `undefined` when the object declares no such property.
 *
 * Scoped to the object literal on purpose (#2418 review, F3). The first version
 * of this sweep tested `/\bcode\b/` against the whole call text, which a
 * comment saying "the stable code rides along" satisfied — the assertion was
 * green on prose while the option itself could be missing.
 */
export function codeOptionExpression(
	optionsArgument: string,
): string | undefined {
	if (!optionsArgument.startsWith("{") || !optionsArgument.endsWith("}")) {
		return undefined;
	}
	const body = optionsArgument.slice(1, -1);
	const explicit = /(?:^|[,{]|\s)code\s*:\s*([^,}]+)/.exec(body);
	if (explicit) return explicit[1].trim();
	// Shorthand `{ code }` / `{ code, level }`: the identifier IS the value.
	if (/(?:^|,)\s*code\s*(?:,|$)/.test(body)) return "code";
	return undefined;
}

/**
 * Every `PILENS_CFG_*` literal a value expression can reach, resolving
 * identifiers through the file's own `const`/parameter declarations (bounded
 * depth, visited-set guarded). Returns `[]` when nothing resolves — a `code`
 * option pointing at something this cannot prove is a registered code fails,
 * rather than passing because the word `code` appeared.
 */
export function resolveCodeLiterals(
	expression: string,
	source: string,
	seen: Set<string> = new Set(),
	depth = 0,
): string[] {
	const literals = [
		...expression.matchAll(/["'`](PILENS_CFG_\d{4})["'`]/g),
	].map((match) => match[1]);
	if (depth >= 4) return literals;
	const identifiers = [
		...expression.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g),
	].map((match) => match[1]);
	for (const identifier of identifiers) {
		if (seen.has(identifier)) continue;
		seen.add(identifier);
		const declaration =
			new RegExp(
				`(?:const|let|var)\\s+${identifier}\\b[^=;]*=\\s*([^;]+);`,
			).exec(source) ??
			new RegExp(`\\b${identifier}\\s*:[^=;,)]*=\\s*([^,;)]+)`).exec(source);
		if (!declaration) continue;
		literals.push(
			...resolveCodeLiterals(declaration[1], source, seen, depth + 1),
		);
	}
	return literals;
}

/**
 * Audit ONE `notifyUserDegradation` call. Returns the failure reason, or
 * `undefined` when the call passes a registered stable code. Exported as a pure
 * (call, source) → verdict function so the parser itself is unit-tested against
 * literal snippets below, rather than only inferred from a whole-tree scan that
 * happens to be green.
 */
export function auditNotifyCall(
	call: string,
	source: string,
): string | undefined {
	const args = callArguments(call);
	const optionsArgument = args[2];
	if (optionsArgument === undefined) {
		return "no options argument (message, level, options)";
	}
	const expression = codeOptionExpression(optionsArgument);
	if (expression === undefined) {
		return `options argument declares no \`code\` property: ${optionsArgument}`;
	}
	const resolved = resolveCodeLiterals(expression, source);
	if (resolved.length === 0) {
		return `\`code\` does not resolve to a PILENS_CFG_* literal: ${expression}`;
	}
	const unregistered = resolved.filter((code) => !isConfigDiagnosticCode(code));
	if (unregistered.length > 0) {
		return `\`code\` resolves to unregistered ${unregistered.join(", ")}`;
	}
	return undefined;
}

/**
 * #2418 review, F1 — and the defect underneath it.
 *
 * The policy doc was written, referenced from AGENTS.md, from this module and
 * from the changelog fragment, and then never reached the repo: `.gitignore`
 * ignores `*.md` with a per-file negation list, so `git add docs/…md` for an
 * un-negated name is a SILENT no-op. Three surfaces pointed users at a file
 * that did not exist, and nothing in the build noticed.
 *
 * A test that only checked the file exists on disk would still have passed, so
 * this one asks git: every `docs/*.md` a policy surface names must be TRACKED.
 */
/** Every `docs/*.md` path referenced anywhere across a set of texts. */
function docRefsIn(texts: string[]): string[] {
	const referenced = new Set<string>();
	for (const text of texts) {
		for (const match of text.matchAll(/docs\/[A-Za-z0-9._-]+\.md/g)) {
			referenced.add(match[0]);
		}
	}
	return [...referenced].sort();
}

function referencedDocPaths(
	sources: ReadonlyArray<ConfigSurfaceSource>,
): string[] {
	// `raw`, not `source` (#2418 review round 3, F2): a doc reference lives in
	// a doc comment, which the stripped form blanks. Reading the stripped text
	// here meant the gate saw only AGENTS.md and the changelog fragments, and a
	// module pointing at a gitignored doc passed clean.
	const texts = sources.map((entry) => entry.raw);
	texts.push(fs.readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf-8"));
	const fragmentDir = path.join(REPO_ROOT, ".changelog");
	for (const name of fs.readdirSync(fragmentDir)) {
		if (!name.endsWith(".md") || name === "README.md") continue;
		texts.push(fs.readFileSync(path.join(fragmentDir, name), "utf-8"));
	}
	return docRefsIn(texts);
}

describe("referenced policy docs are actually in the repo (#2418)", () => {
	const sources = configSurfaceSources();
	const referenced = referencedDocPaths(sources);
	const tracked = new Set(
		gitExecFileSync("git", ["ls-files", "-z", "docs"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		})
			.split("\0")
			.filter(Boolean),
	);

	it("finds doc references to check", () => {
		// Declared floor: a scan that finds nothing must FAIL, not read as clean.
		assertNonEmptyScan("referenced docs", referenced.length, 1);
		assertNonEmptyScan("tracked docs", tracked.size, 1);
	});

	it("finds doc references from config sources on their own", () => {
		// Round-4 gap: the corpus-property check below (comment-only doc refs
		// exist somewhere) holds no matter which field referencedDocPaths reads,
		// because AGENTS.md and the changelog fragments carry the same
		// references too -- reverting its `entry.raw` read to `entry.source`
		// stayed green. This asks the narrower question directly: scanning ONLY
		// the config sources' raw text must itself surface at least one
		// `docs/*.md` reference, since all three live in doc comments that
		// `source` (comments stripped) cannot see.
		assertNonEmptyScan(
			"doc references from config sources",
			docRefsIn(sources.map((s) => s.raw)).length,
			1,
		);
	});

	it("reads references out of doc comments, not only out of code", () => {
		// The round-3 F2 defect, pinned so it cannot come back without the
		// probe: the doc-reference leg must read the file VERBATIM. A config
		// module names its policy doc in a doc comment and nowhere else, so a
		// stripped scan finds zero of them and the tracked-doc gate below
		// degrades to checking AGENTS.md and the changelog only.
		const docRef = new RegExp("docs/[A-Za-z0-9._-]+[.]md");
		const commentOnly = sources.filter(
			({ raw, source }) => docRef.test(raw) && !docRef.test(source),
		);
		assertNonEmptyScan("comment-only doc references", commentOnly.length, 1);
	});

	it("names the stability policy doc", () => {
		expect(referenced).toContain("docs/public-api-stability.md");
	});

	it("tracks every referenced doc — a gitignored doc is a dangling promise", () => {
		const untracked = referenced.filter((doc) => !tracked.has(doc));
		expect(untracked).toEqual([]);
	});
});

describe("config-surface warnings carry a stable code (#2418)", () => {
	const sources = configSurfaceSources();

	it("finds config sources to audit", () => {
		// Declared floor: an empty walk must FAIL, never read as clean. Three
		// config loaders exist today; the floor is deliberately below that so a
		// rename does not break the sweep, but a zero-file walk still does.
		assertNonEmptyScan("config-surface code audit", sources.length, 3);
	});

	it("audits at least the three known config loaders", () => {
		const files = sources.map((entry) => entry.file);
		expect(files).toContain("clients/lens-config.ts");
		expect(files).toContain("clients/project-lens-config.ts");
		expect(files).toContain("clients/lsp/config.ts");
	});

	it("audits the shared config core, whose filenames do not say `config`", () => {
		const files = configSurfaceSources().map((entry) => entry.file);
		expect(files).toContain("clients/config-core/normalize.ts");
		expect(files).toContain("clients/config-core/deny.ts");
		expect(files).toContain("clients/config-core/process-spec.ts");
	});

	it("passes a registered code option on every config-surface notifyUserDegradation call", () => {
		const uncoded: string[] = [];
		let audited = 0;
		for (const { file, source } of sources) {
			for (const call of notifyCalls(source)) {
				audited += 1;
				const failure = auditNotifyCall(call, source);
				if (failure) uncoded.push(`${file}: ${failure}`);
			}
		}
		expect(audited).toBeGreaterThan(0);
		expect(uncoded).toEqual([]);
	});

	it("only references registered codes", () => {
		const referenced = new Set<string>();
		for (const { source } of sources) {
			for (const match of source.matchAll(/PILENS_CFG_\d{4}/g)) {
				referenced.add(match[0]);
			}
		}
		expect(referenced.size).toBeGreaterThan(0);
		for (const code of referenced) {
			expect(isConfigDiagnosticCode(code), code).toBe(true);
		}
	});
});

/**
 * The auditor's own mutants (#2418 review, F3). A scanner is only as good as
 * its failure modes, and the one this replaces passed on prose: the word
 * "code" in a comment next to the call satisfied `/\bcode\b/`. These snippets
 * pin what the auditor accepts and what it rejects, so a future loosening of
 * the parser fails here rather than silently in the tree scan.
 */
describe("the notify-call code auditor itself (#2418)", () => {
	const REAL_SOURCE = [
		'const IGNORED_CONFIG_CODE: ConfigDiagnosticCode = "PILENS_CFG_0001";',
		"const code: ConfigDiagnosticCode = options.code ?? IGNORED_CONFIG_CODE;",
	].join("\n");

	it("accepts a shorthand code resolved through the file's own const", () => {
		const call =
			'notifyUserDegradation(`pi-lens: ${message}`, "warning", { code })';
		expect(auditNotifyCall(call, REAL_SOURCE)).toBeUndefined();
	});

	it("accepts an inline registered literal", () => {
		const call =
			'notifyUserDegradation("pi-lens: x", "warning", { code: "PILENS_CFG_0001" })';
		expect(auditNotifyCall(call, "")).toBeUndefined();
	});

	it("REJECTS a call with the option dropped but the word in prose", () => {
		// The exact mutation the old `/\bcode\b/` assertion passed: the option
		// is gone, only the surrounding prose still says "code".
		const call =
			'notifyUserDegradation(`pi-lens: the stable code rides along ${message}`, "warning")';
		expect(auditNotifyCall(call, REAL_SOURCE)).toMatch(/no options argument/);
	});

	it("REJECTS an options object with every field but code", () => {
		const call =
			'notifyUserDegradation("pi-lens: x", "warning", { detail: "code" })';
		expect(auditNotifyCall(call, REAL_SOURCE)).toMatch(
			/declares no `code` property/,
		);
	});

	it("REJECTS a code that resolves to nothing", () => {
		const call = 'notifyUserDegradation("pi-lens: x", "warning", { code })';
		expect(auditNotifyCall(call, "const unrelated = 1;")).toMatch(
			/does not resolve/,
		);
	});

	it("REJECTS a code that resolves to an unregistered number", () => {
		const call =
			'notifyUserDegradation("pi-lens: x", "warning", { code: "PILENS_CFG_9999" })';
		expect(auditNotifyCall(call, "")).toMatch(/unregistered PILENS_CFG_9999/);
	});

	it("splits arguments without being fooled by nested commas", () => {
		const call =
			'notifyUserDegradation(fmt("a", "b"), "warning", { code: "PILENS_CFG_0001" })';
		expect(callArguments(call)).toEqual([
			'fmt("a", "b")',
			'"warning"',
			'{ code: "PILENS_CFG_0001" }',
		]);
	});

	it("reads the code expression out of the options object only", () => {
		expect(codeOptionExpression('{ code: "PILENS_CFG_0002" }')).toBe(
			'"PILENS_CFG_0002"',
		);
		expect(codeOptionExpression("{ code }")).toBe("code");
		expect(codeOptionExpression("{ level: 1 }")).toBeUndefined();
		expect(codeOptionExpression('"warning"')).toBeUndefined();
	});

	it("resolves an identifier chain to its literal", () => {
		expect(resolveCodeLiterals("code", REAL_SOURCE)).toContain(
			"PILENS_CFG_0001",
		);
	});
});
// flake-shape: real-process-spawn — the real config-diagnostic subprocess boundary is part of contention
