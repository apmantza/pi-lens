// flake-shape: real-process-spawn — two real Node children must contend on the
// production rename; an in-process mock cannot expose the cross-process ENOENT.
/**
 * #2874: `getProjectDataDir`'s slug folded separators to `-`, so two roots
 * differing only in separator-vs-hyphen placement (`src/pi-lens` vs
 * `src/pi/lens`) shared one data directory. The slug now appends an 8-hex
 * SHA-256 of the canonical absolute root, and a pre-hash directory is
 * renamed once on first use.
 *
 * Probe hygiene: scratch roots live under `os.tmpdir()` (outside the
 * worktree); `PILENS_DATA_DIR`/`PI_LENS_HOME` are pointed at per-test temp
 * dirs and restored afterwards. The real HOME is never touched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const realpathState = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
			if (realpathState.fail) {
				throw Object.assign(new Error("temporary failure"), { code: "EACCES" });
			}
			return actual.realpathSync(...args);
		},
	};
});
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import {
	drainProjectDataDirMigrations,
	getProjectDataDir,
	_resetProjectDataDirMemoForTests,
} from "../../clients/file-utils.js";

const savedDataDir = process.env.PILENS_DATA_DIR;
const savedHome = process.env.PI_LENS_HOME;

function isolateDataDir(): string {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-datadir-base-"));
	process.env.PILENS_DATA_DIR = base;
	process.env.PI_LENS_HOME = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-datadir-home-"),
	);
	return base;
}

function runRealProcess(
	env: NodeJS.ProcessEnv,
	script: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", script], {
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let error = "";
		child.stdout.on("data", (chunk: Buffer) => (output += chunk));
		child.stderr.on("data", (chunk: Buffer) => (error += chunk));
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve(output.trim());
			else reject(new Error(`child exited ${code}: ${error}`));
		});
	});
}

afterEach(() => {
	if (savedDataDir === undefined) {
		delete process.env.PILENS_DATA_DIR;
	} else {
		process.env.PILENS_DATA_DIR = savedDataDir;
	}
	if (savedHome === undefined) {
		delete process.env.PI_LENS_HOME;
	} else {
		process.env.PI_LENS_HOME = savedHome;
	}
	drainProjectDataDirMigrations();
	resetDegradationLedger();
});

describe("project data-dir slug (#2874)", () => {
	it("gives separator/hyphen twins distinct directories", () => {
		const base = isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-twins-"));
		const rootA = path.join(scratch, "src", "pi-lens");
		const rootB = path.join(scratch, "src", "pi", "lens");
		fs.mkdirSync(rootA, { recursive: true });
		fs.mkdirSync(rootB, { recursive: true });

		const dirA = getProjectDataDir(rootA);
		const dirB = getProjectDataDir(rootB);

		expect(dirA.startsWith(base)).toBe(true);
		expect(dirB.startsWith(base)).toBe(true);
		expect(dirB).not.toBe(dirA);
		// No state leak across the twins: a file in A's directory is
		// invisible from B's.
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, "marker.json"), "{}");
		expect(fs.existsSync(path.join(dirB, "marker.json"))).toBe(false);
	});

	it("returns the same directory for the same root across calls", () => {
		isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-stable-"));
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const first = getProjectDataDir(root);
		const second = getProjectDataDir(root);
		const trailingSlash = getProjectDataDir(`${root}${path.sep}`);

		expect(second).toBe(first);
		expect(trailingSlash).toBe(first);
	});

	it("resolved root spelling stays the canonical directory identity", () => {
		isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-symlink-"));
		const target = path.join(scratch, "target", "proj");
		const linkParent = path.join(scratch, "linked");
		fs.mkdirSync(target, { recursive: true });
		fs.mkdirSync(linkParent);
		fs.symlinkSync(path.join(scratch, "target"), path.join(linkParent, "root"));

		expect(getProjectDataDir(target)).not.toBe(
			getProjectDataDir(path.join(linkParent, "root", "proj")),
		);
	});

	it("realpath failure keeps the resolved directory stable and records fallback", () => {
		isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-realpath-"));
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });
		const healthy = getProjectDataDir(root);
		_resetProjectDataDirMemoForTests();
		realpathState.fail = true;
		try {
			expect(getProjectDataDir(root)).toBe(healthy);
			const notices = drainProjectDataDirMigrations();
			expect(notices).toHaveLength(1);
			expect(notices[0]?.outcome).toBe("identity-fallback");
			expect(notices[0]?.used).toBe(healthy);
		} finally {
			realpathState.fail = false;
		}
	});

	it("two processes converge on one migrated directory", async () => {
		const base = isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-race-"));
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });
		const hashedDir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(hashedDir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "sessions.json"), "{}\n");
		_resetProjectDataDirMemoForTests();
		const barrier = path.join(scratch, "release");
		const readyA = path.join(scratch, "ready-a");
		const readyB = path.join(scratch, "ready-b");
		const script = [
			"const fs = require('node:fs');",
			"const { getProjectDataDir } = require('./clients/file-utils.js');",
			"const ready = process.env.READY_FILE;",
			"fs.writeFileSync(ready, 'ready');",
			`while (!fs.existsSync(${JSON.stringify(barrier)})) {}`,
			`process.stdout.write(getProjectDataDir(${JSON.stringify(root)}));`,
		].join("\n");
		const childEnv = {
			...process.env,
			PILENS_DATA_DIR: base,
			PI_LENS_HOME: path.join(scratch, "home"),
		};
		const first = runRealProcess({ ...childEnv, READY_FILE: readyA }, script);
		const second = runRealProcess({ ...childEnv, READY_FILE: readyB }, script);
		while (!fs.existsSync(readyA) || !fs.existsSync(readyB)) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		fs.writeFileSync(barrier, "go");
		const dirs = await Promise.all([first, second]);
		expect(dirs[0]).toBe(dirs[1]);
		expect(dirs[0]).toBe(hashedDir);
		expect(fs.existsSync(path.join(hashedDir, "sessions.json"))).toBe(true);
		expect(fs.existsSync(oldDir)).toBe(false);
	});

	it("migrates an old-slug directory by rename and preserves its contents", () => {
		const base = isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-migrate-"));
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const dir = getProjectDataDir(root);
		// The pre-#2874 name is the new basename without its trailing hash.
		const oldDir = path.join(
			base,
			path.basename(dir).replace(/-[0-9a-f]{8}$/, ""),
		);
		expect(oldDir).not.toBe(dir);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "marker.json"), '{"kept":true}');
		_resetProjectDataDirMemoForTests();

		const settled = getProjectDataDir(root);

		expect(settled).toBe(dir);
		expect(fs.existsSync(oldDir)).toBe(false);
		expect(fs.readFileSync(path.join(settled, "marker.json"), "utf8")).toBe(
			'{"kept":true}',
		);
	});

	it("prefers the new directory when both old and new exist", () => {
		const base = isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-both-"));
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const dir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(dir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "old.txt"), "old");
		fs.writeFileSync(path.join(dir, "new.txt"), "new");
		_resetProjectDataDirMemoForTests();

		const settled = getProjectDataDir(root);

		expect(settled).toBe(dir);
		expect(fs.existsSync(path.join(settled, "new.txt"))).toBe(true);
		expect(fs.existsSync(oldDir)).toBe(true);
	});

	it("rename failure records the directory actually used", () => {
		const base = isolateDataDir();
		const scratch = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-rename-failure-"),
		);
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });
		const hashedDir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(hashedDir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		_resetProjectDataDirMemoForTests();
		const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});
		try {
			expect(getProjectDataDir(root)).toBe(oldDir);
			const notices = drainProjectDataDirMigrations();
			expect(notices).toHaveLength(1);
			expect(notices[0]?.outcome).toBe("rename-failed");
			expect(notices[0]?.used).toBe(oldDir);
			expect(notices[0]?.used).not.toBe(notices[0]?.to);
		} finally {
			rename.mockRestore();
		}
	});
});
