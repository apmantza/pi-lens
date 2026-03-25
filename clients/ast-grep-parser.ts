import * as path from "node:path";
import type { AstGrepDiagnostic, RuleDescription } from "./ast-grep-client.js";

// New ast-grep JSON format
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

export class AstGrepParser {
	constructor(
		private getRuleDescription: (ruleId: string) => RuleDescription | undefined,
		private mapSeverity: (severity: string) => AstGrepDiagnostic["severity"],
	) {}

	parseOutput(output: string, filterFile: string): AstGrepDiagnostic[] {
		const resolvedFilterFile = path.resolve(filterFile);

		try {
			const items: any[] = JSON.parse(output);
			if (Array.isArray(items)) {
				return items
					.map((item) => this.parseDiagnostic(item, resolvedFilterFile))
					.filter((d): d is AstGrepDiagnostic => d !== null);
			}
		} catch (err) {
			void err;
		}

		return output
			.split("\n")
			.filter((l) => l.trim())
			.map((line) => {
				try {
					return this.parseDiagnostic(JSON.parse(line), resolvedFilterFile);
				} catch (err) {
					void err;
					return null;
				}
			})
			.filter((d): d is AstGrepDiagnostic => d !== null);
	}

	private parseDiagnostic(
		item: AstGrepJsonDiagnostic,
		filterFile: string,
	): AstGrepDiagnostic | null {
		if (item.labels?.length) {
			return this.parseNewFormat(item, filterFile);
		}
		if (item.spans?.length) {
			return this.parseLegacyFormat(item, filterFile);
		}
		return null;
	}

	private parseNewFormat(
		item: AstGrepJsonDiagnostic,
		filterFile: string,
	): AstGrepDiagnostic | null {
		const label =
			item.labels.find((l) => l.style === "primary") || item.labels[0];
		const filePath = path.resolve(label.file || filterFile);
		if (filePath !== filterFile) return null;

		const start = label.range?.start || { line: 0, column: 0 };
		const end = label.range?.end || start;

		return {
			line: start.line + 1,
			column: start.column,
			endLine: end.line + 1,
			endColumn: end.column,
			severity: this.mapSeverity(item.severity),
			message: item.message || "Unknown issue",
			rule: item.ruleId || "unknown",
			ruleDescription: this.getRuleDescription(item.ruleId || "unknown"),
			file: filePath,
		};
	}

	private parseLegacyFormat(
		item: AstGrepJsonDiagnostic,
		filterFile: string,
	): AstGrepDiagnostic | null {
		const span = item.spans?.[0];
		if (!span) return null;
		const filePath = path.resolve(span.file || filterFile);
		if (filePath !== filterFile) return null;

		const start = span.range?.start || { line: 0, column: 0 };
		const end = span.range?.end || start;
		const ruleId = item.name || item.ruleId || "unknown";

		return {
			line: start.line + 1,
			column: start.column,
			endLine: end.line + 1,
			endColumn: end.column,
			severity: this.mapSeverity(
				item.severity || item.Severity || "warning",
			),
			message: item.Message?.text || item.message || "Unknown issue",
			rule: ruleId,
			ruleDescription: this.getRuleDescription(ruleId),
			file: filePath,
		};
	}
}
