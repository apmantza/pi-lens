/**
 * #5694: which npm `.cmd` shims `launchLSP` may replace by the Node script they
 * name, so the server is pi's direct child on Windows and ends with it.
 *
 * Reading a shim wrong starts the server with arguments or an environment the
 * shim never gave it, so the reader admits the `cmd-shim` templates line for
 * line and refuses everything else; a refused shim keeps `cmd.exe`, which is
 * the behaviour every shim had before #5694. The reader is pure text, so these
 * cases run on every lane; the spawn they feed is pinned on Windows by
 * tests/clients/lsp/windows-server-containment-5694.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	parseNpmCmdShim,
	resolveNpmCmdShim,
} from "../../../clients/lsp/launch.js";
import { setupTestEnvironment, useTrackedTempDirs } from "../test-utils.js";

const HEAD = [
	"@ECHO off",
	"GOTO start",
	":find_dp0",
	"SET dp0=%~dp0",
	"EXIT /b",
	":start",
	"SETLOCAL",
	"CALL :find_dp0",
];

/** npm cmd-shim 6.0.0 (npm 9, 10), as its `writeShim_` renders a node bin. */
function cmdShimV6(
	target: string,
	options: { vars?: string[]; args?: string; prog?: string } = {},
): string {
	const prog = options.prog ?? "node";
	return [
		...HEAD,
		...(options.vars ?? []),
		"",
		`IF EXIST "%dp0%\\${prog}.exe" (`,
		`  SET "_prog=%dp0%\\${prog}.exe"`,
		") ELSE (",
		`  SET "_prog=${prog}"`,
		"  SET PATHEXT=%PATHEXT:;.JS;=;%",
		")",
		"",
		`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${options.args ?? ""} "%dp0%\\${target}" %*`,
		"",
	].join("\r\n");
}

/** npm cmd-shim 7 (npm 11): PATHEXT moved onto the run line. */
function cmdShimV7(target: string): string {
	return [
		...HEAD,
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		'  SET "_prog=node"',
		")",
		"",
		`set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*`,
		"",
	].join("\n");
}

const TARGET = "..\\typescript-language-server\\lib\\cli.mjs";

useTrackedTempDirs("pi-lens-cmd-shim-");

describe("parseNpmCmdShim (#5694)", () => {
	it("reads the script an npm 9/10 shim runs under node", () => {
		expect(parseNpmCmdShim(cmdShimV6(TARGET))).toBe(TARGET);
	});

	it("reads the script an npm 11 shim runs under node", () => {
		expect(parseNpmCmdShim(cmdShimV7(TARGET))).toBe(TARGET);
	});

	// Recurrence guarded: a shim whose shebang sets variables (`env -S VAR=…
	// node`) renders `@SET` lines; spawning node without them drops the
	// server's environment.
	it("refuses a shim that sets variables", () => {
		expect(
			parseNpmCmdShim(
				cmdShimV6(TARGET, {
					vars: ["@SET NODE_OPTIONS=--max-old-space-size=4096"],
				}),
			),
		).toBeUndefined();
	});

	// Recurrence guarded: interpreter flags from the shebang sit between
	// "%_prog%" and the script; dropping them changes how the server runs.
	it("refuses a shim that passes interpreter flags", () => {
		expect(
			parseNpmCmdShim(cmdShimV6(TARGET, { args: "--experimental-vm-modules" })),
		).toBeUndefined();
	});

	// Recurrence guarded: a shim for another interpreter (`#!/usr/bin/env
	// deno`) must not be run under node.
	it("refuses a shim for another interpreter", () => {
		expect(
			parseNpmCmdShim(cmdShimV6(TARGET, { prog: "deno" })),
		).toBeUndefined();
	});

	// Recurrence guarded: a line outside the template is a command the reader
	// does not understand, and it would be skipped.
	it("refuses a shim with a line the template does not have", () => {
		expect(
			parseNpmCmdShim(`${cmdShimV6(TARGET)}EXIT /b %errorlevel%\r\n`),
		).toBeUndefined();
	});

	it("refuses the npm 6 and pnpm shim forms", () => {
		const npm6 = [
			'@IF EXIST "%~dp0\\node.exe" (',
			`  "%~dp0\\node.exe"  "%~dp0\\${TARGET}" %*`,
			") ELSE (",
			"  @SETLOCAL",
			"  @SET PATHEXT=%PATHEXT:;.JS;=;%",
			`  node  "%~dp0\\${TARGET}" %*`,
			")",
		].join("\r\n");
		const pnpm = [
			"@SETLOCAL",
			'@IF EXIST "%~dp0\\node.exe" (',
			`  "%~dp0\\node.exe"  "%~dp0\\${TARGET}" %*`,
			") ELSE (",
			"  @SET PATHEXT=%PATHEXT:;.JS;=;%",
			`  node  "%~dp0\\${TARGET}" %*`,
			")",
		].join("\r\n");
		expect([parseNpmCmdShim(npm6), parseNpmCmdShim(pnpm)]).toEqual([
			undefined,
			undefined,
		]);
	});
});

describe("resolveNpmCmdShim (#5694)", () => {
	beforeEach(() => resetDegradationLedger());

	/** The `lsp-server-uncontained` reasons recorded for one shim. */
	function uncontained(shim: string): string[] {
		return getDegradationSummary()
			.filter((group) => group.kind === "lsp-server-uncontained")
			.flatMap((group) => group.latestReasons)
			.filter((entry) => entry.subject === shim)
			.map((entry) => entry.reason);
	}

	/** `<root>/node_modules/.bin/typescript-language-server.cmd`, and the path
	 *  of the script it names (relative to its own directory), not created. */
	function plantShim(content: string) {
		const root = setupTestEnvironment("pi-lens-cmd-shim-").tmpDir;
		const bin = path.join(root, "node_modules", ".bin");
		fs.mkdirSync(bin, { recursive: true });
		const shim = path.join(bin, "typescript-language-server.cmd");
		fs.writeFileSync(shim, content);
		const script = path.resolve(bin, TARGET.replace(/\\/g, path.sep));
		return { root, bin, shim, script };
	}

	function plantFile(file: string): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "");
	}

	it("runs the node.exe beside the shim, as the shim's IF EXIST does", () => {
		const planted = plantShim(cmdShimV6(TARGET));
		plantFile(planted.script);
		plantFile(path.join(planted.bin, "node.exe"));
		expect(resolveNpmCmdShim(planted.shim, planted.root, { PATH: "" })).toEqual(
			{
				program: path.join(planted.bin, "node.exe"),
				script: path.join(
					planted.root,
					"node_modules",
					"typescript-language-server",
					"lib",
					"cli.mjs",
				),
			},
		);
	});

	// Recurrence guarded: a shim whose package was removed exits 1 under
	// cmd.exe, which the launcher reports as a failed start; running node on a
	// missing script would bypass that report.
	it("keeps cmd.exe when the script the shim names is missing", () => {
		const planted = plantShim(cmdShimV6(TARGET));
		plantFile(path.join(planted.bin, "node.exe"));
		expect({
			resolved: resolveNpmCmdShim(planted.shim, planted.root, { PATH: "" }),
			recorded: uncontained(planted.shim),
		}).toEqual({
			resolved: undefined,
			recorded: [expect.stringContaining("its script is not a file")],
		});
	});

	// Recurrence guarded: a shim the reader refuses runs behind cmd.exe and
	// outlives a killed pi; without a record nothing says which server leaks.
	it("records a shim that is not an npm template as uncontained", () => {
		const planted = plantShim("@ECHO off\r\nnode server.js %*\r\n");
		expect({
			resolved: resolveNpmCmdShim(planted.shim, planted.root, { PATH: "" }),
			recorded: uncontained(planted.shim),
		}).toEqual({
			resolved: undefined,
			recorded: [
				"typescript-language-server.cmd runs behind cmd.exe, so its server outlives a pi that is killed: not an npm cmd-shim template",
			],
		});
	});

	// The PATH search is Windows' own (PATHEXT), so these two cells need a
	// Windows host.
	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"runs the node.exe the child's PATH answers when none sits beside the shim",
		() => {
			const planted = plantShim(cmdShimV6(TARGET));
			plantFile(planted.script);
			const nodeDir = path.join(planted.root, "node-dir");
			plantFile(path.join(nodeDir, "node.exe"));
			expect(
				resolveNpmCmdShim(planted.shim, planted.root, {
					PATH: nodeDir,
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				})?.program.toLowerCase(),
			).toBe(path.join(nodeDir, "node.exe").toLowerCase());
		},
	);

	// Recurrence guarded: a PATH `node` that is itself a `.cmd` (a version
	// manager's shim) cannot be spawned without cmd.exe; Node refuses a `.cmd`
	// with `shell: false`, so the server would fail to start.
	// lane: windows-vitest
	it.runIf(process.platform === "win32")(
		"keeps cmd.exe when the child's PATH answers node with a script",
		() => {
			const planted = plantShim(cmdShimV6(TARGET));
			plantFile(planted.script);
			const nodeDir = path.join(planted.root, "node-dir");
			plantFile(path.join(nodeDir, "node.cmd"));
			expect({
				resolved: resolveNpmCmdShim(planted.shim, planted.root, {
					PATH: nodeDir,
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				}),
				recorded: uncontained(planted.shim),
			}).toEqual({
				resolved: undefined,
				recorded: [expect.stringContaining("not an .exe")],
			});
		},
	);

	// Recurrence guarded: with no node.exe beside the shim and none on the
	// child's PATH, there is no program to run directly.
	it("keeps cmd.exe when no Node program answers", () => {
		const planted = plantShim(cmdShimV6(TARGET));
		plantFile(planted.script);
		expect({
			resolved: resolveNpmCmdShim(planted.shim, planted.root, { PATH: "" }),
			recorded: uncontained(planted.shim),
		}).toEqual({
			resolved: undefined,
			recorded: [expect.stringContaining("no node.exe beside it")],
		});
	});
});
