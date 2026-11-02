// mutation-lane: exclude
/**
 * #5014 (shape 10), split out of `server.smoke.test.ts` for #3801: the five
 * cases below start a real MCP server child plus fake-LSP shims each (4.6 to
 * 7.7 s apiece), a third of that file's time. They share nothing with the
 * rest of it, so the sequencer can now balance the two halves.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness } from "./harness.js";

// Spawns the MCP server as a real stdio subprocess, like server.smoke.test.ts.
// #5014 (shape 10): a fallback that answers in place of a primary that never
// did must not read as the primary's "confirmed clean". The recurrence: the
// `python` primary was refused or failed to start, `python-jedi` (a
// `fallbackFor: "python"` language server) answered with nothing, and
// `unansweredPrimaries` took the fallback's presence for the primary's, so
// `pilens_diagnostics` printed "Primary LSP (python): confirmed clean."
describe("a fallback's answer never confirms a primary that did not answer (#5014)", () => {
	type Primary =
		| "fails"
		| "killed"
		| "answers"
		| "project-local-refused"
		| "not-installed";
	function pythonFamily(prefix: string, primary: Primary) {
		const env = setupTestEnvironment(prefix);
		const home = path.join(env.tmpDir, "home");
		fs.mkdirSync(home);
		const fake = new URL("../fixtures/fake-lsp-server.mjs", import.meta.url)
			.href;
		// Each start of the fake fallback and of the failing primary appends a
		// line, so a cell can show which servers ran.
		const jediStarts = path.join(env.tmpDir, "jedi-starts.log");
		const primaryStarts = path.join(env.tmpDir, "primary-starts.log");
		const answer = path.join(env.tmpDir, "answer.mjs");
		// Push-only, one empty publish: how jedi-language-server answers a
		// clean file (clients/lsp/wait-policy/strategies.ts "python-jedi").
		fs.writeFileSync(
			answer,
			`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(jediStarts)}, "start\\n");\nprocess.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";\nprocess.env.FAKE_LSP_PUBLISH_SEQUENCE = "empty";\nawait import(${JSON.stringify(fake)});\n`,
		);
		// #5034 review F1/F3: the fallback is pinned for every root. An adopted
		// root reads no session config, so the `lsp.json` override below does not
		// reach it, and jedi resolves from PATH: this shim is the only
		// `jedi-language-server` the child's PATH holds (`verdicts`).
		const bin = path.join(env.tmpDir, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "jedi-language-server"),
			`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(answer)} "$@"\n`,
			{ mode: 0o755 },
		);
		fs.writeFileSync(
			path.join(bin, "jedi-language-server.cmd"),
			`@"${process.execPath}" "${answer}" %*\r\n`,
		);
		const fail = path.join(env.tmpDir, "fail.mjs");
		fs.writeFileSync(
			fail,
			`import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(primaryStarts)}, "start\\n");\nprocess.exit(1);\n`,
		);
		// A cause nothing names: the process dies by signal before it speaks.
		const killed = path.join(env.tmpDir, "killed.mjs");
		fs.writeFileSync(killed, 'process.kill(process.pid, "SIGKILL");\n');
		fs.writeFileSync(
			path.join(home, "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					"python-jedi": { command: [process.execPath, answer] },
					...(primary === "fails" && {
						python: { command: [process.execPath, fail] },
					}),
					...(primary === "killed" && {
						python: { command: [process.execPath, killed] },
					}),
					...(primary === "answers" && {
						python: { command: [process.execPath, answer] },
					}),
					// #5034 review r3 (F9): a binary that exists nowhere. The catalog
					// search finds any host pyright: every LSP child's PATH gets
					// node's own directory (`buildAugmentedPath`), where an `npm -g`
					// pyright sits and which is /usr/bin on a distro node.
					...(primary === "not-installed" && {
						python: {
							command: [
								path.join(env.tmpDir, "not-installed", "pyright-langserver"),
								"--stdio",
							],
						},
					}),
				},
				disabledServers: ["ast-grep", "typos", "opengrep"],
			}),
		);
		// A `pi-lens-` prefixed directory is a pi-owned temp artifact the
		// analysis-root rule never adopts (clients/analysis-root.ts), and the
		// fixture's own `.git` marker would make the shared parent both
		// projects' root: neither may hide the adopted-root split driven here.
		fs.rmSync(path.join(env.tmpDir, ".git"), {
			recursive: true,
			force: true,
		});
		const sessionRoot = path.join(env.tmpDir, "projA");
		const fileRoot = path.join(env.tmpDir, "projB");
		for (const root of [sessionRoot, fileRoot]) {
			fs.mkdirSync(root);
			fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\n");
		}
		if (primary === "project-local-refused") {
			// A project-supplied checker in a root the session only adopted: the
			// registry refuses it unrun (clients/lsp/client-registry.ts).
			const bin = path.join(fileRoot, "node_modules", ".bin");
			fs.mkdirSync(bin, { recursive: true });
			fs.writeFileSync(
				path.join(bin, "pyright-langserver"),
				"#!/bin/sh\nexit 1\n",
				{ mode: 0o755 },
			);
		}
		const file = path.join(fileRoot, "probe.py");
		fs.writeFileSync(file, "x = 1  # fake-lsp-clean\n");
		const starts = (log: string): number =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length
				: 0;
		return {
			env,
			home,
			bin,
			sessionRoot,
			fileRoot,
			file,
			jediStarts: () => starts(jediStarts),
			primaryStarts: () => starts(primaryStarts),
		};
	}

	/**
	 * One server per workspace (`dispose` removes its cwd): the scopes in turn,
	 * with the failing primary's start count after each call.
	 */
	async function verdicts(
		ws: ReturnType<typeof pythonFamily>,
		cwd: string,
		serverScopes: readonly ("all" | "primary")[],
	): Promise<{ texts: string[]; primaryStarts: number[] }> {
		const child = new McpHarness({
			cwd,
			env: {
				PI_LENS_HOME: ws.home,
				PI_LENS_TEST_MODE: "0",
				// #5034 review F1: the host's PATH decided which python servers
				// existed (a dev box with jedi in ~/.local/bin passed, CI without it
				// read "python, python-jedi"). The child sees the shim, node and the
				// system directories only, and installs nothing.
				PATH: [ws.bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
					path.delimiter,
				),
				PI_LENS_DISABLE_LSP_INSTALL: "1",
			},
		});
		try {
			const texts: string[] = [];
			const primaryStarts: number[] = [];
			for (const [index, serverScope] of serverScopes.entries()) {
				const res = await child.request(
					5014 + index,
					"tools/call",
					{
						name: "pilens_diagnostics",
						arguments: {
							source: "lsp",
							scope: "paths",
							path: ws.file,
							serverScope,
							severity: "all",
							waitMs: 5000,
						},
					},
					60_000,
				);
				texts.push(
					(res.result as { content: { text: string }[] }).content[0].text,
				);
				primaryStarts.push(ws.primaryStarts());
			}
			return { texts, primaryStarts };
		} finally {
			child.dispose();
		}
	}

	/** The verdict names python alone: the fake fallback was acquired. */
	function expectUnconfirmed(
		ws: ReturnType<typeof pythonFamily>,
		texts: readonly string[],
		scopes: readonly string[],
	): void {
		for (const [index, text] of texts.entries()) {
			expect(text, `${scopes[index]}: ${text}`).not.toContain(
				"confirmed clean",
			);
			// "(python)", not "(python, python-jedi)": the alternate was acquired,
			// so only its owner is unanswered (#5034 review F3).
			expect(text, `${scopes[index]}: ${text}`).toContain(
				"Primary LSP (python): not available",
			);
		}
		expect(ws.jediStarts(), "the fake fallback started").toBeGreaterThan(0);
	}

	it.each([
		["a spawn failure", "fails", "fileRoot"],
		["a failure no cause names (killed by signal)", "killed", "fileRoot"],
		[
			"a project-local checker refused in an adopted root",
			"project-local-refused",
			"sessionRoot",
		],
		// #5034 review F5, r3 F9: the primary's binary exists nowhere, none installed.
		["a primary that is not installed", "not-installed", "fileRoot"],
	] as const)(
		"%s is not confirmed clean by the fallback, for both server scopes",
		async (_label, primary, cwdKey) => {
			const ws = pythonFamily("fallback5014-", primary);
			try {
				const scopes = ["all", "primary"] as const;
				const { texts } = await verdicts(ws, ws[cwdKey], scopes);
				expectUnconfirmed(ws, texts, scopes);
			} finally {
				ws.env.cleanup();
			}
		},
		120_000,
	);

	// #5034 review F5: the state table's breaker row. The first call's spawn
	// failure opens the breaker, so the later calls start no primary at all;
	// the fallback still answers and still confirms nothing.
	it("a primary in its breaker cool-down is not confirmed clean by the fallback", async () => {
		const ws = pythonFamily("fallback5014-", "fails");
		try {
			const scopes = ["all", "all", "primary"] as const;
			const { texts, primaryStarts } = await verdicts(ws, ws.fileRoot, scopes);
			expect(primaryStarts[0], "the first call starts the primary").toBe(1);
			expect(
				primaryStarts.slice(1),
				"the later calls start nothing: the breaker is open",
			).toEqual([1, 1]);
			// The first call is the spawn-failure row above; these are the
			// cool-down calls.
			expectUnconfirmed(ws, texts.slice(1), scopes.slice(1));
		} finally {
			ws.env.cleanup();
		}
	}, 150_000);

	it("still confirms clean when the python primary itself answers", async () => {
		const ws = pythonFamily("fallback5014ok-", "answers");
		try {
			const {
				texts: [text],
			} = await verdicts(ws, ws.fileRoot, ["all"]);
			expect(text).toContain("Primary LSP (python): confirmed clean.");
		} finally {
			ws.env.cleanup();
		}
	}, 90_000);
});
