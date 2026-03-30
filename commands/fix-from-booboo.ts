/**
 * /lens-booboo-fix command - Sequential fixing from booboo results
 *
 * Reads the latest /lens-booboo review and applies automated fixes
 * for the issues found. Works sequentially through fixable issues.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import type { BiomeClient } from "../clients/biome-client.js";
import type { ComplexityClient } from "../clients/complexity-client.js";
import type { JscpdClient } from "../clients/jscpd-client.js";
import type { KnipClient } from "../clients/knip-client.js";
import type { RuffClient } from "../clients/ruff-client.js";
import type { TypeScriptClient } from "../clients/typescript-client.js";
import { getSourceFiles } from "../clients/scan-utils.js";

interface FixClients {
	tsClient: TypeScriptClient;
	astGrep: AstGrepClient;
	ruff: RuffClient;
	biome: BiomeClient;
	knip: KnipClient;
	jscpd: JscpdClient;
	complexity: ComplexityClient;
}

interface BoobooReview {
	meta: {
		timestamp: string;
		project: string;
		path: string;
		totalIssues: number;
		fixableCount: number;
		refactorNeeded: number;
		runners: Array<{
			name: string;
			status: string;
			findings: number;
			time: string;
		}>;
	};
}

export async function handleFixFromBooboo(
	args: string,
	ctx: ExtensionContext,
	clients: FixClients,
	pi: ExtensionAPI,
): Promise<void> {
	const targetPath = args.trim() || ctx.cwd || process.cwd();

	// Find latest booboo review
	const reviewDir = path.join(targetPath, ".pi-lens", "reviews");
	let latestReview: BoobooReview | null = null;

	try {
		const files = nodeFs.readdirSync(reviewDir);
		const jsonFiles = files
			.filter((f) => f.startsWith("booboo-") && f.endsWith(".json"))
			.sort()
			.reverse();

		if (jsonFiles.length === 0) {
			ctx.ui.notify("❌ No /lens-booboo review found. Run `/lens-booboo` first to scan for issues.", "error");
			return;
		}

		const latestReviewPath = path.join(reviewDir, jsonFiles[0]);
		latestReview = JSON.parse(
			nodeFs.readFileSync(latestReviewPath, "utf-8"),
		) as BoobooReview;
	} catch {
		ctx.ui.notify("❌ No /lens-booboo review found. Run `/lens-booboo` first to scan for issues.", "error");
		return;
	}

	if (!latestReview) {
		ctx.ui.notify("❌ Failed to parse booboo review. Run `/lens-booboo` again.", "error");
		return;
	}

	// Debug: log the structure we received
	console.error("[fix-from-booboo] Review structure:", JSON.stringify(latestReview, null, 2).substring(0, 500));

	// Check if meta exists
	if (!latestReview.meta) {
		ctx.ui.notify("❌ Invalid booboo review format (missing meta). Run `/lens-booboo` again.", "error");
		return;
	}

	// Use meta properties directly (summary object doesn't exist in JSON)
	const totalIssues = latestReview.meta.totalIssues ?? 0;
	const fixableCount = latestReview.meta.fixableCount ?? 0;
	const refactorNeeded = latestReview.meta.refactorNeeded ?? 0;
	const timestamp = latestReview.meta.timestamp ?? "unknown";
	const runners = latestReview.meta.runners ?? [];

	ctx.ui.notify(
		`🔧 Fixing from review: ${timestamp} (${fixableCount} fixable issues)`,
		"info",
	);

	const results: string[] = [];
	let fixedCount = 0;
	const isTsProject = nodeFs.existsSync(path.join(targetPath, "tsconfig.json"));

	// Get source files (excluding tests and build artifacts)
	const sourceFiles = getSourceFiles(targetPath, isTsProject);

	// 1. Biome auto-fixes for TS/JS files
	if (clients.biome.isAvailable()) {
		let biomeFixed = 0;
		for (const file of sourceFiles) {
			if (clients.biome.isSupportedFile(file)) {
				const result = clients.biome.fixFile(file);
				if (result.success) {
					biomeFixed += result.fixed;
				}
			}
		}
		if (biomeFixed > 0) {
			fixedCount += biomeFixed;
			results.push(`✅ Biome: Fixed ${biomeFixed} issue(s) in ${sourceFiles.filter(f => clients.biome.isSupportedFile(f)).length} file(s)`);
		}
	}

	// 2. Ruff auto-fixes for Python files
	if (clients.ruff.isAvailable()) {
		let ruffFixed = 0;
		for (const file of sourceFiles) {
			if (file.endsWith(".py")) {
				const result = clients.ruff.fixFile(file);
				if (result.success) {
					ruffFixed += result.fixed;
				}
			}
		}
		if (ruffFixed > 0) {
			fixedCount += ruffFixed;
			results.push(`✅ Ruff: Fixed ${ruffFixed} issue(s)`);
		}
	}

	// 3. Report findings that need manual review
	const findingsToReview: string[] = [];

	// Check for issues from booboo review runners
	for (const runner of runners) {
		if (runner.findings === 0) continue;

		switch (runner.name) {
			case "ast-grep (design smells)":
				findingsToReview.push(`🔧 AST-grep: ${runner.findings} design smell(s) — review for structural fixes`);
				break;
			case "ast-grep (similar functions)":
				findingsToReview.push(`🔧 Similar functions: ${runner.findings} group(s) — consider extracting shared logic`);
				break;
			case "semantic similarity (Amain)":
				findingsToReview.push(`🔧 Semantic duplicates: ${runner.findings} pair(s) — may need consolidation`);
				break;
			case "complexity metrics":
				findingsToReview.push(`📊 Complexity: ${runner.findings} file(s) with high complexity — consider refactoring`);
				break;
			case "duplicate code (jscpd)":
				findingsToReview.push(`📋 Duplicates: ${runner.findings} block(s) — extract shared code`);
				break;
			case "dead code (Knip)":
				findingsToReview.push(`🗑️ Dead code: ${runner.findings} unused export(s)/file(s) — safe to remove after review`);
				break;
		}
	}

	// Summary
	const outputParts = [
		`🔧 /lens-booboo-fix from ${timestamp}`,
		`Found ${totalIssues} total issues, ${fixableCount} fixable`,
		"",
		"=== Automatic Fixes ===",
		...(results.length > 0 ? results : ["ℹ️ No automatic fixes applied"]),
		"",
		"=== Manual Review Required ===",
		...(findingsToReview.length > 0 ? findingsToReview : ["✅ No manual fixes required"]),
		"",
		fixedCount > 0 ? `✅ Fixed ${fixedCount} issue(s) automatically` : "",
		"",
		"Next steps:",
		"- Review manual fixes above",
		fixedCount > 0 ? "- Run `/lens-booboo` again to verify automatic fixes" : "- Run `/lens-booboo` to see current state",
	].filter(Boolean);

	const message = outputParts.join("\n");
	
	// If there are manual fixes required, send as user message to prompt AI action
	if (findingsToReview.length > 0) {
		pi.sendUserMessage(message);
	} else {
		ctx.ui.notify(message, "info");
	}
}
