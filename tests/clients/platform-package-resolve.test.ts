import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	resolvePlatformPackageBinary,
	TOOLS,
} from "../../clients/installer/index.js";

const tool = (id: string) => {
	const t = TOOLS.find((x) => x.id === id);
	if (!t) throw new Error(`tool ${id} not found`);
	return t;
};

const supported = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
	"win32-arm64",
]).has(`${process.platform}-${process.arch}`);

describe("resolvePlatformPackageBinary", () => {
	it("declares platformPackage on the npm platform-CLI tools", () => {
		expect(tool("ast-grep").platformPackage).toBeDefined();
		expect(tool("biome").platformPackage).toBeDefined();
		// pure-JS / non-platform tools must NOT declare it
		expect(tool("knip").platformPackage).toBeUndefined();
		expect(tool("typescript").platformPackage).toBeUndefined();
	});

	it("invariant: platformPackage only on npm-strategy tools (it's an npm-only concept)", () => {
		const offenders = TOOLS.filter(
			(t) => t.platformPackage && t.installStrategy !== "npm",
		).map((t) => `${t.id} (${t.installStrategy})`);
		expect(offenders).toEqual([]);
	});

	it("invariant: every platformPackage tool has a packageName + binaries + suffixes", () => {
		for (const t of TOOLS.filter((x) => x.platformPackage)) {
			expect(t.packageName, t.id).toBeTruthy();
			expect(t.platformPackage?.binaries.length, t.id).toBeGreaterThan(0);
			expect(
				Object.keys(t.platformPackage?.suffixes ?? {}).length,
				t.id,
			).toBeGreaterThan(0);
		}
	});

	it.runIf(supported)(
		"resolves the native ast-grep binary directly (the package that ships it is a runtime dep)",
		() => {
			const bin = resolvePlatformPackageBinary(tool("ast-grep"));
			// @ast-grep/cli-<platform> is installed here (runtime dep), so it resolves.
			expect(bin).toBeTruthy();
			expect(existsSync(bin as string)).toBe(true);
			expect(bin).toMatch(/@ast-grep[/\\]cli-/);
		},
	);

	it("returns undefined for a tool without a platformPackage spec", () => {
		expect(resolvePlatformPackageBinary(tool("knip"))).toBeUndefined();
	});

	it("returns undefined when the platform is unsupported by the spec", () => {
		const fake = {
			...tool("ast-grep"),
			platformPackage: { suffixes: {}, binaries: ["ast-grep"] },
		};
		expect(resolvePlatformPackageBinary(fake)).toBeUndefined();
	});
});
