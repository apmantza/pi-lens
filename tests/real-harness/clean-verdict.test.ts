import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	claimScratchDir,
	SCRATCH_DIR_ROOT,
} from "../../scripts/lib/scratch-dir.mjs";
import { removeTempDirSync } from "../clients/test-utils.js";
import { createRealPiProject, withRealPi } from "../support/real-pi-harness.js";

type JsonObject = Record<string, unknown>;

// flake-shape: real-process-spawn — the per-edit tool result is built by the real host's tool_result handler, which no in-process double reaches
//
// Recurrence prevented: #5258 (the 2026-11-04 clean-verdict probe): the write's
// tool result read `✓ JavaScript/TypeScript clean` for a TypeScript file with
// a type error under `--no-lsp`, and for a generated file with a type error,
// and a bare `✓ 14ms` for a file whose kind has no analyzer, because the
// all-clear line was the DEFAULT of a missing `unconfirmedStatus`, not the
// answer of a runner that completed. Each row writes a file that really holds
// an error and reads the line the host hands the model.

type WriteResult = { text: string; causes: ReadonlyArray<JsonObject> };

const writeResult = async (
	script: string,
	args: readonly string[],
	extraEnv: Record<string, string> = {},
	project?: string,
): Promise<WriteResult> =>
	withRealPi(
		{
			fixture: "clean-verdict",
			script,
			args,
			...(project !== undefined && { project }),
			env: { ...extraEnv, PI_LENS_TEST_MODE: "0" },
		},
		async (pi) => {
			await pi.prompt("write the file");
			const result = await pi.awaitToolResult("write");
			await pi.events("agent_end");
			return {
				text: JSON.stringify(result),
				causes: pi.lens
					.degradations()
					.filter((row) => row.kind === "runner-skip-cause"),
			};
		},
	);

const writeResultText = async (
	script: string,
	args: readonly string[],
	extraEnv: Record<string, string> = {},
): Promise<string> => (await writeResult(script, args, extraEnv)).text;

describe("real pi: a write no check covered never reads clean (#5258)", () => {
	it.each([
		{
			name: "a TypeScript type error under --no-lsp",
			script: "script.json",
			args: ["--no-lsp"],
			reason:
				"no primary checker is enabled for this kind (--no-lsp turns off its language server)",
		},
		{
			name: "a type error in a generated file",
			script: "generated.json",
			args: ["--no-lsp"],
			reason: "generated file",
		},
		{
			name: "a build.gradle syntax error under --no-lsp",
			script: "gradle.json",
			args: ["--no-lsp"],
			reason:
				"no primary checker is enabled for this kind (--no-lsp turns off its language server)",
		},
		{
			// #5285 r3: the --no-lsp return for a kind with no runner came before
			// the generated-file policy.
			name: "a generated build.gradle under --no-lsp",
			script: "generated-gradle.json",
			args: ["--no-lsp"],
			reason: "generated file",
		},
		{
			name: "a file whose kind has no analyzer",
			script: "kindless.json",
			args: ["--no-lsp"],
			reason: "no analyzer handles this file type",
		},
	])(
		"$name renders an unchecked line that names its reason",
		async (row) => {
			const text = await writeResultText(row.script, row.args);
			expect(text).toContain("⚠");
			expect(text).toContain(row.reason);
			expect(text).not.toContain("✓");
		},
		60_000,
	);
});

// Recurrence prevented: #5258 (the 2026-11-08 tool-alignment audit): 119 runner
// returns were a bare `skipped`, so the write notice worded a runner that needs
// a config the project lacks, a runner whose tool is missing and a runner the
// install kill switch kept away with one sentence ("a language tool is missing,
// timed out, or failed to run"). A markdown file under `--no-lsp` has two
// primary runners: spellcheck (typos is absent) and vale (no `.vale.ini`).
describe("real pi: a skipped check names why the file was not checked (#5258)", () => {
	// An unreachable PATH tail hides host-installed typos and vale; the harness
	// keeps the repo bin and node's own directory ahead of it.
	const hidden = { PATH: "/nonexistent-path-5258" };

	it("says which runner is not installed and which is not configured", async () => {
		const text = await writeResultText("markdown.json", ["--no-lsp"], hidden);
		// typos has no managed install, so the kill switch is not its cause.
		expect(text).toContain("spellcheck: not installed;");
		expect(text).toContain("vale: not configured");
		expect(text).not.toContain("a language tool is missing, timed out");
		expect(text).not.toContain("✓");
	}, 60_000);
});

// Recurrence prevented: #5258 r2 (review F1): `toolAbsentSkip()` worded every
// unusable command as "not installed, and the managed install is off", so a
// trust-refused project binary, a `--version` that hangs and one that exits
// non-zero told the user to install a tool that was installed, and the
// session-long `runner-skip-cause` record kept the wrong cause. Each row puts
// the real outcome on disk (a project shim, a PATH shim) and reads the line the
// host hands the model.
describe("real pi: a skip names the true cause of an unusable tool (#5258)", () => {
	const scratchRoot = SCRATCH_DIR_ROOT;

	const textFor = async (
		script: string,
		prepare: (project: string, shimDir: string) => void,
		args: readonly string[] = ["--no-lsp"],
	): Promise<WriteResult> => {
		const project = createRealPiProject("clean-verdict", scratchRoot);
		// Outside the project: pi project trust refuses a PATH entry inside it.
		const shimDir = claimScratchDir(scratchRoot, "real-pi-shims");
		try {
			prepare(project, shimDir);
			return await writeResult(
				script,
				args,
				{ PATH: shimDir, PI_LENS_DISABLE_TOOL_INSTALL: "1" },
				project,
			);
		} finally {
			removeTempDirSync(project);
			removeTempDirSync(shimDir);
		}
	};

	const shim = (dir: string, name: string, body: string): void => {
		const file = path.join(dir, name);
		writeFileSync(file, `#!/bin/sh\n${body}\n`);
		chmodSync(file, 0o755);
	};

	it("names the install kill switch when it is what kept an installable tool away", async () => {
		const { text, causes } = await textFor("shell.json", () => {});
		expect(text).toContain(
			"shellcheck: not installed, and the managed install is off (PI_LENS_DISABLE_TOOL_INSTALL=1)",
		);
		expect(JSON.stringify(causes)).toContain("shellcheck:install-disabled");
		expect(text).not.toContain("✓");
	}, 60_000);

	// #5258 r3 (verify N1b): the row read "✓ HTML clean" on CI. pi trusts a
	// project with no trust-requiring resources, and the maintainer host has a
	// `~/.agents/skills` above the scratch root, which pi counts as one, so the
	// row passed there on the host's ambient trust. `--no-approve` pins the state.
	it("says the project's own binary was refused, not that the tool is missing", async () => {
		const { text, causes } = await textFor(
			"html.json",
			(project) => {
				const bin = path.join(project, "node_modules", ".bin");
				mkdirSync(bin, { recursive: true });
				shim(bin, "htmlhint", "exit 0");
			},
			["--no-lsp", "--no-approve"],
		);
		expect(text).toContain("htmlhint: the project's own binary was refused");
		expect(text).not.toContain("htmlhint: not installed");
		expect(JSON.stringify(causes)).toContain("htmlhint:trust-refused");
	}, 60_000);

	// #5258 r3 (verify N1a): the hang was `exec sleep 40`, and CI's PATH here
	// (the shim dir and node's dir) has no `sleep`, so the shim exited 127 and
	// read as a rejected probe. Node is the one binary this PATH must hold.
	it("says the version probe did not finish when it hangs, not that the tool is missing", async () => {
		const { text, causes } = await textFor("shell.json", (_project, dir) =>
			shim(
				dir,
				"shellcheck",
				`exec "${process.execPath}" -e "setTimeout(() => {}, 40000)"`,
			),
		);
		expect(text).toContain("shellcheck: its availability probe did not finish");
		expect(text).not.toContain("shellcheck: not installed");
		expect(JSON.stringify(causes)).toContain("shellcheck:probe-incomplete");
	}, 90_000);

	it("says the tool rejected its version probe when it exits non-zero", async () => {
		const { text, causes } = await textFor("shell.json", (_project, dir) =>
			shim(dir, "shellcheck", "exit 3"),
		);
		expect(text).toContain(
			"shellcheck: a binary it runs was found but rejected its version probe",
		);
		expect(text).not.toContain("shellcheck: not installed");
		expect(JSON.stringify(causes)).toContain("shellcheck:probe-rejected");
	}, 60_000);

	// #5258 r3 (verify N2, N5): rubocop resolves by its own `--version` spawn,
	// not a checker, and its skip read the registry ladder it never probed:
	// "not installed, and the managed install is off", twice, because ruby
	// lists it in two groups.
	it("reads rubocop's own probe, once, when its --version exits non-zero", async () => {
		const { text, causes } = await textFor("ruby.json", (project, dir) => {
			writeFileSync(path.join(project, ".rubocop.yml"), "AllCops: {}\n");
			shim(dir, "rubocop", "exit 3");
		});
		const cause =
			"rubocop: a binary it runs was found but rejected its version probe";
		expect(text).toContain(cause);
		expect(text).not.toContain(`${cause}; rubocop:`);
		expect(text).not.toContain("rubocop: not installed");
		expect(JSON.stringify(causes)).toContain("rubocop:probe-rejected");
		expect(JSON.stringify(causes)).not.toContain("rubocop:install-disabled");
	}, 60_000);
});
