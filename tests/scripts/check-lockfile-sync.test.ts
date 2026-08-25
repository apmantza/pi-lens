import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CHECKER = path.join(REPO_ROOT, "scripts/check-lockfile-sync.mjs");
const RELEASE = path.join(REPO_ROOT, "scripts/changelog-release.mjs");
const tempDirs: string[] = [];

function fixtureRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lockfile-2043-"));
	tempDirs.push(root);
	const pkg = {
		name: "pi-lens",
		version: "4.1.2",
		license: "MIT",
		bin: { alpha: "dist/alpha.js", beta: "dist/beta.js" },
		engines: { node: ">=22" },
		os: ["linux"],
		cpu: ["x64"],
		libc: ["glibc"],
		funding: { type: "individual", url: "https://example.test" },
		bundleDependencies: ["demo"],
		dependencies: { demo: "^1.0.0" },
		peerDependencies: { peer: "^1.0.0" },
		peerDependenciesMeta: { peer: { optional: true } },
	};
	const lock = {
		name: "pi-lens",
		version: "4.1.2",
		lockfileVersion: 3,
		requires: true,
		packages: {
			"": {
				name: "pi-lens",
				version: "4.1.2",
				license: "MIT",
				bin: { beta: "dist/beta.js", alpha: "dist/alpha.js" },
				engines: { node: ">=22" },
				os: ["linux"],
				cpu: ["x64"],
				libc: ["glibc"],
				funding: { type: "individual", url: "https://example.test" },
				bundleDependencies: ["demo"],
				dependencies: { demo: "^1.0.0" },
				peerDependencies: { peer: "^1.0.0" },
				peerDependenciesMeta: { peer: { optional: true } },
			},
		},
	};
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
	fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
	return { root, pkg, lock };
}

function run(script: string, cwd: string, args: string[] = []) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd,
		encoding: "utf8",
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("package-lock identity guard (#2043)", () => {
	it("checks every top-level and root-package identity mirror through the real CLI", () => {
		const identityFields = [
			["name", "package-lock.json.name"],
			["version", "package-lock.json.version"],
			["packages", 'package-lock.json.packages[""].name'],
			["rootVersion", 'package-lock.json.packages[""].version'],
		] as const;

		for (const [field, expectedMessage] of identityFields) {
			const { root, lock } = fixtureRoot();
			if (field === "name") lock.name = "different-name";
			if (field === "version") lock.version = "4.1.1";
			if (field === "packages") lock.packages[""].name = "different-name";
			if (field === "rootVersion") lock.packages[""].version = "4.1.1";
			fs.writeFileSync(
				path.join(root, "package-lock.json"),
				JSON.stringify(lock),
			);

			const result = run(CHECKER, root);
			expect(result.status, field).not.toBe(0);
			expect(result.stderr, field).toContain(expectedMessage);
			expect(result.stderr, field).toContain("Run `npm install`");
		}
	});

	it("checks every copied root metadata mirror through the real CLI", () => {
		const cases = [
			[
				"license",
				(lock: ReturnType<typeof fixtureRoot>["lock"]) => {
					lock.packages[""].license = "Apache-2.0";
				},
			],
			[
				"bin",
				(lock: ReturnType<typeof fixtureRoot>["lock"]) => {
					lock.packages[""].bin.alpha = "dist/other.js";
				},
			],
			[
				"engines",
				(lock: ReturnType<typeof fixtureRoot>["lock"]) => {
					lock.packages[""].engines.node = ">=24";
				},
			],
			[
				"os",
				(lock: ReturnType<typeof fixtureRoot>["lock"]) => {
					lock.packages[""].os[0] = "darwin";
				},
			],
			[
				"cpu",
				(lock: ReturnType<typeof fixtureRoot>["lock"]) => {
					lock.packages[""].cpu[0] = "arm64";
				},
			],
			[
				"libc",
				(lock: ReturnType<typeof fixtureRoot>["lock"]) => {
					lock.packages[""].libc[0] = "musl";
				},
			],
			[
				"funding",
				(lock: ReturnType<typeof fixtureRoot>["lock"]) => {
					lock.packages[""].funding.url = "https://other.test";
				},
			],
			[
				"bundleDependencies",
				(lock: ReturnType<typeof fixtureRoot>["lock"]) => {
					lock.packages[""].bundleDependencies[0] = "peer";
				},
			],
		] as const;

		for (const [field, mutate] of cases) {
			const { root, lock } = fixtureRoot();
			mutate(lock);
			fs.writeFileSync(
				path.join(root, "package-lock.json"),
				JSON.stringify(lock),
			);

			const result = run(CHECKER, root);
			expect(result.status, field).not.toBe(0);
			expect(result.stderr, field).toContain(`package.json.${field}`);
			expect(result.stderr, field).toContain("Run `npm install`");
		}
	});

	it("accepts npm's normalized string bin shorthand", () => {
		for (const packageName of ["pi-lens", "@scope/pi-lens"]) {
			const { root, pkg, lock } = fixtureRoot();
			const stringBinPackage = {
				...pkg,
				name: packageName,
				bin: "dist/pi-lens.js",
			};
			const normalizedLock = {
				...lock,
				name: packageName,
				packages: {
					"": {
						...lock.packages[""],
						name: packageName,
						bin: { "pi-lens": "dist/pi-lens.js" },
					},
				},
			};
			fs.writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify(stringBinPackage),
			);
			fs.writeFileSync(
				path.join(root, "package-lock.json"),
				JSON.stringify(normalizedLock),
			);

			const result = run(CHECKER, root);
			expect(result.status, packageName).toBe(0);
		}
	});

	it("accepts npm's omitted empty metadata containers and bundled alias", () => {
		const { root, pkg, lock } = fixtureRoot();
		const packageCopy = JSON.parse(JSON.stringify(pkg));
		packageCopy.bin = {};
		packageCopy.engines = {};
		packageCopy.funding = [];
		packageCopy.os = [];
		packageCopy.cpu = [];
		packageCopy.libc = [];
		packageCopy.bundleDependencies = [];
		packageCopy.bundledDependencies = packageCopy.bundleDependencies;
		delete packageCopy.bundleDependencies;
		const lockCopy = JSON.parse(JSON.stringify(lock));
		for (const field of [
			"bin",
			"engines",
			"funding",
			"os",
			"cpu",
			"libc",
			"bundleDependencies",
		]) {
			delete lockCopy.packages[""][field];
		}
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify(packageCopy),
		);
		fs.writeFileSync(
			path.join(root, "package-lock.json"),
			JSON.stringify(lockCopy),
		);

		const result = run(CHECKER, root);
		expect(result.status).toBe(0);
	});

	it("checks the peer optionality policy mirror through the real CLI", () => {
		const { root, lock } = fixtureRoot();
		lock.packages[""].peerDependenciesMeta.peer.optional = false;
		fs.writeFileSync(
			path.join(root, "package-lock.json"),
			JSON.stringify(lock),
		);

		const result = run(CHECKER, root);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("peerDependenciesMeta");
		expect(result.stderr).toContain("Run `npm install`");
	});

	it("rejects malformed JSON roots without an exception stack", () => {
		for (const file of ["package.json", "package-lock.json"]) {
			const { root } = fixtureRoot();
			fs.writeFileSync(path.join(root, file), "null");

			const result = run(CHECKER, root);
			expect(result.status, file).not.toBe(0);
			expect(result.stderr, file).toContain(
				`${file} root must be a JSON object`,
			);
			expect(result.stderr, file).not.toContain("TypeError");
		}
	});

	it("accepts matching identity and dependency maps through the real CLI", () => {
		const { root } = fixtureRoot();
		const result = run(CHECKER, root);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("package-lock.json is in sync");
	});

	it("fails the release preflight atomically before changing changelog state", () => {
		const { root, lock } = fixtureRoot();
		lock.version = "4.1.1";
		fs.writeFileSync(
			path.join(root, "package-lock.json"),
			JSON.stringify(lock),
		);
		fs.mkdirSync(path.join(root, ".changelog"));
		fs.writeFileSync(
			path.join(root, "CHANGELOG.md"),
			"# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- pending\n",
		);
		const fragment = path.join(root, ".changelog", "pending.md");
		fs.writeFileSync(fragment, "---\nsection: Fixed\n---\n\n- pending\n");
		const beforeChangelog = fs.readFileSync(
			path.join(root, "CHANGELOG.md"),
			"utf8",
		);
		const beforeFragment = fs.readFileSync(fragment, "utf8");

		const result = run(RELEASE, root, ["--root-dir", root]);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("package.json.version");
		expect(result.stderr).toContain("package-lock.json.version");
		expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(
			beforeChangelog,
		);
		expect(fs.readFileSync(fragment, "utf8")).toBe(beforeFragment);
		expect(fs.existsSync(fragment)).toBe(true);
	});

	it("runs the release CLI successfully after the preflight passes", () => {
		const { root } = fixtureRoot();
		fs.mkdirSync(path.join(root, ".changelog"));
		fs.writeFileSync(
			path.join(root, "CHANGELOG.md"),
			"# Changelog\n\n## [Unreleased]\n\n",
		);
		fs.writeFileSync(
			path.join(root, ".changelog", "pending.md"),
			"---\nsection: Fixed\n---\n\n- pending\n",
		);

		const result = run(RELEASE, root, ["--root-dir", root]);

		expect(result.status).toBe(0);
		expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain(
			"- pending",
		);
		expect(fs.existsSync(path.join(root, ".changelog", "pending.md"))).toBe(
			false,
		);
	});
});
