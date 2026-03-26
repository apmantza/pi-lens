/**
 * pi-lens - Real-time code feedback for pi
 *
 * Provides real-time diagnostics on every write/edit:
 * - TypeScript/JavaScript: Biome (lint+format) + TypeScript LSP (type checking)
 * - Python: Ruff (lint+format)
 * - All languages: ast-grep (63 structural rules)
 * - JavaScript/TypeScript: Dependency checker (circular deps)
 *
 * Proactive hints before write/edit:
 * - Warns when target file already has existing violations
 *
 * Auto-fix on write (enable with --autofix-ruff flag, Biome auto-fix disabled by default):
 * - Biome: feedback only by default, use /lens-format to apply fixes
 * - Ruff: applies --fix + format (lint + format fixes)
 *
 * On-demand commands:
 * - /lens-format - Apply Biome formatting
 *
 * External dependencies:
 * - npm: @biomejs/biome, @ast-grep/cli, knip, madge
 * - pip: ruff
 */
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AstGrepClient } from "./clients/ast-grep-client.js";
import { BiomeClient } from "./clients/biome-client.js";
import { ComplexityClient } from "./clients/complexity-client.js";
import { DependencyChecker } from "./clients/dependency-checker.js";
import { GoClient } from "./clients/go-client.js";
import { JscpdClient } from "./clients/jscpd-client.js";
import { KnipClient } from "./clients/knip-client.js";
import { MetricsClient } from "./clients/metrics-client.js";
import { RuffClient } from "./clients/ruff-client.js";
import { RustClient } from "./clients/rust-client.js";
import { TestRunnerClient } from "./clients/test-runner-client.js";
import { TodoScanner } from "./clients/todo-scanner.js";
import { TypeCoverageClient } from "./clients/type-coverage-client.js";
import { TypeScriptClient } from "./clients/typescript-client.js";
const DEBUG_LOG = path.join(os.homedir(), "pi-lens-debug.log");
function dbg(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        nodeFs.appendFileSync(DEBUG_LOG, line);
    }
    catch (e) {
        console.error("[pi-lens-debug] write failed:", e);
    }
}
// --- State ---
let _verbose = false;
function log(msg) {
    if (_verbose)
        console.error(`[pi-lens] ${msg}`);
}
// --- Extension ---
export default function (pi) {
    const tsClient = new TypeScriptClient();
    const astGrepClient = new AstGrepClient();
    const ruffClient = new RuffClient();
    const biomeClient = new BiomeClient();
    const knipClient = new KnipClient();
    const todoScanner = new TodoScanner();
    const jscpdClient = new JscpdClient();
    const typeCoverageClient = new TypeCoverageClient();
    const depChecker = new DependencyChecker();
    const testRunnerClient = new TestRunnerClient();
    const metricsClient = new MetricsClient();
    const complexityClient = new ComplexityClient();
    const goClient = new GoClient();
    const rustClient = new RustClient();
    // --- Flags ---
    pi.registerFlag("lens-verbose", {
        description: "Enable verbose pi-lens logging",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("no-biome", {
        description: "Disable Biome linting/formatting",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("no-ast-grep", {
        description: "Disable ast-grep structural analysis",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("no-ruff", {
        description: "Disable Ruff Python linting",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("no-lsp", {
        description: "Disable TypeScript LSP",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("no-madge", {
        description: "Disable circular dependency checking via madge",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("autofix-biome", {
        description: "Auto-fix Biome lint/format issues on write (applies --write --unsafe)",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("autofix-ruff", {
        description: "Auto-fix Ruff lint/format issues on write",
        type: "boolean",
        default: true,
    });
    pi.registerFlag("no-tests", {
        description: "Disable test runner on write",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("no-go", {
        description: "Disable Go linting (go vet)",
        type: "boolean",
        default: false,
    });
    pi.registerFlag("no-rust", {
        description: "Disable Rust linting (cargo check)",
        type: "boolean",
        default: false,
    });
    // --- Commands ---
    pi.registerCommand("lens-booboo", {
        description: "Full codebase review: design smells, complexity, AI slop detection, TODOs, dead code, duplicates, type coverage. Results saved to .pi-lens/reviews/. Usage: /lens-booboo [path]",
        handler: async (args, ctx) => {
            const targetPath = args.trim() || ctx.cwd || process.cwd();
            ctx.ui.notify("🔍 Running full codebase review...", "info");
            const parts = [];
            const fullReport = [];
            const timestamp = new Date()
                .toISOString()
                .replace(/[:.]/g, "-")
                .slice(0, 19);
            const reviewDir = path.join(process.cwd(), ".pi-lens", "reviews");
            // Part 1: Design smells via ast-grep
            if (astGrepClient.isAvailable()) {
                const configPath = path.join(typeof __dirname !== "undefined" ? __dirname : ".", "rules", "ast-grep-rules", ".sgconfig.yml");
                try {
                    const result = require("node:child_process").spawnSync("npx", [
                        "sg",
                        "scan",
                        "--config",
                        configPath,
                        "--json",
                        "--globs",
                        "!**/*.test.ts",
                        "--globs",
                        "!**/*.spec.ts",
                        "--globs",
                        "!**/test-utils.ts",
                        "--globs",
                        "!**/.pi-lens/**",
                        targetPath,
                    ], {
                        encoding: "utf-8",
                        timeout: 30000,
                        shell: true,
                        maxBuffer: 32 * 1024 * 1024, // 32MB
                    });
                    const output = result.stdout || result.stderr || "";
                    if (output.trim() && result.status !== undefined) {
                        const issues = [];
                        // ast-grep outputs either a JSON array or NDJSON (one object per line)
                        // biome-ignore lint/suspicious/noExplicitAny: ast-grep JSON output is untyped
                        const parseItems = (raw) => {
                            const trimmed = raw.trim();
                            if (trimmed.startsWith("[")) {
                                try {
                                    return JSON.parse(trimmed);
                                }
                                catch (err) {
                                    void err;
                                    return [];
                                }
                            }
                            return raw.split("\n").flatMap((l) => {
                                try {
                                    return [JSON.parse(l)];
                                }
                                catch (err) {
                                    void err;
                                    return [];
                                }
                            });
                        };
                        for (const item of parseItems(output)) {
                            const ruleId = item.ruleId || item.rule?.title || item.name || "unknown";
                            const ruleDesc = astGrepClient.getRuleDescription?.(ruleId);
                            const message = ruleDesc?.message || item.message || ruleId;
                            const lineNum = item.labels?.[0]?.range?.start?.line ||
                                item.spans?.[0]?.range?.start?.line ||
                                item.range?.start?.line ||
                                0;
                            issues.push({
                                line: lineNum + 1,
                                rule: ruleId,
                                message: message,
                            });
                        }
                        if (issues.length > 0) {
                            // UI summary (truncated)
                            let report = `[ast-grep] ${issues.length} issue(s) found:\n`;
                            for (const issue of issues.slice(0, 20)) {
                                report += `  L${issue.line}: ${issue.rule} — ${issue.message}\n`;
                            }
                            if (issues.length > 20) {
                                report += `  ... and ${issues.length - 20} more\n`;
                            }
                            parts.push(report);
                            // Full report for file
                            let fullSection = `## ast-grep (Structural Issues)\n\n**${issues.length} issue(s) found**\n\n`;
                            fullSection +=
                                "| Line | Rule | Message |\n|------|------|--------|\n";
                            for (const issue of issues) {
                                fullSection += `| ${issue.line} | ${issue.rule} | ${issue.message} |\n`;
                            }
                            fullReport.push(fullSection);
                        }
                    }
                }
                catch (_err) {
                    dbg(`ast-grep scan failed: ${_err.message}`);
                }
            }
            // Part 2: Similar functions (advanced duplicate detection)
            if (astGrepClient.isAvailable()) {
                const similarGroups = await astGrepClient.findSimilarFunctions(targetPath, "typescript");
                if (similarGroups.length > 0) {
                    // UI summary (truncated)
                    let report = `[Similar Functions] ${similarGroups.length} group(s) of structurally similar functions:\n`;
                    for (const group of similarGroups.slice(0, 5)) {
                        report += `  Pattern: ${group.functions.map((f) => f.name).join(", ")}\n`;
                        for (const fn of group.functions) {
                            report += `    ${fn.name} (${path.basename(fn.file)}:${fn.line})\n`;
                        }
                    }
                    if (similarGroups.length > 5) {
                        report += `  ... and ${similarGroups.length - 5} more groups\n`;
                    }
                    parts.push(report);
                    // Full report for file
                    let fullSection = `## Similar Functions\n\n**${similarGroups.length} group(s) of structurally similar functions**\n\n`;
                    for (const group of similarGroups) {
                        fullSection += `### Pattern: ${group.functions.map((f) => f.name).join(", ")}\n\n`;
                        fullSection +=
                            "| Function | File | Line |\n|----------|------|------|\n";
                        for (const fn of group.functions) {
                            fullSection += `| ${fn.name} | ${fn.file} | ${fn.line} |\n`;
                        }
                        fullSection += "\n";
                    }
                    fullReport.push(fullSection);
                }
            }
            // Part 3: Complexity metrics + AI slop detection
            const results = [];
            const aiSlopIssues = [];
            const scanDir = (dir) => {
                let entries;
                try {
                    entries = nodeFs.readdirSync(dir, { withFileTypes: true });
                }
                catch {
                    return;
                }
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory() &&
                        ![
                            "node_modules",
                            ".git",
                            "dist",
                            "build",
                            ".next",
                            ".pi-lens",
                        ].includes(entry.name)) {
                        scanDir(fullPath);
                    }
                    else if (complexityClient.isSupportedFile(fullPath)) {
                        const metrics = complexityClient.analyzeFile(fullPath);
                        if (metrics) {
                            results.push(metrics);
                            // Check AI slop indicators — skip test files (low MI is expected/structural)
                            if (!/\.(test|spec)\.[jt]sx?$/.test(entry.name)) {
                                const warnings = complexityClient.checkThresholds(metrics);
                                if (warnings.length > 0) {
                                    aiSlopIssues.push(`  ${metrics.filePath}:`);
                                    for (const w of warnings) {
                                        aiSlopIssues.push(`    ⚠ ${w}`);
                                    }
                                }
                            }
                        }
                    }
                }
            };
            scanDir(targetPath);
            if (results.length > 0) {
                const avgMI = results.reduce((a, b) => a + b.maintainabilityIndex, 0) /
                    results.length;
                const avgCognitive = results.reduce((a, b) => a + b.cognitiveComplexity, 0) /
                    results.length;
                const avgCyclomatic = results.reduce((a, b) => a + b.cyclomaticComplexity, 0) /
                    results.length;
                const maxNesting = Math.max(...results.map((r) => r.maxNestingDepth));
                const maxCognitive = Math.max(...results.map((r) => r.cognitiveComplexity));
                const minMI = Math.min(...results.map((r) => r.maintainabilityIndex));
                const lowMI = results
                    .filter((r) => r.maintainabilityIndex < 60)
                    .sort((a, b) => a.maintainabilityIndex - b.maintainabilityIndex);
                const highCognitive = results
                    .filter((r) => r.cognitiveComplexity > 20)
                    .sort((a, b) => b.cognitiveComplexity - a.cognitiveComplexity);
                // UI summary (truncated)
                let summary = `[Complexity] ${results.length} file(s) scanned\n`;
                summary += `  Maintainability: ${avgMI.toFixed(1)} avg | Cognitive: ${avgCognitive.toFixed(1)} avg | Max Nesting: ${maxNesting} levels\n`;
                if (lowMI.length > 0) {
                    summary += `\n  Low Maintainability (MI < 60):\n`;
                    for (const f of lowMI.slice(0, 5)) {
                        summary += `    ✗ ${f.filePath}: MI ${f.maintainabilityIndex.toFixed(1)}\n`;
                    }
                    if (lowMI.length > 5)
                        summary += `    ... and ${lowMI.length - 5} more\n`;
                }
                if (highCognitive.length > 0) {
                    summary += `\n  High Cognitive Complexity (> 20):\n`;
                    for (const f of highCognitive.slice(0, 5)) {
                        summary += `    ⚠ ${f.filePath}: ${f.cognitiveComplexity}\n`;
                    }
                    if (highCognitive.length > 5)
                        summary += `    ... and ${highCognitive.length - 5} more\n`;
                }
                // Add AI slop issues
                if (aiSlopIssues.length > 0) {
                    summary += `\n[AI Slop Indicators]\n${aiSlopIssues.join("\n")}`;
                }
                parts.push(summary);
                // Full report for file
                let fullSection = `## Complexity Metrics\n\n**${results.length} file(s) scanned**\n\n`;
                fullSection += `### Summary\n\n`;
                fullSection += `| Metric | Value |\n|--------|-------|\n`;
                fullSection += `| Avg Maintainability Index | ${avgMI.toFixed(1)} |\n`;
                fullSection += `| Min Maintainability Index | ${minMI.toFixed(1)} |\n`;
                fullSection += `| Avg Cognitive Complexity | ${avgCognitive.toFixed(1)} |\n`;
                fullSection += `| Max Cognitive Complexity | ${maxCognitive} |\n`;
                fullSection += `| Avg Cyclomatic Complexity | ${avgCyclomatic.toFixed(1)} |\n`;
                fullSection += `| Max Nesting Depth | ${maxNesting} |\n`;
                fullSection += `| Total Files | ${results.length} |\n\n`;
                if (lowMI.length > 0) {
                    fullSection += `### Low Maintainability (MI < 60)\n\n`;
                    fullSection += `| File | MI | Cognitive | Cyclomatic | Nesting |\n`;
                    fullSection += `|------|-----|-----------|------------|--------|\n`;
                    for (const f of lowMI) {
                        fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
                    }
                    fullSection += "\n";
                }
                if (highCognitive.length > 0) {
                    fullSection += `### High Cognitive Complexity (> 20)\n\n`;
                    fullSection += `| File | Cognitive | MI | Cyclomatic | Nesting |\n`;
                    fullSection += `|------|-----------|-----|------------|--------|\n`;
                    for (const f of highCognitive) {
                        fullSection += `| ${f.filePath} | ${f.cognitiveComplexity} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} |\n`;
                    }
                    fullSection += "\n";
                }
                // All files table
                fullSection += `### All Files\n\n`;
                fullSection += `| File | MI | Cognitive | Cyclomatic | Nesting | Entropy |\n`;
                fullSection += `|------|-----|-----------|------------|---------|--------|\n`;
                for (const f of results.sort((a, b) => a.maintainabilityIndex - b.maintainabilityIndex)) {
                    fullSection += `| ${f.filePath} | ${f.maintainabilityIndex.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity} | ${f.maxNestingDepth} | ${f.codeEntropy.toFixed(2)} |\n`;
                }
                fullSection += "\n";
                // AI slop indicators
                if (aiSlopIssues.length > 0) {
                    fullSection += `### AI Slop Indicators\n\n`;
                    for (const issue of aiSlopIssues) {
                        fullSection += `${issue}\n`;
                    }
                    fullSection += "\n";
                }
                fullReport.push(fullSection);
            }
            // Part 4: TODOs scan
            const todoResult = todoScanner.scanDirectory(targetPath);
            const todoReport = todoScanner.formatResult(todoResult);
            if (todoReport) {
                parts.push(todoReport);
                // Full TODO report
                let fullSection = `## TODOs / Annotations\n\n`;
                if (todoResult.items.length > 0) {
                    fullSection += `**${todoResult.items.length} annotation(s) found**\n\n`;
                    fullSection += `| Type | File | Line | Text |\n`;
                    fullSection += `|------|------|------|------|\n`;
                    for (const item of todoResult.items) {
                        fullSection += `| ${item.type} | ${item.file} | ${item.line} | ${item.message} |\n`;
                    }
                }
                else {
                    fullSection += `No annotations found.\n`;
                }
                fullSection += "\n";
                fullReport.push(fullSection);
            }
            // Part 5: Dead code (knip)
            if (knipClient.isAvailable()) {
                const knipResult = knipClient.analyze(targetPath);
                const knipReport = knipClient.formatResult(knipResult);
                if (knipReport) {
                    parts.push(knipReport);
                    // Full knip report
                    let fullSection = `## Dead Code (Knip)\n\n`;
                    if (knipResult.issues.length > 0) {
                        fullSection += `**${knipResult.issues.length} issue(s) found**\n\n`;
                        fullSection += `| Type | Name | File |\n`;
                        fullSection += `|------|------|------|\n`;
                        for (const issue of knipResult.issues) {
                            fullSection += `| ${issue.type} | ${issue.name} | ${issue.file ?? ""} |\n`;
                        }
                    }
                    else {
                        fullSection += `No dead code issues found.\n`;
                    }
                    fullSection += "\n";
                    fullReport.push(fullSection);
                }
            }
            // Part 6: Code duplication
            if (jscpdClient.isAvailable()) {
                const jscpdResult = jscpdClient.scan(targetPath);
                const jscpdReport = jscpdClient.formatResult(jscpdResult);
                if (jscpdReport) {
                    parts.push(jscpdReport);
                    // Full jscpd report
                    let fullSection = `## Code Duplication (jscpd)\n\n`;
                    if (jscpdResult.clones.length > 0) {
                        fullSection += `**${jscpdResult.clones.length} duplicate block(s) found** (${jscpdResult.duplicatedLines}/${jscpdResult.totalLines} lines, ${jscpdResult.percentage.toFixed(1)}%)\n\n`;
                        fullSection += `| File A | Line A | File B | Line B | Lines | Tokens |\n`;
                        fullSection += `|--------|--------|--------|--------|-------|--------|\n`;
                        for (const dup of jscpdResult.clones) {
                            fullSection += `| ${dup.fileA} | ${dup.startA} | ${dup.fileB} | ${dup.startB} | ${dup.lines} | ${dup.tokens} |\n`;
                        }
                    }
                    else {
                        fullSection += `No duplicate code found.\n`;
                    }
                    fullSection += "\n";
                    fullReport.push(fullSection);
                }
            }
            // Part 7: Type coverage
            if (typeCoverageClient.isAvailable()) {
                const tcResult = typeCoverageClient.scan(targetPath);
                const tcReport = typeCoverageClient.formatResult(tcResult);
                if (tcReport) {
                    parts.push(tcReport);
                    // Full type coverage report
                    let fullSection = `## Type Coverage\n\n`;
                    fullSection += `**${tcResult.percentage.toFixed(1)}% typed** (${tcResult.typed}/${tcResult.total} identifiers)\n\n`;
                    if (tcResult.untypedLocations.length > 0) {
                        fullSection += `### Untyped Identifiers\n\n`;
                        fullSection += `| File | Line | Column | Name |\n`;
                        fullSection += `|------|------|--------|------|\n`;
                        for (const u of tcResult.untypedLocations) {
                            fullSection += `| ${u.file} | ${u.line} | ${u.column} | ${u.name} |\n`;
                        }
                    }
                    fullSection += "\n";
                    fullReport.push(fullSection);
                }
            }
            // Part 8: Circular dependencies
            if (!pi.getFlag("no-madge") && depChecker.isAvailable()) {
                const { circular } = depChecker.scanProject(targetPath);
                const depReport = depChecker.formatScanResult(circular);
                if (depReport) {
                    parts.push(depReport);
                    let fullSection = `## Circular Dependencies (Madge)\n\n`;
                    fullSection += `**${circular.length} circular chain(s) found**\n\n`;
                    for (const dep of circular) {
                        fullSection += `- ${dep.path.join(" → ")}\n`;
                    }
                    fullSection += "\n";
                    fullReport.push(fullSection);
                }
            }
            // Build and save full markdown report
            const fs = require("node:fs");
            fs.mkdirSync(reviewDir, { recursive: true });
            const projectName = path.basename(process.cwd());
            let mdReport = `# Code Review: ${projectName}\n\n`;
            mdReport += `**Scanned:** ${new Date().toISOString()}\n\n`;
            mdReport += `**Path:** \`${targetPath}\`\n\n`;
            mdReport += `---\n\n`;
            mdReport += fullReport.join("\n");
            const reportPath = path.join(reviewDir, `booboo-${timestamp}.md`);
            fs.writeFileSync(reportPath, mdReport, "utf-8");
            if (parts.length === 0) {
                ctx.ui.notify("✓ Code review clean — saved to .pi-lens/reviews/", "info");
            }
            else {
                ctx.ui.notify(`${parts.join("\n\n")}\n\n📄 Full report: ${reportPath}`, "info");
            }
        },
    });
    // --- Rule action map for lens-booboo-fix ---
    // Rules marked "skip" are architectural — they need deliberate user decisions.
    // They are excluded from inline tool_result hard stops (use /lens-refactor instead).
    const RULE_ACTIONS = {
        "no-var": { type: "biome", note: "auto-fixed by Biome --write" },
        "prefer-template": { type: "biome", note: "auto-fixed by Biome --write" },
        "no-useless-concat": { type: "biome", note: "auto-fixed by Biome --write" },
        "no-lonely-if": { type: "biome", note: "auto-fixed by Biome --write" },
        "prefer-const": { type: "biome", note: "auto-fixed by Biome --write" },
        "empty-catch": {
            type: "agent",
            note: "Add this.log('Error: ' + err.message) to the catch block",
        },
        "no-console-log": {
            type: "agent",
            note: "Remove or replace with class logger method",
        },
        "no-debugger": { type: "agent", note: "Remove the debugger statement" },
        "no-return-await": {
            type: "agent",
            note: "Remove the unnecessary `return await`",
        },
        "nested-ternary": {
            type: "agent",
            note: "Extract to if/else or a named variable",
        },
        "no-throw-string": {
            type: "agent",
            note: "Wrap in `new Error(...)` instead of throwing a string",
        },
        "no-star-imports": {
            type: "skip",
            note: "Requires knowing which exports are actually used.",
        },
        "no-as-any": {
            type: "skip",
            note: "Replacing `as any` requires knowing the correct type.",
        },
        "no-non-null-assertion": {
            type: "skip",
            note: "Each `!` needs nullability analysis in context.",
        },
        "large-class": {
            type: "skip",
            note: "Splitting a class requires architectural decisions.",
        },
        "long-method": {
            type: "skip",
            note: "Extraction requires understanding the function's purpose.",
        },
        "long-parameter-list": {
            type: "skip",
            note: "Redesigning the signature requires an API decision.",
        },
        "no-shadow": {
            type: "skip",
            note: "Renaming requires understanding all variable scopes.",
        },
    };
    // Derived from RULE_ACTIONS — used to suppress architectural rules from inline hard stops.
    const SKIP_RULES = new Set(Object.entries(RULE_ACTIONS)
        .filter(([, v]) => v.type === "skip")
        .map(([k]) => k));
    pi.registerCommand("lens-booboo-fix", {
        description: "Iterative fix loop: auto-fixes Biome/Ruff, then generates a per-issue plan for agent to execute. Run repeatedly until clean. Usage: /lens-booboo-fix [path]",
        handler: async (args, ctx) => {
            const targetPath = args.trim() || ctx.cwd || process.cwd();
            const fs = require("node:fs");
            const sessionFile = path.join(process.cwd(), ".pi-lens", "fix-session.json");
            const configPath = path.join(typeof __dirname !== "undefined" ? __dirname : ".", "rules", "ast-grep-rules", ".sgconfig.yml");
            ctx.ui.notify("🔧 Running booboo fix loop...", "info");
            const MAX_ITERATIONS = 3;
            // Detect TypeScript project — exclude compiled .js output from scans
            const isTsProject = fs.existsSync(path.join(targetPath, "tsconfig.json"));
            dbg(`booboo-fix: isTsProject=${isTsProject}`);
            // Load session state
            let session = {
                iteration: 0,
                counts: {},
            };
            try {
                session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
            }
            catch (e) {
                dbg(`fix-session load failed: ${e}`);
            }
            session.iteration++;
            // Hard stop at max iterations — auto-reset for next run
            if (session.iteration > MAX_ITERATIONS) {
                try {
                    fs.unlinkSync(sessionFile);
                }
                catch {
                    void 0;
                }
                ctx.ui.notify(`⛔ Max iterations (${MAX_ITERATIONS}) reached. Session reset — run /lens-booboo-fix again for a fresh loop, or /lens-booboo for a full report.`, "warning");
                return;
            }
            const prevCounts = { ...session.counts };
            // --- Step 1: Auto-fix with Biome + Ruff ---
            let biomeRan = false;
            if (!pi.getFlag("no-biome") && biomeClient.isAvailable()) {
                require("node:child_process").spawnSync("npx", ["@biomejs/biome", "check", "--write", "--unsafe", targetPath], { encoding: "utf-8", timeout: 30000, shell: true });
                biomeRan = true;
            }
            let ruffRan = false;
            if (!pi.getFlag("no-ruff") && ruffClient.isAvailable()) {
                require("node:child_process").spawnSync("ruff", ["check", "--fix", targetPath], { encoding: "utf-8", timeout: 15000, shell: true });
                require("node:child_process").spawnSync("ruff", ["format", targetPath], { encoding: "utf-8", timeout: 15000, shell: true });
                ruffRan = true;
            }
            const dupClones = [];
            if (jscpdClient.isAvailable()) {
                const jscpdResult = jscpdClient.scan(targetPath);
                // Only within-file duplicates are mechanically fixable
                const clones = jscpdResult.clones.filter((c) => {
                    if (isTsProject && (c.fileA.endsWith(".js") || c.fileB.endsWith(".js")))
                        return false;
                    return path.resolve(c.fileA) === path.resolve(c.fileB);
                });
                dupClones.push(...clones);
                dbg(`booboo-fix jscpd: ${dupClones.length} within-file clone(s) from ${jscpdResult.clones.length} total`);
            }
            const deadCodeIssues = [];
            if (knipClient.isAvailable()) {
                const knipResult = knipClient.analyze(targetPath);
                deadCodeIssues.push(...knipResult.issues);
                dbg(`booboo-fix knip: ${deadCodeIssues.length} issue(s)`);
            }
            const astIssues = [];
            if (astGrepClient.isAvailable()) {
                const result = require("node:child_process").spawnSync("npx", [
                    "sg",
                    "scan",
                    "--config",
                    configPath,
                    "--json",
                    "--globs",
                    "!**/*.test.ts",
                    "--globs",
                    "!**/*.spec.ts",
                    "--globs",
                    "!**/test-utils.ts",
                    "--globs",
                    "!**/.pi-lens/**",
                    ...(isTsProject ? ["--globs", "!**/*.js"] : []),
                    targetPath,
                ], {
                    encoding: "utf-8",
                    timeout: 30000,
                    shell: true,
                    maxBuffer: 32 * 1024 * 1024,
                });
                const raw = result.stdout?.trim() ?? "";
                // biome-ignore lint/suspicious/noExplicitAny: ast-grep JSON output is untyped
                const items = raw.startsWith("[")
                    ? (() => {
                        try {
                            return JSON.parse(raw);
                        }
                        catch (e) {
                            dbg(`ast-grep parse failed: ${e}`);
                            return [];
                        }
                    })()
                    : raw.split("\n").flatMap((l) => {
                        try {
                            return [JSON.parse(l)];
                        }
                        catch (err) {
                            void err;
                            return [];
                        }
                    });
                for (const item of items) {
                    const rule = item.ruleId || item.rule?.title || item.name || "unknown";
                    const line = (item.labels?.[0]?.range?.start?.line ??
                        item.range?.start?.line ??
                        0) + 1;
                    const relFile = path
                        .relative(targetPath, item.file ?? "")
                        .replace(/\\/g, "/");
                    astIssues.push({
                        rule,
                        file: relFile,
                        line,
                        message: item.message ?? rule,
                    });
                }
            }
            // --- Step 5: AI slop from complexity scan ---
            const slopFiles = [];
            const slopScanDir = (dir) => {
                if (!fs.existsSync(dir))
                    return;
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if ([
                            "node_modules",
                            ".git",
                            "dist",
                            "build",
                            ".next",
                            ".pi-lens",
                        ].includes(entry.name))
                            continue;
                        slopScanDir(fullPath);
                    }
                    else if (complexityClient.isSupportedFile(fullPath) &&
                        !/\.(test|spec)\.[jt]sx?$/.test(entry.name) &&
                        !(isTsProject && /\.js$/.test(entry.name))) {
                        const metrics = complexityClient.analyzeFile(fullPath);
                        if (metrics) {
                            const warnings = complexityClient
                                .checkThresholds(metrics)
                                .filter((w) => w.includes("AI-style") ||
                                w.includes("try/catch") ||
                                w.includes("single-use") ||
                                w.includes("Excessive comments"));
                            // Only flag files with 2+ signals — single-issue flags are noise
                            if (warnings.length >= 2) {
                                slopFiles.push({
                                    file: path.relative(targetPath, fullPath).replace(/\\/g, "/"),
                                    warnings,
                                });
                            }
                        }
                    }
                }
            };
            slopScanDir(targetPath);
            // --- Step 6: Remaining Biome lint (unfixable by --unsafe) ---
            const remainingBiome = [];
            if (!pi.getFlag("no-biome") && biomeClient.isAvailable()) {
                const checkResult = require("node:child_process").spawnSync("npx", [
                    "@biomejs/biome",
                    "check",
                    "--reporter=json",
                    "--max-diagnostics=50",
                    targetPath,
                ], { encoding: "utf-8", timeout: 20000, shell: true });
                try {
                    const data = JSON.parse(checkResult.stdout ?? "{}");
                    for (const diag of (data.diagnostics ?? []).slice(0, 20)) {
                        if (!diag.category?.startsWith("lint/"))
                            continue;
                        const filePath = diag.location?.path?.file ?? "";
                        const line = diag.location?.span?.start?.line ?? 0;
                        const rule = diag.category ?? "lint";
                        remainingBiome.push({
                            file: path.relative(targetPath, filePath).replace(/\\/g, "/"),
                            line: line + 1,
                            rule,
                            message: diag.message ?? rule,
                        });
                    }
                }
                catch (e) {
                    dbg(`biome lint parse failed: ${e}`);
                }
            }
            // --- Categorize ast-grep issues ---
            const agentTasks = [];
            const skipRules = new Map();
            const byRule = new Map();
            for (const issue of astIssues) {
                const list = byRule.get(issue.rule) ?? [];
                list.push(issue);
                byRule.set(issue.rule, list);
            }
            for (const [rule, issues] of byRule) {
                const action = RULE_ACTIONS[rule];
                if (!action || action.type === "agent") {
                    agentTasks.push(...issues);
                }
                else if (action.type === "skip") {
                    skipRules.set(rule, { note: action.note, count: issues.length });
                }
            }
            // --- Update session counts ---
            const currentCounts = {
                duplicates: dupClones.length,
                dead_code: deadCodeIssues.length,
                agent_ast: agentTasks.length,
                biome_lint: remainingBiome.length,
                slop_files: slopFiles.length,
            };
            session.counts = currentCounts;
            fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
            fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), "utf-8");
            // --- Check if done ---
            const totalFixable = dupClones.length +
                deadCodeIssues.length +
                agentTasks.length +
                remainingBiome.length +
                slopFiles.length;
            if (totalFixable === 0) {
                const msg = `✅ BOOBOO FIX LOOP COMPLETE — No more fixable issues found after ${session.iteration} iteration(s).\n\nRemaining skipped items are architectural — see /lens-booboo for full report.`;
                ctx.ui.notify(msg, "info");
                try {
                    fs.unlinkSync(sessionFile);
                }
                catch {
                    void 0;
                }
                return;
            }
            // --- Build delta line ---
            let deltaLine = "";
            if (session.iteration > 1 && Object.keys(prevCounts).length > 0) {
                const prevTotal = Object.values(prevCounts).reduce((a, b) => a + b, 0);
                const fixed = prevTotal - totalFixable;
                deltaLine =
                    fixed > 0
                        ? `✅ Fixed ${fixed} issues since last iteration.`
                        : `⚠️ No change since last iteration — check if fixes were applied.`;
            }
            // --- Build the fix plan message ---
            const lines = [];
            lines.push(`📋 BOOBOO FIX PLAN — Iteration ${session.iteration}/${MAX_ITERATIONS} (${totalFixable} fixable items remaining)`);
            if (deltaLine)
                lines.push(deltaLine);
            lines.push("");
            if (biomeRan || ruffRan) {
                lines.push(`⚡ Auto-fixed: ${[biomeRan && "Biome --write --unsafe", ruffRan && "Ruff --fix + format"].filter(Boolean).join(", ")} already ran.`);
                lines.push("");
            }
            // Duplicate code — fix first
            if (dupClones.length > 0) {
                lines.push(`## 🔁 Duplicate code [${dupClones.length} block(s)] — fix first`);
                lines.push("→ Extract duplicated blocks into shared utilities before fixing violations in them.");
                for (const clone of dupClones.slice(0, 10)) {
                    const relA = path
                        .relative(targetPath, clone.fileA)
                        .replace(/\\/g, "/");
                    const relB = path
                        .relative(targetPath, clone.fileB)
                        .replace(/\\/g, "/");
                    lines.push(`  - ${clone.lines} lines: \`${relA}:${clone.startA}\` ↔ \`${relB}:${clone.startB}\``);
                }
                if (dupClones.length > 10)
                    lines.push(`  ... and ${dupClones.length - 10} more`);
                lines.push("");
            }
            // Dead code — delete before fixing violations in it
            if (deadCodeIssues.length > 0) {
                lines.push(`## 🗑️ Dead code [${deadCodeIssues.length} item(s)] — delete before fixing violations`);
                lines.push("→ Remove unused exports/files — no point fixing violations in code you're about to delete.");
                for (const issue of deadCodeIssues.slice(0, 10)) {
                    lines.push(`  - [${issue.type}] \`${issue.name}\`${issue.file ? ` in ${issue.file}` : ""}`);
                }
                if (deadCodeIssues.length > 10)
                    lines.push(`  ... and ${deadCodeIssues.length - 10} more`);
                lines.push("");
            }
            // Agent tasks — ast-grep violations on surviving code
            if (agentTasks.length > 0) {
                lines.push(`## 🔨 Fix these [${agentTasks.length} items]`);
                lines.push("");
                const groupedAgent = new Map();
                for (const t of agentTasks) {
                    const g = groupedAgent.get(t.rule) ?? [];
                    g.push(t);
                    groupedAgent.set(t.rule, g);
                }
                for (const [rule, issues] of groupedAgent) {
                    const action = RULE_ACTIONS[rule];
                    const note = action?.note ?? "Fix this violation";
                    lines.push(`### ${rule} (${issues.length})`);
                    lines.push(`→ ${note}`);
                    for (const issue of issues.slice(0, 15)) {
                        lines.push(`  - \`${issue.file}:${issue.line}\``);
                    }
                    if (issues.length > 15)
                        lines.push(`  ... and ${issues.length - 15} more`);
                    lines.push("");
                }
            }
            // Remaining Biome lint — couldn't be auto-fixed even with --unsafe
            if (remainingBiome.length > 0) {
                lines.push(`## 🟠 Remaining Biome lint [${remainingBiome.length} items]`);
                lines.push("→ These couldn't be auto-fixed by Biome --unsafe. Fix each one manually:");
                for (const d of remainingBiome.slice(0, 10)) {
                    lines.push(`  - \`${d.file}:${d.line}\` [${d.rule}] ${d.message}`);
                }
                if (remainingBiome.length > 10)
                    lines.push(`  ... and ${remainingBiome.length - 10} more`);
                lines.push("");
            }
            // AI slop
            if (slopFiles.length > 0) {
                lines.push(`## 🤖 AI Slop indicators [${slopFiles.length} files]`);
                for (const { file, warnings } of slopFiles.slice(0, 10)) {
                    lines.push(`  - \`${file}\`: ${warnings.map((w) => w.split(" — ")[0]).join(", ")}`);
                }
                if (slopFiles.length > 10)
                    lines.push(`  ... and ${slopFiles.length - 10} more`);
                lines.push("");
            }
            // Skips
            if (skipRules.size > 0) {
                lines.push(`## ⏭️ Skip [${[...skipRules.values()].reduce((a, b) => a + b.count, 0)} items — architectural]`);
                for (const [rule, { note, count }] of skipRules) {
                    lines.push(`  - **${rule}** (${count}): ${note}`);
                }
                lines.push("");
            }
            lines.push("---");
            lines.push("Fix the items above in order, then run `/lens-booboo-fix` again for the next iteration.");
            lines.push("If an item is not safe to fix, skip it with one sentence why.");
            const fixPlan = lines.join("\n");
            // Save plan for reference
            const planPath = path.join(process.cwd(), ".pi-lens", "fix-plan.md");
            fs.writeFileSync(planPath, `# Fix Plan — Iteration ${session.iteration}\n\n${fixPlan}`, "utf-8");
            // Notify and inject into conversation
            ctx.ui.notify(`📄 Fix plan saved: ${planPath}`, "info");
            // Use steer delivery — agent is busy processing this tool call
            // steer interrupts mid-processing with the next fix plan
            pi.sendUserMessage(fixPlan, { deliverAs: "steer" });
        },
    });
    pi.registerCommand("lens-booboo-refactor", {
        description: "Interactive architectural refactor: scans for worst offender, opens a browser interview with options + recommendation, then steers the agent with your decision. Usage: /lens-booboo-refactor [path]",
        handler: async (args, ctx) => {
            const targetPath = args.trim() || ctx.cwd || process.cwd();
            const fs = require("node:fs");
            ctx.ui.notify("🏗️ Scanning for architectural debt...", "info");
            const configPath = path.join(typeof __dirname !== "undefined" ? __dirname : ".", "rules", "ast-grep-rules", ".sgconfig.yml");
            const isTsProject = fs.existsSync(path.join(targetPath, "tsconfig.json"));
            const skipByFile = new Map();
            if (astGrepClient.isAvailable()) {
                const sgResult = require("node:child_process").spawnSync("npx", [
                    "sg",
                    "scan",
                    "--config",
                    configPath,
                    "--json",
                    "--globs",
                    "!**/*.test.ts",
                    "--globs",
                    "!**/*.spec.ts",
                    "--globs",
                    "!**/test-utils.ts",
                    "--globs",
                    "!**/.pi-lens/**",
                    ...(isTsProject ? ["--globs", "!**/*.js"] : []),
                    targetPath,
                ], {
                    encoding: "utf-8",
                    timeout: 30000,
                    shell: true,
                    maxBuffer: 32 * 1024 * 1024,
                });
                const raw = sgResult.stdout?.trim() ?? "";
                // biome-ignore lint/suspicious/noExplicitAny: ast-grep JSON output is untyped
                const items = raw.startsWith("[")
                    ? (() => {
                        try {
                            return JSON.parse(raw);
                        }
                        catch {
                            return [];
                        }
                    })()
                    : raw.split("\n").flatMap((l) => {
                        try {
                            return [JSON.parse(l)];
                        }
                        catch {
                            return [];
                        }
                    });
                for (const item of items) {
                    const rule = item.ruleId || item.rule?.title || item.name || "unknown";
                    if (!SKIP_RULES.has(rule))
                        continue;
                    const line = (item.labels?.[0]?.range?.start?.line ??
                        item.range?.start?.line ??
                        0) + 1;
                    const absFile = path.resolve(item.file ?? "");
                    const list = skipByFile.get(absFile) ?? [];
                    list.push({ rule, line, note: RULE_ACTIONS[rule]?.note ?? "" });
                    skipByFile.set(absFile, list);
                }
            }
            const metricsByFile = new Map();
            const scanComplexity = (dir) => {
                if (!fs.existsSync(dir))
                    return;
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if ([
                            "node_modules",
                            ".git",
                            "dist",
                            "build",
                            ".next",
                            ".pi-lens",
                        ].includes(entry.name))
                            continue;
                        scanComplexity(full);
                    }
                    else if (complexityClient.isSupportedFile(full) &&
                        !/\.(test|spec)\.[jt]sx?$/.test(entry.name) &&
                        !(isTsProject && /\.js$/.test(entry.name))) {
                        const m = complexityClient.analyzeFile(full);
                        if (m)
                            metricsByFile.set(full, {
                                mi: m.maintainabilityIndex,
                                cognitive: m.cognitiveComplexity,
                                nesting: m.maxNestingDepth,
                            });
                    }
                }
            };
            scanComplexity(targetPath);
            // --- Score each file ---
            const allFiles = new Set([...skipByFile.keys(), ...metricsByFile.keys()]);
            const scored = [...allFiles]
                .map((file) => {
                let score = 0;
                const m = metricsByFile.get(file);
                if (m) {
                    if (m.mi < 20)
                        score += 5;
                    else if (m.mi < 40)
                        score += 3;
                    else if (m.mi < 60)
                        score += 1;
                    if (m.cognitive > 300)
                        score += 4;
                    else if (m.cognitive > 150)
                        score += 2;
                    else if (m.cognitive > 80)
                        score += 1;
                    if (m.nesting > 8)
                        score += 2;
                    else if (m.nesting > 5)
                        score += 1;
                }
                for (const issue of skipByFile.get(file) ?? []) {
                    if (issue.rule === "large-class")
                        score += 5;
                    else if (issue.rule === "no-as-any")
                        score += 2;
                    else
                        score += 1;
                }
                return { file, score };
            })
                .filter((f) => f.score > 0)
                .sort((a, b) => b.score - a.score);
            if (scored.length === 0) {
                ctx.ui.notify("✅ No architectural debt found — codebase is clean.", "info");
                return;
            }
            const { file: worstFile, score } = scored[0];
            const relFile = path.relative(targetPath, worstFile).replace(/\\/g, "/");
            const issues = skipByFile.get(worstFile) ?? [];
            const metrics = metricsByFile.get(worstFile);
            // --- Code snippet ---
            let snippet = "";
            let snippetStart = 1;
            let snippetEnd = 1;
            try {
                const fileLines = fs.readFileSync(worstFile, "utf-8").split("\n");
                const firstLine = Math.max(0, (issues[0]?.line ?? 1) - 1);
                const start = Math.max(0, firstLine - 2);
                const end = Math.min(fileLines.length, start + 45);
                snippet = fileLines.slice(start, end).join("\n");
                snippetStart = start + 1;
                snippetEnd = end;
            }
            catch {
                void 0;
            }
            // --- Steer agent (agent generates options + calls interviewer tool) ---
            const ruleGroups = new Map();
            for (const i of issues)
                ruleGroups.set(i.rule, (ruleGroups.get(i.rule) ?? 0) + 1);
            const issuesSummary = [...ruleGroups.entries()]
                .map(([r, n]) => `- \`${r}\` (×${n})${RULE_ACTIONS[r] ? ` — ${RULE_ACTIONS[r].note}` : ""}`)
                .join("\n");
            const metricsSummary = metrics
                ? `MI: ${metrics.mi.toFixed(1)}, Cognitive: ${metrics.cognitive}, Nesting: ${metrics.nesting}`
                : "";
            const steer = [
                `🏗️ BOOBOO REFACTOR — worst offender identified`,
                "",
                `**File**: \`${relFile}\` (debt score: ${score})`,
                "",
                metrics ? `**Complexity**: ${metricsSummary}` : "",
                "",
                issues.length > 0 ? `**Violations**:\n${issuesSummary}` : "",
                "",
                `**Code** (\`${relFile}\` lines ${snippetStart}–${snippetEnd}):`,
                "```typescript",
                snippet,
                "```",
                "",
                "**Your job**:",
                "1. Analyze this code — what's the most impactful refactoring for this file?",
                "2. Build 3-5 refactoring options. For each, explain *why* it helps and *what* you'd change. Mark one as recommended.",
                "3. For each option, estimate the impact: linesReduced (number), miProjection (e.g. '3.5 → 8'), cognitiveProjection (e.g. '1533 → 1400').",
                "4. Include an option to skip to the next worst offender.",
                "5. Call the `interviewer` tool with:",
                "   - `question`: what you're asking the user",
                "   - `options`: array of { value, label, context, recommended, impact: { linesReduced, miProjection, cognitiveProjection } }",
                "6. The user picks an option or types a free-text response in the browser form.",
                "7. Based on their choice, write the proposed changes to TEMP files (e.g. /tmp/). Compute a unified diff: `diff -u <original> <temp>`.",
                "8. Call the `interviewer` tool AGAIN with confirmationMode=true, plan (your step-by-step plan), and diff (the unified diff). The user sees the plan + diff + line counts and clicks Confirm, Cancel, or describes a different approach.",
                "9. If the user types a different approach: delete temp files, re-generate the plan+diff based on their feedback, call interviewer with confirmationMode again. Repeat until confirmed or cancelled.",
                "10. If confirmed: apply changes to the real files. If cancelled: delete temp files, make no changes.",
            ].join("\n");
            pi.sendUserMessage(steer, { deliverAs: "steer" });
        },
    });
    pi.registerCommand("lens-metrics", {
        description: "Measure complexity metrics for all files and export to report.md. Usage: /lens-metrics [path]",
        handler: async (args, ctx) => {
            const targetPath = args.trim() || ctx.cwd || process.cwd();
            ctx.ui.notify("📊 Measuring code metrics...", "info");
            const fs = require("node:fs");
            const reviewDir = path.join(process.cwd(), ".pi-lens", "reviews");
            const timestamp = new Date()
                .toISOString()
                .replace(/[:.]/g, "-")
                .slice(0, 19);
            const projectName = path.basename(process.cwd());
            const results = [];
            const scanDir = (dir) => {
                let entries;
                try {
                    entries = nodeFs.readdirSync(dir, { withFileTypes: true });
                }
                catch {
                    return;
                }
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory() &&
                        ![
                            "node_modules",
                            ".git",
                            "dist",
                            "build",
                            ".next",
                            ".pi-lens",
                        ].includes(entry.name)) {
                        scanDir(fullPath);
                    }
                    else if (complexityClient.isSupportedFile(fullPath)) {
                        const metrics = complexityClient.analyzeFile(fullPath);
                        if (metrics) {
                            results.push(metrics);
                        }
                    }
                }
            };
            scanDir(targetPath);
            if (results.length === 0) {
                ctx.ui.notify("No supported files found to analyze", "warning");
                return;
            }
            // Calculate aggregates
            const avgMI = results.reduce((a, b) => a + b.maintainabilityIndex, 0) /
                results.length;
            const avgCognitive = results.reduce((a, b) => a + b.cognitiveComplexity, 0) / results.length;
            const avgCyclomatic = results.reduce((a, b) => a + b.cyclomaticComplexity, 0) /
                results.length;
            const avgFunctionLength = results.reduce((a, b) => a + b.avgFunctionLength, 0) / results.length;
            const maxNesting = Math.max(...results.map((r) => r.maxNestingDepth));
            const maxCognitive = Math.max(...results.map((r) => r.cognitiveComplexity));
            const minMI = Math.min(...results.map((r) => r.maintainabilityIndex));
            const totalFunctions = results.reduce((a, b) => a + b.functionCount, 0);
            const totalLOC = results.reduce((a, b) => a + b.linesOfCode, 0);
            // Grade distribution
            const grades = results.map((r) => {
                const mi = r.maintainabilityIndex;
                if (mi >= 80)
                    return { letter: "A", color: "🟢" };
                if (mi >= 60)
                    return { letter: "B", color: "🟡" };
                if (mi >= 40)
                    return { letter: "C", color: "🟠" };
                if (mi >= 20)
                    return { letter: "D", color: "🔴" };
                return { letter: "F", color: "⚫" };
            });
            const gradeCount = { A: 0, B: 0, C: 0, D: 0, F: 0 };
            grades.forEach((g) => gradeCount[g.letter]++);
            // Build report
            let report = `# Code Metrics Report: ${projectName}\n\n`;
            report += `**Generated:** ${new Date().toISOString()}\n\n`;
            report += `**Path:** \`${targetPath}\`\n\n`;
            report += `---\n\n`;
            // AI slop aggregates
            const totalAISlopWarnings = results.reduce((a, b) => {
                return a + complexityClient.checkThresholds(b).length;
            }, 0);
            const totalEmojiComments = results.reduce((a, b) => a + b.aiCommentPatterns, 0);
            const totalTryCatch = results.reduce((a, b) => a + b.tryCatchCount, 0);
            const totalSingleUse = results.reduce((a, b) => a + b.singleUseFunctions, 0);
            const maxParams = Math.max(...results.map((r) => r.maxParamsInFunction));
            // Summary
            report += `## Summary\n\n`;
            report += `| Metric | Value |\n`;
            report += `|--------|-------|\n`;
            report += `| Files Analyzed | ${results.length} |\n`;
            report += `| Total Functions | ${totalFunctions} |\n`;
            report += `| Total Lines of Code | ${totalLOC.toLocaleString()} |\n`;
            report += `| Avg Maintainability Index | ${avgMI.toFixed(1)} |\n`;
            report += `| Min Maintainability Index | ${minMI.toFixed(1)} |\n`;
            report += `| Avg Cognitive Complexity | ${avgCognitive.toFixed(1)} |\n`;
            report += `| Max Cognitive Complexity | ${maxCognitive} |\n`;
            report += `| Avg Cyclomatic Complexity | ${avgCyclomatic.toFixed(1)} |\n`;
            report += `| Max Nesting Depth | ${maxNesting} |\n`;
            report += `| Avg Function Length | ${avgFunctionLength.toFixed(1)} lines |\n\n`;
            // AI Slop Summary
            report += `## AI Slop Indicators (Aggregate)\n\n`;
            report += `| Indicator | Count |\n`;
            report += `|-----------|-------|\n`;
            report += `| Total Warnings | ${totalAISlopWarnings} |\n`;
            report += `| Emoji/Boilerplate Comments | ${totalEmojiComments} |\n`;
            report += `| Try/Catch Blocks | ${totalTryCatch} |\n`;
            report += `| Single-Use Helper Functions | ${totalSingleUse} |\n`;
            report += `| Max Function Parameters | ${maxParams} |\n\n`;
            // Grade distribution
            report += `## Maintainability Grade Distribution\n\n`;
            report += `| Grade | Count | Percentage |\n`;
            report += `|-------|-------|------------|\n`;
            for (const [grade, count] of Object.entries(gradeCount)) {
                const pct = ((count / results.length) * 100).toFixed(1);
                const gradeIcons = {
                    A: "🟢",
                    B: "🟡",
                    C: "🟠",
                    D: "🔴",
                };
                const gradeThresholds = {
                    A: 80,
                    B: 60,
                    C: 40,
                    D: 20,
                };
                const icon = gradeIcons[grade] ?? "⚫";
                const threshold = gradeThresholds[grade] ?? 0;
                report += `| ${icon} ${grade} (MI ≥ ${threshold}) | ${count} | ${pct}% |\n`;
            }
            report += `\n`;
            // All files table (sorted by MI ascending)
            report += `## All Files\n\n`;
            report += `| Grade | File | MI | Cognitive | Cyclomatic | Nesting | Functions | LOC | Entropy |\n`;
            report += `|-------|------|-----|-----------|------------|---------|-----------|-----|--------|\n`;
            const sorted = [...results].sort((a, b) => a.maintainabilityIndex - b.maintainabilityIndex);
            for (const f of sorted) {
                const mi = f.maintainabilityIndex;
                let grade;
                if (mi >= 80)
                    grade = "🟢 A";
                else if (mi >= 60)
                    grade = "🟡 B";
                else if (mi >= 40)
                    grade = "🟠 C";
                else if (mi >= 20)
                    grade = "🔴 D";
                else
                    grade = "⚫ F";
                // Make path relative for readability
                const relPath = path.relative(targetPath, f.filePath);
                report += `| ${grade} | ${relPath} | ${mi.toFixed(1)} | ${f.cognitiveComplexity} | ${f.cyclomaticComplexity.toFixed(1)} | ${f.maxNestingDepth} | ${f.functionCount} | ${f.linesOfCode} | ${f.codeEntropy.toFixed(2)} |\n`;
            }
            report += `\n`;
            // Top 10 worst files (actionable)
            report += `## Top 10 Files Needing Attention\n\n`;
            report += `These files have the lowest maintainability scores:\n\n`;
            for (let i = 0; i < Math.min(10, sorted.length); i++) {
                const f = sorted[i];
                const relPath = path.relative(targetPath, f.filePath);
                const warnings = [];
                if (f.maintainabilityIndex < 20)
                    warnings.push("🔴 Critical: MI < 20");
                else if (f.maintainabilityIndex < 40)
                    warnings.push("🟠 Low: MI < 40");
                if (f.cognitiveComplexity > 50)
                    warnings.push(`High cognitive (${f.cognitiveComplexity})`);
                if (f.maxNestingDepth > 5)
                    warnings.push(`Deep nesting (${f.maxNestingDepth})`);
                if (f.maxFunctionLength > 50)
                    warnings.push(`Long functions (max ${f.maxFunctionLength})`);
                // AI slop indicators
                const slopWarnings = complexityClient.checkThresholds(f);
                for (const w of slopWarnings) {
                    if (w.includes("AI-style") ||
                        w.includes("try/catch") ||
                        w.includes("single-use") ||
                        w.includes("parameter list")) {
                        warnings.push(`🤖 ${w.split(" — ")[0]}`);
                    }
                }
                report += `${i + 1}. **${relPath}** — MI: ${f.maintainabilityIndex.toFixed(1)}\n`;
                if (warnings.length > 0) {
                    report += `   - ${warnings.join(", ")}\n`;
                }
            }
            report += `\n`;
            // Save report
            fs.mkdirSync(reviewDir, { recursive: true });
            const reportPath = path.join(reviewDir, `metrics-${timestamp}.md`);
            fs.writeFileSync(reportPath, report, "utf-8");
            // Also save latest.md for easy access
            const latestPath = path.join(reviewDir, "latest.md");
            fs.writeFileSync(latestPath, report, "utf-8");
            // Console summary
            const summary = [
                `📊 Metrics Report`,
                `   ${results.length} files, ${totalLOC.toLocaleString()} LOC, ${totalFunctions} functions`,
                `   MI: ${avgMI.toFixed(1)} avg (${gradeCount.A}A ${gradeCount.B}B ${gradeCount.C}C ${gradeCount.D}D ${gradeCount.F}F)`,
                `   Cognitive: ${avgCognitive.toFixed(1)} avg, ${maxCognitive} max`,
                `📄 Saved: ${reportPath}`,
            ].join("\n");
            ctx.ui.notify(summary, "info");
        },
    });
    pi.registerCommand("lens-format", {
        description: "Apply Biome formatting to files. Usage: /lens-format [file-path] or /lens-format --all",
        handler: async (args, ctx) => {
            if (!biomeClient.isAvailable()) {
                ctx.ui.notify("Biome not installed. Run: npm install -D @biomejs/biome", "error");
                return;
            }
            const arg = args.trim();
            if (!arg || arg === "--all") {
                ctx.ui.notify("🔍 Formatting all files...", "info");
                let formatted = 0;
                let skipped = 0;
                const formatDir = (dir) => {
                    let entries;
                    try {
                        entries = nodeFs.readdirSync(dir, { withFileTypes: true });
                    }
                    catch {
                        return;
                    }
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory() &&
                            !["node_modules", ".git", "dist", "build", ".next"].includes(entry.name)) {
                            formatDir(fullPath);
                        }
                        else if (/\.(ts|tsx|js|jsx|json|css)$/.test(entry.name)) {
                            const result = biomeClient.formatFile(fullPath);
                            if (result.changed)
                                formatted++;
                            else if (result.success)
                                skipped++;
                        }
                    }
                };
                formatDir(ctx.cwd || process.cwd());
                ctx.ui.notify(`✓ Formatted ${formatted} file(s), ${skipped} already clean`, "info");
                return;
            }
            const filePath = path.resolve(arg);
            const result = biomeClient.formatFile(filePath);
            if (result.success && result.changed) {
                ctx.ui.notify(`✓ Formatted ${path.basename(filePath)}`, "info");
            }
            else if (result.success) {
                ctx.ui.notify(`✓ ${path.basename(filePath)} already clean`, "info");
            }
            else {
                ctx.ui.notify(`⚠️ Format failed: ${result.error}`, "error");
            }
        },
    });
    // --- Tools ---
    const LANGUAGES = [
        "c",
        "cpp",
        "csharp",
        "css",
        "dart",
        "elixir",
        "go",
        "haskell",
        "html",
        "java",
        "javascript",
        "json",
        "kotlin",
        "lua",
        "php",
        "python",
        "ruby",
        "rust",
        "scala",
        "sql",
        "swift",
        "tsx",
        "typescript",
        "yaml",
    ];
    let interviewHandler = null;
    const confirmationHTML = (question, plan, diff) => {
        const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const mdToHtml = (md) => md
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/^### (.+)/gm, "<h4>$1</h4>")
            .replace(/^## (.+)/gm, "<h3>$1</h3>")
            .replace(/^# (.+)/gm, "<h2>$1</h2>")
            .replace(/^- (.+)/gm, "<li>$1</li>")
            .replace(/\n\n/g, "</p><p>");
        const diffLines = diff.split("\n");
        const diffHtml = diffLines
            .map((line) => {
            if (line.startsWith("+++") || line.startsWith("---"))
                return `<span class="df">${esc(line)}</span>`;
            if (line.startsWith("@@"))
                return `<span class="dh">${esc(line)}</span>`;
            if (line.startsWith("+"))
                return `<span class="da">${esc(line)}</span>`;
            if (line.startsWith("-"))
                return `<span class="dd">${esc(line)}</span>`;
            return `<span class="dc">${esc(line)}</span>`;
        })
            .join("\n");
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>✅ Confirm</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;padding:28px 32px;max-width:960px;margin:0 auto;line-height:1.5}
h2{font-size:16px;color:#58a6ff;margin-bottom:14px}
.plan{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 18px;margin-bottom:18px;font-size:13px;line-height:1.6}
.plan h3{color:#f0f6fc;font-size:14px;margin:10px 0 4px}.plan h4{color:#c9d1d9;font-size:13px;margin:8px 0 3px}
.plan li{margin:2px 0 2px 16px;list-style:disc}.plan code{background:#21262d;padding:1px 5px;border-radius:3px;font-size:12px}
.diff-wrap{background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:18px;overflow:hidden}
.diff-hdr{padding:7px 14px;font-size:11px;color:#8b949e;border-bottom:1px solid #30363d;font-family:monospace;display:flex;justify-content:space-between}
.diff-stats{display:flex;gap:10px}.stat-add{color:#3fb950}.stat-del{color:#ff7b72}
.diff-pre{padding:12px;font-family:'Fira Code',Consolas,monospace;font-size:12px;line-height:1.55;overflow-x:auto;white-space:pre;margin:0}
.da{color:#3fb950;display:block}.dd{color:#ff7b72;display:block}.dh{color:#79c0ff;display:block}.df{color:#8b949e;display:block}.dc{color:#e6edf3;display:block}
.actions{display:flex;gap:10px;flex-wrap:wrap}
.btn-c{background:#238636;color:#fff;border:1px solid #2ea043;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
.btn-c:hover{background:#2ea043}
.btn-r{background:#1a2332;color:#79c0ff;border:1px solid #1f6feb;padding:10px 24px;border-radius:6px;font-size:14px;cursor:pointer}
.btn-r:hover{background:#1f3050}
.btn-x{background:#21262d;color:#e6edf3;border:1px solid #30363d;padding:10px 24px;border-radius:6px;font-size:14px;cursor:pointer}
.btn-x:hover{background:#30363d}
.redo-area{display:none;margin-top:12px}
textarea{width:100%;background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:9px;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical;min-height:72px;outline:none}
textarea:focus{border-color:#58a6ff}
.hint{color:#6e7681;font-size:12px;margin-top:10px}
</style></head><body>
<h2>${esc(question)}</h2>
<div class="plan"><strong>Plan:</strong><p>${mdToHtml(plan)}</p></div>
<div class="diff-wrap"><div class="diff-hdr"><span>Changes</span><div class="diff-stats"><span class="stat-add">+${(diff.match(/^\+/gm) || []).length}</span><span class="stat-del">−${(diff.match(/^-/gm) || []).length - (diff.match(/^---/gm) || []).length}</span></div></div><pre class="diff-pre">${diffHtml}</pre></div>
<form method="POST" id="f">
<input type="hidden" name="choice" id="c" value="Confirm">
<div class="actions">
<button class="btn-c" type="submit" onclick="document.getElementById('c').value='Confirm'">✅ Confirm and apply</button>
<button class="btn-r" type="button" onclick="toggleRedo()">🔄 Describe a different approach</button>
<button class="btn-x" type="submit" onclick="document.getElementById('c').value='Cancel'">❌ Cancel</button>
</div>
<div class="redo-area" id="ra"><textarea name="freeText" placeholder="What would you do differently? The agent will re-generate the plan and diff..."></textarea>
<div style="margin-top:8px"><button class="btn-c" type="submit" onclick="document.getElementById('c').value='Redo'">Submit revised approach</button></div></div>
</form>
<p class="hint">Ctrl+Enter to confirm · Tab stays open until you decide</p>
<script>
function toggleRedo(){const r=document.getElementById('ra');r.style.display=r.style.display==='none'?'block':'none';if(r.style.display==='block')r.querySelector('textarea').focus();}
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){const r=document.getElementById('ra');if(r.style.display==='block'){document.getElementById('c').value='Redo';}document.getElementById('f').submit();}});
</script>
</body></html>`;
    };
    const interviewHTML = (question, options, _timeoutSeconds, _plan, _diff, _confirmationMode) => {
        if (_confirmationMode && _plan && _diff) {
            return confirmationHTML(question, _plan, _diff);
        }
        const esc = (s) => s
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        const impactBadge = (val, label, good) => `<span class="ib ${good ? "up" : "dn"}">${val > 0 ? "+" : ""}${val} ${label}</span>`;
        const optionsHtml = options
            .map((opt, idx) => {
            let impactHtml = "";
            if (opt.impact) {
                const parts = [];
                if (opt.impact.linesReduced !== undefined)
                    parts.push(impactBadge(opt.impact.linesReduced, "lines", true));
                if (opt.impact.miProjection)
                    parts.push(`<span class="ib proj">MI ${opt.impact.miProjection}</span>`);
                if (opt.impact.cognitiveProjection)
                    parts.push(`<span class="ib proj">Cognitive ${opt.impact.cognitiveProjection}</span>`);
                if (parts.length)
                    impactHtml = `<div class="impact">${parts.join("")}</div>`;
            }
            return `
			<label class="card${opt.recommended ? " rec" : ""}">
				<input type="radio" name="choice" value="${esc(opt.value)}"${opt.recommended ? " checked" : ""}>
				<div class="card-body">
					<div class="card-top"><span class="num">${idx + 1}.</span><span class="lbl">${esc(opt.label)}</span>${opt.recommended ? '<span class="badge-rec">Recommended</span>' : ""}</div>
					${impactHtml}${opt.context ? `<div class="ctx">${esc(opt.context)}</div>` : ""}
				</div>
			</label>`;
        })
            .join("\n");
        const hasFreeText = options.some((o) => o.value === "__free__");
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🏗️ Decision</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;padding:28px 32px;max-width:880px;margin:0 auto;line-height:1.5}
.question{font-size:15px;font-weight:600;color:#f0f6fc;margin-bottom:12px}
.opts{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.card{border:1px solid #30363d;border-radius:8px;padding:11px 14px;cursor:pointer;transition:border-color .12s,background .12s;display:flex;align-items:flex-start;gap:10px}
.card:hover,.card.selected{border-color:#58a6ff;background:#0d1f30}.card.rec{border-color:#1f6feb}
.card input{margin-top:3px;accent-color:#58a6ff;flex-shrink:0}.card-body{flex:1}
.card-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.num{color:#6e7681;font-size:13px;min-width:18px}.lbl{font-size:13.5px;font-weight:500}
.badge-rec{background:#1f4e2e;color:#3fb950;font-size:10px;padding:1px 7px;border-radius:10px;margin-left:4px;font-weight:600}
.ctx{color:#8b949e;font-size:12px;margin-top:3px;padding-left:22px}
.impact{display:flex;gap:6px;margin-top:5px;padding-left:22px;flex-wrap:wrap}
.ib{font-size:11px;padding:2px 8px;border-radius:10px;font-family:monospace;font-weight:600}
.ib.up{background:#1a3a2a;color:#3fb950;border:1px solid #238636}
.ib.dn{background:#3a1a1a;color:#ff7b72;border:1px solid #f85149}
.ib.proj{background:#1a2a3a;color:#79c0ff;border:1px solid #1f6feb}
.free-area{display:none;margin-top:10px;padding-left:22px}
textarea{width:100%;background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:9px;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical;min-height:72px;outline:none}
textarea:focus{border-color:#58a6ff}
.submit-row{display:flex;align-items:center;gap:12px;margin-top:4px}
button{background:#238636;color:#fff;border:1px solid #2ea043;padding:9px 22px;border-radius:6px;font-size:13.5px;font-weight:600;cursor:pointer;transition:background .12s}
button:hover{background:#2ea043}.hint{color:#6e7681;font-size:12px}
</style></head><body>
<div class="question">${esc(question)}</div>
<form method="POST" id="f">
<div class="opts">${optionsHtml}</div>
${hasFreeText ? '<div class="free-area" id="fa"><textarea name="freeText" placeholder="Describe your preferred approach..."></textarea></div>' : ""}
<div class="submit-row"><button type="submit">Submit</button><span class="hint">Ctrl+Enter</span></div>
</form>
<script>
const cards=document.querySelectorAll('.card');function sel(c){cards.forEach(x=>{x.classList.remove('selected');x.querySelector('input').checked=false});c.classList.add('selected');c.querySelector('input').checked=true;const fa=document.getElementById('fa');if(fa)fa.style.display=c.querySelector('input').value==='__free__'?'block':'none';}
cards.forEach(c=>c.addEventListener('click',()=>sel(c)));const rec=document.querySelector('.card.rec');if(rec)sel(rec);else if(cards.length)sel(cards[0]);
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter')document.getElementById('f').submit();});
</script></body></html>`;
    };
    const openBrowserInterview = (html, timeoutSeconds) => {
        const http = require("node:http");
        const net = require("node:net");
        return new Promise((resolve) => {
            const getPort = (cb) => {
                const s = net.createServer();
                s.listen(0, () => {
                    const p = s.address().port;
                    s.close(() => cb(p));
                });
                s.on("error", () => cb(-1));
            };
            getPort((port) => {
                if (port < 0) {
                    resolve(null);
                    return;
                }
                const server = http.createServer((req, res) => {
                    if (req.method === "GET") {
                        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                        res.end(html);
                    }
                    else if (req.method === "POST") {
                        let body = "";
                        req.on("data", (c) => {
                            body += c.toString();
                        });
                        req.on("end", () => {
                            const p = new URLSearchParams(body);
                            const choice = p.get("choice") ?? "";
                            const freeText = p.get("freeText") ?? "";
                            const final = choice === "__free__" ? freeText.trim() : choice;
                            res.writeHead(200, {
                                "Content-Type": "text/html; charset=utf-8",
                            });
                            res.end("<!DOCTYPE html><html><head><meta charset='UTF-8'><style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style></head><body><div><h2>✅ Response received</h2><p style='color:#8b949e;margin-top:8px'>You can close this tab.</p></div></body></html>");
                            clearTimeout(timer);
                            server.close();
                            resolve(final || null);
                        });
                    }
                });
                server.listen(port);
                const { spawnSync } = require("node:child_process");
                const url = `http://localhost:${port}`;
                if (process.platform === "win32")
                    spawnSync("cmd", ["/c", "start", "", url], { shell: false });
                else if (process.platform === "darwin")
                    spawnSync("open", [url]);
                else
                    spawnSync("xdg-open", [url]);
                const timer = setTimeout(() => {
                    server.close();
                    resolve(null);
                }, timeoutSeconds * 1000);
            });
        });
    };
    // Store handler so command can call it later
    interviewHandler = (question, options, timeoutSeconds, plan, diff, confirmationMode) => openBrowserInterview(interviewHTML(question, options, timeoutSeconds, plan, diff, confirmationMode), timeoutSeconds);
    pi.registerTool({
        name: "interviewer",
        label: "Interview",
        description: "Present a multiple-choice interview to the user via browser form. Use this when you need the user to make a decision with options. Returns their choice or null on timeout.",
        parameters: Type.Object({
            question: Type.String({
                description: "The question to present to the user",
            }),
            options: Type.Optional(Type.Array(Type.Object({
                value: Type.String(),
                label: Type.String(),
                context: Type.Optional(Type.String()),
                recommended: Type.Optional(Type.Boolean()),
                impact: Type.Optional(Type.Object({
                    linesReduced: Type.Optional(Type.Number()),
                    miProjection: Type.Optional(Type.String()),
                    cognitiveProjection: Type.Optional(Type.String()),
                })),
            }), {
                description: "Answer options — include { value, label, context, recommended, impact }",
            })),
            plan: Type.Optional(Type.String({ description: "Refactoring plan to display in confirmation mode" })),
            diff: Type.Optional(Type.String({ description: "Unified diff to display in confirmation mode" })),
            confirmationMode: Type.Optional(Type.Boolean({ description: "Show plan+diff confirmation screen instead of option selection" })),
            timeoutSeconds: Type.Optional(Type.Number({
                description: "Auto-close after this many seconds (default 600)",
            })),
        }),
        async execute(_toolCallId, input, _signal, _onUpdate, _ctx) {
            if (!interviewHandler)
                return {
                    content: [
                        { type: "text", text: "Interview tool not initialized" },
                    ],
                    details: null,
                };
            const result = await interviewHandler(input.question, input.options ?? [], input.timeoutSeconds ?? 600, input.plan, input.diff, input.confirmationMode);
            return {
                content: [
                    {
                        type: "text",
                        text: result ?? "No response (timed out or dismissed)",
                    },
                ],
                details: result ?? null,
            };
        },
    });
    pi.registerTool({
        name: "ast_grep_search",
        label: "AST Search",
        description: "Search code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, NOT text search. Examples:\n- Find function: 'function $NAME() { $$$BODY }'\n- Find call: 'fetchMetrics($ARGS)'\n- Find import: 'import { $NAMES } from \"$PATH\"'\n- Generic identifier (broad): 'fetchMetrics'\n\nAlways prefer specific patterns with context over bare identifiers. Use 'paths' to scope to specific files/folders.",
        promptSnippet: "Use ast_grep_search for AST-aware code search",
        parameters: Type.Object({
            pattern: Type.String({
                description: "AST pattern (use function/class/call context, not text)",
            }),
            lang: Type.Union(LANGUAGES.map((l) => Type.Literal(l)), { description: "Target language" }),
            paths: Type.Optional(Type.Array(Type.String(), {
                description: "Specific files/folders to search",
            })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!astGrepClient.isAvailable()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
                        },
                    ],
                    isError: true,
                    details: {},
                };
            }
            const { pattern, lang, paths } = params;
            const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
            const result = await astGrepClient.search(pattern, lang, searchPaths);
            if (result.error) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error}` }],
                    isError: true,
                    details: {},
                };
            }
            const output = astGrepClient.formatMatches(result.matches);
            return {
                content: [{ type: "text", text: output }],
                details: { matchCount: result.matches.length },
            };
        },
    });
    pi.registerTool({
        name: "ast_grep_replace",
        label: "AST Replace",
        description: "Replace code using AST-aware pattern matching. IMPORTANT: Use specific AST patterns, not text. Dry-run by default (use apply=true to apply).\n\nExamples:\n- pattern='console.log($MSG)' rewrite='logger.info($MSG)'\n- pattern='var $X' rewrite='let $X'\n- pattern='function $NAME() { }' rewrite='' (delete)\n\nAlways use 'paths' to scope to specific files/folders. Dry-run first to preview changes.",
        promptSnippet: "Use ast_grep_replace for AST-aware find-and-replace",
        parameters: Type.Object({
            pattern: Type.String({
                description: "AST pattern to match (be specific with context)",
            }),
            rewrite: Type.String({
                description: "Replacement using meta-variables from pattern",
            }),
            lang: Type.Union(LANGUAGES.map((l) => Type.Literal(l)), { description: "Target language" }),
            paths: Type.Optional(Type.Array(Type.String(), { description: "Specific files/folders" })),
            apply: Type.Optional(Type.Boolean({ description: "Apply changes (default: false)" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!astGrepClient.isAvailable()) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
                        },
                    ],
                    isError: true,
                    details: {},
                };
            }
            const { pattern, rewrite, lang, paths, apply } = params;
            const searchPaths = paths?.length ? paths : [ctx.cwd || "."];
            const result = await astGrepClient.replace(pattern, rewrite, lang, searchPaths, apply ?? false);
            if (result.error) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error}` }],
                    isError: true,
                    details: {},
                };
            }
            const isDryRun = !apply;
            let output = astGrepClient.formatMatches(result.matches, isDryRun);
            if (isDryRun && result.matches.length > 0)
                output += "\n\n(Dry run - use apply=true to apply)";
            if (apply && result.matches.length > 0)
                output = `Applied ${result.matches.length} replacements:\n${output}`;
            return {
                content: [{ type: "text", text: output }],
                details: { matchCount: result.matches.length, applied: apply ?? false },
            };
        },
    });
    let cachedJscpdClones = [];
    const cachedExports = new Map(); // function name -> file path
    const complexityBaselines = new Map();
    // Delta baselines: store pre-write diagnostics to diff against post-write
    const astGrepBaselines = new Map();
    const biomeBaselines = new Map();
    // --- Events ---
    pi.on("session_start", async (_event, ctx) => {
        _verbose = !!pi.getFlag("lens-verbose");
        dbg("session_start fired");
        // Reset session state
        metricsClient.reset();
        complexityBaselines.clear();
        // Log available tools
        const tools = [];
        tools.push("TypeScript LSP"); // Always available
        if (biomeClient.isAvailable())
            tools.push("Biome");
        if (astGrepClient.isAvailable())
            tools.push("ast-grep");
        if (ruffClient.isAvailable())
            tools.push("Ruff");
        if (knipClient.isAvailable())
            tools.push("Knip");
        if (depChecker.isAvailable())
            tools.push("Madge");
        if (jscpdClient.isAvailable())
            tools.push("jscpd");
        if (typeCoverageClient.isAvailable())
            tools.push("type-coverage");
        log(`Active tools: ${tools.join(", ")}`);
        dbg(`session_start tools: ${tools.join(", ")}`);
        const cwd = ctx.cwd ?? process.cwd();
        dbg(`session_start cwd: ${cwd}`);
        // Log test runner if detected
        const detectedRunner = testRunnerClient.detectRunner(cwd);
        if (detectedRunner) {
            tools.push(`Test runner (${detectedRunner.runner})`);
        }
        if (goClient.isGoAvailable())
            tools.push("Go (go vet)");
        if (rustClient.isAvailable())
            tools.push("Rust (cargo)");
        log(`Active tools: ${tools.join(", ")}`);
        dbg(`session_start tools: ${tools.join(", ")}`);
        const parts = [];
        // TODO/FIXME scan — fast, no deps
        const todoResult = todoScanner.scanDirectory(cwd);
        const todoReport = todoScanner.formatResult(todoResult);
        dbg(`session_start TODO scan: ${todoResult.items.length} items`);
        if (todoReport)
            parts.push(todoReport);
        // Dead code scan — only if knip is available
        if (knipClient.isAvailable()) {
            const knipResult = knipClient.analyze(cwd);
            const knipReport = knipClient.formatResult(knipResult);
            dbg(`session_start Knip scan done`);
            if (knipReport)
                parts.push(knipReport);
        }
        else {
            dbg(`session_start Knip: not available`);
        }
        // Duplicate code detection (cached for real-time feedback)
        if (jscpdClient.isAvailable()) {
            const jscpdResult = jscpdClient.scan(cwd);
            cachedJscpdClones = jscpdResult.clones;
            const jscpdReport = jscpdClient.formatResult(jscpdResult);
            dbg(`session_start jscpd scan done`);
            if (jscpdReport)
                parts.push(jscpdReport);
        }
        else {
            dbg(`session_start jscpd: not available`);
        }
        // TypeScript type coverage
        if (typeCoverageClient.isAvailable()) {
            const tcResult = typeCoverageClient.scan(cwd);
            const tcReport = typeCoverageClient.formatResult(tcResult);
            dbg(`session_start type-coverage scan done`);
            if (tcReport)
                parts.push(tcReport);
        }
        else {
            dbg(`session_start type-coverage: not available`);
        }
        // Scan for exported functions (cached for duplicate detection on write)
        if (astGrepClient.isAvailable()) {
            const exports = await astGrepClient.scanExports(cwd, "typescript");
            dbg(`session_start exports scan: ${exports.size} functions found`);
            for (const [name, file] of exports) {
                cachedExports.set(name, file);
            }
        }
        dbg(`session_start: scans complete (${parts.length} part(s)), cached for commands`);
    });
    // --- Pre-write proactive hints ---
    // Stored during tool_call, prepended to tool_result output so the agent sees them.
    const preWriteHints = new Map();
    pi.on("tool_call", async (event, _ctx) => {
        const filePath = isToolCallEventType("write", event) || isToolCallEventType("edit", event)
            ? event.input.path
            : undefined;
        if (!filePath)
            return;
        const fs = require("node:fs");
        dbg(`tool_call fired for: ${filePath} (exists: ${fs.existsSync(filePath)})`);
        if (!fs.existsSync(filePath))
            return;
        // Record complexity baseline for TS/JS files
        if (complexityClient.isSupportedFile(filePath) &&
            !complexityBaselines.has(filePath)) {
            const baseline = complexityClient.analyzeFile(filePath);
            if (baseline) {
                complexityBaselines.set(filePath, baseline);
            }
        }
        const hints = [];
        if (/\.(ts|tsx|js|jsx)$/.test(filePath) && !pi.getFlag("no-lsp")) {
            tsClient.updateFile(filePath, fs.readFileSync(filePath, "utf-8"));
            const diags = tsClient.getDiagnostics(filePath);
            if (diags.length > 0) {
                hints.push(`⚠ Pre-write: file already has ${diags.length} TypeScript error(s) — fix before adding more`);
            }
        }
        // Snapshot baselines for delta mode (no pre-write hints — delta handles it)
        if (!pi.getFlag("no-ast-grep") && astGrepClient.isAvailable()) {
            const baselineDiags = astGrepClient.scanFile(filePath);
            astGrepBaselines.set(filePath, baselineDiags);
            // Add to TDR baseline
            const initialTdr = baselineDiags
                .filter((d) => d.ruleDescription?.grade !== undefined)
                .reduce((acc, d) => acc + (d.ruleDescription?.grade ?? 0), 0);
            metricsClient.recordBaseline(filePath, initialTdr);
        }
        else {
            metricsClient.recordBaseline(filePath);
        }
        if (!pi.getFlag("no-biome") &&
            biomeClient.isAvailable() &&
            biomeClient.isSupportedFile(filePath)) {
            biomeBaselines.set(filePath, biomeClient
                .checkFile(filePath)
                .filter((d) => d.category === "lint" || d.severity === "error"));
        }
        dbg(`  pre-write hints: ${hints.length} — ${hints.join(" | ") || "none"}`);
        if (hints.length > 0) {
            preWriteHints.set(filePath, hints.join("\n"));
        }
    });
    // Real-time feedback on file writes/edits
    pi.on("tool_result", async (event) => {
        if (event.toolName !== "write" && event.toolName !== "edit")
            return;
        const filePath = event.input.path;
        if (!filePath)
            return;
        dbg(`tool_result fired for: ${filePath}`);
        dbg(`  cwd: ${process.cwd()}`);
        dbg(`  __dirname: ${typeof __dirname !== "undefined" ? __dirname : "undefined"}`);
        // Prepend any pre-write hints collected during tool_call
        const preHint = preWriteHints.get(filePath);
        preWriteHints.delete(filePath);
        // Record write for metrics (silent tracking)
        const fs = require("node:fs");
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            metricsClient.recordWrite(filePath, content);
        }
        catch (err) {
            void err;
        }
        let lspOutput = preHint ? `\n\n${preHint}` : "";
        // TypeScript LSP diagnostics
        if (!pi.getFlag("no-lsp") && tsClient.isTypeScriptFile(filePath)) {
            try {
                tsClient.updateFile(filePath, fs.readFileSync(filePath, "utf-8"));
            }
            catch (err) {
                void err;
            }
            const diags = tsClient.getDiagnostics(filePath);
            if (diags.length > 0) {
                // Separate unused imports (TS6133, TS6196) from other diagnostics
                const unusedImports = diags.filter((d) => d.code === 6133 || d.code === 6196);
                const otherDiags = diags.filter((d) => d.code !== 6133 && d.code !== 6196);
                if (unusedImports.length > 0) {
                    lspOutput += `\n\n🧹 Remove ${unusedImports.length} unused import(s) — they are dead code:\n`;
                    for (const d of unusedImports.slice(0, 10)) {
                        lspOutput += `  L${d.range.start.line + 1}: ${d.message}\n`;
                    }
                }
                if (otherDiags.length > 0) {
                    const errors = otherDiags.filter((d) => d.severity !== 2);
                    const warnings = otherDiags.filter((d) => d.severity === 2);
                    if (errors.length > 0) {
                        lspOutput += `\n\n🔴 Fix ${errors.length} TypeScript error(s) — these must be resolved:\n`;
                        for (const d of errors.slice(0, 10)) {
                            lspOutput += `  L${d.range.start.line + 1}: ${d.message}\n`;
                        }
                    }
                    if (warnings.length > 0) {
                        lspOutput += `\n\n🟡 ${warnings.length} TypeScript warning(s) — address before moving on:\n`;
                        for (const d of warnings.slice(0, 10)) {
                            lspOutput += `  L${d.range.start.line + 1}: ${d.message}\n`;
                        }
                    }
                }
            }
        }
        // Python — Ruff linting + formatting
        if (!pi.getFlag("no-ruff") && ruffClient.isPythonFile(filePath)) {
            const diags = ruffClient.checkFile(filePath);
            const fmtReport = ruffClient.checkFormatting(filePath);
            const fixable = diags.filter((d) => d.fixable);
            const hasFormatIssues = !!fmtReport;
            if (pi.getFlag("autofix-ruff")) {
                // Apply fixes then re-check to show what remains
                let fixed = 0;
                let formatted = false;
                if (fixable.length > 0) {
                    const fixResult = ruffClient.fixFile(filePath);
                    if (fixResult.success && fixResult.changed)
                        fixed = fixResult.fixed ?? fixable.length;
                }
                const fmtResult = ruffClient.formatFile(filePath);
                if (fmtResult.success && fmtResult.changed)
                    formatted = true;
                if (fixed > 0 || formatted) {
                    lspOutput += `\n\n[Ruff] Auto-fixed: ${fixed} lint issue(s)${formatted ? ", reformatted" : ""} — file updated on disk`;
                    // Re-check remaining issues
                    const remaining = ruffClient.checkFile(filePath);
                    const remainingFmt = ruffClient.checkFormatting(filePath);
                    if (remaining.length > 0 || remainingFmt) {
                        lspOutput += `\n\n${ruffClient.formatDiagnostics(remaining)}`;
                        if (remainingFmt)
                            lspOutput += `\n\n${remainingFmt}`;
                    }
                    else {
                        lspOutput += `\n\n[Ruff] ✓ All issues resolved`;
                    }
                }
                else {
                    if (diags.length > 0)
                        lspOutput += `\n\n${ruffClient.formatDiagnostics(diags)}`;
                    if (fmtReport)
                        lspOutput += `\n\n${fmtReport}`;
                }
            }
            else {
                if (diags.length > 0)
                    lspOutput += `\n\n🟠 Fix ${diags.length} Ruff issue(s):\n${ruffClient.formatDiagnostics(diags)}`;
                if (fmtReport)
                    lspOutput += `\n\n${fmtReport}`;
                if (fixable.length > 0 || hasFormatIssues) {
                    lspOutput += `\n  → Enable --autofix-ruff to auto-fix ${fixable.length} of these on every write`;
                }
            }
        }
        // ast-grep structural analysis — delta mode (only show new violations)
        if (!pi.getFlag("no-ast-grep") && astGrepClient.isAvailable()) {
            const after = astGrepClient.scanFile(filePath);
            const before = astGrepBaselines.get(filePath) ?? [];
            astGrepBaselines.set(filePath, after);
            // Update TDR metrics with current diagnostics
            const tdrEntries = after
                .filter((d) => d.ruleDescription?.grade !== undefined)
                .map((d) => {
                const desc = d.ruleDescription;
                return {
                    category: d.rule,
                    count: desc?.grade ?? 0,
                    severity: d.severity === "error" ? "error" : "warning",
                };
            });
            metricsClient.updateTDR(filePath, tdrEntries);
            // Count by rule before/after
            const countBefore = new Map();
            const countAfter = new Map();
            for (const d of before)
                countBefore.set(d.rule, (countBefore.get(d.rule) ?? 0) + 1);
            for (const d of after)
                countAfter.set(d.rule, (countAfter.get(d.rule) ?? 0) + 1);
            // Find new/increased rules
            const newViolations = [];
            for (const d of after) {
                const ruleBefore = countBefore.get(d.rule) ?? 0;
                const ruleAfter = countAfter.get(d.rule) ?? 0;
                if (ruleAfter > ruleBefore &&
                    newViolations.filter((x) => x.rule === d.rule).length <
                        ruleAfter - ruleBefore) {
                    newViolations.push(d);
                }
            }
            // Find fixed rules
            const fixedRules = [];
            for (const [rule, n] of countBefore) {
                const after_n = countAfter.get(rule) ?? 0;
                if (after_n < n)
                    fixedRules.push(`${rule} (-${n - after_n})`);
            }
            // Filter out skip-category rules — architectural, handled by /lens-refactor
            const actionableViolations = newViolations.filter((v) => !SKIP_RULES.has(v.rule));
            if (actionableViolations.length > 0) {
                const hasFixable = actionableViolations.some((v) => v.fix);
                lspOutput += `\n\n🔴 STOP — you introduced ${actionableViolations.length} new structural violation(s). Fix before continuing:\n`;
                lspOutput += astGrepClient.formatDiagnostics(actionableViolations);
                if (hasFixable)
                    lspOutput += `\n  → Auto-fixable: check the hints above`;
            }
            if (fixedRules.length > 0) {
                lspOutput += `\n\n✅ ast-grep: fixed ${fixedRules.join(", ")}`;
            }
            if (after.length > 0 && actionableViolations.length > 0) {
                const actionableTotal = after.filter((v) => !SKIP_RULES.has(v.rule)).length;
                if (actionableTotal > 0)
                    lspOutput += `\n  (${actionableTotal} actionable remaining — skip-category rules omitted)`;
            }
        }
        // Biome: lint only — delta mode
        const biomeAvailable = biomeClient.isAvailable();
        if (!pi.getFlag("no-biome") &&
            biomeAvailable &&
            biomeClient.isSupportedFile(filePath)) {
            const allDiags = biomeClient.checkFile(filePath);
            const after = allDiags.filter((d) => d.category === "lint" || d.severity === "error");
            const before = biomeBaselines.get(filePath) ?? [];
            biomeBaselines.set(filePath, after);
            // Count by rule before/after
            const countBefore = new Map();
            const countAfter = new Map();
            const ruleKey = (d) => d.rule ?? d.message;
            for (const d of before)
                countBefore.set(ruleKey(d), (countBefore.get(ruleKey(d)) ?? 0) + 1);
            for (const d of after)
                countAfter.set(ruleKey(d), (countAfter.get(ruleKey(d)) ?? 0) + 1);
            const newDiags = [];
            for (const d of after) {
                const key = ruleKey(d);
                const n_before = countBefore.get(key) ?? 0;
                const n_after = countAfter.get(key) ?? 0;
                if (n_after > n_before &&
                    newDiags.filter((x) => ruleKey(x) === key).length < n_after - n_before) {
                    newDiags.push(d);
                }
            }
            const fixedRules = [];
            for (const [rule, n] of countBefore) {
                const after_n = countAfter.get(rule) ?? 0;
                if (after_n < n)
                    fixedRules.push(`${rule} (-${n - after_n})`);
            }
            if (pi.getFlag("autofix-biome") && after.length > 0) {
                const fixResult = biomeClient.fixFile(filePath);
                if (fixResult.success && fixResult.changed) {
                    lspOutput += `\n\n[Biome] Auto-fixed ${fixResult.fixed} issue(s) — file updated on disk`;
                    const remaining = biomeClient
                        .checkFile(filePath)
                        .filter((d) => d.category === "lint" || d.severity === "error");
                    if (remaining.length > 0)
                        lspOutput += `\n\n${biomeClient.formatDiagnostics(remaining, filePath)}`;
                    else
                        lspOutput += `\n\n[Biome] ✓ All issues resolved`;
                }
                else if (after.length > 0) {
                    lspOutput += `\n\n${biomeClient.formatDiagnostics(after, filePath)}`;
                }
            }
            else if (newDiags.length > 0) {
                const fixable = newDiags.filter((d) => d.fixable);
                lspOutput += `\n\n🔴 STOP — you introduced ${newDiags.length} new Biome violation(s). Fix before continuing:\n`;
                lspOutput += biomeClient.formatDiagnostics(newDiags, filePath);
                if (fixable.length > 0)
                    lspOutput += `\n  → Auto-fixable: \`npx @biomejs/biome check --write ${path.basename(filePath)}\``;
                if (fixedRules.length > 0) {
                    lspOutput += `\n\n✅ Biome: fixed ${fixedRules.join(", ")}`;
                }
            }
            else if (fixedRules.length > 0) {
                lspOutput += `\n\n✅ Biome: fixed ${fixedRules.join(", ")}`;
            }
        }
        // Go — go vet diagnostics
        if (!pi.getFlag("no-go") &&
            goClient.isGoFile(filePath) &&
            goClient.isGoAvailable()) {
            const goDiags = goClient.checkFile(filePath);
            if (goDiags.length > 0) {
                lspOutput += `\n\n${goClient.formatDiagnostics(goDiags)}`;
            }
        }
        // Rust — cargo check diagnostics
        if (!pi.getFlag("no-rust") &&
            rustClient.isRustFile(filePath) &&
            rustClient.isAvailable()) {
            const cwd = process.cwd();
            const rustDiags = rustClient.checkFile(filePath, cwd);
            if (rustDiags.length > 0) {
                lspOutput += `\n\n${rustClient.formatDiagnostics(rustDiags)}`;
            }
        }
        // Test runner — run tests for the edited file
        if (!pi.getFlag("no-tests")) {
            const cwd = process.cwd();
            dbg(`  test runner: checking for tests for ${filePath}`);
            const detected = testRunnerClient.detectRunner(cwd);
            dbg(`  test runner: detected runner: ${detected?.runner || "none"}`);
            if (detected) {
                const testInfo = testRunnerClient.findTestFile(filePath, cwd);
                dbg(`  test runner: testInfo: ${testInfo ? testInfo.testFile : "none"}`);
                if (testInfo) {
                    dbg(`  test file found: ${testInfo.testFile} (${testInfo.runner})`);
                    const testResult = testRunnerClient.runTestFile(testInfo.testFile, cwd, testInfo.runner, detected.config);
                    testResult.sourceFile = filePath;
                    const testReport = testRunnerClient.formatResult(testResult);
                    dbg(`  test report: ${testReport || "(empty)"}`);
                    if (testReport) {
                        lspOutput += `\n\n${testReport}`;
                    }
                }
            }
        }
        // Check for code duplication involving the edited file
        if (cachedJscpdClones.length > 0) {
            const fileClones = cachedJscpdClones.filter((clone) => path.resolve(clone.fileA) === path.resolve(filePath) ||
                path.resolve(clone.fileB) === path.resolve(filePath));
            if (fileClones.length > 0) {
                dbg(`  jscpd: ${fileClones.length} duplicate(s) involving ${filePath}`);
                let dupReport = `🔴 STOP — this file has ${fileClones.length} duplicate block(s). Extract to a shared utility before adding more code:\n`;
                for (const clone of fileClones.slice(0, 3)) {
                    const other = path.resolve(clone.fileA) === path.resolve(filePath)
                        ? `${path.basename(clone.fileB)}:${clone.startB}`
                        : `${path.basename(clone.fileA)}:${clone.startA}`;
                    dupReport += `  ${clone.lines} lines duplicated with ${other}\n`;
                }
                if (fileClones.length > 3) {
                    dupReport += `  ... and ${fileClones.length - 3} more\n`;
                }
                lspOutput += `\n\n${dupReport}`;
            }
        }
        // Check for duplicate exports (function already exists elsewhere)
        if (cachedExports.size > 0 && /\.(ts|tsx|js|jsx)$/.test(filePath)) {
            try {
                const newExports = await astGrepClient.scanExports(filePath, "typescript");
                const dupes = [];
                for (const [name, _file] of newExports) {
                    if (cachedExports.has(name)) {
                        const existingFile = cachedExports.get(name);
                        if (existingFile &&
                            path.resolve(existingFile) !== path.resolve(filePath)) {
                            dupes.push(`${name} (already in ${path.basename(existingFile)})`);
                        }
                    }
                }
                if (dupes.length > 0) {
                    dbg(`  duplicate exports: ${dupes.length} found`);
                    let exportReport = `🔴 Do not redefine — ${dupes.length} function(s) already exist elsewhere:\n`;
                    for (const dupe of dupes.slice(0, 5)) {
                        exportReport += `  ${dupe}\n`;
                    }
                    exportReport += `  → Import the existing function instead\n`;
                    lspOutput += `\n\n${exportReport}`;
                }
                // Update cache with new exports
                for (const [name, file] of newExports) {
                    cachedExports.set(name, file);
                }
            }
            catch (err) {
                void err;
                // ast-grep not available, skip
            }
        }
        // Circular dependency check (cached, only when imports change)
        if (!pi.getFlag("no-madge") &&
            depChecker.isAvailable() &&
            /\.(ts|tsx|js|jsx)$/.test(filePath)) {
            const depResult = depChecker.checkFile(filePath);
            if (depResult.hasCircular && depResult.circular.length > 0) {
                const circularDeps = depResult.circular
                    .flatMap((d) => d.path)
                    .filter((p) => !filePath.endsWith(require("node:path").basename(p)));
                const uniqueDeps = [...new Set(circularDeps)];
                if (uniqueDeps.length > 0) {
                    lspOutput += `\n\n${depChecker.formatWarning(filePath, uniqueDeps)}`;
                }
            }
        }
        if (!lspOutput)
            return;
        return {
            content: [...event.content, { type: "text", text: lspOutput }],
        };
    });
}
