/**
 * Tests for clients/log-cleanup.ts — global log retention/rotation.
 *
 * Guards the two bugs this file was created to fix:
 *   1. The rotated-backup deletion pattern had drifted from the actual backup
 *      naming (`name.<ISO-timestamp>.log`), so the 7-day retention sweep matched
 *      zero backups and they accumulated indefinitely.
 *   2. Three logs (actionable-warnings, ast-grep-tools, dead-code) were missing
 *      from the rotation list and grew unbounded.
 *
 * `runLogCleanup` reads the real ~/.pi-lens dir (module-level LOG_DIR), so we
 * exercise the exported building blocks against a temp dir instead.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupOldLogs,
	MANAGED_LOG_FILES,
	ROTATED_BACKUP_RE,
	rotateLogIfNeeded,
} from "../../clients/log-cleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-logclean-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, ageDays = 0): string {
	const p = path.join(dir, name);
	fs.writeFileSync(p, "x");
	if (ageDays > 0) {
		const t = new Date(Date.now() - ageDays * DAY_MS);
		fs.utimesSync(p, t, t);
	}
	return p;
}

describe("ROTATED_BACKUP_RE", () => {
	it("matches the current name.<timestamp>.log backup shape", () => {
		expect(ROTATED_BACKUP_RE.test("latency.2026-04-20T12-44-37-686Z.log")).toBe(
			true,
		);
	});

	it("matches the legacy name.log.<timestamp> shape", () => {
		expect(ROTATED_BACKUP_RE.test("latency.log.2026-04-20")).toBe(true);
	});

	it("never matches an active log", () => {
		for (const name of MANAGED_LOG_FILES) {
			expect(ROTATED_BACKUP_RE.test(name)).toBe(false);
		}
	});
});

describe("cleanupOldLogs on rotated backups", () => {
	it("deletes aged backups (both shapes) but keeps active + recent ones", () => {
		write("latency.log"); // active — no timestamp
		write("sessionstart.log", 400); // active but old — must survive
		const agedBackup = write("latency.2026-04-20T12-44-37-686Z.log", 30);
		const agedLegacy = write("cascade.log.2026-03-01", 30);
		const freshBackup = write("latency.2026-07-01T16-28-00-189Z.log", 2);

		const { deleted } = cleanupOldLogs(dir, ROTATED_BACKUP_RE, 7);

		expect(deleted.sort()).toEqual(
			["cascade.log.2026-03-01", "latency.2026-04-20T12-44-37-686Z.log"].sort(),
		);
		expect(fs.existsSync(agedBackup)).toBe(false);
		expect(fs.existsSync(agedLegacy)).toBe(false);
		expect(fs.existsSync(freshBackup)).toBe(true); // < 7d
		expect(fs.existsSync(path.join(dir, "latency.log"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "sessionstart.log"))).toBe(true);
	});
});

describe("rotate → delete round trip", () => {
	it("rotation produces a name the deletion pattern reaps", () => {
		const logFile = path.join(dir, "actionable-warnings.log");
		fs.writeFileSync(logFile, "x".repeat(2 * 1024 * 1024));

		const { rotated, newFile } = rotateLogIfNeeded(logFile, 1);

		expect(rotated).toBe(true);
		expect(newFile).toBeDefined();
		// the exact class of bug: the backup rotation writes must be reapable
		expect(ROTATED_BACKUP_RE.test(path.basename(newFile as string))).toBe(true);
		// a fresh active log is recreated and must NOT be reapable
		expect(ROTATED_BACKUP_RE.test("actionable-warnings.log")).toBe(false);
	});
});

describe("MANAGED_LOG_FILES", () => {
	it("includes the three previously-unrotated logs", () => {
		expect(MANAGED_LOG_FILES).toEqual(
			expect.arrayContaining([
				"actionable-warnings.log",
				"ast-grep-tools.log",
				"dead-code.log",
			]),
		);
	});
});
