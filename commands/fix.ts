/**
 * Fix command for pi-lens
 *
 * Automated fix loop that scans for issues and generates fix plans.
 * Supports --loop flag for automatic iteration via auto-loop engine.
 */

import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AstGrepClient } from "../clients/ast-grep-client.js";
import { createAutoLoop } from "../clients/auto-loop.js";
import type { BiomeClient } from "../clients/biome-client.js";
import type { ComplexityClient } from "../clients/complexity-client.js";
import {
	type AstIssue,
	type FixScanResults,
	scanAll,
} from "../clients/fix-scanners.js";
import type { JscpdClient } from "../clients/jscpd-client.js";
import type { KnipClient } from "../clients/knip-client.js";
import type { RuffClient } from "../clients/ruff-client.js";

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
	_isTsProject: boolean,
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
	const noProgress =
		session.iteration > 1 && prevTotal === totalFixable && totalFixable > 0;

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

	// --- Write TSV plan file for agent to read ---
	const reportDir = path.join(process.cwd(), ".pi-lens", "reports");
	nodeFs.mkdirSync(reportDir, { recursive: true });
	const reportPath = path.join(reportDir, "fix-plan.tsv");

	const tsvRows: string[] = ["type\tfile\trule\tmessage"];

	// Duplicates
	for (const clone of filteredDups) {
		tsvRows.push(
			`dup\t${clone.fileA}:${clone.startA}\tduplicate-code\t${clone.lines} lines duplicated with ${clone.fileB}:${clone.startB}`,
		);
	}

	// Dead code
	for (const issue of filteredDeadCode) {
		tsvRows.push(
			`dead\t${issue.file || issue.name}\t${issue.type}\t${issue.name} is unused`,
		);
	}

	// AST issues
	for (const issue of agentTasks) {
		tsvRows.push(
			`ast\t${issue.file}:${issue.line}\t${issue.rule}\t${issue.message}`,
		);
	}

	// Biome
	for (const issue of filteredBiome) {
		tsvRows.push(
			`biome\t${issue.file}:${issue.line}\t${issue.rule}\t${issue.message}`,
		);
	}

	// Slop
	for (const { file, warnings } of filteredSlop) {
		for (const w of warnings) {
			tsvRows.push(`slop\t${file}\tcomplexity\t${w}`);
		}
	}

	nodeFs.writeFileSync(reportPath, tsvRows.join("\n"), "utf-8");

	// --- Build compact summary for terminal ---
	const lines: string[] = [];
	lines.push(
		`📋 FIX PLAN — Iteration ${session.iteration}/${MAX_ITERATIONS} — ${totalFixable} issues`,
	);
	lines.push(`📄 Full plan: .pi-lens/reports/fix-plan.tsv\n`);

	// Summary by category with counts
	if (filteredDups.length > 0) {
		lines.push(
			`🔁 Duplicates: ${filteredDups.length} block(s) — extract to shared utils`,
		);
	}
	if (filteredDeadCode.length > 0) {
		lines.push(
			`🗑️ Dead code: ${filteredDeadCode.length} item(s) — remove unused exports`,
		);
	}
	if (agentTasks.length > 0) {
		// Group by rule, show top 5 rules
		const grouped = new Map<string, number>();
		for (const t of agentTasks) {
			grouped.set(t.rule, (grouped.get(t.rule) ?? 0) + 1);
		}
		const sorted = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
		lines.push(`🔨 Lint: ${agentTasks.length} item(s)`);
		for (const [rule, count] of sorted.slice(0, 5)) {
			lines.push(`   ${rule}: ${count}`);
		}
		if (sorted.length > 5)
			lines.push(`   ... and ${sorted.length - 5} more rules`);
	}
	if (filteredBiome.length > 0) {
		lines.push(`🟠 Biome: ${filteredBiome.length} item(s) — auto-fixable`);
	}
	if (filteredSlop.length > 0) {
		lines.push(
			`🤖 AI Slop: ${filteredSlop.length} file(s) — review complexity`,
		);
	}

	lines.push("\n---");
	lines.push(
		"📖 **Read plan**: `read .pi-lens/reports/fix-plan.tsv` for full details",
	);
	lines.push(
		"🚀 **Fix & loop**: Fix items, then run `/lens-booboo-fix --loop`",
	);
	lines.push(
		'🚫 **False positive**: `/lens-booboo-fix --false-positive "type:file:line"`',
	);

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
	_ruleActions: Record<string, { type: string; note: string }>,
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
			ctx.ui.notify(
				`✅ Marked as false positive: "${falsePositiveId}"`,
				"info",
			);
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
		childProcess.spawnSync(
			"npx",
			["@biomejs/biome", "check", "--write", "--unsafe", targetPath],
			{
				encoding: "utf-8",
				timeout: 30000,
				shell: true,
			},
		);
	}
	if (!pi.getFlag("no-ruff") && clients.ruff.isAvailable()) {
		childProcess.spawnSync("ruff", ["check", "--fix", targetPath], {
			encoding: "utf-8",
			timeout: 15000,
			shell: true,
		});
		childProcess.spawnSync("ruff", ["format", targetPath], {
			encoding: "utf-8",
			timeout: 15000,
			shell: true,
		});
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
	nodeFs.writeFileSync(
		planPath,
		`# Fix Plan — Iteration ${session.iteration}\n\n${plan}`,
		"utf-8",
	);

	ctx.ui.notify(`📄 Fix plan saved: ${planPath}`, "info");
	pi.sendUserMessage(plan, { deliverAs: "followUp" });
}
