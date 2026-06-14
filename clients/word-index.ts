/**
 * Identifier-aware inverted word index + BM25 ranking.
 *
 * The lexical half of the "codebase mental model + hybrid ranking" ask (#162):
 * a deterministic, zero-dep index over source identifiers that answers
 * "which files are most relevant to <query>" with BM25 relevance plus a small
 * set of priors (demote tests/vendor and doc files) and an optional graph
 * centrality boost (importedBy count from the reverse-dependency index). It
 * complements LSP/symbol navigation rather than duplicating the host's grep:
 * grep finds raw substrings; this ranks files by identifier relevance.
 *
 * Built from file contents during the session scan, persisted in the project
 * snapshot (serialize/deserialize below), and queried via an MCP tool. No
 * embeddings, no native deps, no daemon — pure in-process TypeScript.
 */

export interface WordHit {
	file: string;
	line: number;
}

export interface WordIndex {
	/** token → postings (one entry per (file,line) the token appears on). */
	postings: Map<string, WordHit[]>;
	/** file → number of indexed tokens (document length, for BM25 normalization). */
	docLengths: Map<string, number>;
	totalTokens: number;
	docCount: number;
}

export interface RankedFile {
	file: string;
	score: number;
	/** Number of query-token occurrences in the file (summed term frequency). */
	hits: number;
	/** Distinct lines where a query token occurred, ascending. */
	lines: number[];
}

export interface RankOptions {
	/** Demote files under test/vendor/example paths (default true). */
	demoteTestVendor?: boolean;
	/** Demote documentation/data files so they can't starve a real source match (default true). */
	demoteDocs?: boolean;
	/** file → graph centrality (e.g. importedBy count); boosts well-connected files. */
	centrality?: Map<string, number>;
	/** Max results to return (default 20). */
	limit?: number;
}

// Common language keywords / boilerplate — indexing them adds noise and bloats
// postings without improving relevance. Kept deliberately small and
// language-agnostic.
const STOPWORDS = new Set([
	"the", "and", "for", "let", "var", "const", "function", "return", "if",
	"else", "import", "export", "from", "class", "interface", "type", "enum",
	"new", "this", "self", "void", "null", "true", "false", "async", "await",
	"public", "private", "protected", "static", "def", "fn", "func", "struct",
	"impl", "pub", "use", "mod", "in", "of", "as", "is", "not", "with",
]);

const TEST_VENDOR_RE =
	/(?:(^|[\\/])(?:tests?|__tests__|spec|specs|__mocks__|vendor|node_modules|examples?|fixtures?|\.git|dist|build|coverage)([\\/]|$))|(?:\.(?:test|spec)\.[a-z]+$)/i;

const DOC_FILE_RE = /\.(?:md|mdx|markdown|json|jsonc|txt|rst|lock|ya?ml|toml|csv)$/i;

const TEST_VENDOR_PENALTY = 0.3;
const DOC_FILE_PENALTY = 0.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function isTestOrVendor(file: string): boolean {
	return TEST_VENDOR_RE.test(file);
}

function isDocFile(file: string): boolean {
	return DOC_FILE_RE.test(file);
}

/**
 * Split an identifier into lowercased sub-tokens across camelCase, PascalCase,
 * snake_case, kebab-case, dotted, and digit boundaries — and keep the whole
 * lowercased identifier too. `getUserByID` → [getuserbyid, get, user, by, id];
 * `MAX_RETRY_2` → [max_retry_2, max, retry, 2] (whole kept, plus parts).
 */
export function splitIdentifier(identifier: string): string[] {
	const parts = new Set<string>();
	const whole = identifier.toLowerCase();
	if (whole.length >= 2 && !STOPWORDS.has(whole)) parts.add(whole);
	for (const chunk of identifier.split(/[^A-Za-z0-9]+/)) {
		if (!chunk) continue;
		const spaced = chunk
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
			.replace(/[A-Z](?=[A-Z][a-z])/g, "$& ") // HTTPServer → HTTP Server (linear; lookahead avoids super-linear backtracking, S5852)
			.replace(/([A-Za-z])([0-9])/g, "$1 $2") // retry2 → retry 2
			.replace(/([0-9])([A-Za-z])/g, "$1 $2"); // 2fa → 2 fa
		for (const sub of spaced.split(/\s+/)) {
			const token = sub.toLowerCase();
			if (token.length >= 2 && !STOPWORDS.has(token)) parts.add(token);
		}
	}
	return [...parts];
}

/** Extract identifier-like tokens from a line and split each into sub-tokens. */
export function tokenizeLine(line: string): string[] {
	const tokens: string[] = [];
	const matches = line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
	if (!matches) return tokens;
	for (const match of matches) {
		for (const token of splitIdentifier(match)) tokens.push(token);
	}
	return tokens;
}

/**
 * Build the inverted index from file contents. One posting per (token, file,
 * line) — a token repeated on the same line counts once — so term frequency is
 * "lines mentioning the token", a stable signal that doesn't over-weight a line
 * that repeats an identifier. Document length is the total indexed token count.
 */
export function buildWordIndex(
	files: Array<{ path: string; content: string }>,
): WordIndex {
	const postings = new Map<string, WordHit[]>();
	const docLengths = new Map<string, number>();
	let totalTokens = 0;

	for (const { path: filePath, content } of files) {
		const lines = content.split(/\r?\n/);
		let docLength = 0;
		for (let i = 0; i < lines.length; i += 1) {
			const lineTokens = tokenizeLine(lines[i]);
			docLength += lineTokens.length;
			const seenOnLine = new Set<string>();
			for (const token of lineTokens) {
				if (seenOnLine.has(token)) continue;
				seenOnLine.add(token);
				const arr = postings.get(token);
				if (arr) arr.push({ file: filePath, line: i + 1 });
				else postings.set(token, [{ file: filePath, line: i + 1 }]);
			}
		}
		docLengths.set(filePath, docLength);
		totalTokens += docLength;
	}

	return { postings, docLengths, totalTokens, docCount: files.length };
}

/**
 * Rank files for a query by BM25 over the query's identifier tokens, then apply
 * priors: demote test/vendor and doc/data files, and boost by graph centrality
 * when supplied. Returns the top {@link RankOptions.limit} files, highest first.
 */
export function searchWordIndex(
	index: WordIndex,
	query: string,
	options: RankOptions = {},
): RankedFile[] {
	const {
		demoteTestVendor = true,
		demoteDocs = true,
		centrality,
		limit = 20,
	} = options;

	const queryTokens = [...new Set(tokenizeLine(query))];
	if (queryTokens.length === 0) return [];

	const docCount = index.docCount || 1;
	const avgDocLength = index.totalTokens / docCount || 1;

	const scores = new Map<
		string,
		{ score: number; hits: number; lines: Set<number> }
	>();

	for (const token of queryTokens) {
		const posting = index.postings.get(token);
		if (!posting) continue;

		const linesByFile = new Map<string, number[]>();
		for (const hit of posting) {
			const arr = linesByFile.get(hit.file);
			if (arr) arr.push(hit.line);
			else linesByFile.set(hit.file, [hit.line]);
		}

		const docFrequency = linesByFile.size;
		const idf = Math.log(
			1 + (docCount - docFrequency + 0.5) / (docFrequency + 0.5),
		);

		for (const [file, lines] of linesByFile) {
			const termFrequency = lines.length;
			const docLength = index.docLengths.get(file) ?? avgDocLength;
			const denominator =
				termFrequency +
				BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength));
			const termScore =
				idf * ((termFrequency * (BM25_K1 + 1)) / denominator);

			const entry = scores.get(file) ?? {
				score: 0,
				hits: 0,
				lines: new Set<number>(),
			};
			entry.score += termScore;
			entry.hits += termFrequency;
			for (const line of lines) entry.lines.add(line);
			scores.set(file, entry);
		}
	}

	const results: RankedFile[] = [];
	for (const [file, entry] of scores) {
		let score = entry.score;
		if (demoteTestVendor && isTestOrVendor(file)) score *= TEST_VENDOR_PENALTY;
		if (demoteDocs && isDocFile(file)) score *= DOC_FILE_PENALTY;
		const connections = centrality?.get(file);
		if (connections && connections > 0) {
			score *= 1 + Math.log(1 + connections) / 4;
		}
		results.push({
			file,
			score,
			hits: entry.hits,
			lines: [...entry.lines].sort((a, b) => a - b),
		});
	}

	results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
	return results.slice(0, Math.max(0, limit));
}

/**
 * Build a centrality map (file → importedBy count) keyed by THIS index's file
 * paths, from the project snapshot's `reverseDeps` (importedBy). The snapshot
 * keys are normalized (`normalizeMapKey(resolve(...))`) while the index keys are
 * the raw scanned paths, so the caller injects a `normalizeKey` bridge; it
 * defaults to identity for testing. Pass the result to {@link searchWordIndex}
 * as `centrality` to boost well-connected files. Kept here (not in the engine)
 * so it stays pure + unit-testable without the normalizer dependency.
 */
export function centralityFromReverseDeps(
	index: WordIndex,
	reverseDeps: Record<string, string[]> | undefined,
	normalizeKey: (file: string) => string = (file) => file,
): Map<string, number> {
	const centrality = new Map<string, number>();
	if (!reverseDeps) return centrality;
	for (const file of index.docLengths.keys()) {
		const importers = reverseDeps[normalizeKey(file)];
		if (importers && importers.length > 0) {
			centrality.set(file, importers.length);
		}
	}
	return centrality;
}

// --- Persistence (compact JSON for the project snapshot) ---------------------

export interface SerializedWordIndex {
	/** Distinct file paths; postings reference files by index to shrink the JSON. */
	files: string[];
	/** token → flat [fileIdx, line, fileIdx, line, …] pairs. */
	postings: Array<[string, number[]]>;
	/** Parallel to {@link files}: indexed token count per file. */
	docLengths: number[];
	totalTokens: number;
}

export function serializeWordIndex(index: WordIndex): SerializedWordIndex {
	const files = [...index.docLengths.keys()];
	const fileIndex = new Map<string, number>();
	files.forEach((file, i) => fileIndex.set(file, i));

	const postings: Array<[string, number[]]> = [];
	for (const [token, hits] of index.postings) {
		const flat: number[] = [];
		for (const hit of hits) {
			const idx = fileIndex.get(hit.file);
			if (idx === undefined) continue;
			flat.push(idx, hit.line);
		}
		if (flat.length > 0) postings.push([token, flat]);
	}

	return {
		files,
		postings,
		docLengths: files.map((file) => index.docLengths.get(file) ?? 0),
		totalTokens: index.totalTokens,
	};
}

export function deserializeWordIndex(
	data: SerializedWordIndex | null | undefined,
): WordIndex | null {
	if (
		!data ||
		!Array.isArray(data.files) ||
		!Array.isArray(data.postings) ||
		!Array.isArray(data.docLengths)
	) {
		return null;
	}
	const docLengths = new Map<string, number>();
	data.files.forEach((file, i) => docLengths.set(file, data.docLengths[i] ?? 0));

	const postings = new Map<string, WordHit[]>();
	for (const [token, flat] of data.postings) {
		if (typeof token !== "string" || !Array.isArray(flat)) continue;
		const hits: WordHit[] = [];
		for (let i = 0; i + 1 < flat.length; i += 2) {
			const file = data.files[flat[i]];
			const line = flat[i + 1];
			if (typeof file === "string" && typeof line === "number") {
				hits.push({ file, line });
			}
		}
		if (hits.length > 0) postings.set(token, hits);
	}

	return {
		postings,
		docLengths,
		totalTokens:
			typeof data.totalTokens === "number" ? data.totalTokens : 0,
		docCount: data.files.length,
	};
}
