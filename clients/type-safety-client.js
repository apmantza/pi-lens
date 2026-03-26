/**
 * Type Safety Client for pi-lens
 *
 * Detects type safety violations that can cause runtime bugs.
 * Uses the shared TypeScriptService for efficient type checking.
 *
 * Checks:
 * - Switch Exhaustiveness: Missing cases in union type switches
 * - Null Safety: Potential null/undefined dereferences (future)
 * - Exhaustive Type Guards: Incomplete instanceof checks (future)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { getTypeScriptService } from "./ts-service.js";
// --- Client ---
export class TypeSafetyClient {
    constructor(verbose = false) {
        this.log = verbose
            ? (msg) => console.error(`[type-safety] ${msg}`)
            : () => { };
    }
    /**
     * Check if file is supported (TS/JS)
     */
    isSupportedFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        return [".ts", ".tsx", ".js", ".jsx"].includes(ext);
    }
    /**
     * Analyze type safety issues for a file
     */
    analyzeFile(filePath) {
        const absolutePath = path.resolve(filePath);
        if (!fs.existsSync(absolutePath))
            return null;
        try {
            const content = fs.readFileSync(absolutePath, "utf-8");
            const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
            const issues = [];
            // Check switch exhaustiveness
            this.checkSwitchExhaustiveness(sourceFile, issues);
            return { filePath: absolutePath, issues };
        }
        catch (error) {
            this.log(`Error analyzing ${filePath}: ${error}`);
            return null;
        }
    }
    /**
     * Check for switch statements that don't exhaust all union cases
     */
    checkSwitchExhaustiveness(sourceFile, issues) {
        const checker = this.getTypeChecker(sourceFile);
        if (!checker)
            return;
        // Use the source file from the program (has proper type information)
        const tsService = getTypeScriptService();
        const programSourceFile = tsService.getSourceFileFromProgram(sourceFile.fileName);
        if (!programSourceFile)
            return;
        const visit = (node) => {
            if (ts.isSwitchStatement(node)) {
                const exprType = checker.getTypeAtLocation(node.expression);
                // Only check union types (literal unions and object unions)
                if (exprType.isUnion()) {
                    const unionTypes = exprType.types;
                    // Get all literal values from the union
                    const literalValues = unionTypes
                        .filter((t) => t.isLiteral() || t.flags & ts.TypeFlags.BooleanLiteral)
                        .map((t) => {
                        if (t.isLiteral()) {
                            return String(t.value);
                        }
                        // Boolean literals
                        if (t.flags & ts.TypeFlags.BooleanLiteral) {
                            return checker.typeToString(t);
                        }
                        return null;
                    })
                        .filter((v) => v !== null);
                    // Skip if no literal union (e.g., string | number)
                    if (literalValues.length === 0)
                        return;
                    // Get all case clauses
                    const coveredCases = new Set();
                    for (const clause of node.caseBlock.clauses) {
                        if (ts.isCaseClause(clause)) {
                            const caseType = checker.getTypeAtLocation(clause.expression);
                            if (caseType.isLiteral()) {
                                coveredCases.add(String(caseType.value));
                            }
                            else if (caseType.flags & ts.TypeFlags.BooleanLiteral) {
                                coveredCases.add(checker.typeToString(caseType));
                            }
                        }
                    }
                    // Check for hasDefault
                    const hasDefault = node.caseBlock.clauses.some((c) => ts.isDefaultClause(c));
                    // Find missing cases
                    const missingCases = literalValues.filter((v) => !coveredCases.has(v));
                    if (missingCases.length > 0 && !hasDefault) {
                        const line = programSourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                        const exprText = node.expression.getText(programSourceFile);
                        const typeStr = missingCases.map((c) => `'${c}'`).join(", ");
                        issues.push({
                            filePath: programSourceFile.fileName,
                            rule: "switch-exhaustiveness",
                            line,
                            message: `Switch on '${exprText}' is not exhaustive. Missing cases: ${typeStr}`,
                            severity: "error",
                            context: `Type has ${literalValues.length} cases, ${coveredCases.size} covered, ${missingCases.length} missing`,
                        });
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(programSourceFile, visit);
    }
    /**
     * Get type checker from shared service
     */
    getTypeChecker(sourceFile) {
        const tsService = getTypeScriptService();
        // Update the file in the shared service
        const content = fs.readFileSync(sourceFile.fileName, "utf-8");
        tsService.updateFile(sourceFile.fileName, content);
        const checker = tsService.getChecker();
        if (!checker) {
            this.log("Could not get type checker, skipping exhaustiveness check");
        }
        return checker;
    }
}
// --- Singleton ---
let instance = null;
export function getTypeSafetyClient(verbose = false) {
    if (!instance) {
        instance = new TypeSafetyClient(verbose);
    }
    return instance;
}
