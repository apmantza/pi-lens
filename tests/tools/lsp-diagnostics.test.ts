import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
	// #533: classifyCascadeWaitTier is mocked at the module boundary so each
	// test controls the "tier3-silent vs waits" verdict directly, without
	// wiring the full getServersForFileWithConfig/capability-snapshot chain
	// cascade-tier.test.ts already exercises for the classifier itself.
	cascadeTier: "waits" as "waits" | "tier3-silent",
}));

// #631: `groupFilesByPrimaryServer`/`runPerServerGroups` are the REAL
// per-server-group scheduling primitives (`tools/lsp-diagnostics.ts` now
// imports them from this module instead of using a flat, server-oblivious
// pool) — only `getLSPService` is faked here. Keeping the real
// grouping/scheduling implementations wired through the mock is what lets
// the "#631 per-server scheduling" describe block below actually exercise
// the property under test (never >1 in-flight touch per server group),
// rather than a mock that would trivially satisfy it either way.
vi.mock("../../clients/lsp/index.js", async () => {
	const actual =
		await vi.importActual<typeof import("../../clients/lsp/index.js")>(
			"../../clients/lsp/index.js",
		);
	return {
		...actual,
		getLSPService: () => mocked.service,
	};
});

vi.mock("../../clients/lsp/cascade-tier.js", () => ({
	classifyCascadeWaitTier: () => mocked.cascadeTier,
}));

const reconcileScanDiagnosticsMock = vi.fn();

vi.mock("../../clients/widget-state.js", () => ({
	reconcileScanDiagnostics: (...args: unknown[]) =>
		reconcileScanDiagnosticsMock(...args),
}));

import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

describe("lsp_diagnostics tool", () => {
	beforeEach(() => {
		mocked.cascadeTier = "waits";
		reconcileScanDiagnosticsMock.mockReset();
		mocked.service = {
			openFile: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn().mockImplementation(async (filePath: string) => {
				if (filePath.endsWith("bad.ts")) {
					return [
						{
							severity: 1,
							message: "Type 'string' is not assignable to type 'number'.",
							range: {
								start: { line: 0, character: 16 },
								end: { line: 0, character: 24 },
							},
							source: "ts",
						},
					];
				}
				return [];
			}),
			getDiagnosticsHealth: vi.fn().mockReturnValue(undefined),
			getCapabilitySnapshots: vi.fn().mockResolvedValue([]),
		};
	});

	it("checks explicit filePaths as a batch", async () => {
		const tool = createLspDiagnosticsTool();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-diag-"));
		const good = path.join(tmpDir, "good.ts");
		const bad = path.join(tmpDir, "bad.ts");
		fs.writeFileSync(good, "const value = 1;\n");
		fs.writeFileSync(bad, "const value: number = 'oops';\n");

		try {
			const result = (await tool.execute(
				"diag-batch",
				{ paths: [good, bad], severity: "all", concurrency: 2 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			)) as any;

			expect(result.isError).toBeUndefined();
			expect(result.details?.mode).toBe("batch");
			expect(result.details?.filesChecked).toBe(2);
			expect(result.details?.totalDiagnostics).toBe(1);
			expect(String(result.content[0]?.text)).toContain("Files checked: 2");
			expect(String(result.content[0]?.text)).toContain("not assignable");
			expect(
				(mocked.service as { openFile: ReturnType<typeof vi.fn> }).openFile,
			).toHaveBeenCalledTimes(2);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("short-circuits the batch fan-out when the signal is already aborted (#343)", async () => {
		const tool = createLspDiagnosticsTool();
		const controller = new AbortController();
		controller.abort();

		const result = (await tool.execute(
			"diag-batch-aborted",
			{
				paths: ["/proj/a.ts", "/proj/b.ts", "/proj/c.ts"],
				severity: "all",
				concurrency: 2,
			},
			controller.signal,
			null,
			{ cwd: "." },
		)) as any;

		// No file was opened in the language server — the worker loop saw the
		// aborted signal and returned before scheduling any file.
		expect(
			(mocked.service as { openFile: ReturnType<typeof vi.fn> }).openFile,
		).not.toHaveBeenCalled();
		// Still returns a (partial) batch result, not a throw.
		expect(result.isError).toBeUndefined();
		expect(result.details?.mode).toBe("batch");
		expect(result.details?.filesChecked).toBe(0);
		expect(result.details?.totalDiagnostics).toBe(0);
	});

	it("short-circuits the directory fan-out when the signal is already aborted (#343)", async () => {
		const tool = createLspDiagnosticsTool();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-diag-"));
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "const value = 1;\n");
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "const value = 2;\n");
		const controller = new AbortController();
		controller.abort();

		try {
			const result = (await tool.execute(
				"diag-dir-aborted",
				{ path: tmpDir, severity: "all", concurrency: 2 },
				controller.signal,
				null,
				{ cwd: "." },
			)) as any;

			// Files were collected by the walk (filesScanned reflects that), but the
			// abort-aware fan-out opened NONE of them in the language server — the
			// #343 invariant: no in-flight files after the turn is abandoned.
			expect(
				(mocked.service as { openFile: ReturnType<typeof vi.fn> }).openFile,
			).not.toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
			expect(result.details?.mode).toBe("directory");
			expect(result.details?.totalDiagnostics).toBe(0);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("skips canonical excluded dirs during directory scans", async () => {
		const tool = createLspDiagnosticsTool();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-diag-"));
		const write = (rel: string, body = "const value = 1;\n") => {
			const full = path.join(tmpDir, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, body);
		};

		write("src/good.ts");
		for (const dir of [
			".claude/worktrees/session",
			".codex",
			".pi/agent",
			".agents",
			".worktrees/branch",
			".pi-lens/cache",
			"vendor/lib",
			"third_party/lib",
			"third-party/lib",
		]) {
			write(`${dir}/bad.ts`, "const value: number = 'oops';\n");
		}

		try {
			const result = (await tool.execute(
				"diag-dir",
				{ path: tmpDir, severity: "all", concurrency: 2 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			)) as any;

			expect(result.isError).toBeUndefined();
			expect(result.details?.mode).toBe("directory");
			expect(result.details?.filesScanned).toBe(1);
			expect(result.details?.totalDiagnostics).toBe(0);
			expect(String(result.content[0]?.text)).toContain("Files scanned: 1");

			const openFile = (mocked.service as {
				openFile: ReturnType<typeof vi.fn>;
			}).openFile;
			const opened = openFile.mock.calls.map(([filePath]) =>
				path.relative(tmpDir, String(filePath)).replace(/\\/g, "/"),
			);
			expect(opened).toEqual(["src/good.ts"]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("honors .pi-lens.json ignore patterns during directory scans (#243)", async () => {
		const tool = createLspDiagnosticsTool();
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-diag-ignore-"),
		);
		// Anchor the ignore matcher's git root at tmpDir + isolate from any global
		// ~/.pi-lens/config.json on the host so the scan is hermetic.
		fs.mkdirSync(path.join(tmpDir, ".git"));
		const prevConfig = process.env.PI_LENS_CONFIG_PATH;
		process.env.PI_LENS_CONFIG_PATH = path.join(tmpDir, "no-global.json");
		resetProjectLensConfigCache();
		const write = (rel: string, body = "const value = 1;\n") => {
			const full = path.join(tmpDir, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, body);
		};
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["generated/**", "**/*.gen.ts"] }),
		);
		write("src/good.ts");
		write("generated/big.ts", "const value: number = 'oops';\n");
		write("src/widget.gen.ts", "const value: number = 'oops';\n");

		try {
			const result = (await tool.execute(
				"diag-dir-ignore",
				{ path: tmpDir, severity: "all", concurrency: 2 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			)) as any;

			// Only the non-ignored file is scanned — the dir glob and the file glob
			// from `.pi-lens.json` both suppress, not just the canonical dir list.
			expect(result.isError).toBeUndefined();
			expect(result.details?.filesScanned).toBe(1);
			const openFile = (
				mocked.service as { openFile: ReturnType<typeof vi.fn> }
			).openFile;
			const opened = openFile.mock.calls.map(([filePath]) =>
				path.relative(tmpDir, String(filePath)).replace(/\\/g, "/"),
			);
			expect(opened).toEqual(["src/good.ts"]);
		} finally {
			if (prevConfig === undefined) delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = prevConfig;
			resetProjectLensConfigCache();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("requires either path or paths", async () => {
		const tool = createLspDiagnosticsTool();
		const result = (await tool.execute(
			"diag-missing",
			{},
			new AbortController().signal,
			null,
			{ cwd: "." },
		)) as any;

		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain(
			"path or paths is required",
		);
	});

	// #533: a push-only, silent-on-clean server's empty result is unconfirmed,
	// not clean — the batch aggregate must preserve that per-file discrimination
	// rather than collapsing an unconfirmed-majority result to "0 diagnostics".
	describe("#533 honest emptiness", () => {
		it("single file: renders unconfirmed instead of a bare clean when the server is tier3-silent", async () => {
			mocked.cascadeTier = "tier3-silent";
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-unconf-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-unconfirmed-file",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.totalDiagnostics).toBe(0);
				expect(result.details?.unconfirmed).toBe(true);
				expect(String(result.content[0]?.text)).toContain("unconfirmed");
				expect(String(result.content[0]?.text)).not.toBe(
					"No diagnostics found.",
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("single file: still renders a plain clean result when the server is NOT tier3-silent", async () => {
			mocked.cascadeTier = "waits";
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-confirmed-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-confirmed-file",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.unconfirmed).toBe(false);
				expect(String(result.content[0]?.text)).toBe(
					"Primary LSP (typescript): confirmed clean.\n\nNo auxiliary findings.",
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("batch: mixed found/clean/unconfirmed never collapses to a bare '0 diagnostics'", async () => {
			mocked.cascadeTier = "tier3-silent";
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-batch-mixed-"),
			);
			const bad = path.join(tmpDir, "bad.ts");
			const clean1 = path.join(tmpDir, "clean1.ts");
			const clean2 = path.join(tmpDir, "clean2.ts");
			fs.writeFileSync(bad, "const value: number = 'oops';\n");
			fs.writeFileSync(clean1, "const value = 1;\n");
			fs.writeFileSync(clean2, "const value = 2;\n");

			try {
				const result = (await tool.execute(
					"diag-batch-mixed",
					{ paths: [bad, clean1, clean2], severity: "all", concurrency: 2 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.totalDiagnostics).toBe(1);
				// bad.ts found a diagnostic (not counted as clean/unconfirmed); the two
				// clean-looking files are both unconfirmed since the server is
				// tier3-silent in this test.
				expect(result.details?.cleanFiles).toBe(0);
				expect(result.details?.unconfirmedFiles).toBe(2);
				expect(String(result.content[0]?.text)).toContain("unconfirmed");
				expect(String(result.content[0]?.text)).not.toContain(
					"No diagnostics found.",
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("directory: an all-unconfirmed clean scan never renders as a bare 'No diagnostics found.'", async () => {
			mocked.cascadeTier = "tier3-silent";
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-dir-unconf-"),
			);
			fs.writeFileSync(path.join(tmpDir, "a.ts"), "const value = 1;\n");
			fs.writeFileSync(path.join(tmpDir, "b.ts"), "const value = 2;\n");

			try {
				const result = (await tool.execute(
					"diag-dir-unconfirmed",
					{ path: tmpDir, severity: "all", concurrency: 2 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.mode).toBe("directory");
				expect(result.details?.totalDiagnostics).toBe(0);
				expect(result.details?.cleanFiles).toBe(0);
				expect(result.details?.unconfirmedFiles).toBe(2);
				expect(String(result.content[0]?.text)).toContain("unconfirmed");
				expect(String(result.content[0]?.text)).not.toContain(
					"No diagnostics found.",
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("compact render: batch with unconfirmed files shows the clean/unconfirmed split, not a bare diagnostic count", () => {
			const tool = createLspDiagnosticsTool();
			const fakeTheme = { fg: (_c: unknown, t: string) => t } as any;
			const component = (tool.renderResult as any)(
				{
					content: [{ type: "text", text: "Files checked: 3" }],
					details: {
						mode: "batch",
						totalDiagnostics: 1,
						cleanFiles: 0,
						unconfirmedFiles: 2,
					},
				},
				{ expanded: false },
				fakeTheme,
				{ args: {} },
			);
			expect((component as { text: string }).text).toContain("unconfirmed");
			expect((component as { text: string }).text).not.toMatch(
				/— 1 diagnostic\s*$/,
			);
		});
	});

	// #611: for a tier3-silent server (classic typescript-language-server), an
	// empty push-based result attempts the `typescript.tsserverRequest` sync
	// escape hatch (`semanticDiagnosticsSync`/`syntacticDiagnosticsSync`) before
	// falling back to #533's "unconfirmed" — a real request/response tsserver
	// command, not push-timing-dependent, so an empty body IS a confirmed clean
	// answer and a non-empty body is real diagnostics that must be surfaced.
	describe("#611 tsserver sync escape hatch", () => {
		function mockExecuteCommand(
			bodies: Partial<
				Record<"semanticDiagnosticsSync" | "syntacticDiagnosticsSync", unknown[]>
			>,
		) {
			return vi
				.fn()
				.mockImplementation(
					async (_file: string, _command: string, args: unknown[]) => {
						const sub = args[0] as
							| "semanticDiagnosticsSync"
							| "syntacticDiagnosticsSync";
						return {
							executed: true,
							result: {
								success: true,
								body: bodies[sub] ?? [],
							},
						};
					},
				);
		}

		it("confirmed-clean via sync path: both sync commands return an empty body", async () => {
			mocked.cascadeTier = "tier3-silent";
			(mocked.service as any).getAdvertisedCommands = vi
				.fn()
				.mockResolvedValue(["typescript.tsserverRequest"]);
			(mocked.service as any).executeCommand = mockExecuteCommand({});

			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-611-clean-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-611-clean",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.totalDiagnostics).toBe(0);
				expect(result.details?.unconfirmed).toBe(false);
				expect(String(result.content[0]?.text)).toBe(
					"Primary LSP (typescript): confirmed clean.\n\nNo auxiliary findings.",
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("real diagnostics surfaced via sync path: semanticDiagnosticsSync returns a finding tsserver never published", async () => {
			mocked.cascadeTier = "tier3-silent";
			(mocked.service as any).getAdvertisedCommands = vi
				.fn()
				.mockResolvedValue(["typescript.tsserverRequest"]);
			(mocked.service as any).executeCommand = mockExecuteCommand({
				semanticDiagnosticsSync: [
					{
						message: "Type 'number' is not assignable to type 'string'.",
						category: "error",
						code: 2322,
						startLocation: { line: 2, offset: 9 },
						endLocation: { line: 2, offset: 10 },
					},
				],
			});

			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-611-found-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-611-found",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.totalDiagnostics).toBe(1);
				expect(result.details?.unconfirmed).toBe(false);
				expect(String(result.content[0]?.text)).toContain(
					"not assignable to type 'string'",
				);
				// tsserver's 1-based startLocation.line=2/offset=9 converts to
				// 0-based line=1/character=8.
				expect(result.details?.diagnostics?.[0]).toMatchObject({
					line: 1,
					character: 8,
				});
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("falls back to unconfirmed when executeCommand throws (e.g. tsserver 'No Project.')", async () => {
			mocked.cascadeTier = "tier3-silent";
			(mocked.service as any).getAdvertisedCommands = vi
				.fn()
				.mockResolvedValue(["typescript.tsserverRequest"]);
			(mocked.service as any).executeCommand = vi
				.fn()
				.mockRejectedValue(new Error("No Project."));

			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-611-error-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-611-error",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.unconfirmed).toBe(true);
				expect(String(result.content[0]?.text)).toContain("unconfirmed");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("falls back to unconfirmed when the command isn't advertised", async () => {
			mocked.cascadeTier = "tier3-silent";
			(mocked.service as any).getAdvertisedCommands = vi
				.fn()
				.mockResolvedValue([]);
			const executeCommand = vi.fn();
			(mocked.service as any).executeCommand = executeCommand;

			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-611-unadvertised-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-611-unadvertised",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.unconfirmed).toBe(true);
				expect(executeCommand).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("falls back to unconfirmed when the service exposes no executeCommand/getAdvertisedCommands at all (older mock/service shape)", async () => {
			mocked.cascadeTier = "tier3-silent";
			// beforeEach's mocked.service has neither method — the default shape.
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-611-nomethod-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-611-nomethod",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.unconfirmed).toBe(true);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("native-ts7 (classifyCascadeWaitTier='waits') never attempts the sync path", async () => {
			mocked.cascadeTier = "waits";
			const getAdvertisedCommands = vi
				.fn()
				.mockResolvedValue(["typescript.tsserverRequest"]);
			const executeCommand = mockExecuteCommand({});
			(mocked.service as any).getAdvertisedCommands = getAdvertisedCommands;
			(mocked.service as any).executeCommand = executeCommand;

			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-611-native-ts7-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-611-native-ts7",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.unconfirmed).toBe(false);
				expect(String(result.content[0]?.text)).toBe(
					"Primary LSP (typescript): confirmed clean.\n\nNo auxiliary findings.",
				);
				expect(getAdvertisedCommands).not.toHaveBeenCalled();
				expect(executeCommand).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// #570: a timed-out priming touchFile() must never present as a confirmed
	// clean result — it's a distinct "unconfirmed" reason from #533's
	// silent-on-clean-server tier, and the tool's own touchFile call is the
	// only path that can observe it (only exercised when waitMs is passed).
	describe("#570 timed-out check is not confirmed-clean", () => {
		it("single file: renders 'timed out' instead of a bare clean when touchFile is inconclusive", async () => {
			const touchFile = vi.fn().mockImplementation(async () => {
				const result: any[] = [];
				Object.defineProperty(result, "inconclusive", { value: true });
				return result;
			});
			(mocked.service as any).touchFile = touchFile;
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-timeout-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-timeout-file",
					{ path: clean, severity: "all", waitMs: 500 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(touchFile).toHaveBeenCalled();
				expect(result.details?.totalDiagnostics).toBe(0);
				expect(result.details?.unconfirmed).toBe(true);
				expect(result.details?.timedOut).toBe(true);
				expect(String(result.content[0]?.text)).toContain("timed out");
				expect(String(result.content[0]?.text)).not.toBe(
					"No diagnostics found.",
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("single file: a confirmed (non-inconclusive) touchFile result still renders plain clean", async () => {
			const touchFile = vi.fn().mockResolvedValue([]);
			(mocked.service as any).touchFile = touchFile;
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-confirmed-touch-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-confirmed-touch",
					{ path: clean, severity: "all", waitMs: 500 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.unconfirmed).toBe(false);
				expect(result.details?.timedOut).toBeUndefined();
				expect(String(result.content[0]?.text)).toBe(
					"Primary LSP (typescript): confirmed clean.\n\nNo auxiliary findings.",
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("batch: tallies timedOutFiles separately from silent-on-clean unconfirmed files", async () => {
			let call = 0;
			const touchFile = vi.fn().mockImplementation(async () => {
				call += 1;
				const result: any[] = [];
				// First file's touch times out; second file's touch is confirmed but
				// its server is a #533 silent-on-clean tier (mocked.cascadeTier below).
				if (call === 1) {
					Object.defineProperty(result, "inconclusive", { value: true });
				}
				return result;
			});
			(mocked.service as any).touchFile = touchFile;
			mocked.cascadeTier = "tier3-silent";
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-batch-timeout-"),
			);
			const a = path.join(tmpDir, "a.ts");
			const b = path.join(tmpDir, "b.ts");
			fs.writeFileSync(a, "const value = 1;\n");
			fs.writeFileSync(b, "const value = 2;\n");

			try {
				const result = (await tool.execute(
					"diag-batch-timeout",
					{ paths: [a, b], severity: "all", concurrency: 1, waitMs: 500 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.unconfirmedFiles).toBe(2);
				expect(result.details?.timedOutFiles).toBe(1);
				expect(String(result.content[0]?.text)).toContain("timed out");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// #571: a standalone lsp_diagnostics check that gets a CONFIRMED fresh
	// result should reconcile it into the footer (widget-state) the same way
	// lens_diagnostics mode=full does — a manual check proving a stale footer
	// error is actually gone (the real-world case that surfaced #571) must
	// correct the footer, not just report the answer back to the caller. A
	// timed-out check (#570, above) is a distinct "unconfirmed" reason and must
	// NOT reconcile either — covered by the "does NOT reconcile an unconfirmed"
	// test below, which shares the same tier3-silent unconfirmed path #570's
	// touchFile-timeout path also feeds into (`confirmation === "unconfirmed"`).
	describe("#571 footer reconciliation", () => {
		it("reconciles a confirmed non-empty result into the footer with a freshly-drawn writeIndex", async () => {
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-reconcile-"),
			);
			const bad = path.join(tmpDir, "bad.ts");
			fs.writeFileSync(bad, "const value: number = 'oops';\n");

			let drawn = 0;
			const tool = createLspDiagnosticsTool(() => (drawn += 1));
			try {
				await tool.execute(
					"diag-reconcile",
					{ path: bad, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				);

				expect(reconcileScanDiagnosticsMock).toHaveBeenCalledTimes(1);
				const [filePath, diags, confirmed, writeIndex] =
					reconcileScanDiagnosticsMock.mock.calls[0];
				expect(filePath).toBe(bad);
				expect(confirmed).toBe(true);
				expect(writeIndex).toBe(1);
				expect(diags).toEqual([
					expect.objectContaining({
						message: "Type 'string' is not assignable to type 'number'.",
					}),
				]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("does NOT reconcile an unconfirmed (tier3-silent, inconclusive) empty result into the footer", async () => {
			mocked.cascadeTier = "tier3-silent";
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-reconcile-unconf-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			const tool = createLspDiagnosticsTool(() => 1);
			try {
				await tool.execute(
					"diag-reconcile-unconfirmed",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				);

				expect(reconcileScanDiagnosticsMock).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("does NOT reconcile a timed-out (#570 inconclusive) result into the footer", async () => {
			const touchFile = vi.fn().mockImplementation(async () => {
				const result: any[] = [];
				Object.defineProperty(result, "inconclusive", { value: true });
				return result;
			});
			(mocked.service as any).touchFile = touchFile;
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-reconcile-timeout-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			const tool = createLspDiagnosticsTool(() => 1);
			try {
				await tool.execute(
					"diag-reconcile-timeout",
					{ path: clean, severity: "all", waitMs: 500 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				);

				expect(reconcileScanDiagnosticsMock).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("reconciles a confirmed CLEAN (empty, non-tier3-silent) result — corrects a stale footer to empty", async () => {
			mocked.cascadeTier = "waits";
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-reconcile-clean-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			const tool = createLspDiagnosticsTool(() => 1);
			try {
				await tool.execute(
					"diag-reconcile-clean",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				);

				expect(reconcileScanDiagnosticsMock).toHaveBeenCalledTimes(1);
				const [filePath, diags, confirmed] =
					reconcileScanDiagnosticsMock.mock.calls[0];
				expect(filePath).toBe(clean);
				expect(confirmed).toBe(true);
				expect(diags).toEqual([]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("batch mode also reconciles each confirmed file", async () => {
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-reconcile-batch-"),
			);
			const good = path.join(tmpDir, "good.ts");
			const bad = path.join(tmpDir, "bad.ts");
			fs.writeFileSync(good, "const value = 1;\n");
			fs.writeFileSync(bad, "const value: number = 'oops';\n");

			const tool = createLspDiagnosticsTool(() => 1);
			try {
				await tool.execute(
					"diag-reconcile-batch",
					{ paths: [good, bad], severity: "all", concurrency: 2 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				);

				const reconciledPaths = reconcileScanDiagnosticsMock.mock.calls.map(
					(call) => call[0],
				);
				expect(reconciledPaths.sort()).toEqual([bad, good].sort());
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// #586: a `// nosemgrep` comment must suppress an opengrep finding the same
	// way it already does in the per-edit dispatch runner — previously this
	// standalone diagnostics-query path ignored the tool's native inline
	// suppression entirely.
	describe("#586 auxiliary inline-suppression (nosemgrep)", () => {
		const RULE = "generic.secrets.security.detected-github-token";

		function semgrepDiag(line0Based: number) {
			return {
				severity: 1,
				message: "GitHub token detected",
				range: {
					start: { line: line0Based, character: 0 },
					end: { line: line0Based, character: 10 },
				},
				source: "Semgrep",
				code: RULE,
			};
		}

		it("single file: a `// nosemgrep` comment on the finding's line drops it from lsp_diagnostics", async () => {
			(mocked.service as any).getDiagnostics = vi
				.fn()
				.mockResolvedValue([semgrepDiag(0)]);
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-nosemgrep-"),
			);
			const target = path.join(tmpDir, "secret.ts");
			fs.writeFileSync(target, "const token = 'x';  // nosemgrep\n");

			try {
				const result = (await tool.execute(
					"diag-nosemgrep-file",
					{ path: target, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.totalDiagnostics).toBe(0);
				expect(String(result.content[0]?.text)).toBe(
					"Primary LSP (typescript): confirmed clean.\n\nNo auxiliary findings.",
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("single file: the same finding WITHOUT a nosemgrep comment still surfaces", async () => {
			(mocked.service as any).getDiagnostics = vi
				.fn()
				.mockResolvedValue([semgrepDiag(0)]);
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-nosemgrep-control-"),
			);
			const target = path.join(tmpDir, "secret.ts");
			fs.writeFileSync(target, "const token = 'x';\n");

			try {
				const result = (await tool.execute(
					"diag-nosemgrep-control",
					{ path: target, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.totalDiagnostics).toBe(1);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("batch mode: nosemgrep-suppressed file drops its finding while an unsuppressed file keeps its own", async () => {
			(mocked.service as any).getDiagnostics = vi
				.fn()
				.mockImplementation(async () => {
					return [semgrepDiag(0)];
				});
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-nosemgrep-batch-"),
			);
			const suppressed = path.join(tmpDir, "suppressed.ts");
			const unsuppressed = path.join(tmpDir, "unsuppressed.ts");
			fs.writeFileSync(suppressed, "const token = 'x';  // nosemgrep\n");
			fs.writeFileSync(unsuppressed, "const token = 'x';\n");

			try {
				const result = (await tool.execute(
					"diag-nosemgrep-batch",
					{ paths: [suppressed, unsuppressed], severity: "all", concurrency: 2 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.totalDiagnostics).toBe(1);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	// Primary/auxiliary split + serverScope: a dogfooding session reported a
	// 55-diagnostic lsp_diagnostics result that was 54 ast-grep findings and 1
	// typescript entry — real signal (the type checker's confirmation) buried
	// in aux noise. The fix reports primary-server confirmation as its own
	// line/section, independent of however many auxiliary findings exist, and
	// adds an opt-in `serverScope: "primary"` that skips auxiliary scanners
	// entirely for a fast, low-noise "does this have real type errors" check.
	describe("primary/auxiliary confirmation split + serverScope", () => {
		it("single file: splits mixed-source diagnostics into a Primary line and an Auxiliary findings section", async () => {
			(mocked.service as any).getDiagnostics = vi
				.fn()
				.mockImplementation(async (filePath: string) => {
					if (filePath.endsWith("mixed.ts")) {
						return [
							{
								severity: 1,
								message: "Type 'string' is not assignable to type 'number'.",
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 1 },
								},
								source: "typescript",
							},
							{
								severity: 2,
								message: "avoid nested ternaries",
								range: {
									start: { line: 1, character: 0 },
									end: { line: 1, character: 1 },
								},
								source: "ast-grep",
							},
						];
					}
					return [];
				});
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-split-"),
			);
			const mixed = path.join(tmpDir, "mixed.ts");
			fs.writeFileSync(mixed, "const value: number = 'oops';\nconst x = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-split-file",
					{ path: mixed, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.primaryServerId).toBe("typescript");
				expect(result.details?.primaryDiagnosticsCount).toBe(1);
				expect(result.details?.auxiliaryDiagnosticsCount).toBe(1);
				const text = String(result.content[0]?.text);
				expect(text).toContain("Primary LSP (typescript): 1 diagnostic.");
				expect(text).toContain("Auxiliary findings (1):");
				expect(text).toContain("not assignable");
				expect(text).toContain("nested ternaries");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("serverScope: 'primary' passes clientScope: 'primary' to touchFile, skipping auxiliary scanners", async () => {
			const touchFile = vi.fn().mockResolvedValue([]);
			(mocked.service as any).touchFile = touchFile;
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-scope-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-scope-primary",
					{ path: clean, severity: "all", serverScope: "primary" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(touchFile).toHaveBeenCalledTimes(1);
				expect(touchFile.mock.calls[0]?.[2]?.clientScope).toBe("primary");
				expect(result.details?.serverScope).toBe("primary");
				// #629: the confirmation touch's own (already correctly-scoped)
				// return value must be used directly as the diagnostics content —
				// a second, unconditionally-UNSCOPED getDiagnostics() call would
				// silently re-touch every auxiliary scanner (opengrep, typos, …)
				// even though serverScope:"primary" asked to skip them, and would
				// cost a second LSP round trip on top of the confirmation touch.
				expect(
					(mocked.service as { getDiagnostics: ReturnType<typeof vi.fn> })
						.getDiagnostics,
				).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("#629: serverScope 'primary' diagnostics content comes from touchFile's own return value, not a second getDiagnostics call", async () => {
			const primaryOnlyDiagnostic = {
				severity: 1,
				message: "Type 'string' is not assignable to type 'number'.",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
				source: "typescript",
			};
			const touchFile = vi.fn().mockResolvedValue([primaryOnlyDiagnostic]);
			(mocked.service as any).touchFile = touchFile;
			// If the bug regresses (a second, unscoped getDiagnostics() call feeds
			// the actual content) this mock would return an aux-scanner finding
			// that serverScope:"primary" should never have touched, and the
			// assertions below would catch it either way — either via the wrong
			// diagnostic content or via getDiagnostics having been called at all.
			(mocked.service as any).getDiagnostics = vi.fn().mockResolvedValue([
				{
					severity: 2,
					message: "aux finding that primary scope must never see",
					range: {
						start: { line: 1, character: 0 },
						end: { line: 1, character: 1 },
					},
					source: "ast-grep",
				},
			]);
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-scope-content-"),
			);
			const bad = path.join(tmpDir, "bad.ts");
			fs.writeFileSync(bad, "const value: number = 'oops';\n");

			try {
				const result = (await tool.execute(
					"diag-scope-primary-content",
					{ path: bad, severity: "all", serverScope: "primary" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(
					(mocked.service as { getDiagnostics: ReturnType<typeof vi.fn> })
						.getDiagnostics,
				).not.toHaveBeenCalled();
				expect(result.details?.totalDiagnostics).toBe(1);
				expect(String(result.content[0]?.text)).toContain("not assignable");
				expect(String(result.content[0]?.text)).not.toContain(
					"aux finding that primary scope must never see",
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("#629: touchFile resolving to undefined (no clients) still falls back to getDiagnostics", async () => {
			const touchFile = vi.fn().mockResolvedValue(undefined);
			(mocked.service as any).touchFile = touchFile;
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-scope-fallback-"),
			);
			const bad = path.join(tmpDir, "bad.ts");
			fs.writeFileSync(bad, "const value: number = 'oops';\n");

			try {
				const result = (await tool.execute(
					"diag-scope-primary-fallback",
					{ path: bad, severity: "all", serverScope: "primary" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(
					(mocked.service as { getDiagnostics: ReturnType<typeof vi.fn> })
						.getDiagnostics,
				).toHaveBeenCalled();
				expect(result.details?.totalDiagnostics).toBe(1);
				expect(String(result.content[0]?.text)).toContain("not assignable");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("default (no serverScope param) still passes clientScope: 'all' to touchFile", async () => {
			const touchFile = vi.fn().mockResolvedValue([]);
			(mocked.service as any).touchFile = touchFile;
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-scope-default-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-scope-default",
					{ path: clean, severity: "all", waitMs: 500 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(touchFile.mock.calls[0]?.[2]?.clientScope).toBe("all");
				expect(result.details?.serverScope).toBe("all");
				// #629: waitMs alone also takes the touchFile branch — same
				// single-round-trip contract applies regardless of serverScope.
				expect(
					(mocked.service as { getDiagnostics: ReturnType<typeof vi.fn> })
						.getDiagnostics,
				).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("#629: neither waitMs nor serverScope:'primary' set (openFile-only path) is unchanged — getDiagnostics('full') still called, touchFile is not", async () => {
			const touchFile = vi.fn().mockResolvedValue([]);
			(mocked.service as any).touchFile = touchFile;
			const getDiagnostics = vi.fn().mockResolvedValue([]);
			(mocked.service as any).getDiagnostics = getDiagnostics;
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-scope-unchanged-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-scope-unchanged",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(touchFile).not.toHaveBeenCalled();
				expect(getDiagnostics).toHaveBeenCalledWith(clean, "full");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("directory: splits the flattened multi-file listing into Primary/Auxiliary sections", async () => {
			(mocked.service as any).getDiagnostics = vi
				.fn()
				.mockImplementation(async (filePath: string) => {
					if (filePath.endsWith("bad.ts")) {
						return [
							{
								severity: 1,
								message: "Type 'string' is not assignable to type 'number'.",
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 1 },
								},
								source: "typescript",
							},
						];
					}
					if (filePath.endsWith("noisy.ts")) {
						return [
							{
								severity: 2,
								message: "avoid nested ternaries",
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 1 },
								},
								source: "ast-grep",
							},
						];
					}
					return [];
				});
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-dir-split-"),
			);
			fs.writeFileSync(
				path.join(tmpDir, "bad.ts"),
				"const value: number = 'oops';\n",
			);
			fs.writeFileSync(path.join(tmpDir, "noisy.ts"), "const x = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-dir-split",
					{ path: tmpDir, severity: "all", concurrency: 2 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.primaryDiagnosticsCount).toBe(1);
				expect(result.details?.auxiliaryDiagnosticsCount).toBe(1);
				const text = String(result.content[0]?.text);
				expect(text).toContain("Primary findings (1):");
				expect(text).toContain("Auxiliary findings (1):");
				expect(text.indexOf("Primary findings")).toBeLessThan(
					text.indexOf("Auxiliary findings"),
				);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});
});
