import { describe, expect, it } from "vitest";
import { LSP_SERVERS } from "../../clients/lsp/server.js";

/**
 * #4269: keep the project-code execution population explicit. A new built-in
 * must not silently become an unknown-trust execution path by omission.
 */
describe("LSP project-code trust census", () => {
	it("declares every known project-code server and no others", () => {
		const expected = new Set([
			"rust",
			"ruby",
			"powershell",
			"csharp",
			"omnisharp",
			"fsharp",
			"java",
			"kotlin",
			"swift",
			"haskell",
			"elixir",
			"expert",
			"dart",
			"zig",
			"ocaml",
			"clojure",
			"terraform",
			"nix",
			"cmake",
			"vue",
			"svelte",
			"tinymist",
		]);
		const actual = new Set(
			LSP_SERVERS.filter((server) => server.executesProjectCode).map(
				(server) => server.id,
			),
		);

		expect(actual).toEqual(expected);
	});
});
