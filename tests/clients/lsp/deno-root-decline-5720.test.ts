/**
 * #5720: a Deno project (`deno.json`, no tsconfig or package.json) got the
 * typescript server, never deno. `DenoExcludeRoot` declined the file, but
 * `resolveLspServerCwd` read the decline as "no root" and handed typescript
 * the file's own directory, so deno (`fallbackFor: "typescript"`) was never
 * acquired.
 *
 * The real `LSPService.getClientsForFile`, `ClientRegistry` root resolution and
 * the production server rows run; only each row's `spawn` is replaced, with a
 * launch that yields nothing, so no client or process exists to double. The
 * observable is which server's `spawn` the acquisition ladder reached.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function unavailableServer<T extends { spawn: unknown }>(server: T): T {
	return { ...server, spawn: vi.fn(async () => undefined) };
}

async function acquire(project: string, file: string) {
	const { DenoServer, TypeScriptServer } =
		await import("../../../clients/lsp/server.js");
	const { LSPService } = await import("../../../clients/lsp/index.js");
	const typescript = unavailableServer(TypeScriptServer);
	const deno = unavailableServer(DenoServer);
	getServersForFileWithConfig.mockReturnValue([typescript, deno]);
	await new LSPService(undefined, project).getClientsForFile(file);
	return { typescript, deno };
}

function fixture(prefix: string, marker: string, source: string) {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(project);
	fs.writeFileSync(path.join(project, marker), "{}\n");
	const file = path.join(project, "main.ts");
	fs.writeFileSync(file, source);
	return { project, file };
}

describe("Deno root decline (#5720)", () => {
	beforeEach(async () => {
		vi.resetModules();
		(await import("../../../clients/lsp/config.js"))._setServersForFileForTests(
			getServersForFileWithConfig,
		);
		getServersForFileWithConfig.mockReset();
	});

	it("never launches TypeScript for a file inside deno.json, and reaches Deno", async () => {
		const { project, file } = fixture(
			"fixture-5720-deno-",
			"deno.json",
			'Deno.writeTextFileSync("out", "ok");\n',
		);

		const { typescript, deno } = await acquire(project, file);

		expect(typescript.spawn).not.toHaveBeenCalled();
		expect(deno.spawn).toHaveBeenCalledOnce();
	});

	it("keeps TypeScript for a normal project without deno.json", async () => {
		const { project, file } = fixture(
			"fixture-5720-typescript-",
			"package.json",
			"export const answer = 42;\n",
		);

		const { typescript } = await acquire(project, file);

		// Deno is not asserted: with a launch that yields nothing, the
		// `fallbackFor` alternate is acquired by design.
		expect(typescript.spawn).toHaveBeenCalledOnce();
	});
});
