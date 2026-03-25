import * as fs from "node:fs";
import * as path from "node:path";
import type { RuleDescription } from "./ast-grep-client.js";

export class AstGrepRuleManager {
	private ruleDescriptions: Map<string, RuleDescription> | null = null;

	constructor(
		private ruleDir: string,
		private log: (msg: string) => void,
	) {}

	loadRuleDescriptions(): Map<string, RuleDescription> {
		if (this.ruleDescriptions !== null) return this.ruleDescriptions;

		const descriptions = new Map<string, RuleDescription>();
		const possiblePaths = [
			path.join(this.ruleDir, "ast-grep-rules", "rules"),
			path.join(this.ruleDir, "rules"),
			this.ruleDir,
		];

		const rulesPath = possiblePaths.find((p) => fs.existsSync(p));

		if (!rulesPath) {
			this.log(
				`Rule descriptions: no rules directory found in ${possiblePaths.join(", ")}`,
			);
			this.ruleDescriptions = descriptions;
			return descriptions;
		}

		try {
			const files = fs.readdirSync(rulesPath).filter((f) => f.endsWith(".yml"));
			this.log(`Loaded ${files.length} rule descriptions from ${rulesPath}`);
			for (const file of files) {
				const filePath = path.join(rulesPath, file);
				const content = fs.readFileSync(filePath, "utf-8");
				const rule = this.parseRuleYaml(content);
				if (rule) {
					descriptions.set(rule.id, rule);
				}
			}
		} catch (err: any) {
			this.log(`Failed to load rule descriptions: ${err.message}`);
		}

		this.ruleDescriptions = descriptions;
		return descriptions;
	}

	private parseRuleYaml(content: string): RuleDescription | null {
		const result: Partial<RuleDescription> = {};

		const idMatch = content.match(/^id:\s*(.+)$/m);
		if (idMatch) result.id = idMatch[1].trim();

		const msgMatch =
			content.match(/^message:\s*"([^"]+)"/m) ||
			content.match(/^message:\s*'([^']+)'/m) ||
			content.match(/^message:\s*(.+)$/m);
		if (msgMatch)
			result.message = (msgMatch[3] || msgMatch[2] || msgMatch[1]).trim();

		const noteMatch = content.match(
			/^note:\s*\|([\s\S]*?)(?=^\w|\n\n|\nrule:)/m,
		);
		if (noteMatch) {
			result.note = noteMatch[1]
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.join(" ");
		}

		const sevMatch = content.match(/^severity:\s*(.+)$/m);
		if (sevMatch) result.severity = this.mapSeverity(sevMatch[1].trim());

		const gradeMatch = content.match(/Grade\s+(\d+\.\d+)/i);
		if (gradeMatch) result.grade = parseFloat(gradeMatch[1]);

		if (result.id && result.message) {
			return result as RuleDescription;
		}
		return null;
	}

	private mapSeverity(severity: string): RuleDescription["severity"] {
		const lower = severity.toLowerCase();
		if (lower === "error") return "error";
		if (lower === "warning") return "warning";
		if (lower === "info") return "info";
		return "hint";
	}
}
