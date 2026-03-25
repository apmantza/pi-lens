/**
 * LSP Types - Core types for the pi-local LSP client
 * Simplified from the full LSP spec to what we actually need
 */

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export enum DiagnosticSeverity {
	Error = 1,
	Warning = 2,
	Information = 3,
	Hint = 4,
}

export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverity;
	code?: string | number;
	source?: string;
	message: string;
}

export interface SymbolInfo {
	name: string;
	kind: string;
	line: number;
	containerName?: string;
}

export interface HoverInfo {
	type: string;
	documentation?: string;
}

export interface Location {
	file: string;
	line: number;
	character: number;
}

export interface CompletionItem {
	name: string;
	kind: string;
	sortText?: string;
}

export interface FoldingRange {
	startLine: number;
	endLine: number;
	kind: string;
}
