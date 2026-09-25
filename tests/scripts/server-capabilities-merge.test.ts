/**
 * Tests for the #469 servercapabilities merge guard fix in
 * scripts/lib/md-matrix.mjs:
 *   - reshapeRowsByName  — reshapes prior rows onto a NEW header by column
 *     NAME (tolerates a schema change, e.g. the ws-pull column addition,
 *     which previously killed the #390 guard's header-identity precondition).
 *   - parseBulletSection / mergeBulletSection — carry a preserved server's
 *     bullet line(s) from the prior doc's "## Raw advertised capability keys"
 *     / "## Advertised executeCommand allowlists" sections into the fresh
 *     doc, which the original guard never did at all.
 *   - mergeServerCapabilitiesDoc — the pure, whole-doc merge function used by
 *     scripts/server-capabilities.mjs (doc text in, doc text out; no LSP
 *     server spawn needed to test it).
 */

import { describe, expect, it } from "vitest";
import {
	compareGeneratedDocs,
	mergeBulletSection,
	renderServerCapabilitiesDoc,
	mergeServerCapabilitiesDoc,
	parseBulletSection,
	parseTable,
	reshapeRowsByName,
} from "../../scripts/lib/md-matrix.mjs";

describe("generated docs comparison", () => {
	it("treats a date-only refresh as unchanged while retaining changed rows", () => {
		// Recurrence #3380: the nightly date marker changed every run and opened
		// a bot PR even when every measured capability row was identical.
		const before =
			"# doc\n\n_Last generated: 2026-09-23 on linux; 1 servers captured, 0 unavailable._\n\n| row | old |\n";
		const dateOnly = before.replace("2026-09-23", "2026-09-24");
		const changedRow = dateOnly.replace("| row | old |", "| row | new |");

		expect(compareGeneratedDocs(before, dateOnly)).toBe(false);
		expect(compareGeneratedDocs(before, changedRow)).toBe(true);
	});
});

const OPS = [
	["definition", "def"],
	["hover", "hov"],
] as const;

describe("server capability rendering", () => {
	it("renders byte-identically when inventory set members arrive in another order", () => {
		// Recurrence #3342: handshake/set iteration order changed docs without
		// changing capability membership, creating no-op nightly PRs.
		const make = (commands: string[], keys: string[]) => ({
			serverId: "tinymist",
			workspaceDiagnosticsSupport: { mode: "pull", workspaceDiagnostics: true },
			operationSupport: { definition: true, hover: false },
			advertisedCommands: commands,
			rawCapabilityKeys: keys,
		});
		const common = {
			unavailable: new Set(["z-server", "a-server"]),
			date: "2026-09-23",
			platform: "linux",
			ops: OPS,
		};
		const first = renderServerCapabilitiesDoc({
			...common,
			rows: [make(["b", "a"], ["zProvider", "aProvider"])],
		});
		const second = renderServerCapabilitiesDoc({
			...common,
			rows: [make(["a", "b"], ["aProvider", "zProvider"])],
		});
		expect(second).toBe(first);
	});
});

describe("reshapeRowsByName", () => {
	it("carries prior columns by name and fills a newly-added column with the placeholder", () => {
		const priorHeader = ["server", "mode", "def", "cmds"];
		const priorRows = [["rust", "pull", "✓", "0"]];
		const newHeader = ["server", "mode", "ws-pull", "def", "cmds"];
		const reshaped = reshapeRowsByName(
			priorRows,
			priorHeader,
			newHeader,
			"server",
		);
		expect(reshaped).toEqual([["rust", "pull", "·", "✓", "0"]]);
	});

	it("drops columns present in the prior schema but absent from the new one", () => {
		const priorHeader = ["server", "mode", "legacyCol", "def"];
		const priorRows = [["php", "push-only", "old-value", "✓"]];
		const newHeader = ["server", "mode", "def"];
		const reshaped = reshapeRowsByName(
			priorRows,
			priorHeader,
			newHeader,
			"server",
		);
		expect(reshaped).toEqual([["php", "push-only", "✓"]]);
	});

	it("honors a custom placeholder", () => {
		const priorHeader = ["server", "mode"];
		const priorRows = [["go", "push-only"]];
		const newHeader = ["server", "mode", "wSym"];
		const reshaped = reshapeRowsByName(
			priorRows,
			priorHeader,
			newHeader,
			"server",
			"?",
		);
		expect(reshaped).toEqual([["go", "push-only", "?"]]);
	});
});

describe("parseBulletSection / mergeBulletSection", () => {
	const PRIOR = `# doc

## Raw advertised capability keys

- **php**: completionProvider, definitionProvider
- **rust**: callHierarchyProvider, definitionProvider

## Advertised executeCommand allowlists

- **rust**: (3): rust-analyzer.runSingle, rust-analyzer.debugSingle, rust-analyzer.showReferences

## Unavailable on the generating host

- clangd
`;

	it("parses bullets keyed by the bold server name", () => {
		const map = parseBulletSection(PRIOR, "## Raw advertised capability keys");
		expect(map.get("php")).toBe(
			"**php**: completionProvider, definitionProvider",
		);
		expect(map.get("rust")).toBe(
			"**rust**: callHierarchyProvider, definitionProvider",
		);
	});

	it("returns an empty map when the heading isn't found", () => {
		const map = parseBulletSection(PRIOR, "## Nonexistent section");
		expect(map.size).toBe(0);
	});

	it("carries over a preserved server's bullet into a fresh section, sorted by key", () => {
		const fresh = `# doc

## Raw advertised capability keys

- **go**: definitionProvider, hoverProvider

## Unavailable on the generating host

- clangd
`;
		const priorBullets = parseBulletSection(
			PRIOR,
			"## Raw advertised capability keys",
		);
		const merged = mergeBulletSection(
			fresh,
			"## Raw advertised capability keys",
			priorBullets,
			["php", "rust"],
		);
		const lines = merged.split("\n");
		const bulletLines = lines.filter((l) => l.startsWith("- **"));
		expect(bulletLines).toEqual([
			"- **go**: definitionProvider, hoverProvider",
			"- **php**: completionProvider, definitionProvider",
			"- **rust**: callHierarchyProvider, definitionProvider",
		]);
		// surrounding structure preserved
		expect(merged).toContain("## Unavailable on the generating host");
		expect(merged).toContain("- clangd");
	});

	it("skips a key silently when the prior doc had no bullet for it", () => {
		const fresh = `# doc

## Raw advertised capability keys

- **go**: definitionProvider
`;
		const priorBullets = parseBulletSection(
			PRIOR,
			"## Raw advertised capability keys",
		);
		const merged = mergeBulletSection(
			fresh,
			"## Raw advertised capability keys",
			priorBullets,
			["go", "nonexistent-server"],
		);
		expect(merged).toBe(fresh); // "go" already present, "nonexistent-server" has no prior bullet
	});

	it("returns the text unchanged when the heading is missing (fail-open)", () => {
		const fresh = "# doc\n\nno sections here\n";
		const merged = mergeBulletSection(
			fresh,
			"## Raw advertised capability keys",
			new Map(),
			["php"],
		);
		expect(merged).toBe(fresh);
	});
});

function tableBlock(header: string[], rows: string[][]) {
	const sep = `|${header.map(() => "---").join("|")}|`;
	const render = (cells: string[]) => `| ${cells.join(" | ")} |`;
	return [render(header), sep, ...rows.map(render)].join("\n");
}

describe("mergeServerCapabilitiesDoc (#469)", () => {
	const OLD_HEADER = ["server", "mode", "def", "cmds"];
	const NEW_HEADER = ["server", "mode", "ws-pull", "def", "cmds"];

	function makeDoc(
		header: string[],
		rows: string[][],
		bullets: Record<string, string>,
	) {
		const lines = [
			"# LSP server capability inventory",
			"",
			"_Last generated: 2026-01-01 on win32; N servers captured, M unavailable._",
			"",
			"## Diagnostic mode + navigation/edit operations",
			"",
			"Legend line.",
			"",
			tableBlock(header, rows),
			"",
			"## Raw advertised capability keys",
			"",
			"Top-level keys.",
			"",
			...Object.entries(bullets)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([server, keys]) => `- **${server}**: ${keys}`),
		];
		return lines.join("\n") + "\n";
	}

	it("(a) header-change merge: prior doc without ws-pull + new table with it → prior-only row preserved with placeholder fill", () => {
		const prior = makeDoc(
			OLD_HEADER,
			[
				["php", "push-only", "✓", "0"],
				["rust", "pull", "✓", "0"],
			],
			{ php: "definitionProvider", rust: "definitionProvider, hoverProvider" },
		);
		// This run only captured "rust" (php's toolchain absent on this host).
		const fresh = makeDoc(NEW_HEADER, [["rust", "pull", "✓", "✓", "0"]], {
			rust: "definitionProvider, hoverProvider",
		});

		const { text, preservedCount } = mergeServerCapabilitiesDoc(prior, fresh);
		expect(preservedCount).toBe(1);

		const tbl = parseTable(text, "| server | mode | ws-pull |")!;
		expect(tbl.header).toEqual(NEW_HEADER);
		const phpRow = tbl.rows.find((r) => r[0] === "php");
		expect(phpRow).toEqual(["php", "push-only", "·", "✓", "0"]); // ws-pull filled with placeholder
		const rustRow = tbl.rows.find((r) => r[0] === "rust");
		expect(rustRow).toEqual(["rust", "pull", "✓", "✓", "0"]); // captured this run, unchanged

		// bullet carried over too
		expect(text).toContain("- **php**: definitionProvider");
	});

	it("(b) same-header merge still works (no schema change)", () => {
		const prior = makeDoc(
			OLD_HEADER,
			[
				["go", "push-only", "✓", "46"],
				["json", "pull", "·", "0"],
			],
			{ go: "definitionProvider", json: "hoverProvider" },
		);
		const fresh = makeDoc(OLD_HEADER, [["json", "pull", "·", "0"]], {
			json: "hoverProvider",
		});

		const { text, preservedCount } = mergeServerCapabilitiesDoc(prior, fresh);
		expect(preservedCount).toBe(1);
		const tbl = parseTable(text, "| server | mode | def |")!;
		expect(tbl.rows.find((r) => r[0] === "go")).toEqual([
			"go",
			"push-only",
			"✓",
			"46",
		]);
		expect(text).toContain("- **go**: definitionProvider");
	});

	it("(c) bullet carry-over for a preserved server in both bullet sections", () => {
		const priorLines = [
			"# doc",
			"",
			tableBlock(OLD_HEADER, [
				["rust", "pull", "✓", "3"],
				["php", "push-only", "✓", "0"],
			]),
			"",
			"## Raw advertised capability keys",
			"",
			"- **php**: definitionProvider, hoverProvider",
			"- **rust**: definitionProvider, callHierarchyProvider",
			"",
			"## Advertised executeCommand allowlists",
			"",
			"- **rust** (3): rust-analyzer.runSingle, rust-analyzer.debugSingle, rust-analyzer.showReferences",
			"",
			"## Unavailable on the generating host",
			"",
			"- clangd",
			"",
		];
		const prior = priorLines.join("\n");
		const freshLines = [
			"# doc",
			"",
			tableBlock(NEW_HEADER, [["ast-grep", "push-only", "·", "·", "1"]]),
			"",
			"## Raw advertised capability keys",
			"",
			"- **ast-grep**: codeActionProvider",
			"",
			"## Advertised executeCommand allowlists",
			"",
			"- **ast-grep** (1): ast-grep.applyAllFixes",
			"",
			"## Unavailable on the generating host",
			"",
			"- rust-analyzer",
			"- intelephense",
			"",
		];
		const fresh = freshLines.join("\n");

		const { text, preservedCount } = mergeServerCapabilitiesDoc(prior, fresh);
		expect(preservedCount).toBe(2); // php + rust rows preserved

		expect(text).toContain("- **php**: definitionProvider, hoverProvider");
		expect(text).toContain(
			"- **rust**: callHierarchyProvider, definitionProvider",
		);
		expect(text).toContain(
			"- **rust** (3): rust-analyzer.debugSingle, rust-analyzer.runSingle, rust-analyzer.showReferences",
		);
		// the host-truth "Unavailable" section is untouched (regenerated as-is)
		expect(text).toContain("- rust-analyzer");
		expect(text).toContain("- intelephense");
		expect(text).not.toContain("- clangd");
	});

	it("keeps preserved rows and bullets in locale-independent order", () => {
		// Recurrence #3342/#390: locale-sensitive preserved-value sorting made
		// identical nightly inputs produce different documentation bytes.
		const prior = [
			"# doc",
			"",
			tableBlock(OLD_HEADER, [
				["ä", "pull", "✓", "0"],
				["z", "pull", "✓", "0"],
			]),
			"",
			"## Raw advertised capability keys",
			"",
			"- **ä**: oldKey",
			"- **z**: oldKey",
			"",
			"## Advertised executeCommand allowlists",
			"",
			"- **ä** (1): old.command",
			"- **z** (1): old.command",
			"",
		].join("\n");
		const fresh = [
			"# doc",
			"",
			tableBlock(OLD_HEADER, [["z", "pull", "✓", "1"]]),
			"",
			"## Raw advertised capability keys",
			"",
			"- **z**: freshKey",
			"",
			"## Advertised executeCommand allowlists",
			"",
			"- **z** (1): fresh.command",
			"",
		].join("\n");

		const { text } = mergeServerCapabilitiesDoc(prior, fresh);
		const lines = text.split("\n");
		expect(lines.indexOf("| z | pull | ✓ | 1 |")).toBeLessThan(
			lines.indexOf("| ä | pull | ✓ | 0 |"),
		);
		expect(lines.indexOf("- **z**: freshKey")).toBeLessThan(
			lines.indexOf("- **ä**: oldKey"),
		);
		expect(lines.indexOf("- **z** (1): fresh.command")).toBeLessThan(
			lines.indexOf("- **ä** (1): old.command"),
		);
	});

	it("(d) captured-this-run servers always win over prior rows", () => {
		const prior = makeDoc(OLD_HEADER, [["go", "push-only", "·", "0"]], {
			go: "(none reported)",
		});
		// This run DID capture go, with different (fresher) values.
		const fresh = makeDoc(OLD_HEADER, [["go", "push-only", "✓", "46"]], {
			go: "definitionProvider, hoverProvider",
		});

		const { text } = mergeServerCapabilitiesDoc(prior, fresh);
		const tbl = parseTable(text, "| server | mode | def |")!;
		expect(tbl.rows.find((r) => r[0] === "go")).toEqual([
			"go",
			"push-only",
			"✓",
			"46",
		]);
		expect(text).toContain("- **go**: definitionProvider, hoverProvider");
		expect(text).not.toContain("- **go**: (none reported)");
	});

	it("(e) unparseable prior doc → fresh doc written, no throw", () => {
		const prior = "not a markdown table at all, just prose.\n";
		const fresh = makeDoc(NEW_HEADER, [["go", "push-only", "·", "✓", "46"]], {
			go: "definitionProvider",
		});
		let result: ReturnType<typeof mergeServerCapabilitiesDoc> | undefined;
		expect(() => {
			result = mergeServerCapabilitiesDoc(prior, fresh);
		}).not.toThrow();
		expect(result!.text).toBe(fresh);
		expect(result!.preservedCount).toBe(0);
	});

	it("also fails open when the FRESH text's table is unparseable (defensive)", () => {
		const prior = makeDoc(OLD_HEADER, [["go", "push-only", "✓", "46"]], {
			go: "definitionProvider",
		});
		const fresh = "no table here either\n";
		const result = mergeServerCapabilitiesDoc(prior, fresh);
		expect(result.text).toBe(fresh);
		expect(result.preservedCount).toBe(0);
	});
});

describe("textDocumentSync.save column (#3407)", () => {
	const render = (rows: Array<Record<string, unknown>>) =>
		renderServerCapabilitiesDoc({
			rows: rows.map((row) => ({
				workspaceDiagnosticsSupport: { mode: "push-only" },
				operationSupport: {},
				advertisedCommands: [],
				rawCapabilityKeys: [],
				...row,
			})) as never,
			unavailable: new Set<string>(),
			date: "2026-09-25",
			platform: "linux",
			ops: OPS,
		});
	const saveCells = (text: string) => {
		const table = parseTable(text, "| server | mode |");
		const saveIdx = table!.header.indexOf("save");
		const serverIdx = table!.header.indexOf("server");
		return Object.fromEntries(
			table!.rows.map((cells) => [cells[serverIdx], cells[saveIdx]]),
		);
	};

	it("renders each save shape, and an unreported one as unknown", () => {
		expect(
			saveCells(
				render([
					{ serverId: "expert", textDocumentSave: "save" },
					{ serverId: "fsharp", textDocumentSave: "save+text" },
					{ serverId: "vue", textDocumentSave: "none" },
					{ serverId: "old-client" },
				]),
			),
		).toEqual({
			expert: "save",
			fsharp: "save+text",
			vue: "·",
			"old-client": "?",
		});
	});

	it("carries a row captured before the column existed as unknown, not as declaring none", () => {
		const prior = [
			"| server | mode | ws-pull | def | hov | cmds |",
			"|---|---|---|---|---|---|",
			"| jdtls | push-only | · | ✓ | ✓ | 3 |",
			"",
		].join("\n");
		const fresh = render([{ serverId: "expert", textDocumentSave: "save" }]);
		const { text } = mergeServerCapabilitiesDoc(prior, fresh);
		expect(saveCells(text)).toEqual({ expert: "save", jdtls: "?" });
	});
});
