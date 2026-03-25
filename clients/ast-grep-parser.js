import * as path from "node:path";
export class AstGrepParser {
    constructor(getRuleDescription, mapSeverity) {
        this.getRuleDescription = getRuleDescription;
        this.mapSeverity = mapSeverity;
    }
    parseOutput(output, filterFile) {
        const resolvedFilterFile = path.resolve(filterFile);
        try {
            const items = JSON.parse(output);
            if (Array.isArray(items)) {
                return items
                    .map((item) => this.parseDiagnostic(item, resolvedFilterFile))
                    .filter((d) => d !== null);
            }
        }
        catch (err) {
            void err;
        }
        return output
            .split("\n")
            .filter((l) => l.trim())
            .map((line) => {
            try {
                return this.parseDiagnostic(JSON.parse(line), resolvedFilterFile);
            }
            catch (err) {
                void err;
                return null;
            }
        })
            .filter((d) => d !== null);
    }
    parseDiagnostic(item, filterFile) {
        if (item.labels?.length) {
            return this.parseNewFormat(item, filterFile);
        }
        if (item.spans?.length) {
            return this.parseLegacyFormat(item, filterFile);
        }
        return null;
    }
    parseNewFormat(item, filterFile) {
        const label = item.labels.find((l) => l.style === "primary") || item.labels[0];
        const filePath = path.resolve(label.file || filterFile);
        if (filePath !== filterFile)
            return null;
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
    parseLegacyFormat(item, filterFile) {
        const span = item.spans?.[0];
        if (!span)
            return null;
        const filePath = path.resolve(span.file || filterFile);
        if (filePath !== filterFile)
            return null;
        const start = span.range?.start || { line: 0, column: 0 };
        const end = span.range?.end || start;
        const ruleId = item.name || item.ruleId || "unknown";
        return {
            line: start.line + 1,
            column: start.column,
            endLine: end.line + 1,
            endColumn: end.column,
            severity: this.mapSeverity(item.severity || item.Severity || "warning"),
            message: item.Message?.text || item.message || "Unknown issue",
            rule: ruleId,
            ruleDescription: this.getRuleDescription(ruleId),
            file: filePath,
        };
    }
}
