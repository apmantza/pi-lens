/**
 * Code-quality FactRules
 *
 * QR-001  no-magic-numbers        — bare numeric literals other than 0 and 1
 * QR-002  no-boolean-params       — function params typed as `boolean`
 * QR-003  high-import-coupling    — file imports from more than 10 distinct modules
 * QR-004  no-complex-conditionals — single condition with > 2 logical operators
 * QR-005  high-entropy-string     — string literals with suspiciously high Shannon entropy
 */

import { ts } from "../../deps/typescript.js";
import type { FactRule } from "../fact-provider-types.js";
import type { Diagnostic } from "../types.js";
import type { ImportEntry } from "../facts/import-facts.js";

// ---------- shared helpers ----------

function tsFile(ctx: { filePath: string }): boolean {
	return /\.tsx?$/.test(ctx.filePath);
}

function createSF(filePath: string, content: string): ts.SourceFile {
	return ts.createSourceFile(
		filePath,
		content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
}

function makeD(
	rule: string,
	filePath: string,
	line: number,
	col: number,
	message: string,
): Diagnostic {
	return {
		id: `${rule}:${filePath}:${line}:${col}`,
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

// ---------- QR-001: no-magic-numbers ----------

const MAGIC_NUMBER_ALLOWLIST = new Set([0, 1, -1, 2, 100]);

// Node kinds where a number literal is expected (not magic)
function isExpectedNumericContext(node: ts.NumericLiteral): boolean {
	const parent = node.parent;
	if (!parent) return false;
	const pk = parent.kind;

	// const X = 42  /  let X = 42  /  var X = 42
	if (pk === ts.SyntaxKind.VariableDeclaration) return true;
	// enum Member = 42
	if (pk === ts.SyntaxKind.EnumMember) return true;
	// object property: { timeout: 5000 }
	if (pk === ts.SyntaxKind.PropertyAssignment) return true;
	// default parameter: fn(x = 5)
	if (pk === ts.SyntaxKind.Parameter) return true;
	// type literal: foo: 42
	if (pk === ts.SyntaxKind.PropertyDeclaration) return true;
	// array index access: arr[2]
	if (pk === ts.SyntaxKind.ElementAccessExpression) return true;
	// export const X = 42
	if (pk === ts.SyntaxKind.ExportAssignment) return true;
	// unary minus: -1 (parent is PrefixUnaryExpression whose parent is one of the above)
	if (pk === ts.SyntaxKind.PrefixUnaryExpression) {
		const gp = parent.parent;
		if (!gp) return false;
		const gpk = gp.kind;
		return (
			gpk === ts.SyntaxKind.VariableDeclaration ||
			gpk === ts.SyntaxKind.EnumMember ||
			gpk === ts.SyntaxKind.PropertyAssignment ||
			gpk === ts.SyntaxKind.Parameter ||
			gpk === ts.SyntaxKind.PropertyDeclaration
		);
	}
	return false;
}

// Files that are expected to contain raw numeric literals by design
const MAGIC_NUMBER_SKIP_FILES = /[/\\](constants?|config|defaults?|enums?|settings)[^/\\]*\.tsx?$/i;

export const noMagicNumbersRule: FactRule = {
	id: "no-magic-numbers",
	requires: ["file.content"],
	appliesTo(ctx) {
		return tsFile(ctx) && !MAGIC_NUMBER_SKIP_FILES.test(ctx.filePath);
	},
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const sf = createSF(ctx.filePath, content);
		const diagnostics: Diagnostic[] = [];

		function visit(node: ts.Node) {
			if (ts.isNumericLiteral(node)) {
				const val = Number(node.text);
				if (!MAGIC_NUMBER_ALLOWLIST.has(val) && !isExpectedNumericContext(node)) {
					const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
					diagnostics.push(
						makeD(
							"no-magic-numbers",
							ctx.filePath,
							line + 1,
							character + 1,
							`Magic number ${node.text} — extract to a named constant`,
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

// ---------- QR-002: no-boolean-params ----------

// Names that unambiguously communicate boolean intent — skip them
const BOOLEAN_PREFIX_OK = /^(is|has|should|can|was|did|will|are|use|allow|skip|needs|wait|want|auto|show|hide|keep|ignore|include|exclude)[A-Z_]/;
const BOOLEAN_SUFFIX_OK = /(Only|Enabled|Disabled|Allowed|Changed|Available|Active|Silent|Strict|Required|Blocking|Verbose|Force|Lazy|Auto)$/;
const BOOLEAN_WHOLE_OK = /^(enabled|disabled|silent|verbose|blocking|strict|force|lazy|allow|allowed|required|active)$/i;

export const noBooleanParamsRule: FactRule = {
	id: "no-boolean-params",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const sf = createSF(ctx.filePath, content);
		const diagnostics: Diagnostic[] = [];

		function checkParams(params: ts.NodeArray<ts.ParameterDeclaration>) {
			for (const param of params) {
				if (!param.type) continue;
				const name =
					ts.isIdentifier(param.name) ? param.name.text : "";
				if (
				BOOLEAN_PREFIX_OK.test(name) ||
				BOOLEAN_SUFFIX_OK.test(name) ||
				BOOLEAN_WHOLE_OK.test(name) ||
				name.startsWith("_")
			) continue;

				const isBoolean =
					param.type.kind === ts.SyntaxKind.BooleanKeyword ||
					(ts.isUnionTypeNode(param.type) &&
						param.type.types.every(
							(t) =>
								t.kind === ts.SyntaxKind.BooleanKeyword ||
								(ts.isLiteralTypeNode(t) &&
									(t.literal.kind === ts.SyntaxKind.TrueKeyword ||
										t.literal.kind === ts.SyntaxKind.FalseKeyword)),
						));

				if (!isBoolean) continue;
				const { line, character } = sf.getLineAndCharacterOfPosition(param.getStart(sf));
				diagnostics.push(
					makeD(
						"no-boolean-params",
						ctx.filePath,
						line + 1,
						character + 1,
						`Boolean parameter '${name || "?"}' — use a descriptive options object or string enum instead`,
					),
				);
			}
		}

		function visit(node: ts.Node) {
			if (
				ts.isFunctionDeclaration(node) ||
				ts.isFunctionExpression(node) ||
				ts.isArrowFunction(node) ||
				ts.isMethodDeclaration(node)
			) {
				checkParams(node.parameters);
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);
		return diagnostics;
	},
};

// ---------- QR-003: high-import-coupling ----------

const IMPORT_COUPLING_THRESHOLD = 15;
// Registry/hub files are intentionally wide — they import everything by design
const IMPORT_COUPLING_EXEMPT = /[/\\](index|integration)\.[cm]?tsx?$/;

export const highImportCouplingRule: FactRule = {
	id: "high-import-coupling",
	requires: ["file.imports"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		if (IMPORT_COUPLING_EXEMPT.test(ctx.filePath)) return [];
		const imports = store.getFileFact<ImportEntry[]>(ctx.filePath, "file.imports") ?? [];
		// Count distinct module sources
		const sources = new Set(imports.map((i) => i.source));
		const count = sources.size;
		if (count <= IMPORT_COUPLING_THRESHOLD) return [];
		return [
			makeD(
				"high-import-coupling",
				ctx.filePath,
				1,
				1,
				`File imports from ${count} distinct modules (threshold: ${IMPORT_COUPLING_THRESHOLD}) — split responsibilities`,
			),
		];
	},
};

// ---------- QR-004: no-complex-conditionals ----------

const MAX_LOGICAL_OPS = 4;

function countLogicalOps(node: ts.Node): number {
	let count = 0;
	function walk(n: ts.Node) {
		if (
			ts.isBinaryExpression(n) &&
			(n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
				n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
				n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
		) {
			count++;
		}
		if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
			count++;
		}
		ts.forEachChild(n, walk);
	}
	walk(node);
	return count;
}

export const noComplexConditionalsRule: FactRule = {
	id: "no-complex-conditionals",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const sf = createSF(ctx.filePath, content);
		const diagnostics: Diagnostic[] = [];

		function visit(node: ts.Node) {
			let condNode: ts.Expression | undefined;

			if (ts.isIfStatement(node)) condNode = node.expression;
			else if (ts.isWhileStatement(node)) condNode = node.expression;
			else if (ts.isDoStatement(node)) condNode = node.expression;
			else if (ts.isForStatement(node) && node.condition) condNode = node.condition;
			else if (ts.isConditionalExpression(node)) condNode = node.condition;

			if (condNode) {
				const ops = countLogicalOps(condNode);
				if (ops > MAX_LOGICAL_OPS) {
					const { line, character } = sf.getLineAndCharacterOfPosition(
						condNode.getStart(sf),
					);
					diagnostics.push(
						makeD(
							"no-complex-conditionals",
							ctx.filePath,
							line + 1,
							character + 1,
							`Condition has ${ops} logical operators (max: ${MAX_LOGICAL_OPS}) — extract sub-conditions to named variables`,
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

// ---------- QR-005: high-entropy-string ----------

const ENTROPY_THRESHOLD = 4.2;
const MIN_ENTROPY_STRING_LEN = 16;

function shannonEntropy(s: string): number {
	if (s.length === 0) return 0;
	const freq = new Map<string, number>();
	for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
	let h = 0;
	for (const count of freq.values()) {
		const p = count / s.length;
		h -= p * Math.log2(p);
	}
	return h;
}

// Strings that look like known patterns rather than actual secrets
const ENTROPY_SKIP_PATTERNS = [
	/^https?:\/\//,           // URLs
	/\s/,                     // contains whitespace → prose/template
	/^[./\\]/,                // path-like (starts with . or / or \)
	/\//,                     // contains forward slash → file path or URL fragment
	/^\$\{/,                  // template expression
	/\$\$\$/,                 // ast-grep metavariable patterns
	/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, // email
	// Architecture/toolchain triples like stable-x86_64-pc-windows-gnu
	/^[a-z]+-[a-z0-9_]+-[a-z]+-[a-z]+-[a-z]+$/,
	// Strings composed mainly of identifier chars with hyphens (config keys, target triples)
	/^[a-z][a-z0-9]*(-[a-z0-9]+){3,}$/i,
	// OAuth/OIDC client IDs — public identifiers, not secrets (hex or alphanumeric, 20-40 chars)
	// Variable names containing "clientId", "client_id", "appId", "app_id" are public by OAuth spec
	/^[a-f0-9]{20,40}$/,      // hex client IDs like f0304373b74a44d2b584a3fb70ca9e56
];

export const highEntropyStringRule: FactRule = {
	id: "high-entropy-string",
	requires: ["file.content"],
	appliesTo: tsFile,
	evaluate(ctx, store) {
		const content = store.getFileFact<string>(ctx.filePath, "file.content");
		if (!content) return [];
		const sf = createSF(ctx.filePath, content);
		const diagnostics: Diagnostic[] = [];

		function visit(node: ts.Node) {
			if (ts.isStringLiteral(node)) {
				const s = node.text;
				if (s.length < MIN_ENTROPY_STRING_LEN) {
					ts.forEachChild(node, visit);
					return;
				}
				if (ENTROPY_SKIP_PATTERNS.some((p) => p.test(s))) {
					ts.forEachChild(node, visit);
					return;
				}
				const h = shannonEntropy(s);
				if (h >= ENTROPY_THRESHOLD) {
					const { line, character } = sf.getLineAndCharacterOfPosition(
						node.getStart(sf),
					);
					diagnostics.push({
						...makeD(
							"high-entropy-string",
							ctx.filePath,
							line + 1,
							character + 1,
							`High-entropy string literal (entropy ${h.toFixed(2)}) — possible hardcoded secret`,
						),
						severity: "error",
						semantic: "blocking",
					});
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);
		return diagnostics;
	},
};
