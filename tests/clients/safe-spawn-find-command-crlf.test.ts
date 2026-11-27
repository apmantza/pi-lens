/**
 * #4414 F3: `where` (Windows) prints one match per line with CRLF endings, and
 * `where tsc` lists both `tsc` and `tsc.cmd` for an npm-global install.
 * `findCommandAsync` split on `"\n"` only (its sync twin, deleted in #5410 S5,
 * did too), so the first match kept a trailing `\r` and `realpath` of it
 * rejected, which the TypeScript
 * server lookup read as "no compiler". Only the child-process boundary is
 * doubled; the output is the CRLF text `where` prints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "../support/fake-child.js";

const WHERE_OUTPUT =
	"C:\\Users\\a\\AppData\\Roaming\\npm\\tsc\r\nC:\\Users\\a\\AppData\\Roaming\\npm\\tsc.cmd\r\n";
const FIRST_MATCH = "C:\\Users\\a\\AppData\\Roaming\\npm\\tsc";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock, spawnSync: spawnSyncMock };
});

const { findCommandAsync } = await import("../../clients/safe-spawn.js");
const { resetProjectTrust, setProjectTrustState } =
	await import("../../clients/project-trust.js");

beforeEach(() => {
	// #4530: a Windows-shaped answer is a relative path to this host's trust
	// judgment (under the session cwd), so the session's trust is adopted; the
	// answer's trust judgment is pinned in session-repository-trust-4530.
	setProjectTrustState("trusted");
	spawnMock.mockReset();
	spawnSyncMock.mockReset();
});

afterEach(() => {
	resetProjectTrust();
});

describe("findCommandAsync keeps the first match free of CRLF (#4414)", () => {
	it("async: returns the first `where` line without a trailing carriage return", async () => {
		const finder = makeFakeChild(4243);
		spawnMock.mockImplementation((command: string) =>
			command === "which" || command === "where" ? finder : makeFakeChild(),
		);

		const found = findCommandAsync("tsc");
		// Let the call reach `spawn`, then feed the child its output and exit.
		for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
		finder.stdout.emit("data", WHERE_OUTPUT);
		finder.emit("exit", 0, null);
		finder.emit("close", 0, null);

		await expect(found).resolves.toBe(FIRST_MATCH);
	});
});
