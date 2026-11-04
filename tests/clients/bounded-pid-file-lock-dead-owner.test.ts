import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireQuarantinePidFileLock } from "../../clients/bounded-pid-file-lock.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** A PID that certainly belongs to no live process. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid as number;
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return pid;
}

function writeLock(dir: string, owner: Record<string, unknown>): string {
	const lockPath = path.join(dir, "state.lock");
	fs.mkdirSync(lockPath, { recursive: true });
	fs.writeFileSync(
		path.join(lockPath, "owner.json"),
		JSON.stringify(owner),
		"utf8",
	);
	return lockPath;
}

describe("acquireQuarantinePidFileLock reclaims a dead owner", () => {
	// #1816: the staleness predicate was one conjunction — pid valid AND
	// createdAt finite AND (dead OR aged) — so an owner.json with no usable
	// createdAt short-circuited before the dead-PID test ever ran. The lock was
	// then never reclaimable and every caller burned its full wait.
	it("reclaims when the PID is dead and createdAt is missing", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-dead-owner-"));
		tempDirs.push(dir);
		const lockPath = writeLock(dir, { pid: await deadPid(), token: "old" });

		const release = await acquireQuarantinePidFileLock(lockPath, {
			waitMs: 300,
			retryMs: 10,
			staleMs: 3_600_000,
			timeoutMessage: "dead-owner lock timed out",
		});
		expect(typeof release).toBe("function");
		await release();
	});

	it("reclaims when the PID is dead and createdAt is not a number", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-dead-owner-"));
		tempDirs.push(dir);
		const lockPath = writeLock(dir, {
			pid: await deadPid(),
			createdAt: "yesterday",
			token: "old",
		});

		const release = await acquireQuarantinePidFileLock(lockPath, {
			waitMs: 300,
			retryMs: 10,
			staleMs: 3_600_000,
			timeoutMessage: "dead-owner lock timed out",
		});
		expect(typeof release).toBe("function");
		await release();
	});

	// The age arm must survive independently: an unusable PID with an aged
	// createdAt still reclaims.
	it("reclaims an aged lock whose PID field is unusable", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-aged-owner-"));
		tempDirs.push(dir);
		const lockPath = writeLock(dir, {
			pid: 0,
			createdAt: Date.now() - 10_000,
			token: "old",
		});

		const release = await acquireQuarantinePidFileLock(lockPath, {
			waitMs: 300,
			retryMs: 10,
			staleMs: 1_000,
			timeoutMessage: "aged lock timed out",
		});
		expect(typeof release).toBe("function");
		await release();
	});

	// Mutation guard: the fix must not make every lock reclaimable. A LIVE owner
	// with a fresh createdAt still holds.
	it("does not reclaim a live owner", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-live-owner-"));
		tempDirs.push(dir);
		const lockPath = writeLock(dir, {
			pid: process.pid,
			createdAt: Date.now(),
			token: "live",
		});

		await expect(
			acquireQuarantinePidFileLock(lockPath, {
				waitMs: 100,
				retryMs: 10,
				staleMs: 3_600_000,
				timeoutMessage: "live-owner lock timed out",
			}),
		).rejects.toThrow("live-owner lock timed out");
	});

	// And a live owner with NO createdAt must still hold — the dead-PID arm is
	// the only thing the fix widened.
	it("does not reclaim a live owner that has no createdAt", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-live-owner-"));
		tempDirs.push(dir);
		const lockPath = writeLock(dir, { pid: process.pid, token: "live" });

		await expect(
			acquireQuarantinePidFileLock(lockPath, {
				waitMs: 100,
				retryMs: 10,
				staleMs: 3_600_000,
				timeoutMessage: "live-owner lock timed out",
			}),
		).rejects.toThrow("live-owner lock timed out");
	});

	// Recurrence this prevents (#4907): `process.kill` refuses a pid above 2^31-1
	// (ERR_INVALID_ARG_TYPE), and the copy this seam replaced read it as dead, so
	// a live owner's fresh quarantine lock was reclaimed. The seam reads it alive.
	it("does not reclaim an owner pid above 2^31-1 that the OS refuses to signal", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-live-owner-"));
		tempDirs.push(dir);
		const lockPath = writeLock(dir, {
			pid: 3_000_000_000,
			createdAt: Date.now(),
			token: "huge",
		});

		await expect(
			acquireQuarantinePidFileLock(lockPath, {
				waitMs: 100,
				retryMs: 10,
				staleMs: 3_600_000,
				timeoutMessage: "huge-pid lock timed out",
			}),
		).rejects.toThrow("huge-pid lock timed out");
	});
});
