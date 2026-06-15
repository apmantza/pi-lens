// Known defect: assigning a string to a number — the TypeScript LSP must flag
// this as a type error (tool-smoke fixture for #209).
export const count: number = "not a number";

export function double(n: number): number {
	return n * 2;
}
