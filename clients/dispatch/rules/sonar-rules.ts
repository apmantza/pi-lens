/**
 * SonarJS-inspired FactRules for TypeScript/TSX
 *
 * SN-001  commented-out-code          — comment blocks containing ≥3 valid statements
 * SN-002  duplicate-string-literal    — same string literal ≥3 occurrences in a file
 * SN-003  function-in-loop            — function declaration inside a loop body
 * SN-004  no-deprecated-api           — call to @deprecated-tagged function/method
 * SN-005  jwt-without-verify          — jwt.sign() without jwt.verify() in same file
 * SN-006  cors-wildcard               — Access-Control-Allow-Origin: * in express-style code
 * SN-007  dynamic-regexp              — new RegExp() with non-literal first argument
 * SN-008  misused-promise             — .then()/.catch() on a non-Promise (void/undefined return)
 * SN-009  max-switch-cases            — switch with > 30 cases
 * SN-010  no-commented-credentials   — password/token/secret in commented-out code
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
	id: string,
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
			const inner = r.kind === ts.SyntaxKind.MultiLineCommentTrivia
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

const MIN_DUPLICATES = 3;
const MIN_STRING_LENGTH = 4;
// Skip common non-signal strings
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
	"id",
	"name",
	"type",
	"value",
	"error",
	"message",
	"data",
	"true",
	"false",
	"null",
	"undefined",
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

		function visit(node: ts.Node) {
			if (
				ts.isStringLiteral(node) &&
				node.text.length >= MIN_STRING_LENGTH &&
				!SKIP_STRINGS.has(node.text.toLowerCase())
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
			if (ts.isFunctionDeclaration(node) && isInsideLoop(node)) {
				const { line, character } =
					sf.getLineAndCharacterOfPosition(node.getStart(sf));
				diagnostics.push(
					makeD(
						"function-in-loop",
						"function-in-loop",
						ctx.filePath,
						line + 1,
						character + 1,
						"Function declaration inside a loop — creates a new function on every iteration",
					),
				);
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);
		return diagnostics;
	},
};

// ---------- SN-004: JWT sign without verify ----------

export const jwtWithoutVerifyRule: FactRule = {
	id: "jwt-without-verify",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];

		const hasSign = /\bjwt\.sign\s*\(/.test(content);
		const hasVerify = /\bjwt\.verify\s*\(/.test(content);
		if (!hasSign || hasVerify) return [];

		// Find the line of jwt.sign
		const match = content.match(/^([\s\S]*?\bjwt\.sign\s*\()/m);
		const line = match ? (match[0].match(/\n/g)?.length ?? 0) + 1 : 1;

		return [
			makeD(
				"jwt-without-verify",
				"jwt-without-verify",
				ctx.filePath,
				line,
				1,
				"jwt.sign() used but jwt.verify() not found in this file — ensure tokens are verified before trusting",
			),
		];
	},
};

// ---------- SN-005: CORS wildcard ----------

export const corsWildcardRule: FactRule = {
	id: "cors-wildcard",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const diagnostics: Diagnostic[] = [];

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (
				(/["']Access-Control-Allow-Origin["']/.test(line) &&
					/["']\*["']/.test(line)) ||
				/origin\s*:\s*["']\*["']/.test(line) ||
				(/cors\s*\(/.test(line) && /\*/.test(line))
			) {
				diagnostics.push(
					makeD(
						"cors-wildcard",
						"cors-wildcard",
						ctx.filePath,
						i + 1,
						1,
						"CORS wildcard origin (*) allows any website to make credentialed requests — restrict to known origins",
					),
				);
			}
		}
		return diagnostics;
	},
};

// ---------- SN-006: dynamic RegExp ----------

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
					const { line, character } =
						sf.getLineAndCharacterOfPosition(node.getStart(sf));
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

// ---------- SN-007: max switch cases ----------

const MAX_SWITCH_CASES = 30;

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
				const caseCount = node.caseBlock.clauses.filter(
					ts.isCaseClause,
				).length;
				if (caseCount > MAX_SWITCH_CASES) {
					const { line, character } =
						sf.getLineAndCharacterOfPosition(node.getStart(sf));
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

// ---------- SN-008: no-commented-credentials ----------

const CREDENTIAL_PATTERNS = [
	/password\s*[:=]\s*["'][^"']{3,}/i,
	/(?:api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{6,}/i,
	/(?:aws|gcp|azure)[_-]?(?:key|secret|token)\s*[:=]\s*["'][^"']{6,}/i,
];

export const commentedCredentialsRule: FactRule = {
	id: "no-commented-credentials",
	requires: ["file.content"],
	appliesTo(ctx) {
		return /\.(tsx?|ya?ml|json|env)$/.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const diagnostics: Diagnostic[] = [];

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trimStart();
			if (!line.startsWith("//") && !line.startsWith("#") && !line.startsWith("*"))
				continue;
			for (const p of CREDENTIAL_PATTERNS) {
				if (p.test(line)) {
					diagnostics.push(
						makeD(
							"no-commented-credentials",
							"no-commented-credentials",
							ctx.filePath,
							i + 1,
							1,
							"Possible credential in commented-out code — remove it and rotate the secret",
						),
					);
					break;
				}
			}
		}
		return diagnostics;
	},
};
