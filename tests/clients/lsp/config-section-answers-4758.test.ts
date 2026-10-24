/**
 * #4758: a server that PULLS its settings gets them, section by section.
 *
 * Recurrence this file prevents: pi-lens answered every `workspace/configuration`
 * pull from one flat `initializationOptions` blob. A server that asks for a
 * named section its blob did not carry was answered `{}`: pyright asks `python`,
 * `python.analysis` and `pyright`; rust-analyzer asks `rust-analyzer`. The
 * answer was well formed, so nothing failed, and no setting pi-lens or the
 * user configured reached either server.
 *
 * Nothing is doubled below the server registry: the real `LSPService`, the
 * real `ClientRegistry` spawn path (user `serverOverrides` read from a real
 * `.pi-lens/lsp.json`), the real `createLSPClient` and its
 * `workspace/configuration` handler, over stdio to
 * `tests/fixtures/fake-lsp-server.mjs`. The fixture sends the pull after
 * `initialized` and writes the client's answer, the `initializationOptions` it
 * received and the `didChangeConfiguration` payload to its trace file. The
 * servers are the production objects with only `spawn` and `root` replaced, so
 * the declaration under test (`settingsSection`, the pyright builder) is the
 * production one. Ordering is by the answer's own trace line, never a sleep.
 *
 * State table (server x section asked -> answer):
 *   rust (settingsSection "rust-analyzer"), user override check.command:
 *     rust-analyzer                          -> whole merged blob
 *     rust-analyzer.check                    -> the user's check object
 *     rust-analyzer.cargo.buildScripts       -> the built-in default
 *     check (a bare, unmapped section)       -> {}
 *     initializationOptions on the wire      -> the flat blob, unwrapped
 *     didChangeConfiguration payload         -> { "rust-analyzer": blob }
 *   python (pyrightInitialization, no settingsSection):
 *     python / python.analysis / pyright     -> each section's own settings
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_setServersForFileForTests,
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import { LSPService } from "../../../clients/lsp/index.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import {
	PythonServer,
	RustServer,
	pyrightInitialization,
	type LSPServerInfo,
} from "../../../clients/lsp/server.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { waitFor } from "../interleaving-kit.js";
import { removeTempDirSync } from "../test-utils.js";

describe("workspace/configuration answers each section (#4758)", () => {
	let tmp: string;
	let trace: string;

	beforeEach(() => {
		setProjectTrustState("trusted");
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4758-"));
		trace = path.join(tmp, "trace.log");
		fs.writeFileSync(trace, "");
	});
	afterEach(() => {
		resetLSPConfigStateForTests();
		// #4808 F3: the sibling LSP suites restore the process-global trust state;
		// leaving it "trusted" leaks into any case that reads it.
		resetProjectTrust();
		removeTempDirSync(tmp);
	});

	/** Spawn `base` against the fixture and return the trace once the answer is in. */
	async function pullSections(
		base: LSPServerInfo,
		initialization: Record<string, unknown>,
		sections: string[],
		file: string,
	): Promise<{
		answers: unknown[];
		initOptions: unknown;
		pushed: unknown;
	}> {
		const server: LSPServerInfo = {
			...base,
			root: async () => tmp,
			spawn: async () => ({
				process: await spawnFakeLspServer({
					cwd: tmp,
					env: {
						...process.env,
						FAKE_LSP_TRACE_FILE: trace,
						FAKE_LSP_TRACE_CONFIG: "1",
						FAKE_LSP_PULL_SECTIONS: JSON.stringify(sections),
					},
				}),
				initialization,
			}),
		};
		_setServersForFileForTests(() => [server]);
		await initLSPConfig(tmp);
		const service = new LSPService();
		try {
			await service.touchFile(file, "x\n", {
				diagnostics: "none",
				clientScope: "primary",
				source: "warm",
			});
			const lines = await waitFor(
				() => fs.readFileSync(trace, "utf8").split("\n"),
				(all) => all.some((line) => line.startsWith("config-pull-answer ")),
			);
			const payload = (prefix: string): unknown => {
				const line = lines.find((l) => l.startsWith(`${prefix} `));
				return line === undefined
					? undefined
					: JSON.parse(line.slice(prefix.length + 1));
			};
			return {
				answers: payload("config-pull-answer") as unknown[],
				initOptions: payload("init-options"),
				pushed: payload("config-push"),
			};
		} finally {
			await service.shutdown();
		}
	}

	it("answers rust-analyzer's pull from its flat blob, user overrides included", async () => {
		fs.mkdirSync(path.join(tmp, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					rust: { initializationOptions: { check: { command: "clippy" } } },
				},
			}),
		);
		const builtIn = { cargo: { buildScripts: { enable: true } } };
		const merged = { ...builtIn, check: { command: "clippy" } };

		const seen = await pullSections(
			RustServer,
			builtIn,
			[
				"rust-analyzer",
				"rust-analyzer.check",
				"rust-analyzer.cargo.buildScripts",
				"check",
			],
			path.join(tmp, "src", "main.rs"),
		);

		expect(seen.answers).toEqual([
			merged,
			{ command: "clippy" },
			{ enable: true },
			{},
		]);
		// The startup options stay the server's own flat shape.
		expect(seen.initOptions).toEqual(merged);
		expect(seen.pushed).toEqual({ "rust-analyzer": merged });
	}, 30_000);

	it("answers pyright's python, python.analysis and pyright pulls from their sections", async () => {
		const built = pyrightInitialization("/venv/bin/python");

		const seen = await pullSections(
			PythonServer,
			built,
			["python", "python.analysis", "pyright"],
			path.join(tmp, "m.py"),
		);

		expect(seen.answers).toEqual([
			{
				pythonPath: "/venv/bin/python",
				analysis: { diagnosticMode: "openFilesOnly" },
			},
			{ diagnosticMode: "openFilesOnly" },
			{},
		]);
		expect(seen.initOptions).toEqual(built);
		expect(seen.pushed).toEqual(built);
	}, 30_000);
});
