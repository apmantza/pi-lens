type IndentStyle = "tab" | "space";

export interface Indentation {
	style: IndentStyle;
	width: number;
}

const DEFAULT_INDENTATION: Indentation = { style: "space", width: 2 };

/**
 * Infer the prevailing indentation convention from lines that are indented.
 * The detector deliberately has no language knowledge: formatter callers use
 * it only as a conservative fallback when the repository has no config.
 */
export function detectIndentation(content: string): Indentation {
	const lines = content.split(/\r?\n/);
	const tabs = lines.filter((line) => /^\t+\S/.test(line)).length;
	const spaceCounts = lines
		.map((line) => line.match(/^ +(?=\S)/)?.[0].length ?? 0)
		.filter((count) => count > 0);

	if (tabs === 0 && spaceCounts.length === 0) return DEFAULT_INDENTATION;
	if (tabs > spaceCounts.length) return { style: "tab", width: 1 };
	if (spaceCounts.length > tabs) {
		const counts = new Map<number, number>();
		for (const count of spaceCounts) {
			for (const other of spaceCounts) {
				if (other > count) {
					const delta = other - count;
					counts.set(delta, (counts.get(delta) ?? 0) + 1);
				}
			}
		}
		const inferredWidth =
			[...counts.entries()].sort(
				(a, b) => b[1] - a[1] || a[0] - b[0],
			)[0]?.[0] ?? Math.min(...spaceCounts);
		return { style: "space", width: inferredWidth <= 8 ? inferredWidth : 2 };
	}

	return DEFAULT_INDENTATION;
}

/** Whether the content supplied evidence from which a style can be inferred. */
export function hasDetectableIndentation(content: string): boolean {
	return /^(?:\t+| {1,})\S/m.test(content);
}
