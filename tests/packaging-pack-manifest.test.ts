// flake-shape: real-process-spawn — the published manifest can only be observed by running the real `npm pack` (prepack/postpack are npm lifecycle hooks; nothing in-process reproduces them faithfully).
/**
 * The tarball's package.json must not carry devDependencies (2026-09-03):
 * pi supplies host-provided packages with `npm install --no-save` into the
 * installed extension, npm's resolver then walks the dev peer graph, and
 * `@vitejs/devtools@0.7.1` / `vitest@5.0.0` crash npm 10.9.8 in #loadPeerSet.
 * `scripts/strip-dev-deps-for-pack.mjs` strips them in `prepack` and restores
 * them in `postpack`; this test observes the REAL `npm pack` output.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// `npm pack` below runs pi-lens's OWN `prepare` -> `scripts/warm-loader-cache.mjs`,
// whose install-log sink is `PI_LENS_INSTALL_LOG` or, failing that,
// `os.homedir()/.pi-lens/install.log` — the exact hazard `scratchEnv` exists to
// pin closed (#2619 review F1; reused here rather than re-typing the same env
// map, #2634).
import { scratchEnv } from "../scripts/release-qa.mjs";
import {
	packedImportResolutionViolations,
	packedLayoutViolations,
} from "../scripts/lib/packed-layout.mjs";
import { assertNonEmptyScan } from "./support/sweep-kit.js";
import {
	restore as restorePackBackup,
	stripForPack,
} from "../scripts/strip-dev-deps-for-pack.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

/**
 * #4003: the real `npm pack` runs pi-lens's own `prepare`, whose first step is
 * `build:dist`. Run in the checkout it wrote `dist/` there, so every file that
 * needs `dist/` passed or failed by test order. Every pack in this file runs in
 * an isolated copy of the checkout (package.json, lock and scripts byte for
 * byte; `node_modules` linked, not copied), so the live checkout is never
 * stripped, rebuilt or stamped. Skipped from the copy: dependencies, git,
 * previous build output, and trees the pack and the build never read.
 */
const PACK_COPY_SKIP = new Set([
	"node_modules",
	".git",
	"dist",
	".pack-backup",
	".probe-home",
	".vitest-cache",
	".claude",
	".tmp",
	"reports",
	"tests",
	"cases",
	"formal",
	"release-qa-evidence",
]);

function copyPackSource(dest: string, source = root): string {
	fs.cpSync(source, dest, {
		recursive: true,
		filter: (src) => {
			const rel = path.relative(source, src);
			return rel === "" || !PACK_COPY_SKIP.has(rel.split(path.sep)[0] ?? "");
		},
	});
	fs.symlinkSync(
		path.join(root, "node_modules"),
		path.join(dest, "node_modules"),
		"junction",
	);
	return dest;
}

/**
 * The live checkout's own state, which no pack in this file may touch.
 * `dist/index.js` is recorded by inode and mtime, not existence: where `dist/`
 * already exists (CI, any built tree) a pack that ran `prepare` in the
 * checkout deletes and rebuilds it, which an existence check cannot see.
 */
function liveCheckoutState(): {
	manifest: string;
	lock: string;
	distIndex: { ino: number; mtimeMs: number } | null;
	packBackupExists: boolean;
	distExists: boolean;
} {
	const index = fs.statSync(path.join(root, "dist", "index.js"), {
		throwIfNoEntry: false,
	});
	return {
		manifest: fs.readFileSync(path.join(root, "package.json"), "utf8"),
		lock: fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
		distIndex: index ? { ino: index.ino, mtimeMs: index.mtimeMs } : null,
		packBackupExists: fs.existsSync(path.join(root, ".pack-backup")),
		distExists: fs.existsSync(path.join(root, "dist")),
	};
}

function expectLiveCheckoutUntouched(
	before: ReturnType<typeof liveCheckoutState>,
): void {
	expect(liveCheckoutState()).toEqual(before);
	expect(before.packBackupExists).toBe(false);
	expect(liveCheckoutState().packBackupExists).toBe(false);
}

/**
 * #2652: the SIGNAL case below still strips the LIVE manifest with the real
 * script (no pack, no build) and needs `onPackSignal` registered for the whole
 * describe (beforeAll/afterAll), not per call: a signal that lands during a
 * synchronous child run is delivered only AFTER it returns, so a per-call
 * listener would already be gone. The listener restores if a backup is still
 * there and re-raises, so the run still stops. SIGKILL cannot be trapped;
 * .pack-backup/ is then the manual path.
 */
let reraisePackSignal: (signal: NodeJS.Signals) => void = (signal) => {
	process.kill(process.pid, signal);
};

function detachPackSignal(): void {
	process.off("SIGINT", onPackSignal);
	process.off("SIGTERM", onPackSignal);
}

function onPackSignal(signal: NodeJS.Signals): void {
	detachPackSignal();
	if (fs.existsSync(path.join(root, ".pack-backup"))) restorePackBackup();
	reraisePackSignal(signal);
}

function attachPackSignal(): void {
	process.on("SIGINT", onPackSignal);
	process.on("SIGTERM", onPackSignal);
}
const pkg = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
	name: string;
	devDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
	scripts: Record<string, string>;
	packageManager?: string;
	files?: string[];
};
// #3885: run the real pack through the repo's pinned npm -- the same
// `npx -y "npm@<packageManager>"` argv `release.yml` and `ci.yml` publish and
// install with. A host on npm 9 (pacote@13) does not forward `script-shell` to
// the `prepare` lifecycle `npm pack` runs for a directory (`pacote/lib/dir.js`
// `_prepareDir` builds its runScript options without `scriptShell`), so the
// #2652 forced-failure wrapper below is inert and the pack wrongly exits 0.
// npm 10+ forwards it. Pinning the npm keeps the test's observation on the
// toolchain the project ships with instead of the host's npm.
const npmPin = String(pkg.packageManager ?? "").replace(/^npm@/, "");

function pinnedPackArgs(extra: string[]): string[] {
	return ["-y", `npm@${npmPin}`, "pack", ...extra];
}

describe("published manifest carries no devDependencies", () => {
	beforeAll(attachPackSignal);
	afterAll(detachPackSignal);

	it("stripForPack drops exactly devDependencies and nothing else", () => {
		const input = {
			name: "x",
			version: "1.0.0",
			dependencies: { a: "1" },
			devDependencies: { vitest: "^4" },
			scripts: { prepack: "p" },
		};
		const out = stripForPack(input);
		expect("devDependencies" in out).toBe(false);
		expect(out).toEqual({
			name: "x",
			version: "1.0.0",
			dependencies: { a: "1" },
			scripts: { prepack: "p" },
		});
	});

	// #4003 recurrence: a name added to PACK_COPY_SKIP that `files[]` ships would
	// pack a tarball silently missing that tree, from a copy that dropped it.
	// `dist` is skipped on purpose: `prepare` rebuilds it inside the copy.
	it("copies every top-level tree package.json files[] ships", () => {
		const shipped = new Set(
			(pkg.files ?? []).map((entry) => entry.split("/")[0] ?? ""),
		);
		assertNonEmptyScan("files[] top-level entries", shipped.size, 5);
		expect(
			[...shipped].filter((top) => PACK_COPY_SKIP.has(top) && top !== "dist"),
		).toEqual([]);
	});

	it("prepack strips and postpack restores, wired in package.json", () => {
		expect(pkg.scripts.prepack).toBe(
			"node scripts/strip-dev-deps-for-pack.mjs --strip",
		);
		expect(pkg.scripts.postpack).toBe(
			"node scripts/strip-dev-deps-for-pack.mjs --restore",
		);
		expect(
			pkg.devDependencies && Object.keys(pkg.devDependencies).length,
		).toBeGreaterThan(0);
		// The pack cases below invoke `npm@<pin>`; pin the shape so a missing or
		// floating `packageManager` cannot silently resolve npm latest (#3885).
		expect(pkg.packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/);
	});

	it(
		"a lifecycle step failing between prepack and postpack leaves the live checkout untouched (#2652, #4003)",
		{ timeout: 180_000 },
		() => {
			// npm runs prepack (strip), prepare, then postpack (restore). A failing
			// `prepare` aborts before postpack, which used to leave the live checkout
			// stripped with .pack-backup/ behind -- seen for real when this file's
			// pack hit a registry error. The pack now runs in a copy, so the same
			// failure strands only the copy; the live checkout must be byte-identical.
			// A script-shell wrapper fails the `prepare` command deterministically;
			// prepack still runs for real.
			const scratch = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-pack-fail-"),
			);
			const shell = path.join(scratch, "fail-prepare.sh");
			fs.writeFileSync(
				shell,
				'#!/bin/sh\ncase "$2" in *build:dist*) echo "prepare forced to fail (#2652)" >&2; exit 1;; esac\nexec sh "$@"\n',
				{ mode: 0o755 },
			);
			const live = liveCheckoutState();
			try {
				const copy = copyPackSource(path.join(scratch, "src"));
				expect(() =>
					execFileSync(npx, pinnedPackArgs(["--pack-destination", scratch]), {
						cwd: copy,
						encoding: "utf8",
						shell: process.platform === "win32",
						timeout: 180_000,
						stdio: ["ignore", "ignore", "pipe"],
						env: {
							...scratchEnv(scratch),
							npm_config_script_shell: shell,
						},
					}),
				).toThrow();
				// The strip really ran in the copy (so the failure is the one this
				// case is about), and the live checkout never saw it.
				expect(fs.existsSync(path.join(copy, ".pack-backup"))).toBe(true);
				expectLiveCheckoutUntouched(live);
			} finally {
				fs.rmSync(scratch, { recursive: true, force: true });
			}
		},
	);

	it("restores and re-raises when a signal lands mid-pack (#2652)", () => {
		// Stands in for npm dying to a process-group SIGINT after prepack: the
		// real strip runs, then the signal reaches this worker's listener. The
		// re-raise is captured instead of killing the worker.
		const before = fs.readFileSync(path.join(root, "package.json"), "utf8");
		const reraised: string[] = [];
		const realReraise = reraisePackSignal;
		reraisePackSignal = (signal) => {
			reraised.push(signal);
		};
		try {
			execFileSync(
				process.execPath,
				[path.join(root, "scripts", "strip-dev-deps-for-pack.mjs"), "--strip"],
				{ cwd: root, stdio: "ignore", timeout: 60_000 },
			);
			expect(fs.existsSync(path.join(root, ".pack-backup"))).toBe(true);
			process.emit("SIGINT", "SIGINT");
			expect(reraised).toEqual(["SIGINT"]);
			expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(
				before,
			);
			expect(fs.existsSync(path.join(root, ".pack-backup"))).toBe(false);
		} finally {
			reraisePackSignal = realReraise;
			if (fs.existsSync(path.join(root, ".pack-backup"))) restorePackBackup();
			detachPackSignal();
			attachPackSignal();
		}
	});

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pack-"));
	afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("copies package source without the worktree's derived Vitest cache (#5488)", () => {
		const source = path.join(tmp, "cache-source");
		fs.mkdirSync(path.join(source, ".vitest-cache"), { recursive: true });
		fs.writeFileSync(path.join(source, ".vitest-cache", "result"), "derived");
		fs.writeFileSync(
			path.join(source, "package.json"),
			'{"name":"pack-fixture"}',
		);
		const copy = copyPackSource(path.join(tmp, "cache-copy"), source);
		expect(fs.readFileSync(path.join(copy, "package.json"), "utf8")).toBe(
			'{"name":"pack-fixture"}',
		);
		expect(fs.existsSync(path.join(copy, ".vitest-cache"))).toBe(false);
	});

	/**
	 * #4561 (shuffle seed 424): both cases below observe the SAME tarball, and one
	 * `npm pack` per run (it builds the copy's `dist/` through `prepare`) is what
	 * keeps them affordable. Sharing it through a memo instead of "the case above
	 * packed it" keeps the order free: whichever case a shuffle runs first packs,
	 * the other reuses. The pre-fix #3219 case threw
	 * "no tarball: the preceding real `npm pack` case must run first" whenever it
	 * ran first.
	 */
	type PackedTarball = {
		filename: string;
		packRoot: string;
		manifestBefore: string;
		lockBefore: string;
		liveBefore: ReturnType<typeof liveCheckoutState>;
		realInstallLogBefore: Buffer | null;
	};

	/** The pack itself, injectable so the retry case can force a failure. */
	type PackStep = (copy: string, destination: string) => void;

	function realPack(copy: string, destination: string): void {
		// Not `--json`: `prepare` also runs on pack and its scripts write to stdout
		// (setup-git-hooks on a fresh CI checkout), which corrupts the JSON payload.
		execFileSync(npx, pinnedPackArgs(["--pack-destination", destination]), {
			cwd: copy,
			encoding: "utf8",
			shell: process.platform === "win32",
			timeout: 180_000,
			stdio: ["ignore", "ignore", "inherit"],
			// scratchEnv pins PI_LENS_INSTALL_LOG (and HOME, PILENS_DATA_DIR,
			// npm_config_cache) inside `destination` — every writer this child's
			// `prepare` lifecycle can reach lands in the scratch root, never in
			// the real developer home (#2619 review F1, reused for #2634).
			env: scratchEnv(destination),
		});
	}

	/**
	 * One real pack per root, shared by the cases below. The pack step is a
	 * parameter so the retry case can drive a failure through this same function
	 * (#4561 review r2).
	 */
	function createTarballMemo(
		destination: string,
		pack: PackStep = realPack,
		source = root,
	): () => PackedTarball {
		let packed: PackedTarball | undefined;
		return () => {
			if (packed !== undefined) return packed;
			const liveBefore = liveCheckoutState();
			const packRoot = path.join(destination, "pack-src");
			// #4561 review r1 LOW: `copyPackSource` is not idempotent, and the memo
			// is set only after a successful pack, so a FAILED pack left `pack-src`
			// half-built and every later attempt reported `EEXIST: symlink
			// node_modules` instead of the pack's own error. Clearing it first makes
			// a retry report the real failure; the case below is the witness.
			// `rmSync` removes the copy's `node_modules` SYMLINK entry and never
			// follows it into the live checkout's install.
			fs.rmSync(packRoot, { recursive: true, force: true });
			copyPackSource(packRoot, source);
			const manifestBefore = fs.readFileSync(
				path.join(packRoot, "package.json"),
				"utf8",
			);
			const lockBefore = fs.readFileSync(
				path.join(packRoot, "package-lock.json"),
				"utf8",
			);
			// #2634: this `npm pack` runs OUR `prepare`, whose last step
			// (`scripts/warm-loader-cache.mjs`) appends to `PI_LENS_INSTALL_LOG` or,
			// failing that, `os.homedir()/.pi-lens/install.log` — with no `env:`
			// pin the child inherited the ambient environment and every run of this
			// suite wrote one record into the DEVELOPER'S REAL install log. Read the
			// real sink (not a stand-in) BEFORE the pack so the assertion below is
			// checking the exact file the bug wrote into, the same way
			// `tests/scripts/release-qa.test.ts`'s hermeticity canary does for
			// `scratchEnv`'s own child probe.
			const realInstallLog = path.join(os.homedir(), ".pi-lens", "install.log");
			const realInstallLogBefore = fs.existsSync(realInstallLog)
				? fs.readFileSync(realInstallLog)
				: null;
			pack(packRoot, destination);
			const filename = fs
				.readdirSync(destination)
				.find((f) => f.endsWith(".tgz"));
			if (!filename) throw new Error("npm pack produced no tarball");
			packed = {
				filename,
				packRoot,
				manifestBefore,
				lockBefore,
				liveBefore,
				realInstallLogBefore,
			};
			return packed;
		};
	}

	const packTarballOnce = createTarballMemo(tmp);

	// #4561 review r2 (Greptile P2 on LOW-6): the retry branch had no failing
	// witness — with and without the `rmSync` the suite reported the same
	// counts, and only the error text differed. This drives the failure through
	// the same memo with the pack step injected: the first attempt throws after
	// the copy exists, the second must rebuild that copy. Deleting the `rmSync`
	// in `createTarballMemo` reds this case with `EEXIST: symlink node_modules`.
	it("a failed pack's retry rebuilds its copy instead of reusing a half-built one (#4561 review r2)", () => {
		const retryRoot = path.join(tmp, "retry");
		const source = path.join(retryRoot, "source");
		fs.mkdirSync(source, { recursive: true });
		fs.writeFileSync(
			path.join(source, "package.json"),
			fs.readFileSync(path.join(root, "package.json")),
		);
		fs.writeFileSync(
			path.join(source, "package-lock.json"),
			fs.readFileSync(path.join(root, "package-lock.json")),
		);
		const halfBuilt = path.join(retryRoot, "pack-src", "half-built.marker");
		let attempts = 0;
		const packTarball = createTarballMemo(
			retryRoot,
			(copy, destination) => {
				expect(fs.readdirSync(copy).sort()).toEqual([
					"node_modules",
					"package-lock.json",
					"package.json",
				]);
				attempts += 1;
				if (attempts === 1) {
					// The shape a real failed pack leaves behind: the copy exists, the
					// pack dies, and the memo is never set.
					fs.writeFileSync(halfBuilt, "first attempt");
					throw new Error("pack forced to fail (#4561 review r2)");
				}
				expect(
					fs.existsSync(halfBuilt),
					"the retry reused the half-built copy instead of rebuilding it",
				).toBe(false);
				expect(fs.readFileSync(path.join(copy, "package.json"), "utf8")).toBe(
					fs.readFileSync(path.join(root, "package.json"), "utf8"),
				);
				fs.writeFileSync(path.join(destination, "retry-1.0.0.tgz"), "tarball");
			},
			source,
		);
		expect(() => packTarball()).toThrow("pack forced to fail");
		expect(fs.existsSync(halfBuilt), "the first attempt built the copy").toBe(
			true,
		);
		expect(packTarball().filename).toBe("retry-1.0.0.tgz");
		expect(attempts, "one failed attempt and one retry").toBe(2);
	});

	it(
		"the real `npm pack` tarball's package.json has no devDependencies, and the working manifest is restored",
		{ timeout: 180_000 },
		() => {
			const {
				filename,
				packRoot,
				manifestBefore,
				lockBefore,
				liveBefore,
				realInstallLogBefore,
			} = packTarballOnce();
			const realInstallLog = path.join(os.homedir(), ".pi-lens", "install.log");
			expect(
				fs.existsSync(realInstallLog) ? fs.readFileSync(realInstallLog) : null,
				"npm pack must not write into the real ~/.pi-lens/install.log (#2634), " +
					"or an unrelated concurrent writer touched it during this run",
			).toEqual(realInstallLogBefore);
			// The real-home assertion above is liveness-free on its own: drop
			// `warm-loader-cache` from `prepare` entirely and it stays green just as
			// happily as a correctly-redirected write does. Assert the SUCCESS path
			// too — the record must land in the SCRATCH sink `scratchEnv(tmp)`
			// pins, proving the seam actually ran and was actually redirected, not
			// merely that nothing reached the real home (review round 1, F1).
			expect(
				fs.readFileSync(
					path.join(tmp, "home", ".pi-lens", "install.log"),
					"utf8",
				),
			).toContain("warm_loader_cache");
			// tar with cwd + a relative path: GNU/bsd tar misread `C:...` as a remote host spec.
			const manifest = execFileSync(
				"tar",
				["-xzOf", filename, "package/package.json"],
				{ cwd: tmp, encoding: "utf8" },
			);
			const packed = JSON.parse(manifest) as {
				devDependencies?: unknown;
				dependencies?: unknown;
				name: string;
				pi: { changelogPath: string };
			};
			expect(packed.name).toBe(pkg.name);
			// #5198: pi must resolve the override inside the published package.
			expect(packed.pi.changelogPath).toBe("CHANGELOG-USER.md");
			expect(packed.devDependencies).toBeUndefined();
			expect(packed.dependencies).toEqual(pkg.dependencies);
			// postpack put the packed copy's manifest back, byte for byte.
			expect(fs.readFileSync(path.join(packRoot, "package.json"), "utf8")).toBe(
				manifestBefore,
			);
			expect(fs.existsSync(path.join(packRoot, ".pack-backup"))).toBe(false);
			// npm re-syncs the lock from the stripped manifest during pack; postpack must put it back too.
			expect(
				fs.readFileSync(path.join(packRoot, "package-lock.json"), "utf8"),
			).toBe(lockBefore);
			// #4003: the live checkout saw none of it -- manifest, lock, no
			// .pack-backup/, and no dist/ written by the pack's `prepare`.
			expectLiveCheckoutUntouched(liveBefore);
		},
	);

	// #3219: the invariant "everything in the published package loads from the
	// bundled tree", checked on the SAME real tarball the case above packed
	// (one `npm pack` per run through `packTarballOnce`, in an isolated copy; it
	// builds that copy's dist/ through `prepare`). Red on the pre-#3219 layout:
	// the tarball carried 477 files under dist/clients/ and dist/tools/, which
	// the bins and both persist workers loaded from.
	// 180 s like the case above: whichever case a shuffle runs first pays the
	// real `npm pack` through `packTarballOnce`, and a 5 s default would time
	// that one out (seed 424 did).
	it(
		"ships only the bundled tree, and both persist workers start from it (#3219)",
		{ timeout: 180_000 },
		async () => {
			const { filename } = packTarballOnce();
			const unpacked = path.join(tmp, "unpacked");
			fs.mkdirSync(unpacked, { recursive: true });
			execFileSync("tar", ["-xzf", filename, "-C", "unpacked"], { cwd: tmp });
			const pkgRoot = path.join(unpacked, "package");
			const manifest = JSON.parse(
				fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"),
			);
			const notes = fs.readFileSync(
				path.join(pkgRoot, manifest.pi.changelogPath),
				"utf8",
			);
			expect(notes).toBe(
				fs.readFileSync(path.join(root, "CHANGELOG-USER.md"), "utf8"),
			);
			// #5202: an Unreleased heading alone must not satisfy the packed release witness.
			expect(notes).toMatch(/^## \[\d+\.\d+\.\d+\]/m);
			expect(notes).not.toContain("### Internal");

			const packedPaths = (
				fs.readdirSync(pkgRoot, { recursive: true }) as string[]
			)
				.map((entry) => entry.split(path.sep).join("/"))
				.filter((entry) => fs.statSync(path.join(pkgRoot, entry)).isFile());
			// Dead-sweep floor (AGENTS.md shape 10): 1184 files packed on 2026-09-25;
			// half, rounded down.
			assertNonEmptyScan("packed files", packedPaths.length, 592);
			expect(
				packedLayoutViolations(packedPaths, (entry) =>
					fs.readFileSync(path.join(pkgRoot, entry), "utf8"),
				),
			).toEqual([]);
			// #5365: the same unpacked tarball answers "does every file a published
			// script imports ship with it". `npm run check` runs
			// `scripts/check-extensions.mjs` over the SOURCE tree, so it resolves an
			// import of an unpacked file against the checkout and passes; every
			// earlier member of that shape (#4789, #2626, #3409, #5364) reached CI's
			// install leg first and was pinned by one `files[]` assertion afterwards.
			// 147 packed .js/.mjs/.cjs files measured on 4.4.10; half, rounded down.
			assertNonEmptyScan(
				"packed JavaScript files",
				packedPaths.filter((entry) => /\.c?m?js$/.test(entry)).length,
				73,
			);
			const specifiers = { relative: 0 };
			expect(
				packedImportResolutionViolations(
					packedPaths,
					(entry) => fs.readFileSync(path.join(pkgRoot, entry), "utf8"),
					specifiers,
				),
			).toEqual([]);
			// 1650 relative specifiers examined on 4.4.10; half, rounded down. A
			// walker that reads nothing would otherwise pass over every file.
			assertNonEmptyScan(
				"relative specifiers examined",
				specifiers.relative,
				825,
			);
			for (const entry of [
				"dist/index.js",
				"dist/mcp/cli.js",
				"dist/mcp/server.js",
				"dist/mcp/analyze-cli.js",
				"dist/mcp/worker.js",
				"dist/workers/project-snapshot-persist-worker.js",
				"dist/workers/review-graph-persist-worker.js",
			])
				expect(packedPaths, entry).toContain(entry);
			// The worker bundles import only node builtins and their own chunks, so
			// the unpacked package starts them with no node_modules at all.
			for (const name of [
				"project-snapshot-persist-worker",
				"review-graph-persist-worker",
			]) {
				const worker = new Worker(
					path.join(pkgRoot, "dist", "workers", `${name}.js`),
				);
				try {
					await new Promise<void>((resolve, reject) => {
						worker.once("online", () => resolve());
						worker.once("error", reject);
					});
				} finally {
					await worker.terminate();
				}
			}
		},
	);
});
