import * as fs from "node:fs";
import * as path from "node:path";
import type { RuleDescription } from "./ast-grep-types.js";
import type { BundledResourceHealth } from "./bundled-resource-health.js";

/**
 * The candidate sub-paths under `ruleDir` that hold ast-grep rule
 * descriptions — SINGLE source of truth shared by `loadRuleDescriptions`
 * (the real read) and `checkAstGrepRulesHealth` (the #2636 observational
 * probe), so the two can never drift apart on "where do rules live".
 */
export function candidateAstGrepRulesPaths(ruleDir: string): string[] {
	return [
		path.join(ruleDir, "ast-grep-rules", "rules"),
		path.join(ruleDir, "rules"),
		ruleDir,
	];
}

/**
 * Classify whether `ruleDir` (the resolved ast-grep rules root, `rules/`
 * inside the bundled package or the project override) yields any loadable
 * `.yml` rule description — mirroring `loadRuleDescriptions`'s OWN
 * resolution EXACTLY (first existing candidate wins, then its `.yml`
 * files), so this never reports a status `loadRuleDescriptions` itself
 * would disagree with. Purely observational: never throws, and does not
 * gate what `ruleDir` `AstGrepClient` uses (#2636, following #2626 review
 * F1 — the acceptance criteria ask for a RECORD, never a changed resolution).
 */
export function checkAstGrepRulesHealth(
	ruleDir: string,
): BundledResourceHealth {
	const possiblePaths = candidateAstGrepRulesPaths(ruleDir);
	let rulesPath: string | undefined;
	for (const candidate of possiblePaths) {
		if (fs.existsSync(candidate)) {
			rulesPath = candidate;
			break;
		}
	}
	if (!rulesPath) {
		// None of the three candidates exist — distinguish `ruleDir` itself
		// being unreadable (EACCES and friends) from it simply being absent
		// (ENOENT), matching #2626 review F4's ENOENT/EACCES split.
		try {
			fs.readdirSync(ruleDir);
		} catch (error) {
			const fsErrorCode = (error as NodeJS.ErrnoException)?.code;
			if (fsErrorCode && fsErrorCode !== "ENOENT") {
				return { status: "unreadable", fsErrorCode };
			}
		}
		return { status: "absent" };
	}
	let entries: string[];
	try {
		entries = fs.readdirSync(rulesPath).filter((f) => f.endsWith(".yml"));
	} catch (error) {
		const fsErrorCode = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
		return { status: "unreadable", fsErrorCode };
	}
	return entries.length > 0
		? { status: "healthy", entryCount: entries.length }
		: { status: "empty" };
}

export class AstGrepRuleManager {
	private ruleDescriptions: Map<string, RuleDescription> | null = null;

	constructor(
		private ruleDir: string,
		private log: (msg: string) => void,
	) {}

	loadRuleDescriptions(): Map<string, RuleDescription> {
		if (this.ruleDescriptions !== null) return this.ruleDescriptions;

		const descriptions = new Map<string, RuleDescription>();
		const possiblePaths = candidateAstGrepRulesPaths(this.ruleDir);

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
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.join(" ");
		}

		const sevMatch = content.match(/^severity:\s*(.+)$/m);
		if (sevMatch) result.severity = this.mapSeverity(sevMatch[1].trim());

		const gradeMatch = content.match(/Grade\s+(\d+\.\d+)/i);
		if (gradeMatch) result.grade = parseFloat(gradeMatch[1]);

		const fixMatch = content.match(/^fix:\s*\|?([\s\S]*?)(?=^\w|^rule:|Z)/m);
		if (fixMatch) {
			result.fix = fixMatch[1]
				.split(/\r?\n/)
				.map((line) => line.replace(/^\s*\|?\s*/, ""))
				.filter((line) => line.length > 0)
				.join("\n");
		}

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
