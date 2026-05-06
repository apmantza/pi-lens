export type ReadToolInput = {
	path?: string;
	filePath?: string;
	offset?: number;
	limit?: number;
};

export function getReadToolInput(
    toolName: string,
    input: unknown,
): ReadToolInput | undefined {
    if (toolName !== "read") return undefined;
    return input as ReadToolInput;
}
