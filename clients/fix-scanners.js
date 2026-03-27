/**
 * Scanner functions for fix.ts
 *
 * Each scanner encapsulates one type of issue detection:
 * - scanDuplicates: JSCPD duplicate code detection
 * - scanDeadCode: Knip dead code detection
 * - scanAstGrep: Structural linting via ast-grep
 * - scanBiome: Remaining Biome lint issues
 * - scanSlop: AI slop indicators (high complexity patterns)
 */
import * as childProcess from "node:child_process";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { shouldIgnoreFile } from "./scan-utils.js";
const DEBUG_LOG = path.join(process.env.HOME || process.env.USERPROFILE || ".", "pi-lens-debug.log");
function dbg(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        nodeFs.appendFileSync(DEBUG_LOG, line);
    }
    catch {
        // Ignored
    }
}
/**
 * Scan for duplicate code blocks using JSCPD
 */
export function scanDuplicates(jscpd, targetPath, isTsProject) {
    if (!jscpd.isAvailable())
        return [];
    const jscpdResult = jscpd.scan(targetPath);
    return jscpdResult.clones.filter((c) => {
        if (isTsProject && (c.fileA.endsWith(".js") || c.fileB.endsWith(".js")))
            return false;
        return path.resolve(c.fileA) !== path.resolve(c.fileB);
    });
}
/**
 * Scan for dead code using Knip
 */
export function scanDeadCode(knip, targetPath, isTsProject) {
    if (!knip.isAvailable())
        return [];
    const knipResult = knip.analyze(targetPath);
    return knipResult.issues.filter((i) => {
        if (!i.file)
            return true;
        return !shouldIgnoreFile(i.file, isTsProject);
    });
}
/**
 * Scan for structural issues using ast-grep
 */
export function scanAstGrep(targetPath, isTsProject, configPath) {
    const hasSg = nodeFs.existsSync(path.join(targetPath, "node_modules", ".bin", "sg")) ||
        childProcess.spawnSync("npx", ["sg", "--version"], { encoding: "utf-8", timeout: 5000, shell: true }).status === 0;
    if (!hasSg)
        return [];
    const result = childProcess.spawnSync("npx", [
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
    const astIssues = [];
    for (const item of items) {
        const rule = item.ruleId || item.rule?.title || item.name || "unknown";
        const line = (item.labels?.[0]?.range?.start?.line ?? item.range?.start?.line ?? 0) +
            1;
        const relFile = path.relative(targetPath, item.file ?? "").replace(/\\/g, "/");
        if (shouldIgnoreFile(relFile, isTsProject))
            continue;
        astIssues.push({
            rule,
            file: relFile,
            line,
            message: item.message ?? rule,
        });
    }
    return astIssues;
}
/**
 * Scan for remaining Biome lint issues (couldn't be auto-fixed)
 */
export function scanBiomeIssues(biome, targetPath) {
    if (!biome.isAvailable())
        return [];
    const checkResult = childProcess.spawnSync("npx", ["@biomejs/biome", "check", "--reporter=json", "--max-diagnostics=50", targetPath], { encoding: "utf-8", timeout: 20000, shell: true });
    const remainingBiome = [];
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
    return remainingBiome;
}
/**
 * Scan for AI slop indicators (high complexity patterns)
 */
export function scanSlop(complexity, targetPath, isTsProject) {
    const slopFiles = [];
    const scanDir = (dir) => {
        if (!nodeFs.existsSync(dir))
            return;
        for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (["node_modules", ".git", "dist", "build", ".next", ".pi-lens"].includes(entry.name))
                    continue;
                scanDir(fullPath);
            }
            else if (complexity.isSupportedFile(fullPath)) {
                const metrics = complexity.analyzeFile(fullPath);
                if (metrics) {
                    const warnings = complexity
                        .checkThresholds(metrics)
                        .filter((w) => w.includes("AI-style") ||
                        w.includes("try/catch") ||
                        w.includes("single-use") ||
                        w.includes("Excessive comments"));
                    const relFile = path
                        .relative(targetPath, fullPath)
                        .replace(/\\/g, "/");
                    if (shouldIgnoreFile(relFile, isTsProject))
                        continue;
                    if (warnings.length >= 2) {
                        slopFiles.push({ file: relFile, warnings });
                    }
                }
            }
        }
    };
    scanDir(targetPath);
    return slopFiles;
}
/**
 * Run all scanners and return combined results
 */
export function scanAll(clients, targetPath, isTsProject, configPath) {
    return {
        duplicates: scanDuplicates(clients.jscpd, targetPath, isTsProject),
        deadCode: scanDeadCode(clients.knip, targetPath, isTsProject),
        astIssues: scanAstGrep(targetPath, isTsProject, configPath),
        biomeIssues: scanBiomeIssues(clients.biome, targetPath),
        slopFiles: scanSlop(clients.complexity, targetPath, isTsProject),
    };
}
