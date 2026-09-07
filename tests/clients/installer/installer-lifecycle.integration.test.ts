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
			// #2722: a layout PLAN (a JSON file of {path, content, mode} entries,
			// written by the test in TypeScript) rather than more generated-source
			// escaping — the intelephense case has to lay down a whole package tree
			// plus its `.bin` shim, which the inline string form cannot express
			// readably.
			"} else if (process.env.FAKE_NPM_LAYOUT) {",
			' const tools = path.join(process.env.PI_LENS_HOME, "tools");',
			' for (const file of JSON.parse(fs.readFileSync(process.env.FAKE_NPM_LAYOUT, "utf8"))) {',
			"  const target = path.join(tools, ...file.path);",
			"  fs.mkdirSync(path.dirname(target), { recursive: true });",
			"  fs.writeFileSync(target, file.content, file.mode ? { mode: file.mode } : undefined);",
			" }",
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

function runEnsure(
	env: NodeJS.ProcessEnv,
	toolId = "oxlint",
): Promise<{
	code: number | null;
	stdout: string;
	stderr: string;
}> {
	const id = JSON.stringify(toolId);
	const program =
		'import("./clients/installer/index.js").then(async m => {' +
		`const value = await m.ensureTool(${id}); await new Promise(r => setTimeout(r, 500));` +
		'const fs = await import("node:fs"); const path = await import("node:path");' +
		'let log = ""; try { log = fs.readFileSync(path.join(process.env.PI_LENS_HOME, "sessionstart.log"), "utf8"); } catch {}' +
		`console.log(JSON.stringify({ value, log, reason: m.getInstallFailureReason(${id}) }));` +
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

	it(
		"keeps a freshly installed intelephense and resolves it (#2722)",
		async () => {
			// The whole PRODUCTION call path: ensureTool -> installNpmTool -> the
			// package-manager spawn -> verification -> the cleanup decision, in a
			// real child process against a scratch PI_LENS_HOME.
			//
			// The installed package is intelephense's real shape: an entry module
			// that writes >2 MiB to stderr, then the #208 transport-required
			// marker, then exits 1. Node drops the piped tail at exit, so the
			// marker never reaches the verifier — which is why `--version`
			// verification cannot pass and, before this fix, the installer deleted
			// the package it had just installed.
			const root = tempDir();
			const home = path.join(root, "home");
			const { counter, script } = writeFakeNpm(root);
			const entrySource = [
				'process.stderr.write("x".repeat(2 * 1024 * 1024) + "\\n");',
				'process.stderr.write("Connection input stream is not set. Please use listen()\\n");',
				"process.exit(1);",
			].join("\n");
			const entryRelative = ["node_modules", "intelephense", "lib", "x.js"];
			const entryAbsolute = path.join(home, "tools", ...entryRelative);
			const layout = path.join(root, "intelephense-layout.json");
			fs.writeFileSync(
				layout,
				JSON.stringify([
					{
						path: ["node_modules", "intelephense", "package.json"],
						content: JSON.stringify({
							name: "intelephense",
							version: "1.18.5",
							bin: { intelephense: "./lib/x.js" },
						}),
					},
					{ path: entryRelative, content: entrySource },
					{
						path:
							process.platform === "win32"
								? ["node_modules", ".bin", "intelephense.cmd"]
								: ["node_modules", ".bin", "intelephense"],
						content:
							process.platform === "win32"
								? `@echo off\r\n"${process.execPath}" "${entryAbsolute}" %*\r\n`
								: `#!/bin/sh\nexec "${process.execPath}" "${entryAbsolute}" "$@"\n`,
						mode: process.platform === "win32" ? undefined : 0o750,
					},
				]),
			);
			const result = await runEnsure(
				{ ...testEnv(home, counter, script), FAKE_NPM_LAYOUT: layout },
				"intelephense",
			);
			expect(result.code, JSON.stringify(result)).toBe(0);
			const payload = JSON.parse(result.stdout) as {
				value?: string;
				log: string;
				reason?: string;
			};
			// The package survives on disk (acceptance 2) …
			expect(
				fs.existsSync(path.join(home, "tools", "node_modules", "intelephense")),
				payload.log,
			).toBe(true);
			// … the cleanup branch never ran …
			expect(payload.log).not.toContain(
				"installed but verification failed, cleaning up",
			);
			expect(payload.reason).toBeUndefined();
			// … and ensureTool hands back the real managed binary.
			expect(payload.value, payload.log).toBe(
				path.join(
					home,
					"tools",
					"node_modules",
					".bin",
					process.platform === "win32" ? "intelephense.cmd" : "intelephense",
				),
			);
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
