/**
 * #3038: the real FormatService path must not amplify inferred indentation.
 * The process boundary is the only mocked seam; formatter loading, selection,
 * command resolution, and formatFile remain in-process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { FormatService } from "../../clients/format-service.js";
import { clearFormatterRuntimeState } from "../../clients/formatters.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { setupTestEnvironment } from "./test-utils.js";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
// #2281 vi-mock export ratchet: spread the real module so a new safe-spawn
// export cannot silently vanish from this double. The two overrides below stay
// explicit — the test must never reach a real PATH probe or a real ambient
// signal.
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
	safeSpawn: vi.fn(),
	getAmbientAbortSignal: () => undefined,
	isCommandAvailableAsync: async () => false,
}));

function writeBiomeEvidence(root: string): void {
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.0.0" } }),
	);
	fs.writeFileSync(
		path.join(root, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: { "node_modules/@biomejs/biome": { version: "2.0.0" } },
		}),
	);
	const bin = path.join(
		root,
		"node_modules",
		".bin",
		process.platform === "win32" ? "biome.cmd" : "biome",
	);
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.writeFileSync(bin, "mock biome\n");
	if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
}

const fixture = [
	"function values() {",
	"  return [",
	"      1,",
	"      2,",
	"      3,",
	"      4,",
	"      5,",
	"      6,",
	"      7,",
	"      8,",
	"      9,",
	"      10,",
	"  ];",
	"}",
	"",
].join("\n");

/** A 2-space module carrying the doc comment that #3039 F1 mis-read. */
const docCommented = [
	"/**",
	" * Adds two numbers.",
	" * @param a the first addend",
	" * @param b the second addend",
	" */",
	"export function add(a: number, b: number): number {",
	"  const sum = a + b;",
	"  if (sum > 0) {",
	"    return sum;",
	"  }",
	"  return 0;",
	"}",
	"",
].join("\n");

/** A tab-indented module carrying the doc comment that #3039 F2 mis-read. */
const tabDocCommented = [
	"/**",
	" * Adds two numbers.",
	" * @param a the first addend",
	" * @param b the second addend",
	" * @returns the sum, or zero",
	" */",
	"export function add(a: number, b: number): number {",
	"\tconst sum = a + b;",
	"\tif (sum > 0) {",
	"\t\treturn sum;",
	"\t}",
	"\treturn 0;",
	"}",
	"",
].join("\n");

/**
 * Re-indent the way `biome format --indent-style space --indent-width N` does:
 * a line's structural depth is its leading run divided by the unit the file is
 * currently written in, and block-comment continuations sit one column past
 * their opener's indent. The double must honor `--indent-width`, or a detector
 * that pins the wrong width would look inert.
 */
function reindentAsBiome(content: string, width: number, unit: number): string {
	const out: string[] = [];
	let inBlock = false;
	for (const line of content.split("\n")) {
		const leading = /^ */.exec(line)?.[0].length ?? 0;
		const rest = line.slice(leading);
		if (rest === "") {
			out.push("");
			continue;
		}
		if (inBlock) {
			out.push(" ".repeat(Math.floor((leading - 1) / unit) * width + 1) + rest);
			if (rest.includes("*/")) inBlock = false;
			continue;
		}
		out.push(" ".repeat(Math.floor(leading / unit) * width) + rest);
		if (rest.startsWith("/*") && !rest.includes("*/")) inBlock = true;
	}
	return out.join("\n");
}

describe("formatter indentation inference through FormatService (#3038)", () => {
	beforeEach(() => {
		// This suite witnesses indentation inference, not the trust gate; local
		// rungs are planted on purpose and the gate is covered elsewhere.
		setProjectTrustState("trusted");
		safeSpawnAsync.mockReset();
		clearFormatterRuntimeState();
		resetDegradationLedger();
	});

	it("keeps a no-config TypeScript fixture byte-identical on the second run", async () => {
		const env = setupTestEnvironment("pi-lens-format-indent-");
		try {
			writeBiomeEvidence(env.tmpDir);
			const filePath = path.join(env.tmpDir, "values.ts");
			fs.writeFileSync(filePath, fixture);
			const argv: string[][] = [];
			safeSpawnAsync.mockImplementation(
				async (_command: string, args: string[]) => {
					argv.push(args);
					const width = Number(args[args.indexOf("--indent-width") + 1]);
					const current = fs.readFileSync(filePath, "utf8");
					fs.writeFileSync(
						filePath,
						current.replace(/^( +)(?=\S)/gm, (spaces) =>
							" ".repeat((spaces.length / 2) * width),
						),
					);
					return { status: 0, stdout: "", stderr: "" };
				},
			);

			const service = new FormatService("format-indent", true);
			service.recordRead(filePath);
			await service.formatFile(filePath);
			const afterFirst = fs.readFileSync(filePath, "utf8");
			await service.formatFile(filePath);

			expect(argv).toHaveLength(2);
			expect(argv[0]).toEqual(argv[1]);
			expect(fs.readFileSync(filePath, "utf8")).toBe(afterFirst);
		} finally {
			env.cleanup();
		}
	});

	it("pins the structural unit for aligned continuation indentation", async () => {
		const env = setupTestEnvironment("pi-lens-format-indent-continuation-");
		try {
			writeBiomeEvidence(env.tmpDir);
			const filePath = path.join(env.tmpDir, "continuation.ts");
			fs.writeFileSync(
				filePath,
				"const value = call(\n      first,\n      second,\n    );\n",
			);
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const service = new FormatService("format-indent-continuation", true);
			service.recordRead(filePath);
			await service.formatFile(filePath);

			expect(safeSpawnAsync.mock.calls[0]?.[1]).toEqual(
				expect.arrayContaining(["--indent-width", "2"]),
			);
		} finally {
			env.cleanup();
		}
	});

	it("declines formatter style for ambiguous nested-only indentation", async () => {
		const env = setupTestEnvironment("pi-lens-format-indent-ambiguous-");
		try {
			writeBiomeEvidence(env.tmpDir);
			const filePath = path.join(env.tmpDir, "nested-only.ts");
			fs.writeFileSync(filePath, "      nested\n            deeper\n");

			const service = new FormatService("format-indent-ambiguous", true);
			service.recordRead(filePath);
			const summary = await service.formatFile(filePath);

			expect(summary.formatters).toEqual([
				expect.objectContaining({ name: "biome", outcome: "skipped" }),
			]);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
			// Recurrence this pins (#3038): the ambiguity refusal was invisible —
			// the file simply came back unformatted with no session record saying
			// why. One bounded row per tool, keyed by the tool and not the path.
			expect(getDegradationSummary()).toEqual([
				expect.objectContaining({
					kind: "formatter-skip",
					count: 1,
					latestReasons: [expect.objectContaining({ subject: "biome" })],
				}),
			]);
		} finally {
			env.cleanup();
		}
	});

	it("declines when block-comment interiors are the only indentation evidence (#3161)", async () => {
		const env = setupTestEnvironment("pi-lens-format-indent-masked-");
		try {
			writeBiomeEvidence(env.tmpDir);
			const filePath = path.join(env.tmpDir, "comment-only.ts");
			fs.writeFileSync(
				filePath,
				[
					"/**",
					" * only comment indentation",
					" */",
					"export const x = 1;",
					"",
				].join("\n"),
			);
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const service = new FormatService("format-indent-masked", true);
			service.recordRead(filePath);
			const summary = await service.formatFile(filePath);

			expect(summary.formatters).toEqual([
				expect.objectContaining({ name: "biome", outcome: "skipped" }),
			]);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
			expect(getDegradationSummary()).toEqual([
				expect.objectContaining({
					kind: "formatter-skip",
					count: 1,
					latestReasons: [expect.objectContaining({ subject: "biome" })],
				}),
			]);
		} finally {
			env.cleanup();
		}
	});

	it("honors an ancestor editorconfig through the selected formatter", async () => {
		const env = setupTestEnvironment("pi-lens-format-indent-config-");
		try {
			writeBiomeEvidence(env.tmpDir);
			fs.writeFileSync(path.join(env.tmpDir, ".editorconfig"), "root = true\n");
			const nested = path.join(env.tmpDir, "packages", "app");
			fs.mkdirSync(nested, { recursive: true });
			const filePath = path.join(nested, "values.ts");
			fs.writeFileSync(filePath, fixture);
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const service = new FormatService("format-indent-config", true);
			service.recordRead(filePath);
			await service.formatFile(filePath);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				expect.any(String),
				expect.arrayContaining(["--use-editorconfig=true"]),
				expect.anything(),
			);
			expect(safeSpawnAsync.mock.calls[0]?.[1]).not.toContain("--indent-width");
		} finally {
			env.cleanup();
		}
	});

	it("keeps a doc-commented 2-space file byte-identical across three passes", async () => {
		// Recurrence this pins (#3039 F1): the block comment's ` * ` continuation
		// lines are indented one column, and `/**` sits at column 0, so the
		// structural-boundary check certified width 1 and the first pass rewrote
		// every doc-commented 2- and 4-space file in the repository.
		const env = setupTestEnvironment("pi-lens-format-indent-doc-");
		try {
			writeBiomeEvidence(env.tmpDir);
			const filePath = path.join(env.tmpDir, "add.ts");
			fs.writeFileSync(filePath, docCommented);
			const argv: string[][] = [];
			let unit = 2;
			safeSpawnAsync.mockImplementation(
				async (_command: string, args: string[]) => {
					argv.push(args);
					const width = Number(args[args.indexOf("--indent-width") + 1]);
					const current = fs.readFileSync(filePath, "utf8");
					fs.writeFileSync(filePath, reindentAsBiome(current, width, unit));
					unit = width;
					return { status: 0, stdout: "", stderr: "" };
				},
			);

			const service = new FormatService("format-indent-doc", true);
			for (let pass = 0; pass < 3; pass++) {
				service.recordRead(filePath);
				await service.formatFile(filePath);
				expect(fs.readFileSync(filePath, "utf8")).toBe(docCommented);
			}

			expect(argv).toHaveLength(3);
			for (const args of argv) {
				expect(args).toEqual(
					expect.arrayContaining([
						"--indent-style",
						"space",
						"--indent-width",
						"2",
					]),
				);
			}
		} finally {
			env.cleanup();
		}
	});

	it("keeps tab style for a tab file carrying a top-level doc comment", async () => {
		// Recurrence this pins (#3039 F2): the six 1-space comment continuation
		// lines outnumbered the tab-indented lines, so the space-majority branch
		// won and a tab-indented file was pinned to two spaces.
		const env = setupTestEnvironment("pi-lens-format-indent-tabdoc-");
		try {
			writeBiomeEvidence(env.tmpDir);
			const filePath = path.join(env.tmpDir, "tabbed.ts");
			fs.writeFileSync(filePath, tabDocCommented);
			safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });

			const service = new FormatService("format-indent-tabdoc", true);
			service.recordRead(filePath);
			await service.formatFile(filePath);

			expect(safeSpawnAsync.mock.calls[0]?.[1]).toEqual(
				expect.arrayContaining(["--indent-style", "tab"]),
			);
			expect(fs.readFileSync(filePath, "utf8")).toBe(tabDocCommented);
		} finally {
			env.cleanup();
		}
	});
});
