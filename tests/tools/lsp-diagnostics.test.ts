import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
	warmAttached: false,
	attachedDiagnostics: vi.fn(),
	// #533: classifyCascadeWaitTier is mocked at the module boundary so each
	// test controls the "tier3-silent vs waits" verdict directly, without
	// wiring the full getServersForFileWithConfig/capability-snapshot chain
	// cascade-tier.test.ts already exercises for the classifier itself.
	cascadeTier: "waits" as "waits" | "tier3-silent",
}));

vi.mock("../../clients/warm-attach.js", () => ({
	isWarmAttached: () => mocked.warmAttached,
	tryWarmAttachedDiagnostics: (...args: unknown[]) =>
		mocked.attachedDiagnostics(...args),
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
	const actual = await vi.importActual<
		typeof import("../../clients/lsp/index.js")
	>("../../clients/lsp/index.js");
	return {
		...actual,
		getLSPService: () => mocked.service,
	};
});

vi.mock("../../clients/lsp/wait-policy/index.js", () => ({
	classifyCascadeWaitTier: () => mocked.cascadeTier,
}));

const reconcileScanDiagnosticsMock = vi.fn().mockReturnValue(true);

vi.mock("../../clients/widget-state.js", () => ({
	reconcileScanDiagnostics: (...args: unknown[]) =>
		reconcileScanDiagnosticsMock(...args),
}));

import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

describe("lsp_diagnostics tool", () => {
	beforeEach(() => {
		mocked.cascadeTier = "waits";
		mocked.warmAttached = false;
		mocked.attachedDiagnostics.mockReset();
		reconcileScanDiagnosticsMock.mockReset().mockReturnValue(true);
		mocked.service = makeLspServiceDouble({
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
			runWorkspaceDiagnostics: vi.fn(),
			// #2598: `collectDiagnosticsForFile` now touches unconditionally —
			// the real `LSPService` defines `touchFile` on every shape, so the
			// probe that used to route this suite down an `openFile` arm is
			// gone. `undefined` is what the real `touchFile` resolves to when
			// it resolves NO client for the file (clients/lsp/index.ts, the
			// `no_clients` return), and it is the state these cases want: the
			// tool falls through to `getDiagnostics`, where their fixtures
			// live. Cases that want the touch itself to answer install their
			// own `touchFile` on the double.
			touchFile: vi.fn(async () => undefined),
		});
	});

	it("uses attached diagnostics for a batch without local warm-up or touches", async () => {
		const touchFile = vi.fn();
		const ensureWarmForSweep = vi.fn();
		(mocked.service as any).touchFile = touchFile;
		(mocked.service as any).ensureWarmForSweep = ensureWarmForSweep;
		mocked.warmAttached = true;
		mocked.attachedDiagnostics.mockResolvedValue({
			available: true,
			response: {
				diagnostics: [
					{
						severity: 1,
						message: "from incumbent",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 1 },
						},
						source: "ts",
					},
				],
			},
		});
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-diag-attached-"),
		);
		const file = path.join(tmpDir, "attached.ts");
		fs.writeFileSync(file, "const value = 1;\n");

		try {
			const result = (await createLspDiagnosticsTool().execute(
				"diag-attached",
				{ paths: [file], severity: "all", waitMs: 321, serverScope: "all" },
				new AbortController().signal,
				null,
				{ cwd: "." },
			)) as any;

			expect(result.details?.totalDiagnostics).toBe(1);
			expect(String(result.content[0]?.text)).toContain("from incumbent");
			expect(mocked.attachedDiagnostics).toHaveBeenCalledWith(
				file,
				"const value = 1;\n",
				321,
				"sweep",
			);
			expect(ensureWarmForSweep).not.toHaveBeenCalled();
			expect(touchFile).not.toHaveBeenCalled();
		} finally {
			removeTempDirSync(tmpDir);
		}
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
				(mocked.service as { touchFile: ReturnType<typeof vi.fn> }).touchFile,
			).toHaveBeenCalledTimes(2);
			expect(
				(
					mocked.service as {
						runWorkspaceDiagnostics: ReturnType<typeof vi.fn>;
					}
				).runWorkspaceDiagnostics,
			).not.toHaveBeenCalled();
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("reports normalized explicit paths in input order and rejects over-cap batches (#837)", async () => {
		const tool = createLspDiagnosticsTool();
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-diag-contract-"),
		);
		const file = path.join(tmpDir, "one.ts");
		fs.writeFileSync(file, "const value = 1;\n");
		try {
			const normalized = (await tool.execute(
				"diag-normalized",
				{ paths: [path.join(tmpDir, ".", "one.ts")] },
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			)) as any;
			expect(normalized.details?.outcomes?.[0]?.file).toBe(
				path.normalize(file),
			);

			const overCap = (await tool.execute(
				"diag-over-cap",
				{ paths: Array.from({ length: 101 }, (_, i) => `f${i}.ts`) },
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			)) as any;
			expect(overCap.isError).toBe(true);
			expect(String(overCap.content[0]?.text)).toContain("at most 100");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("returns honest mixed per-file outcomes and aggregate counts (#837)", async () => {
		const tool = createLspDiagnosticsTool();
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-diag-outcomes-"),
		);
		const files = [
			"clean.ts",
			"bad.ts",
			"unsupported.txt",
			"unavailable.ts",
		].map((name) => path.join(tmpDir, name));
		for (const file of files) fs.writeFileSync(file, "const value = 1;\n");
		(mocked.service as any).getDiagnosticsHealth = vi.fn((file: string) =>
			file.endsWith("unavailable.ts")
				? { health: "no_clients", serverCountAttempted: 1, serverCountReady: 0 }
				: undefined,
		);
		try {
			const result = (await tool.execute(
				"diag-outcomes",
				{ paths: files, concurrency: 2 },
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			)) as any;
			expect(result.details?.outcomeCounts).toMatchObject({
				clean: 1,
				findings: 1,
				unsupported: 1,
				unavailable: 1,
			});
			expect(result.details?.outcomes.map((entry: any) => entry.file)).toEqual(
				files,
			);
			expect(String(result.content[0]?.text)).toContain("Outcomes:");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("bounds an in-flight file and the whole batch on abort (#837)", async () => {
		const previous = process.env.PI_LENS_LSP_BATCH_FILE_MS;
		process.env.PI_LENS_LSP_BATCH_FILE_MS = "1000";
		const tool = createLspDiagnosticsTool();
		const controller = new AbortController();
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-diag-abort-contract-"),
		);
		const files = ["a.ts", "b.ts"].map((name) => path.join(tmpDir, name));
		for (const file of files) fs.writeFileSync(file, "const value = 1;\n");
		(mocked.service as any).touchFile = vi.fn(() => new Promise(() => {}));
		const started = Date.now();
		const pending = tool.execute(
			"diag-abort-contract",
			{ paths: files, concurrency: 1, waitMs: 1 },
			controller.signal,
			null,
			{ cwd: process.cwd() },
		);
		setTimeout(() => controller.abort(), 20);
		try {
			const result = (await pending) as any;
			expect(Date.now() - started).toBeLessThan(500);
			expect(result.details?.outcomeCounts?.inconclusive).toBe(1);
			expect(result.details?.incompleteFiles).toBe(1);
		} finally {
			removeTempDirSync(tmpDir);
			if (previous === undefined) delete process.env.PI_LENS_LSP_BATCH_FILE_MS;
			else process.env.PI_LENS_LSP_BATCH_FILE_MS = previous;
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
			(mocked.service as { touchFile: ReturnType<typeof vi.fn> }).touchFile,
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
				(mocked.service as { touchFile: ReturnType<typeof vi.fn> }).touchFile,
			).not.toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
			expect(result.details?.mode).toBe("directory");
			expect(result.details?.totalDiagnostics).toBe(0);
		} finally {
			removeTempDirSync(tmpDir);
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

			const touchFile = (
				mocked.service as {
					touchFile: ReturnType<typeof vi.fn>;
				}
			).touchFile;
			const opened = touchFile.mock.calls.map(([filePath]) =>
				path.relative(tmpDir, String(filePath)).replace(/\\/g, "/"),
			);
			expect(opened).toEqual(["src/good.ts"]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("scans a mixed .ts + .py directory as typescript, unchanged by the #2434 registry fold", async () => {
		const tool = createLspDiagnosticsTool();
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-diag-mixed-"),
		);
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "const value = 1;\n");
		fs.writeFileSync(path.join(tmpDir, "b.py"), "value = 1\n");

		try {
			const result = (await tool.execute(
				"diag-dir-mixed",
				{ path: tmpDir, severity: "all", concurrency: 2 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			)) as any;

			expect(result.isError).toBeUndefined();
			expect(result.details?.mode).toBe("directory");
			// typescript sits before python in SCAN_LANGUAGE_PRIORITY (same
			// relative order LANG_EXTENSIONS's ".ts" key had before ".py"), so the
			// directory scans as typescript and the python file is not opened.
			expect(result.details?.filesScanned).toBe(1);
			const touchFile = (
				mocked.service as { touchFile: ReturnType<typeof vi.fn> }
			).touchFile;
			const opened = touchFile.mock.calls.map(([filePath]) =>
				path.relative(tmpDir, String(filePath)).replace(/\\/g, "/"),
			);
			expect(opened).toEqual(["a.ts"]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("scans a .ru-only directory as ruby (#2434 Changed: widened from the old LANG_EXTENSIONS table, which never named .ru)", async () => {
		const tool = createLspDiagnosticsTool();
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lsp-diag-ru-"),
		);
		fs.writeFileSync(path.join(tmpDir, "config.ru"), "run MyApp\n");

		try {
			const result = (await tool.execute(
				"diag-dir-ru",
				{ path: tmpDir, severity: "all", concurrency: 2 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			)) as any;

			expect(result.isError).toBeUndefined();
			expect(result.details?.mode).toBe("directory");
			expect(result.details?.filesScanned).toBe(1);
			const touchFile = (
				mocked.service as { touchFile: ReturnType<typeof vi.fn> }
			).touchFile;
			const opened = touchFile.mock.calls.map(([filePath]) =>
				path.relative(tmpDir, String(filePath)).replace(/\\/g, "/"),
			);
			expect(opened).toEqual(["config.ru"]);
		} finally {
			removeTempDirSync(tmpDir);
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
			const touchFile = (
				mocked.service as { touchFile: ReturnType<typeof vi.fn> }
			).touchFile;
			const opened = touchFile.mock.calls.map(([filePath]) =>
				path.relative(tmpDir, String(filePath)).replace(/\\/g, "/"),
			);
			expect(opened).toEqual(["src/good.ts"]);
		} finally {
			if (prevConfig === undefined) delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = prevConfig;
			resetProjectLensConfigCache();
			removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
			}
		});

		// #2860 round 3 N5/F10: `createLspDiagnosticsTool` no longer returns a
		// `renderResult` — the fold's only production caller
		// (`tools/lens-diagnostics.ts`) routes rendering through its OWN
		// `details.source === "lsp"` branch (never through this probe's
		// renderer, which was unreachable dead code since round 1 per #533).
		// The same invariant this test pinned — a batch/directory result with
		// unconfirmed files must never compact-render as a bare N-diagnostic
		// count — is covered on the surviving renderer by
		// tests/tools/lens-diagnostics.test.ts's "lens_diagnostics source=lsp
		// compact render" describe block ("preserves unconfirmed and
		// timed-out files").
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
				Record<
					"semanticDiagnosticsSync" | "syntacticDiagnosticsSync",
					unknown[]
				>
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
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
			}
		});

		it("all-scope touch confirmation still surfaces TypeScript sync diagnostics", async () => {
			mocked.cascadeTier = "tier3-silent";
			(mocked.service as any).getAdvertisedCommands = vi
				.fn()
				.mockResolvedValue(["typescript.tsserverRequest"]);
			const executeCommand = mockExecuteCommand({
				semanticDiagnosticsSync: [
					{
						message: "Type 'number' is not assignable to type 'string'.",
						category: "error",
						code: 2322,
						startLocation: { line: 1, offset: 7 },
						endLocation: { line: 1, offset: 12 },
					},
				],
			});
			(mocked.service as any).executeCommand = executeCommand;
			(mocked.service as any).touchFile = vi.fn().mockResolvedValue({
				diags: [],
				confirmation: "confirmed",
			});
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-611-all-confirmed-"),
			);
			const file = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(file, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-611-all-confirmed",
					{
						paths: [file],
						severity: "all",
						serverScope: "all",
						waitMs: 500,
					},
					new AbortController().signal,
					null,
					{ cwd: tmpDir },
				)) as any;

				expect(executeCommand).toHaveBeenCalled();
				expect(result.details?.totalDiagnostics).toBe(1);
				expect(result.details?.outcomeCounts).toMatchObject({
					findings: 1,
					clean: 0,
					inconclusive: 0,
				});
				expect(String(result.content[0]?.text)).toContain(
					"not assignable to type 'string'",
				);
			} finally {
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
			}
		});

		it("falls back to unconfirmed when the sync command IS advertised but the service exposes no executeCommand (older mock/service shape)", async () => {
			mocked.cascadeTier = "tier3-silent";
			// #2592: this case used to lean on `getAdvertisedCommands` ALSO being
			// missing, which made it bail at clients/lsp/tsserver-sync.ts:424 —
			// the same observable as the "isn't advertised" sibling above, so
			// nothing here could tell the two apart. `executeCommand` is outside
			// `makeLspServiceDouble`'s surface and therefore still genuinely
			// absent, so advertise the command and let the bail happen at
			// tsserver-sync.ts:380 instead: a branch no other case in this file
			// reaches, and one that reds the moment `executeCommand` is stubbed.
			(mocked.service as any).getAdvertisedCommands = vi
				.fn()
				.mockResolvedValue(["typescript.tsserverRequest"]);
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
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
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
				return { diags: [], inconclusive: true };
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
				removeTempDirSync(tmpDir);
			}
		});

		it("single file: a confirmed (non-inconclusive) touchFile result still renders plain clean", async () => {
			const touchFile = vi.fn().mockResolvedValue({ diags: [] });
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
				removeTempDirSync(tmpDir);
			}
		});

		it("batch: tallies timedOutFiles separately from silent-on-clean unconfirmed files", async () => {
			let call = 0;
			const touchFile = vi.fn().mockImplementation(async () => {
				call += 1;
				// First file's touch times out; second file's touch is confirmed but
				// its server is a #533 silent-on-clean tier (mocked.cascadeTier below).
				// #1179: `inconclusive` is an explicit enumerable wrapper field now.
				return call === 1 ? { diags: [], inconclusive: true } : { diags: [] };
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
				removeTempDirSync(tmpDir);
			}
		});
	});

	describe("silent-clean confirmation provenance", () => {
		async function runMarkdown(args: Record<string, unknown>, files: string[]) {
			const tool = createLspDiagnosticsTool();
			return (await tool.execute(
				"diag-marksman-confirmation",
				args,
				new AbortController().signal,
				null,
				{ cwd: path.dirname(files[0]!) },
			)) as any;
		}

		it.each(["primary", "all"] as const)(
			"single clean Markdown file preserves touch confirmation for %s scope",
			async (serverScope) => {
				mocked.cascadeTier = "tier3-silent";
				const getAdvertisedCommands = vi.fn().mockResolvedValue([]);
				const executeCommand = vi.fn();
				(mocked.service as any).getAdvertisedCommands = getAdvertisedCommands;
				(mocked.service as any).executeCommand = executeCommand;
				(mocked.service as any).touchFile = vi.fn().mockResolvedValue({
					diags: [],
					confirmation: "confirmed",
				});
				const tmpDir = fs.mkdtempSync(
					path.join(os.tmpdir(), "pi-lens-marksman-confirmed-"),
				);
				const file = path.join(tmpDir, "README.md");
				fs.writeFileSync(file, "# Example\n");

				try {
					const result = await runMarkdown(
						{ path: file, severity: "all", serverScope, waitMs: 500 },
						[file],
					);
					expect(result.details?.unconfirmed).toBe(false);
					expect(String(result.content[0]?.text)).toContain(
						"Primary LSP (marksman): confirmed clean.",
					);
					expect(getAdvertisedCommands).not.toHaveBeenCalled();
					expect(executeCommand).not.toHaveBeenCalled();
				} finally {
					removeTempDirSync(tmpDir);
				}
			},
		);

		it("batch clean Markdown files count as clean, not inconclusive", async () => {
			mocked.cascadeTier = "tier3-silent";
			(mocked.service as any).touchFile = vi.fn().mockResolvedValue({
				diags: [],
				confirmation: "confirmed",
			});
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-marksman-batch-"),
			);
			const files = ["a.md", "b.md", "c.md", "d.md"].map((name) =>
				path.join(tmpDir, name),
			);
			for (const file of files)
				fs.writeFileSync(file, `# ${path.basename(file)}\n`);

			try {
				const result = await runMarkdown(
					{
						paths: files,
						severity: "all",
						serverScope: "primary",
						waitMs: 500,
					},
					files,
				);
				expect(result.details?.cleanFiles).toBe(4);
				expect(result.details?.unconfirmedFiles).toBe(0);
				expect(result.details?.outcomeCounts).toMatchObject({
					clean: 4,
					inconclusive: 0,
				});
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("default all-scope Markdown batch preserves touch confirmation", async () => {
			mocked.cascadeTier = "tier3-silent";
			const touchFile = vi.fn().mockResolvedValue({
				diags: [],
				confirmation: "confirmed",
			});
			(mocked.service as any).touchFile = touchFile;
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-marksman-default-batch-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n");

			try {
				const result = await runMarkdown({ paths: [file], severity: "all" }, [
					file,
				]);
				expect(touchFile).toHaveBeenCalledWith(
					file,
					"# Example\n",
					expect.objectContaining({ clientScope: "all" }),
				);
				expect(result.details?.cleanFiles).toBe(1);
				expect(result.details?.unconfirmedFiles).toBe(0);
				expect(result.details?.outcomeCounts).toMatchObject({
					clean: 1,
					inconclusive: 0,
				});
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("a cut-off auxiliary demotes the file verdict but keeps the primary line honest (#1470)", async () => {
			// The narrowing, end to end on the tool that IS the security lane's read
			// surface. The primary confirmed clean; opengrep was cut off. Pre-fix
			// this rendered "Primary LSP: confirmed clean." + "No auxiliary
			// findings." with `unconfirmed: false` — a clean bill of health for a
			// scan that never ran. It must now say which coverage is missing WITHOUT
			// claiming the primary failed to confirm (that would be the same
			// overclaim pointing the other way).
			mocked.cascadeTier = "tier3-silent";
			(mocked.service as any).touchFile = vi.fn().mockResolvedValue({
				diags: [],
				confirmation: "partial",
				unconfirmedServerIds: ["opengrep"],
			});
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-marksman-cutoff-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n");

			try {
				const result = await runMarkdown(
					{ path: file, severity: "all", serverScope: "all", waitMs: 500 },
					[file],
				);
				const text = result.content?.[0]?.text ?? "";
				expect(result.details?.unconfirmed).toBe(true);
				expect(result.details?.unconfirmedServerIds).toEqual(["opengrep"]);
				expect(text).toContain("Auxiliary coverage INCOMPLETE");
				expect(text).toContain("opengrep");
				// The primary's own verdict is untouched — no silent-on-clean text.
				expect(text).not.toContain("push-only, silent-on-clean");
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		// #1470 F2: the WARM-ATTACH consumer path. A warm session never reaches the
		// local `touchFile` branch above — `isWarmAttached()` sends every file to
		// the incumbent instead — so the two tests below are the ones that actually
		// cover the default route. Without them, dropping
		// `attached.response.unconfirmedServerIds` or narrowing the incumbent's
		// `confirmation !== undefined` check back to `=== "confirmed"` restores the
		// exact pre-fix false clean while the whole tools suite stays green.
		it("carries the INCUMBENT's coverage gap into the rendered result (#1470)", async () => {
			// Non-empty result on purpose: this is the `total > 0` render branch,
			// where the coverage line is appended after the findings rather than
			// after "No auxiliary findings." Both branches must say it.
			mocked.warmAttached = true;
			mocked.attachedDiagnostics.mockResolvedValue({
				available: true,
				response: {
					diagnostics: [
						{
							severity: 1,
							message: "from incumbent",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
							source: "marksman",
						},
					],
					confirmation: "partial",
					unconfirmedServerIds: ["opengrep"],
				},
			});
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-attached-cutoff-findings-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n");

			try {
				const result = await runMarkdown(
					{ path: file, severity: "all", serverScope: "all", waitMs: 500 },
					[file],
				);
				const text = result.content?.[0]?.text ?? "";
				expect(result.details?.unconfirmedServerIds).toEqual(["opengrep"]);
				expect(text).toContain("from incumbent");
				expect(text).toContain("Auxiliary coverage INCOMPLETE");
				expect(text).toContain("opengrep");
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("an INCUMBENT partial confirmation still counts as the primary's confirmation (#1470)", async () => {
			// The other half of the warm-attach consumer contract. Reading the
			// incumbent's verdict as `=== "confirmed"` looks safely fail-closed, but
			// it drops the primary's real confirmation on the floor and renders the
			// silent-on-clean apology for a primary that DID confirm — the same
			// overclaim pointing the other way. The honest output demotes the FILE
			// verdict and names the scanner, nothing more.
			mocked.cascadeTier = "tier3-silent";
			mocked.warmAttached = true;
			mocked.attachedDiagnostics.mockResolvedValue({
				available: true,
				response: {
					diagnostics: [],
					confirmation: "partial",
					unconfirmedServerIds: ["opengrep"],
				},
			});
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-attached-cutoff-clean-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n");

			try {
				const result = await runMarkdown(
					{ path: file, severity: "all", serverScope: "all", waitMs: 500 },
					[file],
				);
				const text = result.content?.[0]?.text ?? "";
				expect(result.details?.unconfirmed).toBe(true);
				expect(result.details?.unconfirmedServerIds).toEqual(["opengrep"]);
				expect(text).toContain("Auxiliary coverage INCOMPLETE");
				expect(text).not.toContain("push-only, silent-on-clean");
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		// #1470 F3: the BATCH/directory route has its own demotion site
		// (`collectFileDiagnosticResult`), and its own consequence — the persisted
		// workspace-diagnostics cache, whose write gate is `confirmation !==
		// "unconfirmed"`. Without the demotion a partially covered batch result is
		// recorded as a confirmed clean and replayed by every later sweep, so the
		// false clean outlives the touch that produced it.
		it("a batch file whose auxiliary was cut off is neither counted clean nor cached (#1470)", async () => {
			mocked.cascadeTier = "tier3-silent";
			const touchFile = vi.fn().mockResolvedValue({
				diags: [],
				confirmation: "partial",
				unconfirmedServerIds: ["opengrep"],
			});
			(mocked.service as any).touchFile = touchFile;
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-batch-cutoff-"),
			);
			const dataDir = path.join(tmpDir, "data");
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = dataDir;
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n");

			try {
				const first = await runMarkdown(
					{ paths: [file], severity: "all", serverScope: "all", waitMs: 500 },
					[file],
				);
				expect(first.details?.cleanFiles).toBe(0);
				expect(first.details?.unconfirmedFiles).toBe(1);

				// The replay half: a second batch over the same unchanged file must
				// still pay a real touch. A cached "clean" entry would serve the
				// lookup instead, and the partial answer would read as confirmed
				// forever after.
				touchFile.mockClear();
				const second = await runMarkdown(
					{ paths: [file], severity: "all", serverScope: "all", waitMs: 500 },
					[file],
				);
				expect(touchFile).toHaveBeenCalledTimes(1);
				expect(second.details?.cleanFiles).toBe(0);
			} finally {
				if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = previousDataDir;
				removeTempDirSync(tmpDir);
			}
		});

		it("missing confirmation metadata stays unconfirmed and does not try a TypeScript command", async () => {
			mocked.cascadeTier = "tier3-silent";
			const getAdvertisedCommands = vi.fn().mockResolvedValue([]);
			const executeCommand = vi.fn();
			(mocked.service as any).getAdvertisedCommands = getAdvertisedCommands;
			(mocked.service as any).executeCommand = executeCommand;
			(mocked.service as any).touchFile = vi
				.fn()
				.mockResolvedValue({ diags: [] });
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-marksman-unconfirmed-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n");

			try {
				const result = await runMarkdown(
					{ path: file, severity: "all", serverScope: "primary", waitMs: 500 },
					[file],
				);
				expect(result.details?.unconfirmed).toBe(true);
				expect(executeCommand).not.toHaveBeenCalled();
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("an inconclusive touch remains unconfirmed even if confirmation metadata is present", async () => {
			mocked.cascadeTier = "tier3-silent";
			(mocked.service as any).touchFile = vi.fn().mockResolvedValue({
				diags: [],
				inconclusive: true,
				confirmation: "confirmed",
			});
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-marksman-timeout-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n");

			try {
				const result = await runMarkdown(
					{ path: file, severity: "all", serverScope: "primary", waitMs: 500 },
					[file],
				);
				expect(result.details?.unconfirmed).toBe(true);
				expect(result.details?.timedOut).toBe(true);
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		// #1253: the warm-attach branch returns BEFORE the local touch, so the
		// incumbent's own confirmation is the only provenance available there —
		// without it a warm-attached session reports every clean Markdown file
		// unconfirmed, exactly the bug this issue is about, just on the other
		// collection route.
		it("a warm-attached incumbent's confirmed empty result renders clean", async () => {
			mocked.cascadeTier = "tier3-silent";
			mocked.warmAttached = true;
			mocked.attachedDiagnostics.mockResolvedValue({
				available: true,
				response: { diagnostics: [], confirmation: "confirmed" },
			});
			const executeCommand = vi.fn();
			(mocked.service as any).executeCommand = executeCommand;
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-marksman-warm-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n");

			try {
				const result = await runMarkdown(
					{ paths: [file], severity: "all", serverScope: "primary" },
					[file],
				);
				expect(result.details?.outcomeCounts).toMatchObject({
					clean: 1,
					inconclusive: 0,
				});
				expect(executeCommand).not.toHaveBeenCalled();
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("a warm-attached result WITHOUT confirmation stays unconfirmed", async () => {
			mocked.cascadeTier = "tier3-silent";
			mocked.warmAttached = true;
			mocked.attachedDiagnostics.mockResolvedValue({
				available: true,
				response: { diagnostics: [] },
			});
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-marksman-warm-unconfirmed-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n");

			try {
				const result = await runMarkdown(
					{ paths: [file], severity: "all", serverScope: "primary" },
					[file],
				);
				expect(result.details?.outcomeCounts).toMatchObject({
					clean: 0,
					inconclusive: 1,
				});
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("a real Marksman diagnostic remains a finding", async () => {
			mocked.cascadeTier = "tier3-silent";
			(mocked.service as any).touchFile = vi.fn().mockResolvedValue({
				diags: [
					{
						severity: 1,
						message: "Broken link",
						range: {
							start: { line: 2, character: 0 },
							end: { line: 2, character: 8 },
						},
						source: "marksman",
					},
				],
				confirmation: "confirmed",
			});
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-marksman-finding-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n\n[missing](missing.md)\n");

			try {
				const result = await runMarkdown(
					{ path: file, severity: "all", serverScope: "primary", waitMs: 500 },
					[file],
				);
				expect(result.details?.totalDiagnostics).toBe(1);
				expect(result.details?.unconfirmed).toBe(false);
				expect(String(result.content[0]?.text)).toContain("Broken link");
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		/**
		 * #1253: the severity-filtered-to-empty branch.
		 *
		 * `canTrustTouchConfirmation` gates on the touch's own provenance, so a
		 * confirmed touch that DID return diagnostics — which the requested
		 * severity floor then filters away — now yields "clean". The pre-#1253
		 * arrangement fell through to `classifyEmptyResult`, which for a
		 * tier3-silent server answers "unconfirmed": the server's silence was
		 * treated as unexplained even though it had demonstrably answered.
		 *
		 * "clean at the requested severity" is the honest verdict here — the
		 * unconfirmed doctrine (#799/#814) exists for a server that said NOTHING,
		 * not one whose findings were filtered by the caller's own floor. This
		 * pins that distinction, which is otherwise only exercised with `diags: []`
		 * and would flip back silently.
		 */
		it("a confirmed touch whose findings are all below the severity floor is clean, not unconfirmed", async () => {
			mocked.cascadeTier = "tier3-silent";
			const hint = {
				severity: 4 as const,
				message: "Consider a reference link",
				range: {
					start: { line: 2, character: 0 },
					end: { line: 2, character: 8 },
				},
				source: "marksman",
			};
			(mocked.service as any).touchFile = vi.fn().mockResolvedValue({
				diags: [hint],
				confirmation: "confirmed",
			});
			// The tier-3 sync escape hatch is for a GENUINELY empty result; a
			// severity-filtered one must not reach for it.
			const executeCommand = vi.fn();
			(mocked.service as any).executeCommand = executeCommand;
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-marksman-severity-"),
			);
			const file = path.join(tmpDir, "README.md");
			fs.writeFileSync(file, "# Example\n\n[missing](missing.md)\n");

			try {
				const result = await runMarkdown(
					{ paths: [file], severity: "error", serverScope: "primary" },
					[file],
				);

				expect(result.details?.outcomeCounts).toMatchObject({
					clean: 1,
					inconclusive: 0,
				});
				// The hint is below the floor, so it is not reported as a finding...
				expect(result.details?.totalDiagnostics).toBe(0);
				// ...but the server answered, so nothing consults the sync fallback.
				expect(executeCommand).not.toHaveBeenCalled();
			} finally {
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
			}
		});

		it("orders concurrent same-file results by admission, not settlement (#1198)", async () => {
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-race-"),
			);
			const file = path.join(tmpDir, "race.ts");
			fs.writeFileSync(file, "const value = 1;\n");
			const pending: Array<(value: { diags: any[] }) => void> = [];
			(mocked.service as any).touchFile = vi.fn(
				() => new Promise((resolve) => pending.push(resolve)),
			);
			const oldDiagnostics = [
				{
					severity: 1,
					message: "old TypeScript blocker",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					source: "ts",
				},
			];
			let nextWriteIndex = 0;
			const tool = createLspDiagnosticsTool(() => {
				// This is the same monotonic source used by the live runtime. The
				// important assertion is that the old operation reserves 1 before
				// the newer clean operation reserves 2.
				return ++nextWriteIndex;
			});
			try {
				const old = tool.execute(
					"diag-old",
					{ path: file, severity: "all", waitMs: 1000, serverScope: "primary" },
					new AbortController().signal,
					null,
					{ cwd: tmpDir },
				);
				const newer = tool.execute(
					"diag-new",
					{ path: file, severity: "all", waitMs: 1000, serverScope: "primary" },
					new AbortController().signal,
					null,
					{ cwd: tmpDir },
				);
				await vi.waitFor(() => expect(pending).toHaveLength(2));

				// The newer clean result settles first. It is affirmative here (the
				// test server is not the silent tier), so it may reconcile. The old
				// blocker then settles late and must be dropped by its earlier token.
				pending[1]?.({ diags: [] });
				await newer;
				pending[0]?.({ diags: oldDiagnostics });
				await old;

				expect(reconcileScanDiagnosticsMock).toHaveBeenCalledTimes(2);
				// The mock bypasses widget-state's guard, so assert the admission
				// tokens directly: clean settled first with token 2, while the old
				// blocker settled second with token 1 and is dropped by the real
				// reconcile guard.
				expect(
					reconcileScanDiagnosticsMock.mock.calls.map((call) => call[3]),
				).toEqual([2, 1]);
				expect(reconcileScanDiagnosticsMock.mock.calls[0]?.[1]).toEqual([]);
			} finally {
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
			}
		});

		it("does NOT reconcile a timed-out (#570 inconclusive) result into the footer", async () => {
			const touchFile = vi.fn().mockImplementation(async () => {
				return { diags: [], inconclusive: true };
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
				removeTempDirSync(tmpDir);
			}
		});

		// #1095: a non-empty result whose content binding MISMATCHES disk must not
		// re-cement the footer (the #1092 window-1 transcript: 17 live-looking
		// diagnostics stamped fresh while tsc exits 0). This is THE headline
		// regression: the "non-empty = definitionally confirmed" doctrine is now
		// gated on binding.
		function staleTouchResult(messages: string[], bound: boolean | "unknown") {
			// #1179: the `touchFile` wrapper — `binding` is an EXPLICIT enumerable
			// field (survives any copy of `.diags`), not a non-enumerable side-channel.
			return {
				diags: messages.map((message) => ({
					severity: 1,
					message,
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					source: "ts",
				})),
				binding: { boundToCurrentDisk: bound },
			};
		}

		it("does NOT reconcile a NON-EMPTY result whose binding mismatches disk (T2 headline #1092)", async () => {
			const touchFile = vi
				.fn()
				.mockResolvedValue(
					staleTouchResult(["stale error from a pre-fix view"], false),
				);
			(mocked.service as any).touchFile = touchFile;
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-binding-mismatch-"),
			);
			const file = path.join(tmpDir, "bad.ts");
			fs.writeFileSync(file, "const value = 1;\n");

			const tool = createLspDiagnosticsTool(() => 1);
			try {
				await tool.execute(
					"diag-binding-mismatch",
					{ path: file, severity: "all", waitMs: 500 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				);
				// Demoted to unconfirmed → the stale view never confirms/writes.
				expect(reconcileScanDiagnosticsMock).not.toHaveBeenCalled();
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("DOES reconcile a non-empty result when the binding is unknown — version-less fallback unchanged (T3)", async () => {
			const touchFile = vi
				.fn()
				.mockResolvedValue(staleTouchResult(["real error"], "unknown"));
			(mocked.service as any).touchFile = touchFile;
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-binding-unknown-"),
			);
			const file = path.join(tmpDir, "bad.ts");
			fs.writeFileSync(file, "const value = 1;\n");

			const tool = createLspDiagnosticsTool(() => 1);
			try {
				await tool.execute(
					"diag-binding-unknown",
					{ path: file, severity: "all", waitMs: 500 },
					new AbortController().signal,
					null,
					{ cwd: "." },
				);
				// Unknown binding preserves the pre-#1095 doctrine: a non-empty result
				// is confirmed and reconciled.
				expect(reconcileScanDiagnosticsMock).toHaveBeenCalledTimes(1);
				expect(reconcileScanDiagnosticsMock.mock.calls[0][2]).toBe(true);
			} finally {
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
			}
		});

		// #2154 round 4: round 3's version of this case passed
		// `createLspDiagnosticsTool(undefined, …)` — with no LSP service no
		// result ever reached the guard, so it stayed green with the guard
		// deleted outright. It now drives the same clean-result path as the
		// test above, and asserts the seam WAS reached before asserting the
		// callback was not called.
		it("rejects an undefined reconciliation result as unconfirmed", async () => {
			mocked.cascadeTier = "waits";
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-reconcile-undefined-"),
			);
			const file = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(file, "const value = 1;\n");
			reconcileScanDiagnosticsMock.mockReturnValue(undefined);
			const onConfirmedNoBlockers = vi.fn();

			try {
				await createLspDiagnosticsTool(
					() => 1,
					onConfirmedNoBlockers,
				).execute(
					"diag-reconcile-undefined",
					{ path: file, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				);
				expect(reconcileScanDiagnosticsMock).toHaveBeenCalledTimes(1);
				expect(onConfirmedNoBlockers).not.toHaveBeenCalled();
			} finally {
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
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
					{
						paths: [suppressed, unsuppressed],
						severity: "all",
						concurrency: 2,
					},
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(result.details?.totalDiagnostics).toBe(1);
			} finally {
				removeTempDirSync(tmpDir);
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
								serverId: "typescript",
							},
							{
								severity: 2,
								message: "avoid nested ternaries",
								range: {
									start: { line: 1, character: 0 },
									end: { line: 1, character: 1 },
								},
								source: "ast-grep",
								serverId: "ast-grep",
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
				removeTempDirSync(tmpDir);
			}
		});

		it("serverScope: 'primary' passes clientScope: 'primary' to touchFile, skipping auxiliary scanners", async () => {
			const touchFile = vi.fn().mockResolvedValue({ diags: [] });
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
				removeTempDirSync(tmpDir);
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
			const touchFile = vi
				.fn()
				.mockResolvedValue({ diags: [primaryOnlyDiagnostic] });
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
				removeTempDirSync(tmpDir);
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
				removeTempDirSync(tmpDir);
			}
		});

		it("default (no serverScope param) still passes clientScope: 'all' to touchFile", async () => {
			const touchFile = vi.fn().mockResolvedValue({ diags: [] });
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
				removeTempDirSync(tmpDir);
			}
		});

		it("#629: default all-scope path uses touchFile and avoids a second getDiagnostics call", async () => {
			const touchFile = vi.fn().mockResolvedValue({ diags: [] });
			(mocked.service as any).touchFile = touchFile;
			const getDiagnostics = vi.fn().mockResolvedValue([]);
			(mocked.service as any).getDiagnostics = getDiagnostics;
			const tool = createLspDiagnosticsTool();
			const tmpDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lsp-diag-scope-default-touch-"),
			);
			const clean = path.join(tmpDir, "clean.ts");
			fs.writeFileSync(clean, "const value = 1;\n");

			try {
				const result = (await tool.execute(
					"diag-scope-default-touch",
					{ path: clean, severity: "all" },
					new AbortController().signal,
					null,
					{ cwd: "." },
				)) as any;

				expect(result.isError).toBeUndefined();
				expect(touchFile).toHaveBeenCalledWith(
					clean,
					"const value = 1;\n",
					expect.objectContaining({ clientScope: "all" }),
				);
				expect(getDiagnostics).not.toHaveBeenCalled();
			} finally {
				removeTempDirSync(tmpDir);
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
								serverId: "typescript",
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
								serverId: "ast-grep",
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
				removeTempDirSync(tmpDir);
			}
		});
	});
});
