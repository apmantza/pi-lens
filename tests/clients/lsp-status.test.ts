/**
 * #170 — the footer's Active/Failed selection policy. selectLspStatus is the
 * pure decision: given alive ids (#267), raw failed-spawn ids, and the kinds in
 * use this session, which servers go green (Active) and which red (Failed).
 *
 * Real server ids/extensions are used so the per-language coverage check runs
 * against the shipped registry: python + python-jedi share KIND_EXTENSIONS
 * ["python"] (so they're alternatives); typescript's kind is "jsts"; ruby's is
 * "ruby".
 */

import { describe, expect, it } from "vitest";
import { selectLspStatus } from "../../clients/lsp-status.js";

describe("selectLspStatus (#170)", () => {
	it("suppresses a failed server when a live sibling covers its language (alt-LSP)", () => {
		// pyright failed but jedi came up → Python is covered → not a failure.
		const { activeIds, failedIds } = selectLspStatus(
			["python-jedi"],
			["python"],
			["python"],
		);
		expect(activeIds).toEqual(["python-jedi"]);
		expect(failedIds).toEqual([]);
	});

	it("surfaces a genuine failure: language in use, no live sibling", () => {
		const { failedIds } = selectLspStatus([], ["ruby"], ["ruby"]);
		expect(failedIds).toEqual(["ruby"]);
	});

	it("drops a stale failure for a language no longer in use this session", () => {
		// ruby failed earlier, but the session is now only python → stale, no red.
		const { failedIds } = selectLspStatus([], ["ruby"], ["python"]);
		expect(failedIds).toEqual([]);
	});

	it("shows Active and Failed together when some are up and another is fully down", () => {
		const { activeIds, failedIds } = selectLspStatus(
			["typescript"],
			["ruby"],
			["jsts", "ruby"],
		);
		expect(activeIds).toEqual(["typescript"]);
		expect(failedIds).toEqual(["ruby"]);
	});

	it("does not surface an auxiliary failure as a language failure", () => {
		// opengrep is a cross-cutting scanner, not a language's LSP.
		const { failedIds } = selectLspStatus([], ["opengrep"], ["python"]);
		expect(failedIds).toEqual([]);
	});

	it("does not let a live auxiliary provide language coverage", () => {
		// Even though opengrep attaches broadly, an alive opengrep must not make a
		// failed python server look covered — only a live language sibling counts.
		const { failedIds } = selectLspStatus(["opengrep"], ["python"], ["python"]);
		expect(failedIds).toEqual(["python"]);
	});

	it("passes the alive set through as activeIds unchanged (order + auxiliaries)", () => {
		const { activeIds } = selectLspStatus(
			["typescript", "opengrep", "ast-grep"],
			[],
			["jsts"],
		);
		expect(activeIds).toEqual(["typescript", "opengrep", "ast-grep"]);
	});

	it("dedupes repeated failed ids", () => {
		const { failedIds } = selectLspStatus([], ["ruby", "ruby"], ["ruby"]);
		expect(failedIds).toEqual(["ruby"]);
	});
});
