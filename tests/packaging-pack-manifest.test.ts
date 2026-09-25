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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// `npm pack` below runs pi-lens's OWN `prepare` -> `scripts/warm-loader-cache.mjs`,
// whose install-log sink is `PI_LENS_INSTALL_LOG` or, failing that,
// `os.homedir()/.pi-lens/install.log` — the exact hazard `scratchEnv` exists to
// pin closed (#2619 review F1; reused here rather than re-typing the same env
// map, #2634).
import { scratchEnv } from "../scripts/release-qa.mjs";
import {
	restore as restorePackBackup,
	stripForPack,
} from "../scripts/strip-dev-deps-for-pack.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * #2652: `npm pack` strips the LIVE checkout's manifest in prepack and puts
 * it back in postpack. Anything that stops npm in between -- a failing
 * `prepare`, a Ctrl-C to the process group -- skipped postpack and left the
 * checkout stripped with .pack-backup/ behind.
 *
 * `packWithRestore`'s `finally` restores whenever .pack-backup/ survives the
 * pack (postpack never ran).
 *
 * Signals need more than that: with no listener, Node's default action kills
 * this worker mid-`execFileSync` and no `finally` runs. So `onPackSignal` is
 * registered for the whole describe (beforeAll/afterAll), not per pack: a
 * signal that lands during the synchronous pack is delivered only AFTER it
 * returns, by which time a per-call listener would already be gone and the
 * Ctrl-C would be swallowed. The listener restores if a backup is still there
 * and re-raises, so the run still stops. SIGKILL cannot be trapped;
 * .pack-backup/ is then the manual path, as before.
 */
function packWithRestore(run: () => unknown): void {
	try {
		run();
	} finally {
		if (fs.existsSync(path.join(root, ".pack-backup"))) restorePackBackup();
	}
}

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
};

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
	});

	it(
		"restores the working manifest when a lifecycle step between prepack and postpack fails (#2652)",
		{ timeout: 180_000 },
		() => {
			// npm runs prepack (strip), prepare, then postpack (restore). A failing
			// `prepare` aborts before postpack, so the live checkout stayed
			// stripped with .pack-backup/ left behind -- seen for real when this
			// file's pack hit a registry error. A script-shell wrapper fails the
			// `prepare` command deterministically; prepack still runs for real.
			const scratch = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-pack-fail-"),
			);
			const shell = path.join(scratch, "fail-prepare.sh");
			fs.writeFileSync(
				shell,
				'#!/bin/sh\ncase "$2" in *build:dist*) echo "prepare forced to fail (#2652)" >&2; exit 1;; esac\nexec sh "$@"\n',
				{ mode: 0o755 },
			);
			const before = fs.readFileSync(path.join(root, "package.json"), "utf8");
			const lockBefore = fs.readFileSync(
				path.join(root, "package-lock.json"),
				"utf8",
			);
			try {
				expect(() =>
					packWithRestore(() =>
						execFileSync(npm, ["pack", "--pack-destination", scratch], {
							cwd: root,
							encoding: "utf8",
							shell: process.platform === "win32",
							timeout: 180_000,
							stdio: ["ignore", "ignore", "pipe"],
							env: {
								...scratchEnv(scratch),
								npm_config_script_shell: shell,
							},
						}),
					),
				).toThrow();
				expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(
					before,
				);
				expect(
					fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
				).toBe(lockBefore);
				expect(fs.existsSync(path.join(root, ".pack-backup"))).toBe(false);
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

	it(
		"the real `npm pack` tarball's package.json has no devDependencies, and the working manifest is restored",
		{ timeout: 180_000 },
		() => {
			const before = fs.readFileSync(path.join(root, "package.json"), "utf8");
			const lockBefore = fs.readFileSync(
				path.join(root, "package-lock.json"),
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
			// Not `--json`: `prepare` also runs on pack and its scripts write to stdout
			// (setup-git-hooks on a fresh CI checkout), which corrupts the JSON payload.
			packWithRestore(() =>
				execFileSync(npm, ["pack", "--pack-destination", tmp], {
					cwd: root,
					encoding: "utf8",
					shell: process.platform === "win32",
					timeout: 180_000,
					stdio: ["ignore", "ignore", "inherit"],
					// scratchEnv pins PI_LENS_INSTALL_LOG (and HOME, PILENS_DATA_DIR,
					// npm_config_cache) inside `tmp` — every writer this child's
					// `prepare` lifecycle can reach lands in the scratch root, never in
					// the real developer home (#2619 review F1, reused for #2634).
					env: scratchEnv(tmp),
				}),
			);
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
			const filename = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
			if (!filename) throw new Error("npm pack produced no tarball");
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
			};
			expect(packed.name).toBe(pkg.name);
			expect(packed.devDependencies).toBeUndefined();
			expect(packed.dependencies).toEqual(pkg.dependencies);
			// postpack put the working manifest back, byte for byte.
			expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(
				before,
			);
			expect(fs.existsSync(path.join(root, ".pack-backup"))).toBe(false);
			// npm re-syncs the lock from the stripped manifest during pack; postpack must put it back too.
			expect(
				fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
			).toBe(lockBefore);
		},
	);
});
