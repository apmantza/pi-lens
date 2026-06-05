/**
 * Shared types for ast-grep client, parser, and rule manager.
 *
 * Extracted to prevent circular dependencies between:
 * - ast-grep-client.ts
 * - ast-grep-parser.ts
 * - ast-grep-rule-manager.ts
 */

// =============================================================================
// RULE DESCRIPTIONS
// =============================================================================

export interface RuleDescription {
	id: string;
	message: string;
	note?: string;
	fix?: string; // Suggested fix from rule
	severity: "error" | "warning" | "info" | "hint";
	grade?: number;
}

// =============================================================================
// MATCHES (from sg-runner)
// =============================================================================

export interface SgMatch {
	file: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	text: string;
	replacement?: string;
}

export interface SgResult {
	matches: SgMatch[];
	error?: string;
}

// =============================================================================
// DIAGNOSTICS
// =============================================================================

interface AstGrepMetaVarNode {
	text: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
}

export interface AstGrepMatch {
	file: string;
	range: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
	text: string;
	lines?: string;
	language?: string;
	replacement?: string;
	metaVariables?: {
		single: Record<string, AstGrepMetaVarNode>;
		multi: Record<string, AstGrepMetaVarNode[]>;
		transformed: Record<string, string>;
	};
	labels?: Array<{
		range: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
	}>;
}

export interface AstGrepDiagnostic {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	rule: string;
	ruleDescription?: RuleDescription;
	file: string;
	fix?: string;
	note?: string;
}

// =============================================================================
// JSON FORMAT (ast-grep CLI output)
// =============================================================================

export interface AstGrepJsonDiagnostic {
	ruleId: string;
	severity: string;
	message: string;
	note?: string;
	labels: Array<{
		text: string;
		range: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		file?: string;
		style: string;
	}>;
	// Legacy format support
	Message?: { text: string };
	Severity?: string;
	spans?: Array<{
		context: string;
		range: {
			start: { line: number; column: number };
			end: { line: number; column: number };
		};
		file: string;
	}>;
	name?: string;
}
