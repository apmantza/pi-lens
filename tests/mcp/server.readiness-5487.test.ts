// mutation-lane: exclude
/**
 * #5487 (verify of #5495 r2, R2-1): what `pilens_diagnostics` tells the agent
 * when the Rust server cannot give a verdict yet.
 *
 * Recurrence this file prevents: a workspace that failed to load (a broken
 * `Cargo.toml`) and a server still loading both printed "1 timed out (check
 * didn't complete within the wait budget)" on the paths route and "check timed
 * out ... pass a larger waitMs" on the file route. An agent told "timed out"
 * retries or waits longer, and a broken manifest never loads by waiting. The
 * touch already knew the cause (`TouchFileResult.inconclusiveReason` and the
 * server's message); the text now says it.
 *
 * A real MCP server child runs the `rust` server, overridden to the fixture
 * server (`tests/fixtures/fake-lsp-server.mjs`, `FAKE_LSP_LOADING_*`), which
 * announces `experimental/serverStatus` the way rust-analyzer does.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

const fake = new URL("../fixtures/fake-lsp-server.mjs", import.meta.url).href;

/** A fixture-server entry point with `fixtureEnv`. */
function fixtureServer(file: string, fixtureEnv: Record<string, string>) {
	fs.writeFileSync(
		file,
		`${Object.entries(fixtureEnv)
			.map(
				([key, value]) =>
					`process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};\n`,
			)
			.join("")}await import(${JSON.stringify(fake)});\n`,
	);
	return [process.execPath, file];
}

/**
 * A Cargo project whose `rust` server is the fixture with `fixtureEnv`, plus a
 * Python file whose server announces nothing and never answers a pull: a
 * plain diagnostics-wait lapse beside the Rust cause in one batch.
 */
function rustProject(fixtureEnv: Record<string, string>) {
	const env = setupTestEnvironment("readiness5487-");
	const home = path.join(env.tmpDir, "home");
	fs.mkdirSync(home);
	fs.writeFileSync(
		path.join(home, "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				rust: {
					command: fixtureServer(
						path.join(env.tmpDir, "rust-server.mjs"),
						fixtureEnv,
					),
				},
				python: {
					command: fixtureServer(path.join(env.tmpDir, "py-server.mjs"), {
						FAKE_LSP_LOADING_MS: "600000",
						FAKE_LSP_LOADING_NO_STATUS: "1",
						FAKE_LSP_IGNORE_PULL: "1",
					}),
				},
			},
			disabledServers: ["ast-grep", "typos", "opengrep", "python-jedi"],
		}),
	);
	const project = path.join(env.tmpDir, "proj");
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(project, "Cargo.toml"),
		'[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n',
	);
	const file = path.join(project, "src", "main.rs");
	fs.writeFileSync(file, "fn main() {\n    let v: Vec<i32> = 1;\n}\n");
	fs.writeFileSync(path.join(project, "pyproject.toml"), "[project]\n");
	const pyFile = path.join(project, "probe.py");
	fs.writeFileSync(pyFile, "x = 1\n");
	return { env, home, project, file, pyFile };
}

/**
 * The file route (`path`), then the paths route (`paths`), on one server; with
 * `mixed`, a batch of the Rust file and the silent Python file too.
 */
async function bothRoutes(
	ws: ReturnType<typeof rustProject>,
	mixed = false,
): Promise<{ fileText: string; pathsText: string; mixedText?: string }> {
	const child = new McpHarness({
		cwd: ws.project,
		env: {
			PI_LENS_HOME: ws.home,
			PI_LENS_TEST_MODE: "0",
			PI_LENS_DISABLE_LSP_INSTALL: "1",
			// The paths route's default budget holds a loading server about 23 s;
			// the cap keeps the case short and changes no wording.
			PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS: "2000",
		},
	});
	try {
		const call = async (id: number, target: Record<string, unknown>) => {
			const res = await child.request(
				id,
				"tools/call",
				{
					name: "pilens_diagnostics",
					arguments: {
						source: "lsp",
						scope: "paths",
						serverScope: "primary",
						severity: "all",
						waitMs: 1500,
						...target,
					},
				},
				60_000,
			);
			return (res.result as { content: { text: string }[] }).content[0].text;
		};
		const fileText = await call(54871, { path: ws.file });
		const pathsText = await call(54872, { paths: [ws.file] });
		if (!mixed) return { fileText, pathsText };
		const mixedText = await call(54873, { paths: [ws.file, ws.pyFile] });
		return { fileText, pathsText, mixedText };
	} finally {
		child.dispose();
	}
}

describe("pilens_diagnostics names why a Rust server gave no verdict (#5487)", () => {
	it("pilens_diagnostics names a server that is still loading", async () => {
		const ws = rustProject({ FAKE_LSP_LOADING_MS: "600000" });
		try {
			const { fileText, pathsText, mixedText } = await bothRoutes(ws, true);

			expect(fileText).toContain(
				"Primary LSP (rust): unconfirmed — server still loading the workspace; retry shortly.",
			);
			// The cause is named once per file it covers; the other file keeps its own.
			expect(mixedText).toContain(
				"2 unconfirmed: 1 not checked: server still loading the workspace; retry shortly. The other 1: 1 timed out (check didn't complete within the wait budget). NOT the same as 0 diagnostics.",
			);
			expect(pathsText).toContain(
				"1 not checked: server still loading the workspace; retry shortly.",
			);
			for (const text of [fileText, pathsText]) {
				expect(text).not.toContain("timed out");
				expect(text).not.toContain("No diagnostics found.");
			}
			expect(fileText).not.toContain("Primary LSP (rust): confirmed clean");
			expect(pathsText).toContain("Outcomes: clean=0");
		} finally {
			ws.env.cleanup();
		}
	}, 120_000);

	it("pilens_diagnostics names a failed workspace load with the server's message", async () => {
		const ws = rustProject({
			FAKE_LSP_LOADING_MS: "200",
			FAKE_LSP_LOADING_HEALTH: "error",
		});
		try {
			const { fileText, pathsText } = await bothRoutes(ws);

			expect(fileText).toContain(
				"Primary LSP (rust): unconfirmed — workspace failed to load (Failed to load workspaces.); fix the project manifest.",
			);
			expect(pathsText).toContain(
				"1 not checked: workspace failed to load (Failed to load workspaces.); fix the project manifest.",
			);
			for (const text of [fileText, pathsText]) {
				expect(text).not.toContain("timed out");
				expect(text).not.toContain("No diagnostics found.");
			}
			expect(fileText).not.toContain("Primary LSP (rust): confirmed clean");
			expect(pathsText).toContain("Outcomes: clean=0");
		} finally {
			ws.env.cleanup();
		}
	}, 120_000);
});
