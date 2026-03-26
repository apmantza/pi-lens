/**
 * Shared TypeScript Service for pi-lens
 *
 * Creates a single ts.Program per session that is shared across all clients
 * (complexity-client, type-safety-client). Avoids creating a new program per file.
 */
import * as fs from "node:fs";
import * as ts from "typescript";
export class TypeScriptService {
    constructor(verbose = false) {
        this.program = null;
        this.checker = null;
        this.files = new Map();
        this.log = verbose
            ? (msg) => console.error(`[ts-service] ${msg}`)
            : () => { };
    }
    /**
     * Update a file's content in the service
     */
    updateFile(filePath, content) {
        this.files.set(filePath, content);
        this.invalidate();
    }
    /**
     * Invalidate the program (rebuild on next access)
     */
    invalidate() {
        this.program = null;
        this.checker = null;
    }
    /**
     * Get the shared type checker (rebuilds program if needed)
     */
    getChecker() {
        if (this.checker)
            return this.checker;
        if (this.files.size === 0)
            return null;
        try {
            const compilerOptions = {
                target: ts.ScriptTarget.Latest,
                module: ts.ModuleKind.ESNext,
                strict: true,
                noEmit: true,
                skipLibCheck: true,
                lib: ["es2020"],
            };
            const host = ts.createCompilerHost(compilerOptions);
            // Override getSourceFile to return our cached files
            const originalGetSourceFile = host.getSourceFile;
            host.getSourceFile = (fileName, languageVersion) => {
                // Check if we have this file cached
                const cachedContent = this.files.get(fileName);
                if (cachedContent !== undefined) {
                    return ts.createSourceFile(fileName, cachedContent, languageVersion, true);
                }
                // Fall back to default (for lib files, etc.)
                return originalGetSourceFile(fileName, languageVersion);
            };
            // Override fileExists and readFile
            const originalFileExists = host.fileExists;
            host.fileExists = (fileName) => {
                if (this.files.has(fileName))
                    return true;
                return originalFileExists(fileName);
            };
            const originalReadFile = host.readFile;
            host.readFile = (fileName) => {
                const cached = this.files.get(fileName);
                if (cached !== undefined)
                    return cached;
                return originalReadFile(fileName);
            };
            const fileNames = [...this.files.keys()];
            this.program = ts.createProgram(fileNames, compilerOptions, host);
            this.checker = this.program.getTypeChecker();
            this.log(`Program created with ${fileNames.length} files`);
            return this.checker;
        }
        catch (error) {
            this.log(`Error creating program: ${error}`);
            return null;
        }
    }
    /**
     * Get source file for a path
     */
    getSourceFile(filePath) {
        const content = this.files.get(filePath);
        if (!content) {
            // Try to read from disk
            try {
                const diskContent = fs.readFileSync(filePath, "utf-8");
                this.files.set(filePath, diskContent);
                return ts.createSourceFile(filePath, diskContent, ts.ScriptTarget.Latest, true);
            }
            catch {
                return null;
            }
        }
        return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    }
    /**
     * Get source file from program (for type checking)
     */
    getSourceFileFromProgram(filePath) {
        // Ensure program is built
        const checker = this.getChecker();
        if (!checker || !this.program)
            return null;
        return this.program.getSourceFile(filePath) ?? null;
    }
    /**
     * Clear all cached files
     */
    clear() {
        this.files.clear();
        this.invalidate();
    }
}
// --- Singleton ---
let instance = null;
export function getTypeScriptService(verbose = false) {
    if (!instance) {
        instance = new TypeScriptService(verbose);
    }
    return instance;
}
