import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function availableServer<T extends { spawn: unknown }>(server: T): T {
	return {
		...server,
		spawn: vi.fn(async () => ({
			process: { killed: false },
			stdin: {},
			stdout: {},
			stderr: {},
			pid: 5720,
			source: "test",
		})),
	};
}

describe("Deno root decline (#5720)", () => {
	beforeEach(async () => {
		vi.resetModules();
		(await import("../../../clients/lsp/config.js"))._setServersForFileForTests(
			getServersForFileWithConfig,
		);
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
		});
	});

	it("lets Deno acquire a file inside deno.json instead of TypeScript", async () => {
		const { DenoServer, TypeScriptServer } =
			await import("../../../clients/lsp/server.js");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const project = fs.mkdtempSync(
			path.join(process.cwd(), "fixture-5720-deno-"),
		);
		dirs.push(project);
		fs.writeFileSync(path.join(project, "deno.json"), "{}\n");
		const file = path.join(project, "main.ts");
		fs.writeFileSync(file, 'Deno.writeTextFileSync("out", "ok");\n');

		const typescript = availableServer(TypeScriptServer);
		const deno = availableServer(DenoServer);
		getServersForFileWithConfig.mockReturnValue([typescript, deno]);

		const result = await new LSPService(undefined, project).getClientsForFile(
			file,
		);

		expect(result.clients.map((entry) => entry.info.id)).toEqual(["deno"]);
		expect(typescript.spawn).not.toHaveBeenCalled();
		expect(deno.spawn).toHaveBeenCalledOnce();
	});

	it("keeps TypeScript for a normal project without deno.json", async () => {
		const { DenoServer, TypeScriptServer } =
			await import("../../../clients/lsp/server.js");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const project = fs.mkdtempSync(
			path.join(process.cwd(), "fixture-5720-typescript-"),
		);
		dirs.push(project);
		fs.writeFileSync(path.join(project, "package.json"), "{}\n");
		const file = path.join(project, "main.ts");
		fs.writeFileSync(file, "export const answer = 42;\n");

		const typescript = availableServer(TypeScriptServer);
		const deno = availableServer(DenoServer);
		getServersForFileWithConfig.mockReturnValue([typescript, deno]);

		const result = await new LSPService(undefined, project).getClientsForFile(
			file,
		);

		expect(result.clients.map((entry) => entry.info.id)).toEqual([
			"typescript",
		]);
		expect(typescript.spawn).toHaveBeenCalledOnce();
		expect(deno.spawn).not.toHaveBeenCalled();
	});
});
