/**
 * Amain State Types: 57 syntax types + 15 token types
 *
 * Adapted from Amain paper's Java AST structure for TypeScript.
 * 57 syntax types (non-leaf AST nodes) + 15 token types (leaf categories) = 72 states
 *
 * Reference: https://github.com/CGCL-codes/Amain (ASE 2022)
 */

import * as ts from "typescript";

// ============================================================================
// 57 Syntax Types (non-leaf AST nodes, indices 0-56)
// ============================================================================

export const SYNTAX_TYPES = [
	// Declarations (0-9)
	"FunctionDeclaration", // 0
	"ArrowFunction", // 1
	"FunctionExpression", // 2
	"ClassDeclaration", // 3
	"InterfaceDeclaration", // 4
	"TypeAliasDeclaration", // 5
	"EnumDeclaration", // 6
	"MethodDeclaration", // 7
	"Constructor", // 8
	"GetAccessor", // 9

	// More declarations (10-19)
	"SetAccessor", // 10
	"PropertyDeclaration", // 11
	"Parameter", // 12
	"VariableDeclaration", // 13
	"ModuleDeclaration", // 14
	"ImportDeclaration", // 15
	"ExportDeclaration", // 16
	"NamespaceExportDeclaration", // 17
	"ImportClause", // 18
	"NamespaceImport", // 19

	// Statements (20-39)
	"IfStatement", // 20
	"ForStatement", // 21
	"ForOfStatement", // 22
	"ForInStatement", // 23
	"WhileStatement", // 24
	"DoWhileStatement", // 25
	"SwitchStatement", // 26
	"CaseClause", // 27
	"DefaultClause", // 28
	"TryStatement", // 29
	"CatchClause", // 30
	"ThrowStatement", // 31
	"ReturnStatement", // 32
	"BreakStatement", // 33
	"ContinueStatement", // 34
	"Block", // 35
	"EmptyStatement", // 36

	// More statements (37-39)
	"DebuggerStatement", // 37
	"LabeledStatement", // 38
	"WithStatement", // 39

	// Expressions (40-56)
	"BinaryExpression", // 40
	"UnaryExpression", // 41
	"PrefixUnaryExpression", // 42
	"PostfixUnaryExpression", // 43
	"ConditionalExpression", // 44
	"CallExpression", // 45
	"PropertyAccessExpression", // 46
	"ElementAccessExpression", // 47
	"NewExpression", // 48
	"ParenthesizedExpression", // 49
	"TypeAssertionExpression", // 50
	"AsExpression", // 51
	"NonNullExpression", // 52
	"TemplateExpression", // 53
	"ArrayLiteralExpression", // 54
	"ObjectLiteralExpression", // 55
	"ExpressionStatement", // 56
] as const;

// ============================================================================
// 15 Token Types (leaf node categories, indices 57-71)
// ============================================================================

export const TOKEN_TYPES = [
	"Identifier", // 57
	"StringLiteral", // 58
	"NumericLiteral", // 59
	"TrueKeyword", // 60
	"FalseKeyword", // 61
	"NullKeyword", // 62
	"UndefinedKeyword", // 63
	"ThisKeyword", // 64
	"SuperKeyword", // 65
	"RegularExpressionLiteral", // 66
	"NoSubstitutionTemplateLiteral", // 67
	"TemplateHead", // 68
	"TemplateMiddle", // 69
	"TemplateTail", // 70
	"ComputedPropertyName", // 71
] as const;

// ============================================================================
// Constants
// ============================================================================

export const NUM_SYNTAX: number = SYNTAX_TYPES.length; // 57
export const NUM_TOKEN: number = TOKEN_TYPES.length; // 15
export const NUM_STATES: number = NUM_SYNTAX + NUM_TOKEN; // 72

// ============================================================================
// State Index Mapping
// ============================================================================

/**
 * Map a TypeScript AST node to its Amain state index (0-71)
 */
export function getStateIndex(node: ts.Node): number {
	// Try syntax types first (0-56)
	const kindName = ts.SyntaxKind[node.kind];
	const syntaxIdx = SYNTAX_TYPES.indexOf(
		kindName as (typeof SYNTAX_TYPES)[number],
	);
	if (syntaxIdx !== -1) return syntaxIdx;

	// Map to token types (57-71) based on node kind
	if (ts.isIdentifier(node)) return 57;
	if (ts.isStringLiteral(node)) return 58;
	if (ts.isNumericLiteral(node)) return 59;
	if (node.kind === ts.SyntaxKind.TrueKeyword) return 60;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return 61;
	if (node.kind === ts.SyntaxKind.NullKeyword) return 62;
	if (node.kind === ts.SyntaxKind.UndefinedKeyword) return 63;
	if (node.kind === ts.SyntaxKind.ThisKeyword) return 64;
	if (node.kind === ts.SyntaxKind.SuperKeyword) return 65;
	if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return 66;
	if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return 67;
	if (node.kind === ts.SyntaxKind.TemplateHead) return 68;
	if (node.kind === ts.SyntaxKind.TemplateMiddle) return 69;
	if (node.kind === ts.SyntaxKind.TemplateTail) return 70;
	if (node.kind === ts.SyntaxKind.ComputedPropertyName) return 71;

	// Default: treat as identifier for any other leaf node
	return 57;
}

/**
 * Check if a node is a syntax type (non-leaf) vs token type (leaf)
 */
export function isSyntaxNode(node: ts.Node): boolean {
	return getStateIndex(node) < NUM_SYNTAX;
}

/**
 * Get state name for debugging
 */
export function getStateName(index: number): string {
	if (index < NUM_SYNTAX) return SYNTAX_TYPES[index];
	if (index < NUM_STATES) return TOKEN_TYPES[index - NUM_SYNTAX];
	return "Unknown";
}
