/**
 * Recurrence this guards: AGENTS.md shape 83 (a rule re-derived beside its
 * owner). `installArchiveTool` pinned the Windows archive extractors
 * (`tar.exe`, `powershell.exe`) with its own copy of the System32 spelling,
 * beside `windowsExe`, the seam every other System32 spawn names through
 * (`scripts/lib/process-scan.mjs`).
 *
 * Through the production installer (`installTool`) on the installer's own
 * platform seam (`PI_LENS_TEST_PLATFORM=win32`), with `SystemRoot` spelled so
 * that raw concatenation and the seam's normalized Windows path differ
 * (forward slashes, a trailing slash). Doubled at true boundaries only:
 * `node:https` (the download) and the extractor process, which answers a
 * failed extraction so the install stops right after the spawn under test.
 * The registry entry's sha256 pin is patched through the exported `TOOLS` so
 * the fixture archive verifies.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { removeTempDirSync } from "../test-utils.js";

vi.unmock("../../../clients/installer/index.js");

const { httpsGetMock, extractorCalls } = vi.hoisted(() => ({
	httpsGetMock: vi.fn(),
	extractorCalls: [] as Array<{ command: string; args: string[] }>,
}));

vi.mock("node:https", () => ({
	default: { get: httpsGetMock },
	get: httpsGetMock,
}));

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: vi.fn(async (command: string, args: string[]) => {
		extractorCalls.push({ command, args });
		return { stdout: "", stderr: "", status: 1 };
	}),
}));

const ARCHIVE = Buffer.from("FIXTURE-ARCHIVE-BYTES-SYSTEM32\n");

httpsGetMock.mockImplementation(
	(_url: string, _options: unknown, callback: (res: EventEmitter) => void) => {
		const request = new EventEmitter();
		queueMicrotask(() => {
			const res = new EventEmitter() as EventEmitter & {
				statusCode: number;
				headers: Record<string, string>;
				resume: () => void;
			};
			res.statusCode = 200;
			res.headers = {};
			res.resume = () => {};
			callback(res);
			queueMicrotask(() => {
				res.emit("data", ARCHIVE);
				res.emit("end");
			});
		});
		return request;
	},
);

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"PI_LENS_HOME",
	"PI_LENS_DISABLE_TOOL_INSTALL",
	"PI_LENS_TEST_PLATFORM",
	"SystemRoot",
];

beforeEach(() => {
	extractorCalls.length = 0;
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
	process.env.PI_LENS_TEST_PLATFORM = "win32";
	process.env.SystemRoot = "Z:/Sentinel Root/";
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-system32-arc-"));
	roots.push(home);
	process.env.PI_LENS_HOME = home;
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

afterAll(() => {
	for (const root of roots) removeTempDirSync(root);
});

/** Install `toolId` and answer the extractor spawn the installer made. */
async function extractorFor(toolId: string): Promise<{
	command: string;
	args: string[];
}> {
	vi.resetModules();
	const installer = await import("../../../clients/installer/index.js");
	const spec = installer.TOOLS.find((tool) => tool.id === toolId)?.archive;
	if (!spec?.sha256 || typeof spec.url !== "string")
		throw new Error(`${toolId} archive spec changed shape`);
	spec.sha256[spec.url] = createHash("sha256").update(ARCHIVE).digest("hex");
	await installer.installTool(toolId);
	const call = extractorCalls[0];
	if (!call) throw new Error(`${toolId}: the installer never spawned`);
	return call;
}

describe("the Windows archive extractors are named through the System32 seam", () => {
	it("a .tgz archive is extracted with the pinned tar.exe", async () => {
		const call = await extractorFor("spotbugs");
		expect(call.command).toBe("Z:\\Sentinel Root\\System32\\tar.exe");
		expect(call.args[0]).toBe("-xzf");
	});

	it("a .zip archive is extracted with the pinned powershell.exe", async () => {
		const call = await extractorFor("kotlin-language-server");
		expect(call.command).toBe(
			"Z:\\Sentinel Root\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		);
		expect(call.args[0]).toBe("-NoProfile");
	});
});
