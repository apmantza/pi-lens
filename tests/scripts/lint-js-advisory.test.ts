import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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
	[`@oxlint-tsgolint/${process.platform}-${process.arch}/package.json`]: {
		name: `@oxlint-tsgolint/${process.platform}-${process.arch}`,
	},
};

function resolver(name: string) {
	const key = name.replace(/\/package\.json$/, "");
	if (name.endsWith(`/tsgolint${process.platform === "win32" ? ".exe" : ""}`)) {
		return `/tmp/${name}`;
	}
	if (!Object.hasOwn(packageFiles, name)) throw new Error(`missing ${key}`);
	return `/tmp/${key}/package.json`;
}

function readPackage(file: string) {
	return packageFiles[
		file.replace(/^\/tmp\//, "") as keyof typeof packageFiles
	];
}

function writePackage(
	root: string,
	name: string,
	packageJson: Record<string, unknown>,
) {
	const directory = join(root, "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
	return directory;
}

function realTree(tsgolintVersion: string | null, withPlatformBinary = true) {
	mkdirSync(join(process.cwd(), ".probe-home"), { recursive: true });
	const root = mkdtempSync(join(process.cwd(), ".probe-home", "tsgolint-"));
	writePackage(root, "oxlint", {
		name: "oxlint",
		version: "1.81.0",
		peerDependencies: { "oxlint-tsgolint": ">=7.0.2001" },
	});
	if (tsgolintVersion !== null) {
		const tsgolintDirectory = writePackage(root, "oxlint-tsgolint", {
			name: "oxlint-tsgolint",
			version: tsgolintVersion,
			bin: { tsgolint: "bin/tsgolint.js" },
		});
		mkdirSync(join(tsgolintDirectory, "bin"), { recursive: true });
		writeFileSync(join(tsgolintDirectory, "bin/tsgolint.js"), "");
	}
	const platformDirectory = writePackage(
		root,
		`@oxlint-tsgolint/${process.platform}-${process.arch}`,
		{ name: `@oxlint-tsgolint/${process.platform}-${process.arch}` },
	);
	if (withPlatformBinary) {
		writeFileSync(
			join(
				platformDirectory,
				`tsgolint${process.platform === "win32" ? ".exe" : ""}`,
			),
			"",
		);
	}
	return root;
}

function realRequireFactory(root: string) {
	const nodeRequire = createRequire(join(root, "package.json"));
	return {
		resolve(name: string) {
			const resolved = nodeRequire.resolve(name);
			if (!resolved.startsWith(root))
				throw new Error(`outside test tree: ${resolved}`);
			return resolved;
		},
	};
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

	it("uses real resolution when the optional peer is absent", () => {
		// Regression for #2709: the real Node resolution path must not let an
		// absent peer turn a type-aware run into an untyped run.
		const root = realTree(null);
		const result = runAdvisory({
			resolveBase: root,
			requireFactory: realRequireFactory(root),
			spawn: () => {
				throw new Error("oxlint must not spawn after a failed preflight");
			},
		});
		expect(result).toBe(2);
	});

	it("uses real resolution when the peer version is out of range", () => {
		const root = realTree("7.0.1000");
		const result = validateTypeAwareDependency({
			resolveBase: root,
			requireFactory: realRequireFactory(root),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("7.0.1000");
		expect(result.message).toContain(">=7.0.2001");
	});

	it("accepts the real peer and platform package", () => {
		const root = realTree("7.0.2001");
		const result = validateTypeAwareDependency({
			resolveBase: root,
			requireFactory: realRequireFactory(root),
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a real peer when its platform package is absent", () => {
		const root = realTree("7.0.2001", false);
		const result = validateTypeAwareDependency({
			resolveBase: root,
			requireFactory: realRequireFactory(root),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("has no binary for");
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
