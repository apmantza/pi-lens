export interface ComplexityFunctionResult {
	name: string;
	line: number;
	length: number;
	cyclomatic: number;
	cognitive: number;
	nestingDepth: number;
	filePath?: string;
}

export interface ComplexityFileResult {
	filePath: string;
	linesOfCode: number;
	maxCyclomaticComplexity: number;
	cognitiveComplexity: number;
	functionCount: number;
	lineCount?: number;
	functions?: ComplexityFunctionResult[];
}

export declare const COMPLEXITY_FUNCTION_THRESHOLD: number;
export declare const COMPLEXITY_FILE_SIZE_THRESHOLD: number;
export declare function shapeComplexityReport(
	results: ComplexityFileResult[],
	options?: {
		topN?: number;
		fileSizeThreshold?: number;
		functionThreshold?: number;
	},
): string;
