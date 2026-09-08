import { describe, expect, it } from "vitest";
import {
	runAdvisory,
	validateTypeAwareDependency,
} from "../../scripts/lint-js-advisory.mjs";

const packageFiles = {
	"oxlint/package.json": {
		name: "oxlint",
		version: "1.81.0",
		peerDependencies: { "oxlint-tsgolint": ">=7.0.2001" },
	},
	"oxlint-tsgolint/package.json": {
		name: "oxlint-tsgolint",
		version: "7.0.2001",
		bin: { tsgolint: "bin/tsgolint.js" },
	},
};

function resolver(name: string) {
	const key = name.replace(/\/package\.json$/, "");
	if (!Object.hasOwn(packageFiles, name)) throw new Error(`missing ${key}`);
	return `/tmp/${key}/package.json`;
}

function readPackage(file: string) {
	return packageFiles[
		file
			.replace(/^\/tmp\//, "")
			.replace(/\/package\.json$/, "/package.json") as keyof typeof packageFiles
	];
}

describe("lint:js:advisory preflight (#2709)", () => {
	it("fails through the wrapper when the optional peer is shadowed off the path", () => {
		// Regression for #2709: oxlint accepts --type-aware without its peer and
		// reports zero rules, silently converting this tier into an untyped run.
		const result = validateTypeAwareDependency({
			resolve: (name: string) => {
				if (name === "oxlint-tsgolint/package.json") throw new Error("absent");
				return resolver(name);
			},
			readPackage,
		});
		const exitCode = runAdvisory({
			resolve: (name: string) => {
				if (name === "oxlint-tsgolint/package.json") throw new Error("absent");
				return resolver(name);
			},
			readPackage,
			spawn: () => {
				throw new Error("oxlint must not spawn after a failed preflight");
			},
		});
		expect(result.ok).toBe(false);
		expect(result.message).toBe(
			"oxlint advisory: oxlint-tsgolint is not installed (peer of oxlint 1.81.0); the type-aware tier would silently run untyped",
		);
		expect(exitCode).toBe(2);
	});

	it("rejects a tsgolint version below oxlint's declared peer range", () => {
		const result = validateTypeAwareDependency({
			resolve: resolver,
			readPackage: (file: string) =>
				file.includes("tsgolint")
					? {
							...packageFiles["oxlint-tsgolint/package.json"],
							version: "7.0.2000",
						}
					: readPackage(file),
			fileExists: () => true,
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("does not satisfy oxlint");
		expect(result.message).toContain(">=7.0.2001");
	});

	it("checks the real npm script wiring and passes oxlint's exit code through", async () => {
		const pkg = await import("../../package.json", { with: { type: "json" } });
		const script = pkg.default.scripts["lint:js:advisory"];
		expect(script).toMatch(
			/^node scripts\/lint-js-advisory\.mjs\s+--deny-warnings/,
		);
		const spawned: string[][] = [];
		const exitCode = runAdvisory({
			resolve: resolver,
			readPackage,
			fileExists: () => true,
			args: ["--type-aware"],
			spawn: (_command: string, args: string[]) => {
				spawned.push(args);
				return { status: 7 };
			},
		});
		expect(spawned).toEqual([["--type-aware"]]);
		expect(exitCode).toBe(7);
	});
});
