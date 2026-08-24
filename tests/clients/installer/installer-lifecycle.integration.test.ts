import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-installer-945-"));
	tempDirs.push(dir);
	return dir;
}

function writeFakeNpm(dir: string): {
	binDir: string;
	counter: string;
	script: string;
} {
	const binDir = path.join(dir, "fake-bin");
	const counter = path.join(dir, "installs.log");
	fs.mkdirSync(binDir, { recursive: true });
	const script = path.join(binDir, "fake-npm.cjs");
	fs.writeFileSync(
		script,
		[
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'const { spawn } = require("node:child_process");',
			'fs.appendFileSync(process.env.FAKE_NPM_COUNTER, "install\\n");',
			'if (process.env.FAKE_NPM_SLOW === "1") {',
			' const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
			" fs.writeFileSync(process.env.FAKE_NPM_CHILD_PID, String(child.pid));",
			" setInterval(() => {}, 1000);",
			"} else {",
			' const bin = path.join(process.env.PI_LENS_HOME, "tools", "node_modules", ".bin");',
			" fs.mkdirSync(bin, { recursive: true });",
			process.platform === "win32"
				? ' fs.writeFileSync(path.join(bin, "oxlint.cmd"), "@echo off\\r\\necho oxlint 1.0.0\\r\\n");'
				: ' fs.writeFileSync(path.join(bin, "oxlint"), "#!/bin/sh\\necho oxlint 1.0.0\\n", { mode: 0o750 });',
			"}",
		].join("\n"),
	);
	if (process.platform === "win32") {
		fs.writeFileSync(
			path.join(binDir, "npm.cmd"),
			`@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
		);
	} else {
		fs.writeFileSync(
			path.join(binDir, "npm"),
			`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
			{ mode: 0o750 },
		);
	}
	return { binDir, counter, script };
}

function runEnsure(env: NodeJS.ProcessEnv): Promise<{
	code: number | null;
	stdout: string;
	stderr: string;
}> {
	const program =
		'import("./clients/installer/index.js").then(async m => {' +
		'const value = await m.ensureTool("oxlint"); await new Promise(r => setTimeout(r, 500));' +
		'const fs = await import("node:fs"); const path = await import("node:path");' +
		'let log = ""; try { log = fs.readFileSync(path.join(process.env.PI_LENS_HOME, "sessionstart.log"), "utf8"); } catch {}' +
		'console.log(JSON.stringify({ value, log, reason: m.getInstallFailureReason("oxlint") }));' +
		"}).catch(e => { console.error(e); process.exitCode = 1; });";
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["-e", program], {
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => (stdout += data));
		child.stderr.on("data", (data) => (stderr += data));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

function testEnv(
	home: string,
	counter: string,
	script: string,
): NodeJS.ProcessEnv {
	const nodeDir = path.dirname(process.execPath);
	// #2015: verifyToolBinary routes through safeSpawnAsync, whose Windows
	// .cmd/.bat wrapper runs `chcp ... & <shim>` (clients/safe-spawn.ts).
	// Since #2023 chcp is invoked via its pinned System32 absolute path, so
	// System32 no longer HAS to be on PATH; keeping it here exercises the
	// restricted-PATH scenario without depending on the pin. Node's dir stays
	// first so the restricted PATH still cannot collide with a real oxlint.
	const toolPath =
		process.platform === "win32"
			? `${nodeDir};${process.env.SystemRoot ?? "C:\\Windows"}\\System32`
			: nodeDir;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_LENS_HOME: home,
		PI_LENS_DISABLE_TOOL_INSTALL: "0",
		PI_LENS_DEBUG: "1",
		PI_LENS_TEST_MODE: "1",
		PI_LENS_TEST_NPM_SCRIPT: script,
		FAKE_NPM_COUNTER: counter,
	};
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "path") delete env[key];
	}
	env.PATH = toolPath;
	return env;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
});

describe("installer process lifecycle (#945)", () => {
	// These tests spawn REAL child node processes that run the full ensureTool
	// flow (discovery probes, the install lock, the package-manager spawn, and
	// — since #2015 routes verifyToolBinary through safeSpawnAsync — the
	// cmd.exe-wrapped shim verification). Under parallel vitest workers a
	// single run can legitimately take several seconds, so the 5s default
	// test budget is too tight (same reasoning as tool-discovery.test.ts's
	// 30s installTool budget). 15s still catches a true hang.
	const REAL_PROCESS_TIMEOUT_MS = 15_000;

	it.skipIf(process.platform !== "win32")(
		"kills a fake npm's complete Windows process tree on timeout",
		async () => {
			const root = tempDir();
			const home = path.join(root, "home");
			const childPidFile = path.join(root, "child.pid");
			const { counter, script } = writeFakeNpm(root);
			const result = await runEnsure({
				...testEnv(home, counter, script),
				FAKE_NPM_SLOW: "1",
				FAKE_NPM_CHILD_PID: childPidFile,
				PI_LENS_INSTALL_TIMEOUT_MS: "500",
			});
			expect(result.code).toBe(0);
			expect(fs.existsSync(childPidFile), JSON.stringify(result)).toBe(true);
			const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(pidAlive(childPid)).toBe(false);
		},
		REAL_PROCESS_TIMEOUT_MS,
	);

	it(
		"serializes two processes so exactly one package-manager install runs",
		async () => {
			const root = tempDir();
			const home = path.join(root, "home");
			const { counter, script } = writeFakeNpm(root);
			const env = testEnv(home, counter, script);
			const results = await Promise.all([runEnsure(env), runEnsure(env)]);
			expect(results.map((result) => result.code)).toEqual([0, 0]);
			expect(fs.existsSync(counter), JSON.stringify(results)).toBe(true);
			expect(
				fs.readFileSync(counter, "utf8").trim().split(/\r?\n/),
			).toHaveLength(1);
			expect(results.every((result) => /oxlint/.test(result.stdout))).toBe(
				true,
			);
		},
		REAL_PROCESS_TIMEOUT_MS,
	);

	it(
		"reports disabled installation and never spawns the package manager",
		async () => {
			const root = tempDir();
			const home = path.join(root, "home");
			const { counter, script } = writeFakeNpm(root);
			const result = await runEnsure({
				...testEnv(home, counter, script),
				PI_LENS_DISABLE_TOOL_INSTALL: "1",
			});
			expect(result.code).toBe(0);
			const payload = JSON.parse(result.stdout) as { reason?: string };
			expect(payload.reason).toBe(
				"installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
			);
			expect(fs.existsSync(counter)).toBe(false);
		},
		REAL_PROCESS_TIMEOUT_MS,
	);

	it("ordinary Vitest execution has tool installation disabled", () => {
		expect(process.env.PI_LENS_DISABLE_TOOL_INSTALL).toBe("1");
	});

	// A literal parent-exit orphan test is intentionally omitted: racing the test
	// harness against Windows process teardown is flaky. The deterministic timeout
	// case above exercises the same taskkill /T descendant-tree primitive.
});
