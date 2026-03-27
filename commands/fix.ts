/**
 * Fix command for pi-lens
 *
 * Automated fix loop that scans for issues and generates fix plans.
 * Supports --loop flag for automatic iteration via auto-loop engine.
 */

import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import type { BiomeClient } from "../clients/biome-client.js";
import type { ComplexityClient } from "../clients/complexity-client.js";
import type { JscpdClient } from "../clients/jscpd-client.js";
import type { KnipClient } from "../clients/knip-client.js";
import type { RuffClient } from "../clients/ruff-client.js";
import { createAutoLoop } from "../clients/auto-loop.js";
import {
	scanAll,
	type FixScanResults,
	type AstIssue,
} from "../clients/fix-scanners.js";

// --- Auto-loop singleton ---
let fixLoop: ReturnType<typeof createAutoLoop> | null = null;

function getFixLoop(pi: ExtensionAPI) {
	if (!fixLoop) {
		fixLoop = createAutoLoop(pi, {
			name: "fix",
			maxIterations: 3,
			command: "/lens-booboo-fix --loop",
			exitPatterns: [
				/✅ BOOBOO FIX LOOP COMPLETE/,
				/⚠️ BOOBOO FIX LOOP STOPPED/,
				/No more fixable issues/,
				/Max iterations.*reached/,
			],
		});
	}
	return fixLoop;
}

// --- Session management ---
interface FixSession {
	iteration: number;
	counts: Record<string, number>;
	falsePositives: string[];
}

function loadSession(sessionFile: string): FixSession {
	try {
		const session = JSON.parse(nodeFs.readFileSync(sessionFile, "utf-8"));
		return {
			iteration: session.iteration || 0,
			counts: session.counts || {},
			falsePositives: session.falsePositives || [],
		};
	} catch {
		return { iteration: 0, counts: {}, falsePositives: [] };
	}
}

function saveSession(sessionFile: string, session: FixSession): void {
	nodeFs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	nodeFs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), "utf-8");
}

function resetSession(sessionFile: string): FixSession {
	try {
		nodeFs.unlinkSync(sessionFile);
	} catch {
		// Ignore if doesn't exist
	}
	return { iteration: 0, counts: {}, falsePositives: [] };
}

// --- Issue ID helpers ---
const issueId = (type: string, file: string, line?: number): string =>
	line !== undefined ? `${type}:${file}:${line}` : `${type}:${file}`;

const isFalsePositive = (id: string, session: FixSession): boolean =>
	session.falsePositives.includes(id);

// --- Plan generation ---
function generatePlan(
	results: FixScanResults,
	session: FixSession,
	isTsProject: boolean,
	prevCounts: Record<string, number>,
): string {
	const MAX_ITERATIONS = 3;

	// Filter out false positives
	const filteredDups = results.duplicates.filter(
		(c) => !isFalsePositive(issueId("duplicate", c.fileA, c.startA), session),
	);
	const filteredDeadCode = results.deadCode.filter(
		(i) => !isFalsePositive(issueId("dead_code", i.file ?? i.name), session),
	);
	const filteredBiome = results.biomeIssues.filter(
		(i) => !isFalsePositive(issueId("biome", i.file, i.line), session),
	);
	const filteredSlop = results.slopFiles.filter(
		(f) => !isFalsePositive(issueId("slop", f.file), session),
	);

	// Filter ast issues (exclude skip rules and false positives)
	const agentTasks = results.astIssues.filter(
		(i) => !isFalsePositive(issueId("ast", i.file, i.line), session),
	);

	const totalFixable =
		filteredDups.length +
		filteredDeadCode.length +
		agentTasks.length +
		filteredBiome.length +
		filteredSlop.length;

	// Check for no progress
	const prevTotal = Object.values(prevCounts).reduce((a, b) => a + b, 0);
	const noProgress = session.iteration > 1 && prevTotal === totalFixable && totalFixable > 0;

	// Completion/stopped messages
	if (totalFixable === 0) {
		const fpNote =
			session.falsePositives.length > 0
				? `\n\n📝 ${session.falsePositives.length} item(s) marked as false positives.`
				: "";
		return `✅ BOOBOO FIX LOOP COMPLETE — No more fixable issues found after ${session.iteration} iteration(s).${fpNote}`;
	}

	if (noProgress) {
		return `⚠️ BOOBOO FIX LOOP STOPPED — No progress after ${session.iteration} iteration(s).\n\nRemaining items may be false positives. Mark with: /lens-booboo-fix --false-positive "<type>:<file>:<line>"`;
	}

	// Build plan
	const lines: string[] = [];
	lines.push(`📋 BOOBOO FIX PLAN — Iteration ${session.iteration}/${MAX_ITERATIONS} (${totalFixable} fixable items remaining)`);
	lines.push("");

	// Duplicates
	if (filteredDups.length > 0) {
		lines.push(`## 🔁 Duplicate code [${filteredDups.length} block(s)] — fix first`);
		lines.push("→ Extract duplicated blocks into shared utilities.");
		for (const clone of filteredDups.slice(0, 5)) {
			lines.push(`  - ${clone.lines} lines: \`${clone.fileA}:${clone.startA}\` ↔ \`${clone.fileB}:${clone.startB}\``);
		}
		if (filteredDups.length > 5) lines.push(`  ... and ${filteredDups.length - 5} more`);
		lines.push("");
	}

	// Dead code
	if (filteredDeadCode.length > 0) {
		lines.push(`## 🗑️ Dead code [${filteredDeadCode.length} item(s)]`);
		for (const issue of filteredDeadCode.slice(0, 10)) {
			lines.push(`  - [${issue.type}] \`${issue.name}\`${issue.file ? ` in ${issue.file}` : ""}`);
		}
		if (filteredDeadCode.length > 10) lines.push(`  ... and ${filteredDeadCode.length - 10} more`);
		lines.push("");
	}

	// AST issues to fix
	if (agentTasks.length > 0) {
		lines.push(`## 🔨 Fix these [${agentTasks.length} items]`);
		const grouped = new Map<string, AstIssue[]>();
		for (const t of agentTasks) {
			const list = grouped.get(t.rule) ?? [];
			list.push(t);
			grouped.set(t.rule, list);
		}
		for (const [rule, issues] of grouped) {
			lines.push(`### ${rule} (${issues.length})`);
			for (const issue of issues.slice(0, 10)) {
				lines.push(`  - \`${issue.file}:${issue.line}\``);
			}
			if (issues.length > 10) lines.push(`  ... and ${issues.length - 10} more`);
			lines.push("");
		}
	}

	// Biome lint
	if (filteredBiome.length > 0) {
		lines.push(`## 🟠 Biome lint [${filteredBiome.length} items]`);
		for (const d of filteredBiome.slice(0, 5)) {
			lines.push(`  - \`${d.file}:${d.line}\` [${d.rule}] ${d.message}`);
		}
		if (filteredBiome.length > 5) lines.push(`  ... and ${filteredBiome.length - 5} more`);
		lines.push("");
	}

	// AI slop
	if (filteredSlop.length > 0) {
		lines.push(`## 🤖 AI Slop indicators [${filteredSlop.length} files]`);
		for (const { file, warnings } of filteredSlop.slice(0, 5)) {
			lines.push(`  - \`${file}\`: ${warnings.map((w) => w.split(" — ")[0]).join(", ")}`);
		}
		lines.push("");
	}

	lines.push("---");
	lines.push('**ACTION REQUIRED**: Fix items above, then run `/lens-booboo-fix --loop` again.');
	lines.push('Mark false positives with: `/lens-booboo-fix --false-positive "type:file:line"`');

	return lines.join("\n");
}

// --- Main handler ---
export async function handleFix(
	args: string,
	ctx: ExtensionContext,
	clients: {
		tsClient: any;
		astGrep: AstGrepClient;
		ruff: RuffClient;
		biome: BiomeClient;
		knip: KnipClient;
		jscpd: JscpdClient;
		complexity: ComplexityClient;
	},
	pi: ExtensionAPI,
	ruleActions: Record<string, { type: string; note: string }>,
) {
	const resetRequested = args.includes("--reset");
	const loopMode = args.includes("--loop");
	const fpMatch = args.match(/--false-positive\s+"([^"]+)"/);
	const falsePositiveId = fpMatch?.[1];

	// Clean args
	const cleanArgs = args
		.replace("--reset", "")
		.replace("--loop", "")
		.replace(/--false-positive\s+"[^"]+"/, "")
		.trim();
	const targetPath = cleanArgs || ctx.cwd || process.cwd();

	const sessionFile = path.join(process.cwd(), ".pi-lens", "fix-session.json");
	const configPath = path.join(
		typeof __dirname !== "undefined" ? __dirname : ".",
		"..",
		"rules",
		"ast-grep-rules",
		".sgconfig.yml",
	);

	// Load session
	let session = loadSession(sessionFile);
	if (resetRequested) {
		session = resetSession(sessionFile);
		ctx.ui.notify("🔄 Fix session reset.", "info");
	}

	// Handle false positive marking
	if (falsePositiveId) {
		if (!session.falsePositives.includes(falsePositiveId)) {
			session.falsePositives.push(falsePositiveId);
			saveSession(sessionFile, session);
			ctx.ui.notify(`✅ Marked as false positive: "${falsePositiveId}"`, "info");
		}
		return;
	}

	// Start auto-loop if requested
	const loop = getFixLoop(pi);
	if (loopMode && !loop.getState().active) {
		loop.start(ctx);
	}

	ctx.ui.notify("🔧 Running booboo fix loop...", "info");

	const isTsProject = nodeFs.existsSync(path.join(targetPath, "tsconfig.json"));

	// Auto-fix with Biome + Ruff
	if (!pi.getFlag("no-biome") && clients.biome.isAvailable()) {
		childProcess.spawnSync("npx", ["@biomejs/biome", "check", "--write", "--unsafe", targetPath], {
			encoding: "utf-8",
			timeout: 30000,
			shell: true,
		});
	}
	if (!pi.getFlag("no-ruff") && clients.ruff.isAvailable()) {
		childProcess.spawnSync("ruff", ["check", "--fix", targetPath], { encoding: "utf-8", timeout: 15000, shell: true });
		childProcess.spawnSync("ruff", ["format", targetPath], { encoding: "utf-8", timeout: 15000, shell: true });
	}

	// Run all scanners
	const prevCounts = { ...session.counts };
	session.iteration++;

	const results = scanAll(clients, targetPath, isTsProject, configPath);

	// Update session counts
	session.counts = {
		duplicates: results.duplicates.length,
		dead_code: results.deadCode.length,
		ast_issues: results.astIssues.length,
		biome_issues: results.biomeIssues.length,
		slop_files: results.slopFiles.length,
	};
	saveSession(sessionFile, session);

	// Generate and send plan
	const plan = generatePlan(results, session, isTsProject, prevCounts);
	const planPath = path.join(process.cwd(), ".pi-lens", "fix-plan.md");
	nodeFs.writeFileSync(planPath, `# Fix Plan — Iteration ${session.iteration}\n\n${plan}`, "utf-8");

	ctx.ui.notify(`📄 Fix plan saved: ${planPath}`, "info");
	pi.sendUserMessage(plan, { deliverAs: "followUp" });
}
