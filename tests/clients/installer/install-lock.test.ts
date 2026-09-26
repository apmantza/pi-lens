/**
 * The shared tools install lock across versions (#3476). The lock is a
 * generation lock in `<tools>/.install.locks`; while installers from before
 * #3476 run, a holder also takes their `<tools>/.install.lock` file. The
 * double-takeover race and the exit release run real processes in
 * `installer-lifecycle.integration.test.ts`; these cases drive the lock in
 * this process through `acquireManagedInstallGate`.
 */
import fs from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// TOOLS_DIR is a module-level const: the home must be set before the
// installer module is imported.
const TEST_HOME = vi.hoisted(() => {
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-install-lock-"),
	);
	process.env.PI_LENS_HOME = dir;
	return dir;
});

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { acquireManagedInstallGate } from "../../../clients/installer/index.js";
import { withEnv } from "../../support/with-env.js";
import { removeTempDirSync } from "../test-utils.js";

const TOOLS_DIR = path.join(TEST_HOME, "tools");
const LEGACY = path.join(TOOLS_DIR, ".install.lock");
const GENERATIONS = path.join(TOOLS_DIR, ".install.locks");
/** Above any pid_max (Linux caps it at 2^22) and odd (Windows pids are not). */
const DEAD_PID = 2_147_483_647;

let restoreEnv: () => void;

beforeEach(() => {
	restoreEnv = withEnv({
		PI_LENS_DISABLE_TOOL_INSTALL: "0",
		PI_LENS_INSTALL_LOCK_TIMEOUT_MS: "150",
	});
	fs.mkdirSync(TOOLS_DIR, { recursive: true });
});

afterEach(() => {
	restoreEnv();
	fs.rmSync(LEGACY, { force: true });
	fs.rmSync(GENERATIONS, { recursive: true, force: true });
	resetDegradationLedger();
});

afterAll(() => removeTempDirSync(TEST_HOME));

function degradationCount(kind: string): number {
	return (
		getDegradationSummary().find((group) => group.kind === kind)?.count ?? 0
	);
}

function writeLegacy(content: string, ageMs = 0): void {
	fs.writeFileSync(LEGACY, content);
	const at = new Date(Date.now() - ageMs);
	fs.utimesSync(LEGACY, at, at);
}

function writeGeneration(pid: number, ageMs: number): void {
	fs.mkdirSync(GENERATIONS, { recursive: true });
	const lock = path.join(GENERATIONS, "lock.1");
	fs.writeFileSync(lock, `${pid} ${Date.now()}\n`);
	const at = new Date(Date.now() - ageMs);
	fs.utimesSync(lock, at, at);
}

describe("install lock across versions (#3476)", () => {
	// An installer from before #3476 takes only `.install.lock`, with `wx`.
	it("holds the pre-generation lock file while inside, so an older installer blocks", async () => {
		const gate = await acquireManagedInstallGate("test");
		expect(gate.ok).toBe(true);
		expect(() => fs.writeFileSync(LEGACY, "{}", { flag: "wx" })).toThrow(
			expect.objectContaining({ code: "EEXIST" }),
		);
		expect(JSON.parse(fs.readFileSync(LEGACY, "utf8")).pid).toBe(process.pid);
		await gate.release?.();
		expect(fs.existsSync(LEGACY)).toBe(false);
		expect(fs.readdirSync(GENERATIONS).sort()).toEqual([
			"lock.1",
			"lock.1.released",
		]);
		expect(
			getDegradationSummary().filter((group) =>
				group.kind.startsWith("generation-lock-"),
			),
		).toEqual([]);
	});

	it("waits out a live older installer's lock file without keeping its generation", async () => {
		const createdAt = Date.now();
		writeLegacy(JSON.stringify({ pid: process.pid, createdAt }));
		const gate = await acquireManagedInstallGate("test");
		expect(gate.ok).toBe(false);
		expect(gate.reason).toBe(
			`timed out after 150ms waiting for shared tools install lock (pid=${process.pid} createdAt=${createdAt})`,
		);
		// Review F2: the 150 ms wait makes two attempts; one back-off is recorded.
		expect(degradationCount("generation-lock-legacy-held")).toBe(1);
		fs.unlinkSync(LEGACY);
		// A generation kept by a back-off would hold this out for 180 s.
		const next = await acquireManagedInstallGate("test");
		expect(next.ok).toBe(true);
		await next.release?.();
	});

	// The pre-#3476 staleness rules, now applied only by a generation holder.
	it.each([
		[
			"names a dead pid",
			JSON.stringify({ pid: DEAD_PID, createdAt: Date.now() }),
			0,
		],
		[
			"is older than the install bound",
			JSON.stringify({ pid: process.pid, createdAt: Date.now() - 200_000 }),
			0,
		],
		["is unreadable and its mtime is past the bound", "", 200_000],
	])(
		"takes over an older installer's lock file that %s",
		async (_label, content, ageMs) => {
			writeLegacy(content, ageMs);
			const gate = await acquireManagedInstallGate("test");
			expect(gate.ok).toBe(true);
			expect(JSON.parse(fs.readFileSync(LEGACY, "utf8")).pid).toBe(process.pid);
			await gate.release?.();
		},
	);

	it("keeps a fresh unreadable lock file, which may be mid-write", async () => {
		writeLegacy("");
		const gate = await acquireManagedInstallGate("test");
		expect(gate.ok).toBe(false);
		expect(fs.readFileSync(LEGACY, "utf8")).toBe("");
	});

	// Issue comment on #3476: after an age-out takeover, the old owner's
	// release removed the new owner's lock by path.
	// #3476 review F3: release matched the old file by pid alone, so after a
	// same-process age-out takeover the superseded hold removed its
	// successor's file while the successor was inside.
	it("keeps its successor's lock file when a superseded hold in this process releases", async () => {
		const first = await acquireManagedInstallGate("test");
		expect(first.ok).toBe(true);
		const aged = new Date(Date.now() - 200_000);
		fs.utimesSync(path.join(GENERATIONS, "lock.1"), aged, aged);
		fs.writeFileSync(
			LEGACY,
			JSON.stringify({ pid: process.pid, createdAt: aged.getTime() }),
		);
		const second = await acquireManagedInstallGate("test");
		expect(second.ok).toBe(true);
		const successors = fs.readFileSync(LEGACY, "utf8");
		await first.release?.();
		expect(fs.readFileSync(LEGACY, "utf8")).toBe(successors);
		await second.release?.();
		expect(fs.existsSync(LEGACY)).toBe(false);
	});

	it("keeps an older installer's replacement lock file when it releases", async () => {
		const gate = await acquireManagedInstallGate("test");
		const theirs = JSON.stringify({ pid: DEAD_PID, createdAt: Date.now() });
		fs.writeFileSync(LEGACY, theirs);
		await gate.release?.();
		expect(fs.readFileSync(LEGACY, "utf8")).toBe(theirs);
	});

	it("takes over a live installer's generation only once the install bound has passed", async () => {
		writeGeneration(process.pid, 100_000);
		expect((await acquireManagedInstallGate("test")).ok).toBe(false);
		expect(degradationCount("generation-lock-stale-takeover")).toBe(0);
		writeGeneration(process.pid, 200_000);
		const gate = await acquireManagedInstallGate("test");
		expect(gate.ok).toBe(true);
		await gate.release?.();
		expect(degradationCount("generation-lock-stale-takeover")).toBe(1);
	});

	it("releases its generation when the old lock file cannot be created", async () => {
		const realWrite = fs.writeFileSync;
		let refused = 0;
		fs.writeFileSync = ((...args: Parameters<typeof realWrite>) => {
			if (args[0] === LEGACY) {
				refused += 1;
				throw Object.assign(new Error("EACCES: permission denied"), {
					code: "EACCES",
				});
			}
			return realWrite(...args);
		}) as typeof realWrite;
		syncBuiltinESMExports();
		try {
			await expect(acquireManagedInstallGate("test")).rejects.toThrow("EACCES");
		} finally {
			fs.writeFileSync = realWrite;
			syncBuiltinESMExports();
		}
		expect(refused).toBe(1);
		const gate = await acquireManagedInstallGate("test");
		expect(gate.ok).toBe(true);
		await gate.release?.();
	});
});
