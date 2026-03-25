/**
 * Complexity Metrics Client for pi-lens
 *
 * Calculates AST-based code complexity metrics for TypeScript/JavaScript files.
 * Uses the TypeScript compiler API for parsing.
 *
 * Tracks:
 * - Max Nesting Depth: Deepest control flow nesting
 * - Avg/Max Function Length: Lines per function
 * - Cyclomatic Complexity: Independent code paths (M = E - N + 2P)
 * - Cognitive Complexity: Human understanding difficulty
 * - Halstead Volume: Vocabulary-based complexity
 * - Maintainability Index: Composite score (0-100, higher is better)
 *
 * These are silent metrics shown in session summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

// --- Types ---

export interface FileComplexity {
  filePath: string;
  maxNestingDepth: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  functionCount: number;
  cyclomaticComplexity: number;      // Average across functions
  maxCyclomaticComplexity: number;   // Most complex function
  cognitiveComplexity: number;
  halsteadVolume: number;
  maintainabilityIndex: number;      // 0-100
  linesOfCode: number;
  commentLines: number;
  codeEntropy: number;               // Shannon entropy (0-1, lower = more predictable)
}

export interface FunctionMetrics {
  name: string;
  line: number;
  length: number;
  cyclomatic: number;
  cognitive: number;
  nestingDepth: number;
}

// --- Constants ---

// Nodes that increase cyclomatic complexity
const CYCLOMAL_NODES = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.BinaryExpression,  // && and ||
]);

// Nodes that increase cognitive complexity (with nesting penalty)
const COGNITIVE_NODES = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CatchClause,
]);

// Nesting-increasing nodes
const NESTING_NODES = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.CatchClause,
]);

// Function-like nodes
const FUNCTION_LIKE_NODES = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

// Halstead operators (common operators)
const HALSTEAD_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken, ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken,
  ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.QuestionToken, ts.SyntaxKind.ColonToken,
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.EqualsGreaterThanToken,
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken,
  ts.SyntaxKind.CommaToken, ts.SyntaxKind.SemicolonToken,
  ts.SyntaxKind.DotToken, ts.SyntaxKind.QuestionDotToken,
]);

// --- Client ---

export class ComplexityClient {
  private log: (msg: string) => void;

  constructor(verbose = false) {
    this.log = verbose
      ? (msg: string) => console.log(`[complexity] ${msg}`)
      : () => {};
  }

  /**
   * Check if file is supported (TS/JS)
   */
  isSupportedFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
  }

  /**
   * Analyze complexity metrics for a file
   */
  analyzeFile(filePath: string): FileComplexity | null {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) return null;

    try {
      const content = fs.readFileSync(absolutePath, "utf-8");
      const lines = content.split("\n");
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true
      );

      // Count lines of code (non-empty, non-comment)
      const { codeLines, commentLines } = this.countLines(sourceFile, lines);

      // Collect function metrics
      const functions: FunctionMetrics[] = [];
      this.collectFunctionMetrics(sourceFile, sourceFile, functions, 0);

      // Calculate file-level metrics
      const maxNestingDepth = this.calculateMaxNesting(sourceFile, 0);
      const cyclomatic = this.calculateCyclomaticComplexity(sourceFile);
      const cognitive = this.calculateCognitiveComplexity(sourceFile);
      const halstead = this.calculateHalsteadVolume(sourceFile);

      // Function length stats
      const funcLengths = functions.map(f => f.length);
      const avgFunctionLength = funcLengths.length > 0
        ? Math.round(funcLengths.reduce((a, b) => a + b, 0) / funcLengths.length)
        : 0;
      const maxFunctionLength = funcLengths.length > 0 ? Math.max(...funcLengths) : 0;

      // Function cyclomatic stats
      const cyclomatics = functions.map(f => f.cyclomatic);
      const avgCyclomatic = cyclomatics.length > 0
        ? Math.round(cyclomatics.reduce((a, b) => a + b, 0) / cyclomatics.length)
        : 1;
      const maxCyclomatic = cyclomatics.length > 0 ? Math.max(...cyclomatics) : 1;

      // Maintainability Index (simplified Microsoft formula)
      // MI = max(0, (171 - 5.2 * ln(Halstead) - 0.23 * Cyclomatic - 16.2 * ln(LOC)) * 100 / 171)
      const maintainabilityIndex = this.calculateMaintainabilityIndex(
        halstead,
        avgCyclomatic,
        codeLines,
        commentLines
      );

      // Code Entropy (Shannon entropy of code tokens)
      const codeEntropy = this.calculateCodeEntropy(content);

      return {
        filePath: path.relative(process.cwd(), absolutePath),
        maxNestingDepth,
        avgFunctionLength,
        maxFunctionLength,
        functionCount: functions.length,
        cyclomaticComplexity: avgCyclomatic,
        maxCyclomaticComplexity: maxCyclomatic,
        cognitiveComplexity: cognitive,
        halsteadVolume: Math.round(halstead * 10) / 10,
        maintainabilityIndex: Math.round(maintainabilityIndex * 10) / 10,
        linesOfCode: codeLines,
        commentLines,
        codeEntropy: Math.round(codeEntropy * 100) / 100,
      };
    } catch (err: any) {
      this.log(`Analysis error for ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Format metrics for display
   */
  formatMetrics(metrics: FileComplexity): string {
    const parts: string[] = [];

    // Maintainability Index (most important)
    const miLabel = metrics.maintainabilityIndex >= 80 ? "✓" :
                    metrics.maintainabilityIndex >= 60 ? "⚠" : "✗";
    parts.push(`${miLabel} Maintainability: ${metrics.maintainabilityIndex}/100`);

    // Complexity metrics
    if (metrics.cyclomaticComplexity > 5 || metrics.maxCyclomaticComplexity > 10) {
      const avg = metrics.cyclomaticComplexity;
      const max = metrics.maxCyclomaticComplexity;
      parts.push(`  Cyclomatic: avg ${avg}, max ${max} (${metrics.functionCount} functions)`);
    }

    if (metrics.cognitiveComplexity > 15) {
      parts.push(`  Cognitive: ${metrics.cognitiveComplexity} (high mental complexity)`);
    }

    // Nesting depth
    if (metrics.maxNestingDepth > 4) {
      parts.push(`  Max nesting: ${metrics.maxNestingDepth} levels (consider extracting)`);
    }

    // Code entropy (in bits, >3.5 = risky AI-induced complexity)
    if (metrics.codeEntropy > 3.5) {
      parts.push(`  Entropy: ${metrics.codeEntropy.toFixed(1)} bits (>3.5 — risky AI-induced complexity)`);
    }

    // Function length
    if (metrics.maxFunctionLength > 50) {
      parts.push(`  Longest function: ${metrics.maxFunctionLength} lines (avg: ${metrics.avgFunctionLength})`);
    }

    // Halstead (only if notably high)
    if (metrics.halsteadVolume > 500) {
      parts.push(`  Halstead volume: ${metrics.halsteadVolume} (high vocabulary)`);
    }

    return parts.length > 0 ? `[Complexity] ${metrics.filePath}\n${parts.join("\n")}` : "";
  }

  /**
   * Check thresholds and return actionable warnings
   */
  checkThresholds(metrics: FileComplexity): string[] {
    const warnings: string[] = [];

    if (metrics.maintainabilityIndex < 60) {
      warnings.push(`Maintainability dropped to ${metrics.maintainabilityIndex} — extract logic into helper functions`);
    }

    if (metrics.cyclomaticComplexity > 10) {
      warnings.push(`High complexity (${metrics.cyclomaticComplexity}) — use early returns or switch expressions`);
    }

    if (metrics.cognitiveComplexity > 15) {
      warnings.push(`Cognitive complexity (${metrics.cognitiveComplexity}) — simplify logic flow`);
    }

    if (metrics.maxNestingDepth > 4) {
      warnings.push(`Deep nesting (${metrics.maxNestingDepth} levels) — extract nested logic into separate functions`);
    }

    if (metrics.codeEntropy > 3.5) {
      warnings.push(`High entropy (${metrics.codeEntropy.toFixed(1)} bits) — follow project conventions`);
    }

    return warnings;
  }

  /**
   * Format delta for session summary
   */
  formatDelta(previous: FileComplexity, current: FileComplexity): string {
    const parts: string[] = [];

    const miDelta = current.maintainabilityIndex - previous.maintainabilityIndex;
    if (Math.abs(miDelta) > 1) {
      const arrow = miDelta > 0 ? "↑" : "↓";
      const sign = miDelta > 0 ? "+" : "";
      parts.push(`  ${arrow} ${current.filePath}: MI ${previous.maintainabilityIndex} → ${current.maintainabilityIndex} (${sign}${miDelta.toFixed(1)})`);
    }

    const cogDelta = current.cognitiveComplexity - previous.cognitiveComplexity;
    if (Math.abs(cogDelta) > 3) {
      const arrow = cogDelta > 0 ? "↑" : "↓";
      const sign = cogDelta > 0 ? "+" : "";
      parts.push(`  ${arrow} ${current.filePath}: cognitive ${previous.cognitiveComplexity} → ${current.cognitiveComplexity} (${sign}${cogDelta})`);
    }

    return parts.join("\n");
  }

  // --- Private: Line Counting ---

  private countLines(sourceFile: ts.SourceFile, lines: string[]): { codeLines: number; commentLines: number } {
    let commentLines = 0;
    const commentPositions = new Set<number>();

    // Find comment positions
    const visitComments = (node: ts.Node) => {
      ts.forEachChild(node, visitComments);
    };

    // Scan for comments using text
    const text = sourceFile.getFullText();
    const commentRegex = /\/\/.*$|\/\*[\s\S]*?\*\//gm;
    let match;
    while ((match = commentRegex.exec(text)) !== null) {
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const startLine = text.substring(0, lineStart).split("\n").length - 1;
      const endLine = text.substring(0, match.index + match[0].length).split("\n").length - 1;
      for (let i = startLine; i <= endLine; i++) {
        commentPositions.add(i);
      }
    }

    commentLines = commentPositions.size;
    const codeLines = lines.filter((line, i) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !commentPositions.has(i);
    }).length;

    return { codeLines, commentLines };
  }

  // --- Private: Function Metrics Collection ---

  private collectFunctionMetrics(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    functions: FunctionMetrics[],
    nestingLevel: number
  ): void {
    if (FUNCTION_LIKE_NODES.has(node.kind)) {
      const funcNode = node as ts.FunctionLikeDeclaration;
      const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
      const length = endLine - startLine + 1;

      const cyclomatic = this.nodeCyclomaticComplexity(node, 0);
      const cognitive = this.nodeCognitiveComplexity(node, nestingLevel);
      const maxNesting = this.calculateMaxNesting(node, 0);

      const name = funcNode.name
        ? funcNode.name.getText(sourceFile)
        : `<anonymous@L${startLine + 1}>`;

      functions.push({
        name,
        line: startLine + 1,
        length,
        cyclomatic,
        cognitive,
        nestingDepth: maxNesting,
      });
    }

    // Track nesting depth changes
    const newNesting = NESTING_NODES.has(node.kind) ? nestingLevel + 1 : nestingLevel;
    ts.forEachChild(node, (child) => {
      this.collectFunctionMetrics(child, sourceFile, functions, newNesting);
    });
  }

  // --- Private: Max Nesting Depth ---

  private calculateMaxNesting(node: ts.Node, currentDepth: number): number {
    let maxDepth = currentDepth;

    if (NESTING_NODES.has(node.kind)) {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    }

    ts.forEachChild(node, (child) => {
      const childMax = this.calculateMaxNesting(child, currentDepth);
      maxDepth = Math.max(maxDepth, childMax);
    });

    return maxDepth;
  }

  // --- Private: Cyclomatic Complexity ---

  private calculateCyclomaticComplexity(node: ts.Node): number {
    return this.nodeCyclomaticComplexity(node, 0);
  }

  private nodeCyclomaticComplexity(node: ts.Node, complexity: number): number {
    // Base increment for branching nodes
    if (CYCLOMAL_NODES.has(node.kind)) {
      complexity++;
    }

    // Binary && and || add complexity
    if (node.kind === ts.SyntaxKind.BinaryExpression) {
      const binary = node as ts.BinaryExpression;
      if (binary.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          binary.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        complexity++;
      }
    }

    ts.forEachChild(node, (child) => {
      complexity = this.nodeCyclomaticComplexity(child, complexity);
    });

    return complexity;
  }

  // --- Private: Cognitive Complexity ---
  // Based on SonarSource's Cognitive Complexity specification
  // Increment for: if, for, while, case, catch, conditional
  // Additional increment for nesting

  private calculateCognitiveComplexity(node: ts.Node): number {
    return this.nodeCognitiveComplexity(node, 0);
  }

  private nodeCognitiveComplexity(node: ts.Node, nestingDepth: number): number {
    let complexity = 0;

    // Structures that contribute to cognitive complexity
    if (COGNITIVE_NODES.has(node.kind)) {
      // Base increment + nesting penalty
      complexity += 1 + nestingDepth;
    }

    // Break/continue with label add to complexity
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      if (node.label) {
        complexity += 1 + nestingDepth;
      }
    }

    // Binary && and || contribute to complexity
    if (node.kind === ts.SyntaxKind.BinaryExpression) {
      const binary = node as ts.BinaryExpression;
      if (binary.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          binary.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        complexity += 1;
      }
    }

    // Calculate nesting for children
    const increasesNesting = NESTING_NODES.has(node.kind);
    const childNesting = increasesNesting ? nestingDepth + 1 : nestingDepth;

    ts.forEachChild(node, (child) => {
      complexity += this.nodeCognitiveComplexity(child, childNesting);
    });

    return complexity;
  }

  // --- Private: Halstead Volume ---
  // V = N * log2(n) where N = total operators+operands, n = unique operators+operands

  private calculateHalsteadVolume(node: ts.Node): number {
    const operators = new Set<string>();
    const operands = new Set<string>();
    let totalOperators = 0;
    let totalOperands = 0;

    const visit = (n: ts.Node) => {
      // Check if it's an operator
      if (HALSTEAD_OPERATORS.has(n.kind)) {
        const opText = ts.SyntaxKind[n.kind];
        operators.add(opText);
        totalOperators++;
      }
      // Check for identifiers (operands)
      else if (ts.isIdentifier(n)) {
        const text = n.getText();
        // Skip keywords that are parsed as identifiers
        if (!this.isKeyword(text)) {
          operands.add(text);
          totalOperands++;
        }
      }
      // Check for literals (operands)
      else if (ts.isNumericLiteral(n) || ts.isStringLiteral(n) ||
               n.kind === ts.SyntaxKind.TrueKeyword ||
               n.kind === ts.SyntaxKind.FalseKeyword ||
               n.kind === ts.SyntaxKind.NullKeyword ||
               n.kind === ts.SyntaxKind.UndefinedKeyword) {
        const text = n.getText();
        operands.add(text);
        totalOperands++;
      }

      ts.forEachChild(n, visit);
    };

    visit(node);

    const uniqueOps = operators.size + operands.size;
    const totalOps = totalOperators + totalOperands;

    if (uniqueOps === 0 || totalOps === 0) return 0;

    // V = N * log2(n)
    return totalOps * Math.log2(uniqueOps);
  }

  /**
   * Calculate Shannon entropy of code tokens (in bits)
   * Uses log2 for entropy measured in bits
   * Threshold: >3.5 bits indicates risky AI-induced complexity
   */
  private calculateCodeEntropy(sourceText: string): number {
    // Tokenize by splitting on whitespace and common delimiters
    const tokens = sourceText
      .replace(/\/\/.*/g, "")           // Remove single-line comments
      .replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments
      .replace(/["'`][^"'`]*["'`]/g, "STR") // Normalize strings
      .replace(/\b\d+(\.\d+)?\b/g, "NUM")   // Normalize numbers
      .split(/[\s\n\r\t,;:()[\]{}=<>!&|+\-*/%^~?]+/)
      .filter(t => t.length > 0);

    if (tokens.length === 0) return 0;

    // Count token frequencies
    const freq = new Map<string, number>();
    for (const token of tokens) {
      freq.set(token, (freq.get(token) || 0) + 1);
    }

    // Calculate Shannon entropy in bits: H = -sum(p * log2(p))
    let entropy = 0;
    for (const count of freq.values()) {
      const p = count / tokens.length;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    return entropy; // Return in bits, not normalized
  }

  private isKeyword(text: string): boolean {
    const keywords = new Set([
      "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
      "return", "throw", "try", "catch", "finally", "class", "extends", "super",
      "import", "export", "default", "from", "as", "const", "let", "var", "function",
      "new", "delete", "typeof", "void", "instanceof", "in", "of", "this", "true",
      "false", "null", "undefined", "async", "await", "yield", "static", "get", "set",
    ]);
    return keywords.has(text);
  }

  // --- Private: Maintainability Index ---
  // Microsoft's formula: MI = max(0, (171 - 5.2 * ln(Halstead) - 0.23 * Cyclomatic - 16.2 * ln(LOC)) * 100 / 171)
  // Adjusted for comment density bonus

  private calculateMaintainabilityIndex(
    halstead: number,
    cyclomatic: number,
    loc: number,
    comments: number
  ): number {
    if (loc === 0) return 100;

    const lnHalstead = halstead > 0 ? Math.log(halstead) : 0;
    const lnLOC = loc > 0 ? Math.log(loc) : 0;

    // Base MI formula
    let mi = (171 - 5.2 * lnHalstead - 0.23 * cyclomatic - 16.2 * lnLOC) * 100 / 171;

    // Comment density bonus (up to +10%)
    const commentDensity = comments / loc;
    const commentBonus = Math.min(10, commentDensity * 50);

    mi += commentBonus;

    return Math.max(0, Math.min(100, mi));
  }
}
