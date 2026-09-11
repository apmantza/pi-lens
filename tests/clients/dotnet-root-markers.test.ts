import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DOTNET_CSHARP_ROOT_MARKERS,
	DOTNET_FSHARP_ROOT_MARKERS,
} from "../../clients/file-kinds.js";
import { removeTempDirSync } from "./test-utils.js";

// Set test mode to isolate logging from production logs
process.env.PI_LENS_TEST_MODE = "1";

vi.mock("../../clients/installer/index.js", () => ({
	ensureTool: vi.fn(),
	getToolEnvironment: vi.fn(async () => ({})),
	findManagedToolBinary: vi.fn(async () => undefined),
}));

vi.mock("../../clients/lsp/launch.js", () => ({
	launchLSP: vi.fn(),
}));

// Suppress sync disk I/O from logLatency — prevents timeout under full-suite load
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: vi.fn(),
	resetLatencyLog: vi.fn(),
}));

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		removeTempDirSync(dir);
	}
	vi.resetModules();
});

// Single-source-of-truth coverage for the .NET root markers (refs #895, PR
// #883 pattern): fixtures are DERIVED from the shared constants, and every
// marker must be honored by BOTH root-resolution subsystems — the LSP root
// detectors in lsp/server.ts and resolveLanguageRootForFile in
// language-profile.ts. If either call site drifts back to a hand-copied list
// that misses (or mistypes) a marker, the corresponding iteration fails here.
describe("dotnet root markers single source of truth (#895)", () => {
	it("every csharp marker is honored by the LSP root detectors and the language-profile resolver", async () => {
		const { CSharpServer, OmniSharpServer } =
			await import("../../clients/lsp/server.js");
		const { resolveLanguageRootForFile } =
			await import("../../clients/language-profile.js");

		for (const pattern of DOTNET_CSHARP_ROOT_MARKERS) {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-dotnet-sst-"));
			dirs.push(tmp);
			const workspace = path.join(tmp, "repo");
			const project = path.join(workspace, "nested");
			const file = path.join(project, "src", "Program.cs");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				path.join(project, pattern.replaceAll("*", "App")),
				"\n",
			);
			fs.writeFileSync(file, "// test\n");

			await expect(CSharpServer.root(file), pattern).resolves.toBe(project);
			await expect(OmniSharpServer.root(file), pattern).resolves.toBe(project);
			expect(resolveLanguageRootForFile(file, workspace), pattern).toBe(
				project,
			);
		}
	});

	it("every fsharp marker is honored by the LSP root detector and the language-profile resolver", async () => {
		const { FSharpServer } = await import("../../clients/lsp/server.js");
		const { resolveLanguageRootForFile } =
			await import("../../clients/language-profile.js");

		for (const pattern of DOTNET_FSHARP_ROOT_MARKERS) {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-dotnet-sst-"));
			dirs.push(tmp);
			const workspace = path.join(tmp, "repo");
			const project = path.join(workspace, "nested");
			const file = path.join(project, "src", "Program.fs");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				path.join(project, pattern.replaceAll("*", "App")),
				"\n",
			);
			fs.writeFileSync(file, "// test\n");

			await expect(FSharpServer.root(file), pattern).resolves.toBe(project);
			expect(resolveLanguageRootForFile(file, workspace), pattern).toBe(
				project,
			);
		}
	});
});
