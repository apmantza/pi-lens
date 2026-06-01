/**
 * SonarJS-inspired FactRules for TypeScript/TSX
 *
 * SN-001  commented-out-code          — comment blocks containing ≥2 code indicators
 * SN-002  duplicate-string-literal    — same string literal ≥10 occurrences in a file
 * SN-003  function-in-loop            — function/arrow/expression inside a loop body
 * SN-004  cors-wildcard               — Access-Control-Allow-Origin: * (TS/JS/Python/Go)
 * SN-005  dynamic-regexp              — new RegExp() with non-literal first argument
 * SN-006  max-switch-cases            — switch with > 40 cases
 * SN-007  no-commented-credentials   — password/token/secret in comments (TS/JS/Python/Go/Ruby)
 */

import * as ts from "typescript";
import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";

// ---------- helpers ----------

function tsFile(ctx: { filePath: string }): boolean {
	return /\.tsx?$/.test(ctx.filePath);
}

function createSourceFile(filePath: string, content: string): ts.SourceFile {
	return ts.createSourceFile(
		filePath,
		content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
}

function makeD(
	_id: string,
	rule: string,
	filePath: string,
	line: number,
	col: number,
	message: string,
): Diagnostic {
	return {
		id: `${rule}:${filePath}:${line}`,
		tool: rule,
		rule,
		filePath,
		line,
		column: col,
		severity: "warning",
		semantic: "warning",
		message,
	};
}

// ---------- SN-001: commented-out code ----------

const COMMENT_CODE_INDICATORS = [
	/^\s*(const|let|var|function|class|if|for|while|return|import|export|throw|try|catch)\b/m,
	/;\s*$/m,
	/\)\s*\{/m,
	/=>/m,
];

function looksLikeCode(text: string): boolean {
	let hits = 0;
	for (const p of COMMENT_CODE_INDICATORS) {
		if (p.test(text)) hits++;
		if (hits >= 2) return true;
	}
	return false;
}

export const commentedOutCodeRule: FactRule = {
	id: "commented-out-code",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const sf = createSourceFile(ctx.filePath, content);
		const diagnostics: Diagnostic[] = [];

		// Collect leading/trailing comment ranges
		const ranges: ts.CommentRange[] = [];
		ts.forEachChild(sf, function collect(node) {
			const leading = ts.getLeadingCommentRanges(content, node.pos) ?? [];
			ranges.push(...leading);
			ts.forEachChild(node, collect);
		});

		const seen = new Set<number>();
		for (const r of ranges) {
			if (seen.has(r.pos)) continue;
			seen.add(r.pos);
			const text = content.slice(r.pos, r.end);
			const inner =
				r.kind === ts.SyntaxKind.MultiLineCommentTrivia
					? text.slice(2, -2)
					: text.replace(/^\/\//gm, "");
			if (!looksLikeCode(inner)) continue;
			const { line } = sf.getLineAndCharacterOfPosition(r.pos);
			diagnostics.push(
				makeD(
					"commented-out-code",
					"commented-out-code",
					ctx.filePath,
					line + 1,
					1,
					"Commented-out code detected — remove or restore it",
				),
			);
		}
		return diagnostics;
	},
};

// ---------- SN-002: duplicate string literals ----------

const MIN_DUPLICATES = 10;
const MIN_STRING_LENGTH = 5;
// Skip common non-signal strings (string-enum values, HTTP verbs, primitives, etc.)
const SKIP_STRINGS = new Set([
	"",
	" ",
	"\n",
	"utf-8",
	"utf8",
	"text",
	"json",
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"head",
	"id",
	"name",
	"type",
	"value",
	"error",
	"warning",
	"info",
	"debug",
	"message",
	"data",
	"true",
	"false",
	"null",
	"undefined",
	"none",
	"unknown",
	"blocking",
	"succeeded",
	"failed",
	"skipped",
	"success",
	"pending",
	"string",
	"number",
	"boolean",
	"object",
	"array",
	"node_modules",
	".bin",
	// Platform / environment constants
	"win32",
	"linux",
	"darwin",
	// Common language/tool discriminators
	"python",
	"shell",
	"typescript",
	"javascript",
	// Test and package management conventions
	"__tests__",
	"tests",
	"install",
	"ignore",
	// Common auth/config keys
	"github",
	"allow",
	"deny",
]);

export const duplicateStringLiteralRule: FactRule = {
	id: "duplicate-string-literal",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const sf = createSourceFile(ctx.filePath, content);
		const diagnostics: Diagnostic[] = [];

		const counts = new Map<string, { count: number; line: number }>();

		function isSkipped(s: string): boolean {
			if (SKIP_STRINGS.has(s.toLowerCase())) return true;
			// Skip fact/config dot-notation keys (e.g. "file.content", "tool.mypy")
			if (/^\w+\.\w+/.test(s)) return true;
			// Skip strings containing path separators or variable markers
			if (s.includes("/") || s.includes("\\") || s.includes("$")) return true;
			// Skip CLI flags (start with --)
			if (s.startsWith("--")) return true;
			// Skip strings that look like test fixture paths or filenames with extensions
			if (/\.\w{2,4}$/.test(s)) return true;
			return false;
		}

		function visit(node: ts.Node) {
			if (
				ts.isStringLiteral(node) &&
				node.text.length >= MIN_STRING_LENGTH &&
				!isSkipped(node.text)
			) {
				const val = node.text;
				const existing = counts.get(val);
				if (existing) {
					existing.count++;
				} else {
					const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
					counts.set(val, { count: 1, line: line + 1 });
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);

		for (const [val, { count, line }] of counts) {
			if (count >= MIN_DUPLICATES) {
				diagnostics.push(
					makeD(
						"duplicate-string-literal",
						"duplicate-string-literal",
						ctx.filePath,
						line,
						1,
						`String literal "${val}" repeated ${count} times — extract to a named constant`,
					),
				);
			}
		}
		return diagnostics;
	},
};

// ---------- SN-003: function in loop ----------

const LOOP_KINDS = new Set([
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.DoStatement,
]);

function isInsideLoop(node: ts.Node): boolean {
	let cur = node.parent;
	while (cur) {
		if (LOOP_KINDS.has(cur.kind)) return true;
		// Stop at function boundaries
		if (
			ts.isFunctionDeclaration(cur) ||
			ts.isFunctionExpression(cur) ||
			ts.isArrowFunction(cur) ||
			ts.isMethodDeclaration(cur)
		)
			return false;
		cur = cur.parent;
	}
	return false;
}

export const functionInLoopRule: FactRule = {
	id: "function-in-loop",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const sf = createSourceFile(ctx.filePath, content);
		const diagnostics: Diagnostic[] = [];

		function visit(node: ts.Node) {
			const isFn =
				ts.isFunctionDeclaration(node) ||
				ts.isFunctionExpression(node) ||
				ts.isArrowFunction(node);
			if (isFn && isInsideLoop(node)) {
				const { line, character } = sf.getLineAndCharacterOfPosition(
					node.getStart(sf),
				);
				const label = ts.isFunctionDeclaration(node)
					? "Function declaration"
					: ts.isFunctionExpression(node)
						? "Function expression"
						: "Arrow function";
				diagnostics.push(
					makeD(
						"function-in-loop",
						"function-in-loop",
						ctx.filePath,
						line + 1,
						character + 1,
						`${label} inside a loop — creates a new function object on every iteration`,
					),
				);
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);
		return diagnostics;
	},
};

// ---------- SN-004: CORS wildcard ----------

export const corsWildcardRule: FactRule = {
	id: "cors-wildcard",
	requires: ["file.content"],
	appliesTo(ctx) {
		return /\.(tsx?|py|go)$/.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const diagnostics: Diagnostic[] = [];

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const isWildcard =
				// TS/JS: header assignment or cors() call
				(/["']Access-Control-Allow-Origin["']/.test(line) && /["']\*["']/.test(line)) ||
				/origin\s*:\s*["']\*["']/.test(line) ||
				(/cors\s*\(/.test(line) && /\*/.test(line)) ||
				// Python (FastAPI CORSMiddleware / Flask-CORS):
				// allow_origins="*"  origins="*"
				/(?:allow_origins|origins)\s*=\s*["']\*["']/.test(line) ||
				// allow_origins=["*"]  allow_origins=['*']  origins=["*"]
				/(?:allow_origins|origins)\s*=\s*[[(]["']\*["']/.test(line) ||
				// Go (gin-cors, chi-cors, gorilla):
				// AllowAllOrigins: true
				/AllowAllOrigins\s*:\s*true/.test(line) ||
				// AllowOrigins: []string{"*"}  AllowedOrigins: []string{"*"}
				// Use [^*\n]{0,60} instead of .* to prevent super-linear backtracking
				/Allow(?:ed)?Origins[^*\n]{0,60}\*/.test(line);

			if (isWildcard) {
				diagnostics.push({
					...makeD(
						"cors-wildcard",
						"cors-wildcard",
						ctx.filePath,
						i + 1,
						1,
						"CORS wildcard origin (*) allows any website to make credentialed requests — restrict to known origins",
					),
					severity: "error",
					semantic: "blocking",
				});
			}
		}
		return diagnostics;
	},
};

// ---------- SN-005: dynamic RegExp ----------

export const dynamicRegexpRule: FactRule = {
	id: "dynamic-regexp",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const sf = createSourceFile(ctx.filePath, content);
		const diagnostics: Diagnostic[] = [];

		function visit(node: ts.Node) {
			if (
				ts.isNewExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === "RegExp" &&
				node.arguments &&
				node.arguments.length > 0
			) {
				const firstArg = node.arguments[0];
				// Only flag if the argument is NOT a string/template literal (i.e. dynamic)
				if (
					!ts.isStringLiteral(firstArg) &&
					!ts.isNoSubstitutionTemplateLiteral(firstArg)
				) {
					const { line, character } = sf.getLineAndCharacterOfPosition(
						node.getStart(sf),
					);
					diagnostics.push(
						makeD(
							"dynamic-regexp",
							"dynamic-regexp",
							ctx.filePath,
							line + 1,
							character + 1,
							"new RegExp() with dynamic argument — potential ReDoS if argument comes from user input",
						),
					);
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);
		return diagnostics;
	},
};

// ---------- SN-006: max switch cases ----------

const MAX_SWITCH_CASES = 40;

export const maxSwitchCasesRule: FactRule = {
	id: "max-switch-cases",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const sf = createSourceFile(ctx.filePath, content);
		const diagnostics: Diagnostic[] = [];

		function visit(node: ts.Node) {
			if (ts.isSwitchStatement(node)) {
				const caseCount = node.caseBlock.clauses.filter(ts.isCaseClause).length;
				if (caseCount > MAX_SWITCH_CASES) {
					const { line, character } = sf.getLineAndCharacterOfPosition(
						node.getStart(sf),
					);
					diagnostics.push(
						makeD(
							"max-switch-cases",
							"max-switch-cases",
							ctx.filePath,
							line + 1,
							character + 1,
							`Switch has ${caseCount} cases (max ${MAX_SWITCH_CASES}) — consider a lookup map or polymorphism`,
						),
					);
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);
		return diagnostics;
	},
};

// ---------- SN-007: no-commented-credentials ----------

const CREDENTIAL_PATTERNS = [
	/password\s*[:=]\s*["'][^"']{3,}/i,
	/(?:api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{6,}/i,
	/(?:aws|gcp|azure)[_-]?(?:key|secret|token)\s*[:=]\s*["'][^"']{6,}/i,
];

// Files that define credential patterns as code (scanners, test fixtures, etc.) —
// their own regex literals would otherwise self-trigger this rule.
const CREDENTIALS_EXEMPT = /[/\\](secrets?[-_]?(scanner|detect|check)|scanner|fixture|mock)[^/\\]*\.(tsx?|ya?ml|json|env)$/i;

export const commentedCredentialsRule: FactRule = {
	id: "no-commented-credentials",
	requires: ["file.content"],
	appliesTo(ctx) {
		return /\.(tsx?|py|go|rb|ya?ml|json|env)$/.test(ctx.filePath) &&
			!CREDENTIALS_EXEMPT.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const diagnostics: Diagnostic[] = [];

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trimStart();
			if (
				!line.startsWith("//") &&
				!line.startsWith("#") &&
				!line.startsWith("*")
			)
				continue;
			for (const p of CREDENTIAL_PATTERNS) {
				if (p.test(line)) {
					diagnostics.push({
						...makeD(
							"no-commented-credentials",
							"no-commented-credentials",
							ctx.filePath,
							i + 1,
							1,
							"Possible credential in commented-out code — remove it and rotate the secret",
						),
						severity: "error",
						semantic: "blocking",
					});
					break;
				}
			}
		}
		return diagnostics;
	},
};
