import type { CascadeNeighborResult } from "./cascade-types.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";

export function formatCascadeNeighborDiagnostics(
	cwd: string,
	neighbors: CascadeNeighborResult[],
	options: { noun?: string; includeReason?: boolean } = {},
): string {
	const withErrors = neighbors.filter((n) => n.diagnostics.length > 0);
	if (withErrors.length === 0) return "";

	const noun = options.noun ?? "neighbor";
	let out = `📐 Cascade errors in ${withErrors.length} ${noun} file(s) — fix before finishing turn:`;
	for (const neighbor of withErrors) {
		const display = toRunnerDisplayPath(cwd, neighbor.filePath);
		const reason = options.includeReason ? ` reason="${neighbor.reason}"` : "";
		out += `\n<diagnostics file="${display}"${reason}>`;
		for (const d of neighbor.diagnostics) {
			const line = d.line ?? 1;
			const col = d.column ?? 1;
			const rule = d.rule ? ` rule=${d.rule}` : "";
			out += `\n  line ${line}, col ${col}${rule}: ${d.message.split("\n")[0].slice(0, 100)}`;
		}
		out += "\n</diagnostics>";
	}
	return out;
}
