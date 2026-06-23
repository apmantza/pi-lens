import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => mocked.service,
}));

import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

describe("lsp_diagnostics tool", () => {
	beforeEach(() => {
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
});
