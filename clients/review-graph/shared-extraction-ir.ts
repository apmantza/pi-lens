import { createHash } from "node:crypto";
import type { FunctionSummary } from "../dispatch/facts/function-facts.js";
import type {
	ImportEntry,
	ReExportEntry,
} from "../dispatch/facts/import-facts.js";
import { normalizeMapKey } from "../path-utils.js";
import type { ExtractedSymbols } from "../tree-sitter-symbol-extractor.js";

export type ReviewGraphExtractionStatus = "complete" | "partial" | "unavailable";

export interface ReviewGraphExtractionCoverage {
	definitions: ReviewGraphExtractionStatus;
	references: ReviewGraphExtractionStatus;
	imports: ReviewGraphExtractionStatus;
	/** Warm TS/TSX function facts; JS-like files intentionally report unavailable. */
	calls: ReviewGraphExtractionStatus;
}

export interface JsTsReviewGraphIr {
	kind: "jsts";
	imports: ImportEntry[];
	reexports: ReExportEntry[];
	functionSummaries: FunctionSummary[];
	coverage: ReviewGraphExtractionCoverage;
}

export interface TreeSitterReviewGraphIr {
	kind: "tree-sitter";
	languageId: string;
	extracted: ExtractedSymbols;
}

export type ReviewGraphStructuralIr =
	| JsTsReviewGraphIr
	| TreeSitterReviewGraphIr;

export interface ReviewGraphFileIr {
	filePath: string;
	contentHash: string;
	/** False means extraction degraded/failed; consumers must parse normally. */
	complete: boolean;
	structural?: ReviewGraphStructuralIr;
}

/**
 * THE producer/consumer hash contract, in one place (#955 review): scanner
 * publication and builder acceptance must produce byte-identical digests or
 * every lookup silently misses forever. Both sides hash the exact decoded
 * string they parsed.
 */
export function reviewGraphIrContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

// Process-local handoff only. Values are compact extracted data: never source
// strings, web-tree-sitter trees, or FactStores. Bounds (#955 review — the
// #886 retention class): a small root bound, a per-root entry cap, and
// consume-once semantics — an entry is DELETED when the graph accepts it, and
// the full build clears the root's leftovers when it finishes, so the
// registry's lifetime is the scan-to-build window, not the process lifetime.
const MAX_ROOTS = 8;
const MAX_FILES_PER_ROOT = 20_000;
const roots = new Map<string, Map<string, ReviewGraphFileIr>>();
let accepted = 0;
let rejected = 0;

function rootKey(cwd: string): string {
	return normalizeMapKey(cwd);
}

export function publishReviewGraphFileIr(
	cwd: string,
	entry: ReviewGraphFileIr,
): void {
	// Only consumable entries are worth storing: the builder rejects
	// incomplete entries and has nothing to read without `structural`, so
	// publishing them would be pure retention — and an incomplete late
	// publication must never clobber a still-valid entry (#955 review).
	if (!entry.complete || !entry.structural) return;
	const key = rootKey(cwd);
	let files = roots.get(key);
	if (!files) {
		files = new Map();
		roots.set(key, files);
		while (roots.size > MAX_ROOTS) {
			const oldest = roots.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			roots.delete(oldest);
		}
	}
	const fileKey = normalizeMapKey(entry.filePath);
	files.delete(fileKey);
	while (files.size >= MAX_FILES_PER_ROOT) {
		const oldest = files.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		files.delete(oldest);
	}
	files.set(fileKey, { ...entry, filePath: fileKey });
}

/**
 * Consume-once: a hash-fresh entry is removed as it is returned. The graph is
 * about to ingest these arrays, so keeping a second registry copy alive would
 * both duplicate the heap and leave a write-through aliasing target (#955
 * review); a later build re-parses or waits for the next scan to republish.
 */
export function getFreshReviewGraphFileIr(
	cwd: string,
	filePath: string,
	contentHash: string,
): ReviewGraphFileIr | undefined {
	const files = roots.get(rootKey(cwd));
	const fileKey = normalizeMapKey(filePath);
	const entry = files?.get(fileKey);
	if (!entry) return undefined;
	if (entry.contentHash !== contentHash) {
		// Present but stale — the only honest "rejected" (#955 review: absence
		// is not rejection; counting it made the stat unusable).
		rejected++;
		return undefined;
	}
	files?.delete(fileKey);
	accepted++;
	return entry;
}

/** Build-end/session-reset seam; builds also work when this is never called. */
export function clearReviewGraphFileIr(cwd?: string): void {
	if (cwd === undefined) roots.clear();
	else roots.delete(rootKey(cwd));
}

export function getReviewGraphIrStats(): {
	accepted: number;
	rejected: number;
} {
	return { accepted, rejected };
}

export function resetReviewGraphIrStats(): void {
	accepted = 0;
	rejected = 0;
}
