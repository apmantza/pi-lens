/**
 * Tests for buildMadgeArgs — the madge circular-dependency argv builder.
 *
 * Guards the two correctness levers added in the tool-utilization audit:
 *   - mjs/cjs extensions are always scanned
 *   - `--ts-config` is passed iff a tsconfig.json exists at the project root
 *     (so TS path-alias imports resolve and alias-routed cycles aren't missed)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildMadgeArgs,
	parseMadgeSkips,
} from "../../clients/dependency-checker.js";

describe("buildMadgeArgs", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-madge-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("always scans mjs/cjs alongside ts/tsx/js/jsx", () => {
		const args = buildMadgeArgs(tmp, tmp);
		const ext = args[args.indexOf("--extensions") + 1];
		expect(ext.split(",")).toEqual(
			expect.arrayContaining(["mjs", "cjs", "ts", "tsx", "js", "jsx"]),
		);
		expect(args).toContain("--circular");
		expect(args[args.length - 1]).toBe(tmp); // target is last
	});

	it("passes --ts-config when tsconfig.json exists at the root", () => {
		const tsconfig = path.join(tmp, "tsconfig.json");
		fs.writeFileSync(tsconfig, "{}");
		const args = buildMadgeArgs(tmp, tmp);
		expect(args).toContain("--ts-config");
		expect(args[args.indexOf("--ts-config") + 1]).toBe(tsconfig);
	});

	it("omits --ts-config for a non-TS project (no tsconfig)", () => {
		const args = buildMadgeArgs(tmp, tmp);
		expect(args).not.toContain("--ts-config");
	});

	it("requests --warning so skipped files aren't silent", () => {
		expect(buildMadgeArgs(tmp, tmp)).toContain("--warning");
	});
});

describe("parseMadgeSkips", () => {
	const STDERR = [
		"- Finding files",
		"Processed 1125 files (8.2s) (8 warnings)",
		"",
		"✔ No circular dependency found!",
		"",
		"✖ Skipped 8 files",
		"",
		"vscode-jsonrpc/node",
		"web-tree-sitter",
		"vitest/config",
		"./test-utils.js",
		"../shared/helpers.ts",
	].join("\n");

	it("counts total skips and isolates LOCAL ones (external are expected)", () => {
		const { total, local } = parseMadgeSkips(STDERR);
		expect(total).toBe(8);
		// only relative/absolute specifiers are flagged; bare packages are not
		expect(local).toEqual(["./test-utils.js", "../shared/helpers.ts"]);
	});

	it("returns zero when madge reports no skips", () => {
		expect(parseMadgeSkips("✔ No circular dependency found!\n")).toEqual({
			total: 0,
			local: [],
		});
		expect(parseMadgeSkips("")).toEqual({ total: 0, local: [] });
	});
});
