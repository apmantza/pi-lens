import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
const sessionLog = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));
vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: sessionLog,
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { TOOLS, verifyToolBinary } from "../../../clients/installer/index.js";
import { removeTempDirSync } from "../test-utils.js";

const fixture = fs.readFileSync(
	path.join(
		process.cwd(),
		"tests",
		"fixtures",
		"installer",
		"markdownlint-cli2-verify.stdout.txt",
	),
	"utf8",
);

function result(overrides: Record<string, unknown> = {}) {
	return {
		stdout: "",
		stderr: "",
		status: 1,
		...overrides,
	};
}

describe("managed markdownlint verification (#2045)", () => {
	it("uses the captured bounded stdin command", () => {
		const tool = TOOLS.find((entry) => entry.id === "markdownlint");
		expect(tool?.checkArgs).toEqual(["--no-globs", "-"]);
		expect(fixture).toContain("markdownlint-cli2 v0.23.2");
		expect(fixture).toContain("Linting: 1 file");
		expect(fixture).toContain("Summary: 0 issues in 0 files");
	});

	it("accepts a transport rescue visible only through the streaming latch", async () => {
		safeSpawnAsync.mockResolvedValueOnce(
			result({
				stderr: "x".repeat(64 * 1024),
				outputTruncated: true,
				streamingMatch: true,
			}),
		);

		await expect(
			verifyToolBinary("latch-only-tool", undefined, undefined, 10),
		).resolves.toBe(true);
	});

	it.each([
		"tool-not-found",
		"cwd-unresolvable",
		"permission-denied",
		"timeout",
		"killed",
		"spawn-failed",
	] as const)(
		"keeps typed spawn failure %s over generic error",
		async (kind) => {
			sessionLog.mockClear();
			safeSpawnAsync.mockResolvedValueOnce(
				result({ error: new Error("generic race"), spawnFailure: { kind } }),
			);
			await expect(
				verifyToolBinary("typed-failure", undefined, undefined, 10),
			).resolves.toBe(false);
			expect(sessionLog).toHaveBeenLastCalledWith(
				expect.stringContaining(`kind=${kind}`),
			);
		},
	);

	it("keeps typed timeout telemetry ahead of output truncation", async () => {
		sessionLog.mockClear();
		safeSpawnAsync.mockResolvedValueOnce(
			result({
				error: new Error("output cap raced with timeout"),
				outputTruncated: true,
				spawnFailure: { kind: "timeout" },
			}),
		);
		await expect(
			verifyToolBinary("timeout-with-capped-output", undefined, undefined, 10),
		).resolves.toBe(false);
		expect(sessionLog).toHaveBeenLastCalledWith(
			expect.stringContaining("check=--version, kind=timeout"),
		);
	});

	it("covers signal-only, nonzero, and successful output", async () => {
		sessionLog.mockClear();
		safeSpawnAsync.mockResolvedValueOnce(
			result({ signal: "SIGTERM", error: new Error("killed") }),
		);
		await expect(
			verifyToolBinary("signal-only", undefined, undefined, 10),
		).resolves.toBe(false);
		expect(sessionLog).toHaveBeenLastCalledWith(
			expect.stringContaining("kind=killed-signal=SIGTERM"),
		);
		safeSpawnAsync.mockResolvedValueOnce(result({ status: 3 }));
		await expect(
			verifyToolBinary("nonzero", undefined, undefined, 10),
		).resolves.toBe(false);
		expect(sessionLog).toHaveBeenLastCalledWith(
			expect.stringContaining("kind=exit-nonzero"),
		);
		const onVersion = vi.fn();
		safeSpawnAsync.mockResolvedValueOnce(
			result({ status: 0, stdout: "real output\n", error: undefined }),
		);
		await expect(
			verifyToolBinary("success", onVersion, undefined, 10),
		).resolves.toBe(true);
		expect(onVersion).toHaveBeenCalledWith("real output\n");
		expect(sessionLog).not.toHaveBeenCalledWith(
			expect.stringContaining("success for"),
		);
	});

	it("passes a command override to the real spawn seam", async () => {
		safeSpawnAsync.mockResolvedValueOnce(
			result({ status: 0, error: undefined }),
		);
		await verifyToolBinary("markdownlint-cli2", undefined, undefined, 10, [
			"--no-globs",
			"-",
		]);
		expect(safeSpawnAsync).toHaveBeenLastCalledWith(
			process.platform === "win32"
				? "markdownlint-cli2.cmd"
				: "markdownlint-cli2",
			["--no-globs", "-"],
			expect.objectContaining({ timeout: 10, input: "" }),
		);
	});

	it("pins effective argv for npm and non-npm verification samples", async () => {
		safeSpawnAsync.mockClear();
		safeSpawnAsync.mockResolvedValue(result({ status: 0, error: undefined }));
		for (const id of [
			"markdownlint",
			"svelte-language-server",
			"@prisma/language-server",
			"mypy",
		]) {
			const tool = TOOLS.find((entry) => entry.id === id);
			expect(tool).toBeDefined();
			await verifyToolBinary(id, undefined, undefined, 10, tool!.checkArgs);
		}
		const calls = safeSpawnAsync.mock.calls;
		expect(calls.map((call) => call[1])).toEqual([
			["--no-globs", "-"],
			["--version"],
			["--version"],
			["--version"],
		]);
		expect(calls.every((call) => call[2].input === "")).toBe(true);
	});

	it("bounds retained output for noisy language-server probes", async () => {
		resetDegradationLedger();
		const onInconclusive = vi.fn();
		safeSpawnAsync.mockResolvedValueOnce(
			result({ status: 1, outputTruncated: true }),
		);
		await verifyToolBinary(
			"intelephense",
			undefined,
			undefined,
			10,
			["--version"],
			undefined,
			onInconclusive,
		);
		expect(safeSpawnAsync).toHaveBeenLastCalledWith(
			process.platform === "win32" ? "intelephense.cmd" : "intelephense",
			["--version"],
			expect.objectContaining({
				maxOutputBytes: 64 * 1024,
				matchWhileStreaming: expect.any(RegExp),
			}),
		);
		// #2722: this SAME probe shape — armed matcher, unmatched, truncated
		// prefix — is the one the installer must not delete an install on, and it
		// now records a second, differently-named row. Asserted here because this
		// is the seam's cross-platform coverage: the real-fixture proof in
		// npm-package-entry-verify-2722.test.ts depends on Node dropping a piped
		// stderr tail at exit, which is POSIX-only.
		expect(onInconclusive).toHaveBeenCalledTimes(1);
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "installer-verification-output-truncated",
				count: 1,
			}),
			expect.objectContaining({
				kind: "installer-verification-inconclusive",
				count: 1,
				latestReasons: [
					{
						subject: "intelephense",
						reason:
							"transport-required marker unresolved in truncated output (--version)",
					},
				],
			}),
		]);
	});

	it.skipIf(!resolveMarkdownlintBinary())(
		"proves the old real probe and corrected production verification",
		async () => {
			const binary = resolveMarkdownlintBinary();
			expect(binary).toBeTruthy();
			const cwd = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-2045-markdownlint-"),
			);
			try {
				fs.writeFileSync(path.join(cwd, "project.md"), "# title\n", "utf8");
				const old = await runProbe(binary!, ["--version"], cwd);
				expect(`${old.stdout}\n${old.stderr}`).toContain("Finding: --version");
				const corrected = await runProbe(
					binary!,
					["--no-globs", "-"],
					cwd,
					"# title\n",
				);
				expect(`${corrected.stdout}\n${corrected.stderr}`).not.toContain(
					"Finding: --version",
				);
				expect(`${corrected.stdout}\n${corrected.stderr}`).toContain(
					"Linting: 1 file",
				);
			} finally {
				removeTempDirSync(cwd);
			}
			safeSpawnAsync.mockResolvedValue(
				result({
					status: 0,
					stdout: fixture,
					error: undefined,
				}),
			);
			await expect(
				verifyToolBinary(binary!, undefined, undefined, 10_000, [
					"--no-globs",
					"-",
				]),
			).resolves.toBe(true);
		},
		15_000,
	);
});

function runProbe(
	binary: string,
	args: string[],
	cwd: string,
	input = "",
): Promise<{ stdout: string; stderr: string }> {
	const command =
		process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : binary;
	const commandArgs =
		process.platform === "win32" ? ["/d", "/c", binary, ...args] : args;
	return new Promise((resolve) => {
		const child = execFile(
			command,
			commandArgs,
			{ cwd, timeout: 10_000 },
			(_error, stdout, stderr) =>
				resolve({ stdout: String(stdout), stderr: String(stderr) }),
		);
		child.stdin?.end(input);
	});
}

function resolveMarkdownlintBinary(): string | undefined {
	const binaryName =
		process.platform === "win32"
			? "markdownlint-cli2.cmd"
			: "markdownlint-cli2";
	const candidates = [
		path.join(
			os.homedir(),
			".pi-lens",
			"tools",
			"node_modules",
			".bin",
			binaryName,
		),
		path.join(process.cwd(), "node_modules", ".bin", binaryName),
		process.env.PI_LENS_2045_MARKDOWNLINT_BIN,
	];
	return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}
