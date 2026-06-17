// A deliberately CLEAN TypeScript file (no diagnostics) — used by the latency
// benchmark to measure the clean-file edit path, which the intentionally-broken
// fixtures mask (#240). The smoke harness passes it as "server replied".
export function add(a: number, b: number): number {
	return a + b;
}

export const total: number = add(2, 3);
