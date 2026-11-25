/**
 * The whole-content sha256 of a DECODED STRING has one owner: `hashContentBytes`
 * in `clients/content-stamp.ts`, reached as `hashContentBytes(Buffer.from(text,
 * "utf8"))`. Six production sites spelled `createHash("sha256").update(text)`
 * themselves: `hashDiagnosticContent` (LSP), `reviewGraphIrContentHash`,
 * the warm-attach `contentHash`, the `TreeCache` entry hash, the
 * `fingerprintDocumentContent` long form, and the inline hash
 * `buildActionableWarningsReport` hands `getLastKnownDiagnostics`. The first
 * three had byte-identical bodies, and `clients/lsp/index.ts` already warns that
 * a second implementation of the LSP hash "is a silent divergence waiting for
 * one of them to be tuned". #4541's bytes fold (`content-hash-seam-fold.test.ts`)
 * left this string half alone.
 *
 * Recurrence this guards: a former site stops delegating to the seam, or the
 * seam's digest drifts from the plain sha256 the stored hashes, the warm
 * socket's peer and the pinned fixtures hold. Each cell drives a former site
 * through its exported production caller and compares with a digest this file
 * derives itself, so a mutation of the seam reds the cell instead of staying
 * consistent on both sides of a comparison. The inline hash in
 * `buildActionableWarningsReport` is witnessed by `passes the current file
 * content hash to the guarded getter` in
 * `tests/clients/actionable-warnings-lsp-cache.test.ts`, which compares it with
 * its own `createHash`.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { hashContentBytes } from "../../clients/content-stamp.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { fingerprintDocumentContent } from "../../clients/lsp/document-drift.js";
import { contentHash } from "../../clients/mcp/ipc.js";
import { reviewGraphIrContentHash } from "../../clients/review-graph/shared-extraction-ir.js";
import { TreeCache } from "../../clients/tree-sitter-cache.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

// Texts a decoded file can hold: empty, CRLF with a BOM, an astral character,
// a lone surrogate (utf-8 encodes it as U+FFFD, in both spellings), a NUL, and
// both sides of the fingerprint's 96-character raw-versus-hash boundary.
const TEXTS: Record<string, string> = {
	empty: "",
	ascii: "const x = 1;\n",
	crlfBom: "\uFEFFa\r\nb\r\n",
	astral: "x\u{1F600}",
	loneSurrogate: "x\uD800y",
	nul: "a\u0000b",
	at96: "a".repeat(96),
	at97: "a".repeat(97),
};

function independentSha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

describe("whole-content sha256 of a decoded string (content-stamp owner)", () => {
	for (const [name, text] of Object.entries(TEXTS)) {
		describe(name, () => {
			it("the seam answers the plain sha256 hex of the text's utf-8 bytes", () => {
				expect(hashContentBytes(Buffer.from(text, "utf8"))).toBe(
					independentSha256(text),
				);
			});

			it("hashDiagnosticContent (LSP binding hash) answers the plain sha256", () => {
				expect(hashDiagnosticContent(text)).toBe(independentSha256(text));
			});

			it("reviewGraphIrContentHash answers the plain sha256", () => {
				expect(reviewGraphIrContentHash(text)).toBe(independentSha256(text));
			});

			it("the warm-attach contentHash answers the plain sha256", () => {
				expect(contentHash(text)).toBe(independentSha256(text));
			});

			it("the document fingerprint is the raw text up to 96 characters and the plain sha256 beyond", () => {
				expect(fingerprintDocumentContent(text)).toBe(
					text.length <= 96
						? `${text.length}:${text}`
						: `${text.length}:${independentSha256(text)}`,
				);
			});
		});
	}

	it("TreeCache serves a same-text entry and misses on a same-length edit", () => {
		const env = setupTestEnvironment("pi-lens-content-hash-text-fold-");
		cleanups.push(env.cleanup);
		const file = createTempFile(env.tmpDir, "a.ts", "const a = 1;");
		const cache = new TreeCache(4);
		const tree = { delete: () => undefined, rootNode: { type: "program" } };
		cache.set(file, "const a = 1;", "typescript", tree);
		expect(cache.get(file, "const a = 1;", "typescript")).toBe(tree);
		expect(cache.get(file, "const b = 1;", "typescript")).toBeNull();
		const stats = cache.getStats();
		expect(stats.hits).toBe(1);
		expect(stats.contentChangedMisses).toBe(1);
	});
});
