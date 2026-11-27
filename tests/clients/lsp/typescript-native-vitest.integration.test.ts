import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";

const { publicationEvents } = vi.hoisted(() => ({
	publicationEvents: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn((event: Record<string, unknown>) => {
		if (event.phase === "lsp_typescript_diagnostic_sequence")
			publicationEvents.push(event);
	}),
}));

import {
	killProcessTree,
	createLSPClient,
} from "../../../clients/lsp/client.js";

import { normalizeMapKey } from "../../../clients/lsp/path-utils.js";
import { TypeScriptServer } from "../../../clients/lsp/server.js";

const runFile = promisify(execFile);
const RUN_LIVE_NATIVE_TS7 = process.env.PI_LENS_INTEGRATION === "1";
const FIXTURE = path.join(
	process.cwd(),
	"tests",
	"fixtures",
	"native-ts7-vitest",
);

describe.skipIf(!RUN_LIVE_NATIVE_TS7)(
	"live native TS7 Vitest diagnostics",
	() => {
		// The copy lives INSIDE the repo deliberately (L2): the temp project has
		// no node_modules, so native-TS7 detection and `types: ["vitest/globals"]`
		// resolution work only because the ancestor walk reaches the repo's own
		// node_modules. Moving this to os.tmpdir() breaks launchVariant detection
		// (the assertion below fails loudly if that regresses).
		const projectRoot = path.join(
			process.cwd(),
			"tests",
			`native-ts7-live-${process.pid}-${Date.now()}`,
		);
		const providerFile = path.join(projectRoot, "provider-cache.test.ts");
		const controlFile = path.join(projectRoot, "control.ts");
		let spawned: Awaited<ReturnType<typeof TypeScriptServer.spawn>>;
		let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;

		afterAll(async () => {
			if (client) await client.shutdown().catch(() => {});
			if (spawned)
				await killProcessTree(
					spawned.process.process,
					spawned.process.pid,
				).catch(() => {});
			fs.rmSync(projectRoot, { recursive: true, force: true });
		});

		it("keeps Vitest Mock typing clean and surfaces the control error", async () => {
			fs.cpSync(FIXTURE, projectRoot, { recursive: true });
			const intentionalControl = fs.readFileSync(controlFile, "utf8");
			fs.writeFileSync(
				controlFile,
				"export const control: string = 'clean';\n",
			);
			const tscJs = path.join(
				process.cwd(),
				"node_modules",
				"typescript",
				"lib",
				"tsc.js",
			);
			const cleanTsc = await runFile(
				process.execPath,
				[
					tscJs,
					"--project",
					path.join(projectRoot, "tsconfig.json"),
					"--noEmit",
				],
				{ cwd: projectRoot },
			);
			// tsc reports diagnostics on STDOUT (L3); a non-zero exit already
			// rejects the promisified execFile, so assert the stream that would
			// actually carry diagnostics.
			expect(cleanTsc.stdout.trim()).toBe("");
			fs.writeFileSync(controlFile, intentionalControl);

			spawned = await TypeScriptServer.spawn(projectRoot, {
				allowInstall: false,
			});
			expect(spawned?.launchVariant).toBe("native-ts7");
			client = await createLSPClient({
				serverId: TypeScriptServer.id,
				process: spawned!.process,
				root: projectRoot,
				initialization: spawned!.initialization,
				launchVariant: spawned!.launchVariant,
			});

			await client.notify.open(
				providerFile,
				fs.readFileSync(providerFile, "utf8"),
				"typescript",
			);
			await client.waitForDiagnostics(providerFile, 8_000);
			expect(client.getDiagnostics(providerFile)).toEqual([]);

			await client.notify.open(
				controlFile,
				fs.readFileSync(controlFile, "utf8"),
				"typescript",
			);
			await client.waitForDiagnostics(controlFile, 8_000);
			expect(
				client
					.getDiagnostics(controlFile)
					.map((diagnostic) => String(diagnostic.code)),
			).toContain("2322");

			const rawSequence = publicationEvents.map((event) => {
				const metadata = event.metadata as Record<string, unknown>;
				return {
					filePath: event.filePath,
					publicationIndex: metadata.publicationIndex,
					diagnosticCount: metadata.diagnosticCount,
					diagnosticCodes: metadata.diagnosticCodes,
					settledReturn: metadata.settledReturn,
					settleSource: metadata.settleSource,
				};
			});
			console.info(
				`Native TS7 publication sequence: ${JSON.stringify(rawSequence)}`,
			);
			expect(
				rawSequence.some(
					(event) =>
						event.filePath === normalizeMapKey(providerFile) &&
						Array.isArray(event.diagnosticCodes) &&
						!event.diagnosticCodes.includes("2304"),
				),
			).toBe(true);
			expect(
				rawSequence.some(
					(event) =>
						event.filePath === normalizeMapKey(controlFile) &&
						Array.isArray(event.diagnosticCodes) &&
						event.diagnosticCodes.includes("2322"),
				),
			).toBe(true);
		}, 30_000);
	},
);
