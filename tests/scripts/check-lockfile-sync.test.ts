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
		dependencies: { demo: "^1.0.0" },
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
				dependencies: { demo: "^1.0.0" },
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
