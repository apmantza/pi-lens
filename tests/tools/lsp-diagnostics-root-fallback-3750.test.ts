/**
 * #3750: when a server's project root could not be resolved (no Cargo.toml for
 * rust-analyzer, no dune-project for ocamllsp, ...) pi-lens still launches the
 * server rooted at the file's own directory and records
 * `lsp:server-root-fallback` (`resolveLspServerCwd`). A server in that state
 * analyses nothing for a detached file: rust-analyzer answers an EMPTY result,
 * and `lsp_diagnostics` rendered "Primary LSP (rust): confirmed clean." for a
 * file with a type error.
 *
 * Recurrence guarded: an empty answer from a server that was never given a
 * project read as clean because the verdict chain only asked the server's
 * capability tier, never how its root was resolved.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, the real LSPService and
 * the real registry entries over a real stdio JSON-RPC wire. The only fake is
 * the language-server binary itself (tests/fixtures/fake-lsp-server.mjs), the
 * host boundary: a `rust-analyzer`/`ocamllsp`/`gopls` shim on PATH is launched
 * through the production `spawn` of `RustServer`/`OCamlServer`/`GoServer`, so
 * the root function, the root fallback and the verdict code are all production.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
// The fixture root goes through `setupTestEnvironment` so the tmp-fixture
// hygiene gate attributes and sweeps it; the spawned servers hold the
// workspaces past the last assertion, so removal is the drained cleanup below.
const env = setupTestEnvironment("pi-lens-3750-");
const root = env.tmpDir;
const shimDir = path.join(root, "shim-bin");
const originalPath = process.env.PATH;

/** A fake language server launched under `name` from PATH. */
function writeShim(name: string): void {
	fs.mkdirSync(shimDir, { recursive: true });
	const shim = path.join(shimDir, name);
	fs.writeFileSync(
		shim,
		[
			"#!/usr/bin/env node",
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	fs.chmodSync(shim, 0o755);
	if (process.platform === "win32") {
		fs.writeFileSync(`${shim}.cmd`, `@node "%~dp0${name}" %*\r\n`);
	}
}

/**
 * The server's pull answer for the next spawn: `empty` is an answering server
 * with nothing to report (the detached-file shape), `items` a real finding for
 * every file, `mixed` a finding except for a file whose text carries the fake
 * server's clean marker.
 */
function answerWith(pull: "empty" | "items" | "mixed"): void {
	if (pull === "mixed") delete process.env.FAKE_LSP_RESPOND_PULL_WITH;
	else process.env.FAKE_LSP_RESPOND_PULL_WITH = pull;
}

let counter = 0;
function workspace(markers: Record<string, string> = {}): string {
	const dir = path.join(root, `ws-${counter++}`);
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(markers)) {
		fs.writeFileSync(path.join(dir, name), body);
	}
	return dir;
}

function source(dir: string, name: string, body = "let x = 1\n"): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	return file;
}

type ToolOutput = { text: string; details: Record<string, unknown> };

async function runTool(
	cwd: string,
	params: Record<string, unknown>,
): Promise<ToolOutput> {
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(cwd);
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-3750",
		{ waitMs: 3000, serverScope: "primary", ...params },
		undefined,
		null,
		{ cwd },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		details: result.details ?? {},
	};
}

describe("#3750 an empty result under a server-root fallback", () => {
	let service: { shutdown: () => Promise<void> } | undefined;

	beforeAll(async () => {
		// Host-boundary stub: this fixture exercises the real LSP service and
		// admits its project-code servers as a trusted project.
		setProjectTrustState("trusted");
		for (const name of [
			"rust-analyzer",
			"csharp-ls",
			"lua-language-server",
			"ocamllsp",
			"gopls",
		])
			writeShim(name);
		process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});

	// #4397: the ledger keeps the first ENTRIES_PER_KIND rows of a kind. Every
	// sibling case records a `tool-cwd-resolution` row, so the case reading the
	// row for its own file saw it dropped once enough siblings had run first.
	beforeEach(() => {
		resetDegradationLedger();
	});

	afterAll(async () => {
		resetProjectTrust();
		process.env.PATH = originalPath;
		delete process.env.FAKE_LSP_RESPOND_PULL_WITH;
		await cleanupTestEnvironmentsDrained("pi-lens-3750-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
	});

	it("reports a rust file with no Cargo.toml as unconfirmed, naming the missing project", async () => {
		answerWith("empty");
		const dir = workspace();
		const file = source(dir, "orphan.rs");

		const { text, details } = await runTool(dir, { path: file });

		expect(text).toContain(
			"Primary LSP (rust): unconfirmed — rust-analyzer: no project root found for this file (looked for Cargo.toml / Cargo.lock)",
		);
		expect(text).toContain("NOT the same as 0 diagnostics");
		expect(text).toContain(
			"check the file from inside its project and re-run.",
		);
		expect(text).not.toContain("confirmed clean");
		expect(details.unconfirmed).toBe(true);
		expect(String(details.rootFallbackReason)).toContain("rust-analyzer");
		// The signal and the degradation row come from the one place.
		expect(
			getDegradationSummary()
				.find((group) => group.kind === "tool-cwd-resolution")
				?.latestReasons.map((row) => row.reason),
		).toContain(`lsp:server-root-fallback:${file}`);
	});

	it("stays unconfirmed on the second check of the same file (the once-only degradation row does not gate the verdict)", async () => {
		answerWith("empty");
		const dir = workspace();
		const file = source(dir, "twice.rs");

		const first = await runTool(dir, { path: file });
		const second = await runTool(dir, { path: file });

		expect(first.text).toContain("Primary LSP (rust): unconfirmed");
		expect(second.text).toContain("Primary LSP (rust): unconfirmed");
		expect(second.text).not.toContain("confirmed clean");
	});

	it("reaches the pilens_diagnostics / lens_diagnostics source=lsp route unchanged", async () => {
		// The reported entry point folds into the same probe (tools/lens-diagnostics.ts).
		answerWith("empty");
		const dir = workspace();
		const file = source(dir, "viaLens.rs");
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(dir);
		const { createLensDiagnosticsTool } =
			await import("../../tools/lens-diagnostics.js");
		const lens = createLensDiagnosticsTool({} as never, () => dir);

		const result = (await lens.execute(
			"probe-3750-lens",
			{ source: "lsp", scope: "paths", paths: [file], serverScope: "primary" },
			undefined,
			null,
			{ cwd: dir },
		)) as { content: Array<{ text?: string }> };

		const text = String(result.content[0]?.text);
		expect(text).toContain("rust-analyzer: no project root found");
		expect(text).toContain("0 files confirmed clean, 1 unconfirmed");
		expect(text).not.toContain("No diagnostics found");
	});

	it("keeps confirmed clean for a rust file inside a Cargo project", async () => {
		answerWith("empty");
		const dir = workspace({ "Cargo.toml": '[package]\nname = "x"\n' });
		const file = source(dir, "lib.rs");

		const { text, details } = await runTool(dir, { path: file });

		expect(text).toContain("Primary LSP (rust): confirmed clean.");
		expect(text).not.toContain("unconfirmed");
		expect(details.unconfirmed).toBe(false);
		expect(details.rootFallbackReason).toBeUndefined();
	});

	it("still reports the findings a fallback-rooted server does publish", async () => {
		answerWith("items");
		const dir = workspace();
		const file = source(dir, "found.rs");

		const { text, details } = await runTool(dir, { path: file });

		expect(text).toContain("Primary LSP (rust): 1 diagnostic.");
		expect(text).not.toContain("unconfirmed");
		expect(details.primaryDiagnosticsCount).toBe(1);
	});

	it("applies to every server that requires a project, not only rust (csharp-ls)", async () => {
		answerWith("empty");
		// A project one level BELOW the file's directory: csharp-ls searches its
		// cwd recursively, so pi-lens starts it at the fallback root (#4806 F4)
		// and the #3750 demotion applies to its empty answer.
		const dir = workspace();
		fs.mkdirSync(path.join(dir, "sub"));
		fs.writeFileSync(path.join(dir, "sub", "App.csproj"), "<Project />\n");
		const file = source(dir, "Orphan.cs");

		const { text } = await runTool(dir, { path: file });

		expect(text).toContain(
			"Primary LSP (csharp): unconfirmed — csharp-ls: no project root found for this file",
		);
		// A hosted server was not declined by the bounded search (#4806 N3).
		expect(text).not.toContain("bounded search");
		expect(text).not.toContain("confirmed clean");
	});

	// Recurrence guarded (#4806 N3): a project deeper than the 128-directory search
	// bound declines, and the sentence "no project root found" then asserted an
	// absence the bounded search could not support; the declined reason names the
	// bound (on this path only: the rust case above must not carry it).
	// Recurrence guarded (#4806 F1): csharp-ls aborts without a project file, so
	// the registry declines the spawn at a project-less fallback root. No client
	// then answers, and the primary line said only "could not be started, or was
	// still starting" (a transient start problem) while the #3750 root verdict
	// that names the durable cause never reached the model.
	it("names the missing project when csharp-ls is declined at a project-less root", async () => {
		answerWith("empty");
		const dir = workspace();
		const file = source(dir, "Orphan.cs");

		const { text, details } = await runTool(dir, { path: file });

		expect(text).toMatch(
			/Primary LSP \(csharp[^)]*\): not available — no language server answered for this file/,
		);
		expect(text).toContain(
			"csharp-ls: no project root found for this file (looked for *.csproj / *.sln / *.slnx, including a bounded search of 128 directories below it).",
		);
		expect(text).not.toContain("confirmed clean");
		expect(text).not.toContain("started at the file's directory");
		expect(details.unconfirmed).toBe(true);
		expect(details.rootFallbackReason).toBe(
			"csharp-ls: no project root found for this file (looked for *.csproj / *.sln / *.slnx, including a bounded search of 128 directories below it)",
		);
		// The decline is the registry's policy record, not a spawn failure.
		const declined = getDegradationSummary().find(
			(group) => group.kind === "lsp-root-declined",
		);
		expect(declined?.latestReasons[0]?.subject).toContain("csharp:");
	});

	// Recurrence guarded (#4806 N2): the root verdict on an unavailable primary
	// was wired for every `requiresProjectRoot` server but pinned only for
	// csharp-ls, so narrowing either arm of the widening to csharp stayed green.
	// Here rust-analyzer's command is a path that does not exist (no client ever
	// runs), and the file has no Cargo.toml: the model must read the durable cause
	// (no project), not only the transient "could not be started".
	it("names the missing project when a rust-analyzer that cannot start is asked about a project-less file (single file and batch)", async () => {
		answerWith("empty");
		const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		try {
			const dir = workspace();
			fs.mkdirSync(path.join(dir, ".pi-lens"));
			fs.writeFileSync(
				path.join(dir, ".pi-lens", "lsp.json"),
				JSON.stringify({
					serverOverrides: {
						rust: { command: [path.join(dir, "missing", "rust-analyzer")] },
					},
				}),
			);
			const first = source(dir, "one.rs");
			const second = source(dir, "two.rs");

			const single = await runTool(dir, { path: first });

			expect(single.text).toMatch(
				/Primary LSP \(rust\): not available — no language server answered for this file/,
			);
			expect(single.text).toContain(
				"rust-analyzer: no project root found for this file (looked for Cargo.toml / Cargo.lock).",
			);
			expect(single.text).not.toContain("started at the file's directory");
			// The bounded csharp-ls search is not rust-analyzer's decision.
			expect(single.text).not.toContain("bounded search");
			expect(single.details.unconfirmed).toBe(true);
			expect(single.details.rootFallbackReason).toBe(
				"rust-analyzer: no project root found for this file (looked for Cargo.toml / Cargo.lock)",
			);

			const batch = await runTool(dir, { paths: [first, second] });

			expect(batch.text).toContain("0 files confirmed clean, 2 unconfirmed");
			expect(batch.text).toContain(
				"2 with no language server answer (it could not be started, or was still starting): rust-analyzer: no project root found for this file (looked for Cargo.toml / Cargo.lock). NOT the same as 0 diagnostics.",
			);
			expect(batch.text).not.toContain("bounded search");
		} finally {
			if (savedInstall === undefined)
				delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
			else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
		}
	}, 30_000);

	// Recurrence guarded: #3750 round 1 demoted all 11 undefined-root servers, so a
	// healthy Lua repo (`.luarc.json` is optional; lua-language-server analyses
	// standalone files) could never read confirmed clean.
	it("keeps confirmed clean for a server whose root markers are optional (lua-language-server)", async () => {
		answerWith("empty");
		const dir = workspace();
		const file = source(dir, "main.lua");

		const { text, details } = await runTool(dir, { path: file });

		expect(text).toContain("Primary LSP (lua): confirmed clean.");
		expect(details.unconfirmed).toBe(false);
		expect(details.rootFallbackReason).toBeUndefined();
	});

	it("keeps confirmed clean for a second server whose markers are optional (ocamllsp)", async () => {
		answerWith("empty");
		const dir = workspace();
		const file = source(dir, "orphan.ml");

		const { text } = await runTool(dir, { path: file });

		expect(text).toContain("Primary LSP (ocaml): confirmed clean.");
	});

	// Recurrence guarded: the round-1 text said "no project root found (looked for
	// Cargo.toml / Cargo.lock)" while a Cargo.toml sat right there, because
	// NearestRoot refuses fixture and ignored directories.
	it("uses neutral wording when a marker exists but the directory is excluded as a root", async () => {
		answerWith("empty");
		const dir = workspace();
		const crate = path.join(dir, "__fixtures__", "crate");
		fs.mkdirSync(path.join(crate, "src"), { recursive: true });
		fs.writeFileSync(path.join(crate, "Cargo.toml"), '[package]\nname = "z"\n');
		const file = source(path.join(crate, "src"), "lib.rs");

		const { text } = await runTool(dir, { path: file });

		expect(text).toContain(
			"Primary LSP (rust): unconfirmed — rust-analyzer: found Cargo.toml for this file but pi-lens did not select it as the project root",
		);
		expect(text).not.toContain("no project root found");
	});

	// Recurrence guarded (F4, round 2 verify): a rust file with no Cargo.toml
	// inside a real git repo read "found .git ... did not select it as the project
	// root", because the wording probe's own `.git` fallback marker is not one of
	// rust's rootMarkers. Nothing was refused; no project root was found.
	it("names the missing project, not a refused .git, for a rust file in a git repo with no Cargo.toml", async () => {
		answerWith("empty");
		const repo = workspace();
		// A repository as `isRealGitMarker` reads one (a `.git` directory with a
		// HEAD, clients/path-utils.ts); a real `git init` spawn is not needed.
		fs.mkdirSync(path.join(repo, ".git"));
		fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
		const file = source(repo, "orphan.rs");

		for (const sessionCwd of [repo, path.dirname(repo)]) {
			const { text } = await runTool(sessionCwd, { path: file });

			expect(text).toContain(
				"Primary LSP (rust): unconfirmed — rust-analyzer: no project root found for this file (looked for Cargo.toml / Cargo.lock)",
			);
			expect(text).not.toContain("did not select");
			expect(text).not.toContain("found .git");
		}
	});

	it("keeps confirmed clean for a server whose root falls back to the file directory by design (gopls)", async () => {
		answerWith("empty");
		const dir = workspace();
		const file = source(dir, "main.go");

		const { text } = await runTool(dir, { path: file });

		expect(text).toContain("Primary LSP (go): confirmed clean.");
	});

	it("names the fallback in an explicit batch and keeps the in-project file confirmed clean", async () => {
		answerWith("empty");
		const bare = source(workspace(), "orphan.rs");
		const projectDir = workspace({ "Cargo.toml": '[package]\nname = "y"\n' });
		const inProject = source(projectDir, "lib.rs");

		const { text, details } = await runTool(root, {
			paths: [bare, inProject],
		});

		expect(text).toContain("1 file confirmed clean, 1 unconfirmed");
		expect(text).toContain(
			"rust-analyzer: no project root found for this file (looked for Cargo.toml / Cargo.lock)",
		);
		expect(text).not.toContain("silent-on-clean");
		expect(details.filesChecked).toBe(2);
	});

	it("joins the distinct reasons of different servers in one batch", async () => {
		answerWith("empty");
		const dir = workspace();
		const rust = source(dir, "orphan.rs");
		const csharp = source(dir, "Orphan.cs");

		const { text } = await runTool(root, { paths: [rust, csharp] });

		expect(text).toContain("0 files confirmed clean, 2 unconfirmed");
		// The declined csharp-ls file names its root verdict with the files no
		// server answered; the rust file keeps the hosted-server wording.
		expect(text).toContain(
			"1 with no language server answer (it could not be started, or was still starting): csharp-ls: no project root found for this file (looked for *.csproj / *.sln / *.slnx, including a bounded search of 128 directories below it); the other 1: rust-analyzer: no project root found for this file (looked for Cargo.toml / Cargo.lock); the server was started at the file's directory and may not have analysed it",
		);
		expect(text).toContain("NOT the same as 0 diagnostics.");
	});

	it("counts a fallback-rooted file that published findings as findings in a batch, and only its empty sibling as unconfirmed", async () => {
		answerWith("mixed");
		const dir = workspace();
		const empty = source(dir, "orphan.rs", "// fake-lsp-clean\n");
		const found = source(dir, "found.rs");

		const { text } = await runTool(root, { paths: [empty, found] });

		expect(text).toContain("findings=1");
		expect(text).toContain("inconclusive=1");
		expect(text).toContain("0 files confirmed clean, 1 unconfirmed");
	});

	it("names the fallback in a directory scan that also found diagnostics", async () => {
		answerWith("mixed");
		const dir = workspace();
		source(dir, "orphan.rs", "// fake-lsp-clean\n");
		source(dir, "found.rs");

		const { text } = await runTool(dir, { path: dir });

		expect(text).toContain("Total diagnostics: 1");
		expect(text).toContain("1 unconfirmed");
		expect(text).toContain(
			"rust-analyzer: no project root found for this file (looked for Cargo.toml / Cargo.lock)",
		);
		expect(text).not.toContain("silent-on-clean");
	});

	it("names the fallback in a directory scan", async () => {
		answerWith("empty");
		const dir = workspace();
		source(dir, "orphan.rs");

		const { text } = await runTool(dir, { path: dir });

		expect(text).toContain("1 unconfirmed");
		expect(text).toContain(
			"(1 unconfirmed in all). NOT the same as 0 diagnostics.",
		);
		expect(text).toContain(
			"rust-analyzer: no project root found for this file (looked for Cargo.toml / Cargo.lock)",
		);
		expect(text).not.toContain("silent-on-clean");
	});
});
