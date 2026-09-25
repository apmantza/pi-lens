import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireBoundedPidFileLock } from "../../clients/bounded-pid-file-lock.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("acquireBoundedPidFileLock", () => {
	it("defaults to throwing when contention policy is omitted", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		const releaseFirst = acquireBoundedPidFileLock(lockPath, {
			waitMs: 10,
			retryMs: 1,
			timeoutMessage: "first lock timed out",
		});
		expect(() =>
			acquireBoundedPidFileLock(lockPath, {
				waitMs: 0,
				retryMs: 1,
				timeoutMessage: "second lock timed out",
			}),
		).toThrow("second lock timed out");
		releaseFirst();
	});

	it("logs and skips after two seconds without disturbing a concurrent process's write", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		const statePath = path.join(dir, "state.json");
		const fixture = fileURLToPath(
			new URL("../fixtures/bounded-pid-lock-holder.mjs", import.meta.url),
		);
		const holder = spawn(process.execPath, [fixture, lockPath, statePath], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		await new Promise<void>((resolve, reject) => {
			holder.once("error", reject);
			holder.stdout.once("data", (chunk) => {
				if (String(chunk).includes("locked")) resolve();
				else reject(new Error(`unexpected holder output: ${String(chunk)}`));
			});
		});
		const logContention = vi.fn();

		expect(
			acquireBoundedPidFileLock(lockPath, {
				waitMs: 2_000,
				retryMs: 10,
				timeoutMessage: "second lock timed out",
				onContention: "skip-log",
				logContention,
			}),
		).toBeNull();
		expect(logContention).toHaveBeenCalledOnce();
		await new Promise<void>((resolve, reject) => {
			holder.once("error", reject);
			holder.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)),
			);
		});
		expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
			writer: "first",
		});
	});
});

describe("acquireBoundedPidFileLock with a lock whose pid is unreadable (#3475)", () => {
	// The lock is created by `openSync(lockPath, "wx")`, then the token is
	// written: a contender can read the file in between. An empty or garbled
	// lock parsed to NaN, which `ownerPidIsLive` reports as dead, so the
	// contender unlinked a live lock and both processes committed.
	function lockWith(content: string, ageMs: number): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		fs.writeFileSync(lockPath, content, "utf8");
		const at = new Date(Date.now() - ageMs);
		fs.utimesSync(lockPath, at, at);
		return lockPath;
	}

	function contend(lockPath: string) {
		const logContention = vi.fn();
		const release = acquireBoundedPidFileLock(lockPath, {
			waitMs: 50,
			retryMs: 5,
			timeoutMessage: "unreadable lock timed out",
			onContention: "skip-log",
			logContention,
		});
		return { release, logContention };
	}

	it.each([
		["empty", ""],
		["garbled", "not-a-pid"],
	])("waits on a fresh %s lock instead of unlinking it", (_label, content) => {
		const lockPath = lockWith(content, 0);
		const { release, logContention } = contend(lockPath);
		expect(release).toBeNull();
		expect(logContention).toHaveBeenCalledOnce();
		expect(fs.readFileSync(lockPath, "utf8")).toBe(content);
	});

	it.each([
		["empty", ""],
		["garbled", "not-a-pid"],
	])("reclaims a %s lock once it has aged out", (_label, content) => {
		const lockPath = lockWith(content, 10_000);
		const { release, logContention } = contend(lockPath);
		expect(typeof release).toBe("function");
		expect(logContention).not.toHaveBeenCalled();
		release?.();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	it("still reclaims a fresh lock whose token names a dead pid at once", async () => {
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		const deadPid = child.pid as number;
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const lockPath = lockWith(`${deadPid}:${Date.now()}:gone`, 0);
		const { release, logContention } = contend(lockPath);
		expect(typeof release).toBe("function");
		expect(logContention).not.toHaveBeenCalled();
		release?.();
	});

	it("does not enter while a real process has opened the lock but not written its token", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pid-lock-"));
		tempDirs.push(dir);
		const lockPath = path.join(dir, "state.lock");
		// The creator's first step, then a pause standing in for descheduling
		// before its token write, as acquireBoundedPidFileLock itself does.
		const creator = spawn(
			process.execPath,
			[
				"-e",
				`const fs = require("node:fs");
const fd = fs.openSync(process.argv[1], "wx");
process.stdout.write("opened\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
fs.writeFileSync(fd, process.pid + ":" + Date.now() + ":creator", "utf8");
fs.closeSync(fd);
fs.unlinkSync(process.argv[1]);`,
				lockPath,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		const exited = new Promise<number | null>((resolve, reject) => {
			creator.once("error", reject);
			creator.once("exit", resolve);
		});
		await new Promise<void>((resolve, reject) => {
			creator.once("error", reject);
			creator.stdout.once("data", (chunk) => {
				if (String(chunk).includes("opened")) resolve();
				else reject(new Error(`unexpected creator output: ${String(chunk)}`));
			});
		});

		const { release } = contend(lockPath);
		expect(release).toBeNull();
		expect(await exited).toBe(0);
	});
});
