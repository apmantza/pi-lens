import type { LSPSymbol } from "./lsp/client.js";
import { getLSPService } from "./lsp/index.js";

// Grounded against this repo's workspace-native TypeScript 7.0.2 server
// (`tsc --lsp --stdio`) on 2026-07-30: 20 already-open documentSymbol calls
// measured p50 3.70 ms / p95 5.28 ms. Keep generous headroom for slower hosts.
const LSP_DOCUMENT_SYMBOL_TIMEOUT_MS = 150;

export const SYMBOL_KIND_NAMES: Record<number, string> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enum-member",
	23: "struct",
	24: "event",
	25: "operator",
	26: "type-parameter",
};

export function lspSymbolKindName(kind: number): string {
	return SYMBOL_KIND_NAMES[kind] ?? `lsp-symbol-${kind}`;
}

export async function getOpenDocumentSymbols(
	filePath: string,
	timeoutMs = LSP_DOCUMENT_SYMBOL_TIMEOUT_MS,
): Promise<LSPSymbol[] | undefined> {
	const spawned = await getLSPService().getWarmClientForFile(filePath);
	if (
		!spawned ||
		!spawned.client.isDocumentOpen(filePath) ||
		!spawned.client.getOperationSupport().documentSymbol
	) {
		return undefined;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			spawned.client.documentSymbol(filePath),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs);
			}),
		]);
	} catch {
		return undefined;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface LocatedDocumentSymbol {
	symbol: LSPSymbol;
	ancestry: LSPSymbol[];
}

function symbolRange(symbol: LSPSymbol) {
	return symbol.range ?? symbol.location?.range;
}

export function findDocumentSymbolAtLine(
	symbols: LSPSymbol[],
	oneBasedLine: number,
): LocatedDocumentSymbol | undefined {
	const line = oneBasedLine - 1;
	let best: LocatedDocumentSymbol | undefined;
	let bestSpan = Number.POSITIVE_INFINITY;
	const visit = (items: LSPSymbol[], ancestry: LSPSymbol[]) => {
		for (const symbol of items) {
			const range = symbolRange(symbol);
			if (range && range.start.line <= line && range.end.line >= line) {
				const nextAncestry = [...ancestry, symbol];
				const span = range.end.line - range.start.line;
				if (span <= bestSpan) {
					best = { symbol, ancestry };
					bestSpan = span;
				}
				if (symbol.children) visit(symbol.children, nextAncestry);
			}
		}
	};
	visit(symbols, []);
	return best;
}

/**
 * Full owner chain for a FLAT SymbolInformation result: hierarchical results
 * carry ancestry directly, but native-ts7 (measured: TypeScript 7.0.2 via
 * tsc --lsp) returns flat symbols whose only containment signal is the
 * immediate `containerName`. Walk containerName links through the full result
 * so nested owners qualify completely (Outer.Inner.method, #951 review) —
 * cycle-guarded and depth-capped.
 */
export function containerNameChain(
	symbol: LSPSymbol,
	allSymbols: readonly LSPSymbol[] | undefined,
): string[] {
	const chain: string[] = [];
	const seen = new Set<string>();
	let container = symbol.containerName;
	while (container && !seen.has(container) && chain.length < 10) {
		chain.unshift(container);
		seen.add(container);
		container = allSymbols?.find(
			(candidate) => candidate.name === container,
		)?.containerName;
	}
	return chain;
}

export function qualifiedLspSymbolName(
	located: LocatedDocumentSymbol,
	allSymbols?: readonly LSPSymbol[],
): string {
	const owners =
		located.ancestry.length > 0
			? located.ancestry.map((entry) => entry.name)
			: containerNameChain(located.symbol, allSymbols);
	return [...owners, located.symbol.name].join(".");
}
