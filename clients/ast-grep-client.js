/**
 * AstGrep Client for pi-lens
 *
 * Structural code analysis using ast-grep CLI.
 * Scans files against YAML rule definitions.
 *
 * Requires: npm install -D @ast-grep/cli
 * Rules: ./rules/ directory
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AstGrepParser } from "./ast-grep-parser.js";
import { AstGrepRuleManager } from "./ast-grep-rule-manager.js";
// --- Client ---
export class AstGrepClient {
    constructor(ruleDir, verbose = false) {
        this.available = null;
        this.ruleDir =
            ruleDir ||
                path.join(typeof __dirname !== "undefined" ? __dirname : ".", "..", "rules");
        this.log = verbose
            ? (msg) => console.log(`[ast-grep] ${msg}`)
            : () => { };
        this.ruleManager = new AstGrepRuleManager(this.ruleDir, this.log);
    }
    /**
     * Check if ast-grep CLI is available
     */
    isAvailable() {
        if (this.available !== null)
            return this.available;
        const result = spawnSync("npx", ["sg", "--version"], {
            encoding: "utf-8",
            timeout: 10000,
            shell: true,
        });
        this.available = !result.error && result.status === 0;
        if (this.available) {
            this.log("ast-grep available");
        }
        return this.available;
    }
    /**
     * Search for AST patterns in files
     */
    async search(pattern, lang, paths) {
        return this.runSg([
            "run",
            "-p",
            pattern,
            "--lang",
            lang,
            "--json=compact",
            ...paths,
        ]);
    }
    /**
     * Search and replace AST patterns
     */
    async replace(pattern, rewrite, lang, paths, apply = false) {
        const args = [
            "run",
            "-p",
            pattern,
            "-r",
            rewrite,
            "--lang",
            lang,
            "--json=compact",
        ];
        if (apply)
            args.push("--update-all");
        args.push(...paths);
        const result = await this.runSg(args);
        return { matches: result.matches, applied: apply, error: result.error };
    }
    /**
     * Run a one-off scan with a temporary rule and configuration
     */
    runTempScan(dir, ruleId, ruleYaml, timeout = 30000) {
        if (!this.isAvailable())
            return [];
        const tmpDir = require("node:os").tmpdir();
        const ts = Date.now();
        const sessionDir = path.join(tmpDir, `pi-lens-temp-${ruleId}-${ts}`);
        const rulesSubdir = path.join(sessionDir, "rules");
        const ruleFile = path.join(rulesSubdir, `${ruleId}.yml`);
        const configFile = path.join(sessionDir, ".sgconfig.yml");
        try {
            fs.mkdirSync(rulesSubdir, { recursive: true });
            fs.writeFileSync(configFile, `ruleDirs:\n  - ./rules\n`);
            fs.writeFileSync(ruleFile, ruleYaml);
            const result = spawnSync("npx", ["sg", "scan", "--config", configFile, "--json", dir], {
                encoding: "utf-8",
                timeout,
                shell: true,
            });
            const output = result.stdout || result.stderr || "";
            if (!output.trim())
                return [];
            const items = JSON.parse(output);
            return Array.isArray(items) ? items : [items];
        }
        catch (err) {
            void err;
            return [];
        }
        finally {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            catch (err) {
                void err;
            }
        }
    }
    /**
     * Find similar functions by comparing normalized AST structure
     */
    async findSimilarFunctions(dir, lang = "typescript") {
        const ruleYaml = `id: find-functions
language: ${lang}
rule:
  kind: function_declaration
severity: info
message: found
`;
        const matches = this.runTempScan(dir, "find-functions", ruleYaml);
        if (matches.length === 0)
            return [];
        return this.groupSimilarFunctions(matches);
    }
    groupSimilarFunctions(matches) {
        const normalized = new Map();
        for (const item of matches) {
            const text = item.text || "";
            const nameMatch = text.match(/function\s+(\w+)/);
            if (!nameMatch?.[1])
                continue;
            const signature = this.normalizeFunction(text);
            if (!normalized.has(signature)) {
                normalized.set(signature, []);
            }
            const line = item.range?.start?.line || item.labels?.[0]?.range?.start?.line || 0;
            normalized.get(signature)?.push({
                name: nameMatch[1],
                file: item.file,
                line: line + 1,
            });
        }
        const result_groups = [];
        for (const [pattern, functions] of normalized) {
            if (functions.length > 1) {
                result_groups.push({ pattern, functions });
            }
        }
        return result_groups;
    }
    normalizeFunction(text) {
        const normalizedText = text
            .replace(/function\s+\w+/, "function FN")
            .replace(/\bconst\b|\blet\b|\bvar\b/g, "VAR")
            .replace(/["'].*?["']/g, "STR")
            .replace(/`[^`]*`/g, "TMPL")
            .replace(/\b\d+\b/g, "NUM")
            .replace(/\btrue\b|\bfalse\b/g, "BOOL")
            .replace(/\/\/.*/g, "")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\s+/g, " ")
            .trim();
        // Extract just the body structure
        const bodyMatch = normalizedText.match(/\{(.*)\}/);
        const body = bodyMatch ? bodyMatch[1].trim() : normalizedText;
        // Use first 200 chars as signature
        return body.slice(0, 200);
    }
    /**
     * Scan for exported function names in a directory
     */
    async scanExports(dir, lang = "typescript") {
        const exports = new Map();
        const ruleYaml = `id: find-functions
language: ${lang}
rule:
  kind: function_declaration
severity: info
message: found
`;
        const matches = this.runTempScan(dir, "find-functions", ruleYaml, 15000);
        this.log(`scanExports output length: ${matches.length}`);
        for (const item of matches) {
            const text = item.text || "";
            const nameMatch = text.match(/function\s+(\w+)/);
            if (nameMatch?.[1]) {
                this.log(`scanExports found: ${nameMatch[1]} in ${item.file}`);
                exports.set(nameMatch[1], item.file);
            }
        }
        return exports;
    }
    runSg(args) {
        return new Promise((resolve) => {
            const proc = spawn("npx", ["sg", ...args], {
                stdio: ["ignore", "pipe", "pipe"],
                shell: true,
            });
            let stdout = "";
            let stderr = "";
            proc.stdout.on("data", (data) => (stdout += data.toString()));
            proc.stderr.on("data", (data) => (stderr += data.toString()));
            proc.on("error", (err) => {
                if (err.message.includes("ENOENT")) {
                    resolve({
                        matches: [],
                        error: "ast-grep CLI not found. Install: npm i -D @ast-grep/cli",
                    });
                }
                else {
                    resolve({ matches: [], error: err.message });
                }
            });
            proc.on("close", (code) => {
                if (code !== 0 && !stdout.trim()) {
                    resolve({
                        matches: [],
                        error: stderr.includes("No files found")
                            ? undefined
                            : stderr.trim() || `Exit code ${code}`,
                    });
                    return;
                }
                if (!stdout.trim()) {
                    resolve({ matches: [] });
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout);
                    const matches = Array.isArray(parsed) ? parsed : [parsed];
                    resolve({ matches });
                }
                catch (err) {
                    void err;
                    resolve({ matches: [], error: "Failed to parse output" });
                }
            });
        });
    }
    formatMatches(matches, isDryRun = false) {
        if (matches.length === 0)
            return "No matches found";
        const MAX = 50;
        const shown = matches.slice(0, MAX);
        const lines = shown.map((m) => {
            const loc = `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}`;
            const text = m.text.length > 100 ? `${m.text.slice(0, 100)}...` : m.text;
            return isDryRun && m.replacement
                ? `${loc}\n  - ${text}\n  + ${m.replacement}`
                : `${loc}: ${text}`;
        });
        if (matches.length > MAX)
            lines.unshift(`Found ${matches.length} matches (showing first ${MAX}):`);
        return lines.join("\n");
    }
    /**
     * Scan a file against all rules
     */
    scanFile(filePath) {
        if (!this.isAvailable())
            return [];
        const absolutePath = path.resolve(filePath);
        if (!fs.existsSync(absolutePath))
            return [];
        const configPath = path.join(this.ruleDir, ".sgconfig.yml");
        try {
            const result = spawnSync("npx", ["sg", "scan", "--config", configPath, "--json", absolutePath], {
                encoding: "utf-8",
                timeout: 15000,
                shell: true,
            });
            // ast-grep exits 1 when it finds issues
            const output = result.stdout || result.stderr || "";
            if (!output.trim())
                return [];
            const parser = new AstGrepParser((id) => this.getRuleDescription(id), (sev) => this.mapSeverity(sev));
            return parser.parseOutput(output, absolutePath);
        }
        catch (err) {
            this.log(`Scan error: ${err.message}`);
            return [];
        }
    }
    /**
     * Format diagnostics for LLM consumption
     */
    formatDiagnostics(diags) {
        if (diags.length === 0)
            return "";
        const errors = diags.filter((d) => d.severity === "error");
        const warnings = diags.filter((d) => d.severity === "warning");
        const hints = diags.filter((d) => d.severity === "hint");
        let output = `[ast-grep] ${diags.length} structural issue(s)`;
        if (errors.length)
            output += ` — ${errors.length} error(s)`;
        if (warnings.length)
            output += ` — ${warnings.length} warning(s)`;
        if (hints.length)
            output += ` — ${hints.length} hint(s)`;
        output += ":\n";
        for (const d of diags.slice(0, 10)) {
            const loc = d.line === d.endLine ? `L${d.line}` : `L${d.line}-${d.endLine}`;
            const ruleInfo = d.ruleDescription
                ? `${d.rule}: ${d.ruleDescription.message}`
                : d.rule;
            const fix = d.fix || d.ruleDescription?.note ? " [fixable]" : "";
            output += `  ${ruleInfo} (${loc})${fix}\n`;
            if (d.ruleDescription?.note) {
                const shortNote = d.ruleDescription.note.split("\n")[0];
                output += `    → ${shortNote}\n`;
            }
        }
        if (diags.length > 10) {
            output += `  ... and ${diags.length - 10} more\n`;
        }
        return output;
    }
    getRuleDescription(ruleId) {
        return this.ruleManager.loadRuleDescriptions().get(ruleId);
    }
    mapSeverity(severity) {
        const lower = severity.toLowerCase();
        if (lower === "error")
            return "error";
        if (lower === "warning")
            return "warning";
        if (lower === "info")
            return "info";
        return "hint";
    }
}
