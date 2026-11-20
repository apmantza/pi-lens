/**
 * Tests for clients/log-cleanup.ts — global log retention/rotation.
 *
 * Guards the bugs this file was created to fix:
 *   1. The rotated-backup deletion pattern had drifted from the actual backup
 *      naming (`name.<ISO-timestamp>.log`), so the 7-day retention sweep matched
 *      zero backups and they accumulated indefinitely.
 *   2. Three logs (actionable-warnings, ast-grep-tools, dead-code), and later
 *      bus-events.log, were missing from a hand-maintained rotation list and
 *      grew unbounded — twice. `getManagedLogFiles()` now derives the list
 *      instead of hand-maintaining it (see its doc comment in log-cleanup.ts):
 *      any `createNdjsonLogger` instance self-registers, so a new logger
 *      module gets rotation/summary coverage automatically.
 *
 * `runLogCleanup` reads the real ~/.pi-lens dir (module-level LOG_DIR), so we
 * exercise the exported building blocks against a temp dir instead.
 */

import * as net from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getManagedLogFiles,
	pidScopedSocketLiveness,
	ROTATED_BACKUP_RE,
	rotateLogIfNeeded,
} from "../../clients/log-cleanup.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { createNdjsonLogger } from "../../clients/ndjson-logger.js";
import { minTmpRootLength, removeTempDirSync } from "./test-utils.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-logclean-"));
});
afterEach(() => {
	removeTempDirSync(dir);
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
		const knownActiveLogs = [
			"latency.log",
			"sessionstart.log",
			"tree-sitter.log",
			"cascade.log",
			"read-guard.log",
			"actionable-warnings.log",
			"ast-grep-tools.log",
			"dead-code.log",
			"bus-events.log",
		];
		for (const name of knownActiveLogs) {
			expect(ROTATED_BACKUP_RE.test(name)).toBe(false);
		}
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

/**
 * #5702: `runLogCleanup` is the one retention seam. These cases enter through
 * it (the production entry point the session-start deferral calls) with
 * `PI_LENS_HOME`, `PILENS_DATA_DIR` and, where sockets are concerned,
 * `TMPDIR` pinned at per-test temp dirs, so the sweep never sees the real
 * home. The import is dynamic after `vi.resetModules()` because pre-#5702 the
 * module captured its directories at import time from those env vars.
 */
// Saved outside the teardown the way tests/clients/project-data-dir-slug.test.ts
// saves its pins, so the #4589 restore ratchet reads the coverage.
const savedRetainHome = process.env.PI_LENS_HOME;
const savedRetainDataDir = process.env.PILENS_DATA_DIR;
// CI runs with TMPDIR unset: assigning the saved `undefined` back writes the
// string "undefined", and every later mkdtemp in the file fails (#5707 r1 F2).
const savedRetainTmp = process.env.TMPDIR;

describe("runLogCleanup retention rows (#5702)", () => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const CURRENT_SESSION_ID = "01234567-89ab-4cde-8f01-23456789abcd";
	let home: string;
	let dataBase: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-retain-home-"));
		dataBase = path.join(home, "projects");
		process.env.PI_LENS_HOME = home;
		process.env.PILENS_DATA_DIR = dataBase;
	});

	afterEach(() => {
		if (savedRetainHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedRetainHome;
		if (savedRetainDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = savedRetainDataDir;
		removeTempDirSync(home);
	});

	/** A fresh module copy, so pre-#5702 import-time LOG_DIR honors the pin. */
	async function loadCleanup(): Promise<
		typeof import("../../clients/log-cleanup.js")
	> {
		vi.resetModules();
		return import("../../clients/log-cleanup.js");
	}

	function backdate(target: string, days: number): void {
		const t = new Date(Date.now() - days * DAY_MS);
		fs.utimesSync(target, t, t);
	}

	/** A project data dir the way the stores create one, then aged. */
	function seedProjectDataDir(root: string, ageDays: number): string {
		const dir = getProjectDataDir(root);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "metrics-history.json"), "{}");
		backdate(dir, ageDays);
		return dir;
	}

	/**
	 * A socket file with no listener behind it: bind, rename the bound file
	 * aside, then close — the close unlinks the server's own name and leaves
	 * the renamed socket file orphaned, which is exactly the signal-death
	 * shape D3 measured.
	 */
	async function seedStaleSocket(dir: string, name: string): Promise<void> {
		const bindName = path.join(dir, "bind-tmp.sock");
		const server = net.createServer(() => {});
		await new Promise<void>((resolve) => server.listen(bindName, resolve));
		fs.renameSync(bindName, path.join(dir, name));
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	async function seedLiveSocket(
		dir: string,
		name: string,
	): Promise<net.Server> {
		const server = net.createServer(() => {});
		await new Promise<void>((resolve) =>
			server.listen(path.join(dir, name), resolve),
		);
		return server;
	}

	it("removes an aged spill log and a rotated backup but keeps a fresh spill log and an active log", async () => {
		// The writer's own name derivation (tools/render-compact.ts spills
		// through it), so a naming drift between writer and reaper reds here
		// (#5707 r1 F4).
		const { spillResultLogName } = await import("../../clients/log-cleanup.js");
		const oldSpill = path.join(
			home,
			spillResultLogName(Date.now() - 40 * DAY_MS),
		);
		fs.writeFileSync(oldSpill, "x");
		backdate(oldSpill, 40);
		const freshSpill = path.join(
			home,
			`tool-result-${Date.now()}-${randomUUID()}.log`,
		);
		fs.writeFileSync(freshSpill, "x");
		const activeLog = path.join(home, "latency.log");
		fs.writeFileSync(activeLog, "x");
		backdate(activeLog, 400);
		const oldBackup = path.join(home, "latency.2026-04-20T12-44-37-686Z.log");
		fs.writeFileSync(oldBackup, "x");
		backdate(oldBackup, 40);
		const oldLegacyBackup = path.join(home, "cascade.log.2026-03-01");
		fs.writeFileSync(oldLegacyBackup, "x");
		backdate(oldLegacyBackup, 40);
		const freshBackup = path.join(home, "latency.2026-07-01T16-28-00-189Z.log");
		fs.writeFileSync(freshBackup, "x");
		backdate(freshBackup, 2);

		const { runLogCleanup } = await loadCleanup();
		const result = await runLogCleanup();

		expect(fs.existsSync(oldSpill)).toBe(false);
		expect(fs.existsSync(oldBackup)).toBe(false);
		expect(fs.existsSync(oldLegacyBackup)).toBe(false);
		expect(fs.existsSync(freshBackup)).toBe(true);
		expect(fs.existsSync(freshSpill)).toBe(true);
		expect(fs.existsSync(activeLog)).toBe(true);
		expect(result.report).toMatch(/spill log/);
	});

	it("removes an orphaned project data dir and keeps a live one, an unrecognized name and the ephemeral base", async () => {
		const liveRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-retain-root-live-"),
		);
		const orphanRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-retain-root-orphan-"),
		);
		// An orphan whose directory was touched inside the window stays,
		// whatever the root's fate: the window is the decode's failure-mode
		// guard, not the deletion criterion.
		const freshOrphanRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-retain-root-fresh-"),
		);
		try {
			const liveDir = seedProjectDataDir(liveRoot, 40);
			const orphanDir = seedProjectDataDir(orphanRoot, 40);
			fs.rmSync(orphanRoot, { recursive: true, force: true });
			const defaultNamed = path.join(dataBase, "default-01234567");
			fs.mkdirSync(defaultNamed, { recursive: true });
			backdate(defaultNamed, 400);
			const freshOrphanDir = seedProjectDataDir(freshOrphanRoot, 0);
			fs.rmSync(freshOrphanRoot, { recursive: true, force: true });
			const ephemeralBase = path.join(dataBase, ".ephemeral");
			fs.mkdirSync(ephemeralBase, { recursive: true });
			backdate(ephemeralBase, 400);
			// #5707 r1 F1: a live root whose last component's fold ends in a
			// dash names a slug the old per-component decode never matched.
			const dashRoot = path.join(liveRoot, "proj-");
			fs.mkdirSync(dashRoot);
			const dashDir = seedProjectDataDir(dashRoot, 40);
			// #5707 r1 F8: a plain file of slug shape in the base is not a
			// project data dir, whatever its name decodes to.
			const slugFile = path.join(dataBase, "backup-0a1b2c3d");
			fs.writeFileSync(slugFile, "x");
			backdate(slugFile, 400);

			const { runLogCleanup } = await loadCleanup();
			const result = await runLogCleanup();

			expect(fs.existsSync(orphanDir)).toBe(false);
			expect(fs.existsSync(freshOrphanDir)).toBe(true);
			expect(fs.existsSync(liveDir)).toBe(true);
			expect(fs.existsSync(defaultNamed)).toBe(true);
			expect(fs.existsSync(ephemeralBase)).toBe(true);
			expect(fs.existsSync(dashDir)).toBe(true);
			expect(fs.existsSync(slugFile)).toBe(true);
			expect(result.report).toMatch(/1 orphaned project data dirs/);
		} finally {
			removeTempDirSync(liveRoot);
			removeTempDirSync(orphanRoot);
			removeTempDirSync(freshOrphanRoot);
		}
	});

	it("removes an old session state file but keeps the current session's and a fresh one", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-retain-root-sessions-"),
		);
		try {
			const dir = seedProjectDataDir(root, 0);
			const sessions = path.join(dir, "sessions");
			fs.mkdirSync(sessions, { recursive: true });
			const oldOther = path.join(
				sessions,
				"99991111-2222-4c33-8d44-555566667777.json",
			);
			fs.writeFileSync(oldOther, "{}");
			backdate(oldOther, 40);
			const currentOld = path.join(sessions, `${CURRENT_SESSION_ID}.json`);
			fs.writeFileSync(currentOld, "{}");
			backdate(currentOld, 40);
			const freshOther = path.join(
				sessions,
				"aaaabbbb-cccc-4ddd-8eee-ffff00001111.json",
			);
			fs.writeFileSync(freshOther, "{}");
			// Not a state file the store writes: the row's name pattern keeps it.
			const notState = path.join(sessions, "notes.txt");
			fs.writeFileSync(notState, "x");
			backdate(notState, 40);

			const { runLogCleanup } = await loadCleanup();
			const result = await runLogCleanup(undefined, {
				cwd: root,
				currentSessionId: CURRENT_SESSION_ID,
			});

			expect(fs.existsSync(oldOther)).toBe(false);
			expect(fs.existsSync(currentOld)).toBe(true);
			expect(fs.existsSync(freshOther)).toBe(true);
			expect(fs.existsSync(notState)).toBe(true);
			expect(result.report).toMatch(/session state file/);
		} finally {
			removeTempDirSync(root);
		}
	});

	it("keeps the current session's state file under the name the store wrote it, for an id the store sanitizes", async () => {
		// Recurrence: #5707 CodeRabbit 7n. The exemption compared the raw id
		// with the file name, so an id the store sanitizes (`team/session` is
		// stored as `team_session.json`) lost its exemption and the live
		// session's snapshot was reaped once it idled past the window.
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-retain-root-sanitized-"),
		);
		try {
			const sessionId = "team/session";
			const { saveSessionState } =
				await import("../../clients/session-state-store.js");
			await saveSessionState(root, sessionId, {});
			const sessions = path.join(getProjectDataDir(root), "sessions");
			const stored = fs.readdirSync(sessions);
			expect(stored).toHaveLength(1);
			const storedPath = path.join(sessions, stored[0] as string);
			backdate(storedPath, 40);

			const { runLogCleanup } = await loadCleanup();
			await runLogCleanup(undefined, {
				cwd: root,
				currentSessionId: sessionId,
			});

			expect(fs.existsSync(storedPath)).toBe(true);
		} finally {
			removeTempDirSync(root);
		}
	});

	it("counts a failed delete once per run instead of throwing (decision 3)", async () => {
		// A directory where the spill row expects a file: unlinkSync fails
		// EISDIR, the sweep counts it, and the remaining entries still run.
		const blocker = path.join(
			home,
			`tool-result-${Date.now() - 40 * DAY_MS}-${randomUUID()}.log`,
		);
		fs.mkdirSync(blocker, { recursive: true });
		backdate(blocker, 40);
		const removable = path.join(
			home,
			`tool-result-${Date.now() - 41 * DAY_MS}-${randomUUID()}.log`,
		);
		fs.writeFileSync(removable, "x");
		backdate(removable, 41);

		const { runLogCleanup } = await loadCleanup();
		const dbgLines: string[] = [];
		const result = await runLogCleanup((msg) => dbgLines.push(msg));

		expect(result.report).toMatch(/1 deletions failed/);
		expect(fs.existsSync(blocker)).toBe(true);
		expect(fs.existsSync(removable)).toBe(false);
		expect(dbgLines).toContainEqual(
			expect.stringMatching(/1 deletions failed; first: tool-result-/),
		);
	});

	// lane: Unit tests (a short CI TMPDIR always has room); a dev box whose
	// probe home is too deep for the seeded socket names skips, the same
	// guard tests/clients/mcp/ipc.test.ts applies to its own socket seeds.
	const SUN_PATH_LIMIT = 104;
	const socketSeedNeeds =
		minTmpRootLength() +
		1 +
		"pi-lens-retain-sock-XXXXXX".length +
		1 +
		"pi-lens-mcp-999999-diagnostics-fedcba9876543210.sock".length;
	const socketTestLacksRoom = socketSeedNeeds > SUN_PATH_LIMIT;

	it.skipIf(socketTestLacksRoom)(
		"removes stale sockets of both name shapes and keeps a live listener, a live owner pid and a non-socket file",
		async () => {
			const socketDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-retain-sock-"),
			);
			let liveServer: net.Server | undefined;
			try {
				process.env.TMPDIR = socketDir;
				// The row's window is 1 day, so the seeds are aged past it: a socket
				// whose owner just died lingers until the next sweep, which is the
				// same grace every row gives a fresh file.
				const ageStale = (name: string): void =>
					backdate(path.join(socketDir, name), 2);
				await seedStaleSocket(socketDir, "pi-lens-mcp-0123456789abcdef.sock");
				ageStale("pi-lens-mcp-0123456789abcdef.sock");
				await seedStaleSocket(
					socketDir,
					"pi-lens-mcp-999999-diagnostics-fedcba9876543210.sock",
				);
				ageStale("pi-lens-mcp-999999-diagnostics-fedcba9876543210.sock");
				// Every keep below is aged past the 1-day window, so the guard named
				// beside it is what keeps it, not the window (#5707 r1 F4).
				liveServer = await seedLiveSocket(
					socketDir,
					"pi-lens-mcp-9876543210fedcba.sock",
				);
				ageStale("pi-lens-mcp-9876543210fedcba.sock");
				const livePid = path.join(
					socketDir,
					`pi-lens-mcp-${process.pid}-diagnostics-0123456789abcdef.sock`,
				);
				await seedStaleSocket(socketDir, path.basename(livePid));
				ageStale(path.basename(livePid));
				const notASocket = path.join(
					socketDir,
					"pi-lens-mcp-ffffffffffffffff.sock",
				);
				fs.writeFileSync(notASocket, "x");
				backdate(notASocket, 2);
				// A socket whose owner just died is inside the row's 1-day window:
				// the next sweep reaps it, this one leaves it.
				const freshStale = path.join(
					socketDir,
					"pi-lens-mcp-1111111122222222.sock",
				);
				await seedStaleSocket(socketDir, path.basename(freshStale));
				const unrelated = path.join(socketDir, "unrelated.sock");
				fs.writeFileSync(unrelated, "x");
				backdate(unrelated, 2);
				// Another application's dead socket: the name classifier refuses
				// it, whatever its listener state.
				await seedStaleSocket(socketDir, "other-app.sock");
				ageStale("other-app.sock");

				const { runLogCleanup } = await loadCleanup();
				const result = await runLogCleanup();

				expect(
					fs.existsSync(
						path.join(socketDir, "pi-lens-mcp-0123456789abcdef.sock"),
					),
				).toBe(false);
				expect(
					fs.existsSync(
						path.join(
							socketDir,
							"pi-lens-mcp-999999-diagnostics-fedcba9876543210.sock",
						),
					),
				).toBe(false);
				expect(
					fs.existsSync(
						path.join(socketDir, "pi-lens-mcp-9876543210fedcba.sock"),
					),
				).toBe(true);
				expect(fs.existsSync(path.join(socketDir, "other-app.sock"))).toBe(
					true,
				);
				expect(fs.existsSync(livePid)).toBe(true);
				expect(fs.existsSync(freshStale)).toBe(true);
				expect(fs.existsSync(notASocket)).toBe(true);
				expect(fs.existsSync(unrelated)).toBe(true);
				expect(result.report).toMatch(/stale socket/);
			} finally {
				if (savedRetainTmp === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = savedRetainTmp;
				await new Promise<void>((resolve) =>
					liveServer?.close(() => resolve()),
				);
				removeTempDirSync(socketDir);
			}
		},
	);

	// lane: Unit tests. Root skips: root's connect ignores the socket's mode,
	// so the dial answers "dead" and the cell this case pins cannot arise.
	it.skipIf(socketTestLacksRoom || process.getuid?.() === 0)(
		"keeps an aged workspace socket whose dial neither connects nor proves the listener gone",
		async () => {
			// Recurrence: #5707 r1 F4 found the dial's indeterminate arm
			// mapped to stale with every test green; a socket the sweep cannot
			// judge (here EACCES on connect) must stay.
			const socketDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-retain-sock-"),
			);
			const name = "pi-lens-mcp-abcdefabcdefabcd.sock";
			try {
				process.env.TMPDIR = socketDir;
				await seedStaleSocket(socketDir, name);
				fs.chmodSync(path.join(socketDir, name), 0o000);
				backdate(path.join(socketDir, name), 2);

				const { runLogCleanup } = await loadCleanup();
				await runLogCleanup();

				expect(fs.existsSync(path.join(socketDir, name))).toBe(true);
			} finally {
				if (savedRetainTmp === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = savedRetainTmp;
				removeTempDirSync(socketDir);
			}
		},
	);
});

describe("pidScopedSocketLiveness (#5702)", () => {
	it("a dead owner is stale: nobody can ever bind that name again", () => {
		expect(pidScopedSocketLiveness(4242, () => "esrch")).toBe("stale");
	});

	it("an alive owner is live", () => {
		expect(pidScopedSocketLiveness(4242, () => "alive")).toBe("live");
	});

	it("a probe the process refuses to answer keeps the socket: judging it would reap another user's live listener", () => {
		expect(pidScopedSocketLiveness(4242, () => "refused")).toBe(
			"indeterminate",
		);
	});
});

describe("getManagedLogFiles — auto-derivation", () => {
	it("picks up a createNdjsonLogger instance via self-registration (registry path)", () => {
		// This is the mechanism that would have caught the bus-events.log gap
		// automatically: constructing a logger against `dir` is exactly what
		// every `*-logger.ts` module does at its own top level, and that alone
		// — with zero edits to log-cleanup.ts — is enough for it to show up
		// here.
		createNdjsonLogger({ filePath: path.join(dir, "new-subsystem.log") });

		expect(getManagedLogFiles(dir)).toContain("new-subsystem.log");
	});

	it("matches registered paths when the directory uses Windows separators", () => {
		createNdjsonLogger({ filePath: path.join(dir, "separator-safe.log") });
		const slashVariant = dir.replace(/\\/g, "/");

		expect(getManagedLogFiles(slashVariant)).toContain("separator-safe.log");
	});

	it("does not register a lazy (function) filePath — those are logs/*.jsonl territory", () => {
		createNdjsonLogger({ filePath: () => path.join(dir, "dated.jsonl") });

		expect(getManagedLogFiles(dir)).not.toContain("dated.jsonl");
	});

	it("does not leak a registration made against a different directory", () => {
		const otherDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-logclean-other-"),
		);
		try {
			createNdjsonLogger({ filePath: path.join(otherDir, "elsewhere.log") });
			expect(getManagedLogFiles(dir)).not.toContain("elsewhere.log");
		} finally {
			removeTempDirSync(otherDir);
		}
	});

	it("backstops a .log file on disk that was never registered (import-order safety net)", () => {
		// Simulates a logger module that hasn't self-registered yet (e.g. it's
		// only dynamically imported) but has already written a file.
		write("unregistered.log");

		expect(getManagedLogFiles(dir)).toContain("unregistered.log");
	});

	it("excludes rotated-backup names from the disk backstop", () => {
		write("latency.2026-04-20T12-44-37-686Z.log");
		write("cascade.log.2026-03-01");

		const managed = getManagedLogFiles(dir);
		expect(managed).not.toContain("latency.2026-04-20T12-44-37-686Z.log");
		expect(managed).not.toContain("cascade.log.2026-03-01");
	});

	it("includes bus-events.log once its logger is constructed — the #551 gap this PR closes", () => {
		createNdjsonLogger({ filePath: path.join(dir, "bus-events.log") });

		expect(getManagedLogFiles(dir)).toContain("bus-events.log");
	});
});
