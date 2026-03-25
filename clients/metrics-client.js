/**
 * Silent Metrics Client for pi-lens
 *
 * Tracks code quality metrics silently during the session.
 * Metrics are aggregated and shown in session summary only.
 *
 * Tracks:
 * - TDR (Technical Debt Ratio): composite score from existing signals
 * - AI Code Ratio: % of file written by agent this session vs pre-existing
 * - Code Entropy: Shannon entropy delta per file
 *
 * These are observational metrics — they inform the human in session summary,
 * they don't gate or interrupt the agent mid-task.
 */
import * as fs from "node:fs";
import * as path from "node:path";
// --- Client ---
export class MetricsClient {
    constructor(verbose = false) {
        this.fileBaselines = new Map();
        this.fileSessionWrites = new Map(); // agent-written lines
        this.tdrFindings = new Map();
        this.log = verbose
            ? (msg) => console.log(`[metrics] ${msg}`)
            : () => { };
    }
    /**
     * Record initial state of a file when first touched this session
     */
    recordBaseline(filePath) {
        const absolutePath = path.resolve(filePath);
        if (!fs.existsSync(absolutePath))
            return;
        if (this.fileBaselines.has(absolutePath))
            return; // Already recorded
        const content = fs.readFileSync(absolutePath, "utf-8");
        const entropy = this.calculateEntropy(content);
        this.fileBaselines.set(absolutePath, { content, entropy });
        this.fileSessionWrites.set(absolutePath, 0);
        this.log(`Baseline recorded: ${path.basename(filePath)} (entropy: ${entropy.toFixed(2)})`);
    }
    /**
     * Update TDR findings for a file
     */
    updateTDR(filePath, entries) {
        const absolutePath = path.resolve(filePath);
        this.tdrFindings.set(absolutePath, entries);
    }
    /**
     * Get overall TDR score for the session
     * 0-100, where 100 is high debt.
     */
    getTDRScore() {
        let totalScore = 0;
        for (const entries of this.tdrFindings.values()) {
            for (const entry of entries) {
                // Each entry adds to the debt index based on its Grade (count as the Grade value)
                totalScore += entry.count;
            }
        }
        // Normalize to 0-100? Or just return the raw Index.
        // SCA.md says "Technical Debt Index"
        return totalScore;
    }
    /**
     * Record that the agent wrote/replaced content in a file
     * @param newContent The new content after the write
     */
    recordWrite(filePath, newContent) {
        const absolutePath = path.resolve(filePath);
        this.recordBaseline(absolutePath);
        const baseline = this.fileBaselines.get(absolutePath);
        const _baselineLines = baseline.content.split("\n").length;
        const _newLines = newContent.split("\n").length;
        // Estimate agent-written lines: count the diff
        const diffLines = this.estimateDiffLines(baseline.content, newContent);
        const currentAgentLines = this.fileSessionWrites.get(absolutePath) || 0;
        this.fileSessionWrites.set(absolutePath, currentAgentLines + diffLines);
        this.log(`Write recorded: ${path.basename(filePath)} (+~${diffLines} agent lines)`);
    }
    /**
     * Get metrics for a specific file
     */
    getFileMetrics(filePath) {
        const absolutePath = path.resolve(filePath);
        const baseline = this.fileBaselines.get(absolutePath);
        if (!baseline)
            return null;
        if (!fs.existsSync(absolutePath))
            return null;
        const currentContent = fs.readFileSync(absolutePath, "utf-8");
        const totalLines = currentContent.split("\n").length;
        const agentLines = this.fileSessionWrites.get(absolutePath) || 0;
        const baselineLines = baseline.content.split("\n").length;
        // Pre-existing lines = lines that weren't touched by agent
        // (simplified: baseline - deleted + not-added-by-agent)
        const _preExistingLines = Math.max(0, baselineLines - Math.max(0, agentLines - (totalLines - baselineLines)));
        const entropyCurrent = this.calculateEntropy(currentContent);
        const entropyDelta = entropyCurrent - baseline.entropy;
        return {
            filePath: path.relative(process.cwd(), absolutePath),
            totalLines,
            agentLines: Math.min(agentLines, totalLines),
            preExistingLines: Math.max(0, totalLines - agentLines),
            entropyStart: baseline.entropy,
            entropyCurrent,
            entropyDelta,
            tdrContributors: [], // Populated by session summary scan
        };
    }
    /**
     * Calculate AI Code Ratio for the session
     * Returns 0-1 where 1 = all code written by agent
     */
    getAICodeRatio() {
        let totalAgentLines = 0;
        let totalPreExistingLines = 0;
        let fileCount = 0;
        for (const [filePath, agentLines] of this.fileSessionWrites) {
            if (!fs.existsSync(filePath))
                continue;
            const content = fs.readFileSync(filePath, "utf-8");
            const totalLines = content.split("\n").length;
            const baseline = this.fileBaselines.get(filePath);
            const _baselineLines = baseline
                ? baseline.content.split("\n").length
                : totalLines;
            // Pre-existing = lines that existed before this session and weren't replaced
            const preExisting = Math.max(0, totalLines - agentLines);
            totalAgentLines += agentLines;
            totalPreExistingLines += preExisting;
            fileCount++;
        }
        const total = totalAgentLines + totalPreExistingLines;
        return {
            ratio: total > 0 ? totalAgentLines / total : 0, // fixed
            agentLines: totalAgentLines,
            preExistingLines: totalPreExistingLines,
            fileCount,
        };
    }
    /**
     * Get entropy delta for all touched files
     */
    getEntropyDeltas() {
        const results = [];
        for (const [filePath, baseline] of this.fileBaselines) {
            if (!fs.existsSync(filePath))
                continue;
            if (!this.fileSessionWrites.has(filePath))
                continue;
            const content = fs.readFileSync(filePath, "utf-8");
            const current = this.calculateEntropy(content);
            const delta = current - baseline.entropy;
            results.push({
                file: path.relative(process.cwd(), filePath),
                start: baseline.entropy,
                current,
                delta,
            });
        }
        return results.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    }
    /**
     * Calculate Shannon entropy of a string
     * Returns bits per character
     */
    calculateEntropy(text) {
        if (text.length === 0)
            return 0;
        const freq = new Map();
        for (const char of text) {
            freq.set(char, (freq.get(char) || 0) + 1);
        }
        let entropy = 0;
        const len = text.length;
        for (const count of freq.values()) {
            const p = count / len;
            if (p > 0) {
                entropy -= p * Math.log2(p);
            }
        }
        return entropy;
    }
    /**
     * Format metrics for session summary
     */
    formatSessionSummary() {
        const aiRatio = this.getAICodeRatio();
        const entropyDeltas = this.getEntropyDeltas();
        const tdrScore = this.getTDRScore();
        const fileCount = this.fileSessionWrites.size;
        if (fileCount === 0)
            return ""; // No files touched
        const parts = [];
        // Technical Debt Index
        if (tdrScore > 0) {
            parts.push(`[TDR Index] Total Debt: ${tdrScore.toFixed(1)} (based on architectural rule grades)`);
        }
        // AI Code Ratio
        const pct = (aiRatio.ratio * 100).toFixed(1);
        parts.push(`[AI Code] ${pct}% of ${fileCount} file(s) written by agent this session (${aiRatio.agentLines} lines, ${aiRatio.preExistingLines} pre-existing)`);
        // Entropy deltas (only show files with significant changes)
        const significant = entropyDeltas.filter((e) => Math.abs(e.delta) > 0.1);
        if (significant.length > 0) {
            const topChanges = significant.slice(0, 5);
            parts.push(`[Entropy] ${significant.length} file(s) with complexity changes:`);
            for (const e of topChanges) {
                const arrow = e.delta > 0 ? "↑" : "↓";
                const sign = e.delta > 0 ? "+" : "";
                parts.push(`  ${arrow} ${e.file}: ${e.start.toFixed(2)} → ${e.current.toFixed(2)} (${sign}${e.delta.toFixed(2)} bits)`);
            }
            if (significant.length > 5) {
                parts.push(`  ... and ${significant.length - 5} more`);
            }
        }
        return parts.join("\n");
    }
    /**
     * Reset session state (for new session)
     */
    reset() {
        this.fileBaselines.clear();
        this.fileSessionWrites.clear();
        this.log("Session metrics reset");
    }
    // --- Internal ---
    /**
     * Estimate number of lines that changed between two texts
     * Simple line-based diff (not Myers, but good enough for metrics)
     */
    estimateDiffLines(oldText, newText) {
        const oldLines = new Set(oldText.split("\n"));
        const newLines = newText.split("\n");
        let changed = 0;
        for (const line of newLines) {
            if (!oldLines.has(line)) {
                changed++;
            }
        }
        // Also count deleted lines
        const newLinesSet = new Set(newLines);
        for (const line of oldLines) {
            if (!newLinesSet.has(line)) {
                changed++;
            }
        }
        // Return roughly half (additions + deletions / 2)
        return Math.max(1, Math.ceil(changed / 2));
    }
}
