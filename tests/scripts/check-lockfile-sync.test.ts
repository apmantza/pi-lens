// flake-shape: real-process-spawn — the guard reads the committed lock through
// a real `git show`, so its regression cases drive a real repository.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { envFor, gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";

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

function run(
	script: string,
	cwd: string,
	args: string[] = [],
	env?: NodeJS.ProcessEnv,
) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd,
		encoding: "utf8",
		...(env ? { env } : {}),
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
		fs.writeFileSync(
			fragment,
			"---\nsection: Fixed\naudience: user\n---\n\n- pending\n",
		);
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
			"---\nsection: Fixed\naudience: user\n---\n\n- pending\n",
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

// #5207. npm 9.2 on the maintainer host does not know the lockfile's `libc`
// field, so `npm install --package-lock-only` under it rewrote all 56 entries
// of #5200's lock without the field and nothing failed. The guard compares the
// working lock against the committed one — the state the pre-commit hook sees —
// and refuses a drop that no resolved version explains.
describe("package-lock libc drift guard (#5207)", () => {
	const PKG = {
		name: "pi-lens",
		version: "4.1.2",
		packageManager: "npm@11.18.0",
	};
	const libcLock = (
		entries: Record<string, { version: string; libc?: string[] }>,
	) => ({
		name: PKG.name,
		version: PKG.version,
		lockfileVersion: 3,
		requires: true,
		packages: {
			"": { name: PKG.name, version: PKG.version },
			...Object.fromEntries(
				Object.entries(entries).map(([key, entry]) => [
					`node_modules/${key}`,
					entry,
				]),
			),
		},
	});
	const GLYDE = { version: "4.52.4", libc: ["glibc"] };

	// One shared `git` call site keeps the file's pinned real-spawn count while
	// every case needs its own committed lock (#4867: a real git fixture lives
	// under the git-ignored `.probe-home`, never at the checkout root).
	function probeGit(args: string[], cwd: string) {
		return String(gitExecFileSync(args, { cwd }));
	}

	function committedRepo(headLock: unknown | null) {
		const root = fs.mkdtempSync(
			path.join(REPO_ROOT, ".probe-home", "lockfile-libc-"),
		);
		tempDirs.push(root);
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(PKG));
		if (headLock !== null)
			fs.writeFileSync(
				path.join(root, "package-lock.json"),
				typeof headLock === "string" ? headLock : JSON.stringify(headLock),
			);
		probeGit(["init", "-q", "-b", "fixture-lock"], root);
		probeGit(["add", "."], root);
		probeGit(
			[
				"-c",
				"user.email=pi-lens-test@example.com",
				"-c",
				"user.name=pi-lens-test",
				"commit",
				"-qm",
				"fixture",
			],
			root,
		);
		return root;
	}

	// A repository git refuses to read, with an error the gate has no absence
	// form for: the shared-checkout `safe.directory` refusal (Greptile's thread
	// on #5213) in a form a fixture can produce without a foreign owner.
	function breakRepository(root: string) {
		fs.appendFileSync(
			path.join(root, ".git", "config"),
			"[core]\n\trepositoryFormatVersion = 99\n",
		);
	}

	function check(
		root: string,
		workingLock: unknown | null,
		args: string[] = [],
	) {
		if (workingLock === null)
			fs.rmSync(path.join(root, "package-lock.json"), { force: true });
		else
			fs.writeFileSync(
				path.join(root, "package-lock.json"),
				JSON.stringify(workingLock),
			);
		return run(CHECKER, root, args, envFor(root));
	}

	// Git stages before it runs `pre-commit`, so the blob the commit records is
	// the index, not the file on disk (#5213 F1).
	function stage(root: string, lock: unknown) {
		fs.writeFileSync(
			path.join(root, "package-lock.json"),
			JSON.stringify(lock),
		);
		probeGit(["add", "package-lock.json"], root);
	}

	function writeWorking(root: string, lock: unknown) {
		fs.writeFileSync(
			path.join(root, "package-lock.json"),
			JSON.stringify(lock),
		);
	}

	function commit(root: string, message: string) {
		probeGit(["add", "-A"], root);
		probeGit(
			[
				"-c",
				"user.email=pi-lens-test@example.com",
				"-c",
				"user.name=pi-lens-test",
				"commit",
				"-qm",
				message,
			],
			root,
		);
		return probeGit(["rev-parse", "HEAD"], root).trim();
	}

	it("refuses the npm-9.2 shape and names the pinned regeneration", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const dropped = libcLock({
			"@rollup/rollup-linux-x64-gnu": { version: "4.52.4" },
		});
		const result = check(committedRepo(good), dropped);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'node_modules/@rollup/rollup-linux-x64-gnu@4.52.4 recorded libc ["glibc"]',
		);
		expect(result.stderr).toContain("npm@11.18.0");
		expect(result.stderr).toContain(
			"npx npm@11.18.0 install --package-lock-only --ignore-scripts",
		);
	});

	it("accepts the pinned npm's regeneration, unrelated drift included", () => {
		const good = libcLock({
			"@rollup/rollup-linux-x64-gnu": GLYDE,
			"@rollup/rollup-linux-arm64-musl": {
				version: "4.52.4",
				libc: ["musl"],
			},
			kept: { version: "1.0.0" },
		});
		const regenerated = libcLock({
			"@rollup/rollup-linux-x64-gnu": GLYDE,
			"@rollup/rollup-linux-arm64-musl": { version: "4.52.4", libc: ["musl"] },
			kept: { version: "1.1.0" },
		});
		const result = check(committedRepo(good), regenerated);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('keeps every "libc" field');
	});

	it("ignores a package that left the lock and a resolved version that moved", () => {
		const good = libcLock({
			gone: { version: "1.0.0", libc: ["glibc"] },
			moved: { version: "2.0.0", libc: ["glibc"] },
			kept: { version: "1.0.0" },
		});
		const after = libcLock({
			moved: { version: "3.0.0" },
			kept: { version: "1.0.0" },
		});
		const result = check(committedRepo(good), after);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("caps the reported entries and counts the rest", () => {
		const entries = Object.fromEntries(
			Array.from({ length: 8 }, (_, index) => [
				`binding-${index}`,
				{ version: "1.0.0", libc: ["glibc"] },
			]),
		);
		const dropped = Object.fromEntries(
			Object.keys(entries).map((key) => [key, { version: "1.0.0" }]),
		);
		const result = check(committedRepo(libcLock(entries)), libcLock(dropped));

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("8 package entries");
		expect(result.stderr.match(/recorded libc/g) as string[]).toHaveLength(5);
		expect(result.stderr).toContain("... and 3 more");
	});

	it("refuses the drop the commit records, not the working copy", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const dropped = libcLock({
			"@rollup/rollup-linux-x64-gnu": { version: "4.52.4" },
		});
		const root = committedRepo(good);
		// The incident's own order: npm 9.2 rewrites the lock, `git add` stages it,
		// then the pinned npm restores the working copy. The commit still records
		// the damaged blob.
		stage(root, dropped);
		writeWorking(root, good);

		const result = run(CHECKER, root, [], envFor(root));

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'node_modules/@rollup/rollup-linux-x64-gnu@4.52.4 recorded libc ["glibc"]',
		);
		expect(result.stderr).toContain(
			"Compared HEAD → the staged package-lock.json.",
		);
		expect(result.stderr).toContain(
			"npx npm@11.18.0 install --package-lock-only --ignore-scripts",
		);
	});

	it("names the working copy it did not judge when the staged copy is clean", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const regrown = { ...good, requires: false };
		const dropped = libcLock({
			"@rollup/rollup-linux-x64-gnu": { version: "4.52.4" },
		});
		const root = committedRepo(libcLock({ kept: { version: "1.0.0" } }));
		stage(root, regrown);
		writeWorking(root, dropped);

		const result = run(CHECKER, root, [], envFor(root));

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"the working package-lock.json differs from the staged copy",
		);
	});

	it("reads a HEAD lock past Node's 1 MiB spawn default", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const padded = { ...good, padding: "x".repeat(2 * 1024 * 1024) };
		const dropped = libcLock({
			"@rollup/rollup-linux-x64-gnu": { version: "4.52.4" },
		});
		const result = check(committedRepo(padded), dropped);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('recorded libc ["glibc"]');
	});

	it("refuses when HEAD's lock is past the read bound", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const oversized = { ...good, padding: "x".repeat(9 * 1024 * 1024) };
		const dropped = libcLock({
			"@rollup/rollup-linux-x64-gnu": { version: "4.52.4" },
		});
		const result = check(committedRepo(oversized), dropped);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("package-lock libc drift: unverifiable");
		expect(result.stderr).toContain("ENOBUFS");
	});

	it("refuses when git cannot read HEAD", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const root = committedRepo(good);
		breakRepository(root);

		const result = check(root, libcLock({ kept: { version: "1.0.0" } }));

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"package-lock libc drift: unverifiable (git could not read HEAD: ",
		);
		expect(result.stderr).toContain("Expected git repo version");
	});

	it("refuses with the --complete inconclusive code when git cannot read HEAD", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const root = committedRepo(good);
		breakRepository(root);

		const result = check(root, libcLock({ kept: { version: "1.0.0" } }), [
			"--complete",
		]);

		expect(result.status).toBe(3);
		expect(result.stderr).toContain("package-lock libc drift: unverifiable");
	});

	it("compares a clean tree against the merge base with origin/master", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const dropped = libcLock({
			"@rollup/rollup-linux-x64-gnu": { version: "4.52.4" },
		});
		const root = committedRepo(good);
		const base = probeGit(["rev-parse", "HEAD"], root).trim();
		writeWorking(root, dropped);
		commit(root, "drop libc");
		probeGit(["update-ref", "refs/remotes/origin/master", base], root);

		const result = run(CHECKER, root, [], envFor(root));

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('recorded libc ["glibc"]');
		expect(result.stderr).toContain(
			"Compared the merge base with origin/master",
		);
	});

	it("accepts a clean tree whose merge base kept every libc field", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const root = committedRepo(libcLock({ kept: { version: "1.0.0" } }));
		const base = probeGit(["rev-parse", "HEAD"], root).trim();
		writeWorking(root, good);
		commit(root, "add libc");
		probeGit(["update-ref", "refs/remotes/origin/master", base], root);

		const result = run(CHECKER, root, [], envFor(root));

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			`the merge base with origin/master (${base.slice(0, 7)}) recorded`,
		);
	});

	it("records that origin/master does not resolve on a clean tree", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const result = check(committedRepo(good), good);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("libc drift: not checked (clean tree");
		expect(result.stdout).toContain("origin/master does not resolve");
	});

	it("records that HEAD is the merge base on a clean tree", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const root = committedRepo(good);
		probeGit(["update-ref", "refs/remotes/origin/master", "HEAD"], root);

		const result = check(root, good);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("libc drift: not checked (clean tree");
		expect(result.stdout).toContain("is the merge base with origin/master");
	});

	it("never passes a HEAD lock with no packages map", () => {
		const working = libcLock({ kept: { version: "1.0.0" } });
		for (const headLock of [
			"null",
			{
				name: PKG.name,
				version: PKG.version,
				lockfileVersion: 1,
				dependencies: { kept: { version: "1.0.0" } },
			},
		]) {
			const result = check(committedRepo(headLock), working);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("libc drift: not checked (HEAD's");
			expect(result.stdout).toContain("no packages map");
		}
	});

	it("records the drift when package.json carries no npm pin", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const dropped = libcLock({
			"@rollup/rollup-linux-x64-gnu": { version: "4.52.4" },
		});
		const root = committedRepo(good);
		const unpinned = { name: PKG.name, version: PKG.version };
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(unpinned));

		const result = check(root, dropped);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('recorded libc ["glibc"]');
		expect(result.stderr).toContain("packageManager pin is unavailable");
		expect(result.stderr).not.toContain("at file://");
	});

	it("says one package entry stays on a singular drop", () => {
		const good = libcLock({ "@rollup/rollup-linux-x64-gnu": GLYDE });
		const dropped = libcLock({
			"@rollup/rollup-linux-x64-gnu": { version: "4.52.4" },
		});
		const result = check(committedRepo(good), dropped);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"from 1 package entry that stays in the lock",
		);
	});

	it("skips the comparison when HEAD records no lockfile", () => {
		const root = committedRepo(null);
		const result = check(root, libcLock({ kept: { version: "1.0.0" } }));

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"libc drift: not checked (HEAD holds no package-lock.json)",
		);
	});

	it("skips the comparison when HEAD records no commit yet", () => {
		const root = fs.mkdtempSync(
			path.join(REPO_ROOT, ".probe-home", "lockfile-libc-"),
		);
		tempDirs.push(root);
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(PKG));
		probeGit(["init", "-q", "-b", "fixture-lock"], root);

		const result = check(root, libcLock({ kept: { version: "1.0.0" } }));

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"libc drift: not checked (HEAD records no commit",
		);
	});

	it("skips the comparison when HEAD's lockfile is unreadable", () => {
		const root = committedRepo("{ not json");
		const result = check(root, libcLock({ kept: { version: "1.0.0" } }));

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("libc drift: not checked (HEAD's");
		expect(result.stdout).toContain("is unreadable");
	});
});
