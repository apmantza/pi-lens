import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	classify,
	fixtureDispatchCwd,
	FIXTURES,
} from "../../scripts/smoke-tools.mjs";
import { dispatchLintDetailed } from "../../clients/dispatch/integration.js";
import * as safeSpawn from "../../clients/safe-spawn.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// #4130: enumerating three faults let parser_error and unconfirmed_output pass,
// even when the runner never reached a verdict about the file.
describe("tool-smoke runner verdicts (#4130)", () => {
	it.each([
		"timeout",
		"exception",
		"server_error",
		"parser_error",
		"unconfirmed_output",
		"output_limit",
		"tool_not_found",
		"future_fault_kind",
		undefined,
	])("fails %s with or without synthetic diagnostics", (failureKind) => {
		for (const diagnostics of [[], [{ message: "synthetic runner fault" }]]) {
			expect(
				classify({
					result: {
						status: "failed",
						failureKind,
						failureMessage: "could not evaluate output",
						diagnostics,
					},
				}),
			).toEqual({
				state: "fail",
				detail: `${failureKind ?? "unknown"}: could not evaluate output`,
				diags: diagnostics.length,
			});
		}
	});

	it.each(["succeeded", "failed"])("passes a completed %s check", (status) => {
		for (const diagnostics of [[], [{ message: "source error" }]]) {
			expect(
				classify({
					result: {
						status,
						failureKind:
							status === "failed" ? "blocking_diagnostics" : undefined,
						diagnostics,
					},
				}),
			).toEqual({
				state: "pass",
				detail:
					status === "failed" ? "failed (blocking_diagnostics)" : "succeeded",
				diags: diagnostics.length,
			});
		}
	});

	// RECURRENCE THIS PREVENTS: #4130 item 3. A timeout, a signal death and a
	// rejected invocation reached the classifier as a bare skipped result and
	// rendered "unavailable (not a failure)". The skip now names the fault.
	it.each(["did-not-run", "rejected-invocation", "report-missing"])(
		"fails a skip that names the fault %s",
		(skipFault) => {
			expect(
				classify({
					result: {
						status: "skipped",
						skipFault,
						diagnostics: [],
						semantic: "none",
					},
				}),
			).toEqual({
				state: "fail",
				detail: `${skipFault}: tool was invoked and produced no result`,
				diags: 0,
			});
		},
	);

	it("keeps a filtered runner visible as not executed", () => {
		expect(classify(undefined)).toEqual({
			state: "skip",
			detail: "not executed (filtered / when-skipped)",
			diags: 0,
		});
	});
});

describe("tool-smoke fails a runner whose tool broke, through dispatch (#4130)", () => {
	// A yamllint the OS kills mid-run, reached through the real dispatcher. The
	// process boundary (`safeSpawnAsync`) is the only double: it kills the
	// yamllint invocation and passes every other spawn through. Pre-fix the
	// runner's bare skip read as "tool unavailable" and exited 0.
	it("fails a signal-killed yamllint", async () => {
		const fixture = FIXTURES.find((row) => row.lang === "yaml-cwd");
		if (!fixture) throw new Error("yaml-cwd fixture row is missing");
		const source = path.join(repoRoot, fixture.dir);
		fs.mkdirSync(path.join(repoRoot, ".probe-home"), { recursive: true });
		const workspace = fs.mkdtempSync(
			path.join(repoRoot, ".probe-home", "fault-"),
		);
		const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-yamllint-"));
		const previousPath = process.env.PATH;
		const realSpawn = safeSpawn.safeSpawnAsync;
		const spawn = vi
			.spyOn(safeSpawn, "safeSpawnAsync")
			.mockImplementation((cmd, args, options) =>
				args?.includes("parsable")
					? Promise.resolve({
							error: null,
							status: null,
							signal: "SIGKILL",
							stdout: "",
							stderr: "",
						} as never)
					: realSpawn(cmd, args, options),
			);
		try {
			// A hermetic yamllint on PATH: the run must not depend on the host
			// having one (RECURRENCE THIS PREVENTS: the CI Unit tests lanes do not
			// install yamllint, and the spawn assertion below reds before the
			// killed-process classification runs). The shim sits outside the
			// session repository on purpose: a bare lookup never resolves to a
			// PATH entry inside the checkout (#4530), so a shim under
			// `.probe-home` is not discovered. The kill double below intercepts
			// the invocation, so the shim body never executes.
			const shim = path.join(shimDir, "yamllint");
			fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
			fs.chmodSync(shim, 0o755);
			process.env.PATH = `${shimDir}${path.delimiter}${previousPath ?? ""}`;
			fs.cpSync(source, workspace, { recursive: true });
			const { runners } = await dispatchLintDetailed(
				path.join(workspace, fixture.file),
				fixtureDispatchCwd(fixture, workspace),
				{ getFlag: (flag) => (flag === "no-delta" ? true : undefined) },
				{ blockingOnly: false },
			);
			expect(
				spawn.mock.calls.some(([, args]) => args?.includes("parsable")),
			).toBe(true);
			const verdict = classify(
				runners.find((row) => row.runnerId === "yamllint"),
			);
			expect(verdict.state).toBe("fail");
			expect(verdict.detail).toBe(
				"did-not-run: tool was invoked and produced no result",
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			spawn.mockRestore();
			fs.rmSync(workspace, { recursive: true, force: true });
			fs.rmSync(shimDir, { recursive: true, force: true });
		}
	}, 30_000);
});

describe("tool-smoke cwd-sensitive rows (#2697)", () => {
	it("uses the dispatch cwd for real yamllint config discovery (#2691)", async () => {
		const fixture = FIXTURES.find((row) => row.lang === "yaml-cwd");
		if (!fixture) throw new Error("yaml-cwd fixture row is missing");
		const source = path.join(repoRoot, fixture.dir);
		fs.mkdirSync(path.join(repoRoot, ".probe-home"), { recursive: true });
		const workspace = fs.mkdtempSync(
			path.join(repoRoot, ".probe-home", "cwd-"),
		);
		// Outside the session repository on purpose (#4530, #4996): while pi has
		// not trusted the project, the spawn seam drops a PATH entry inside the
		// checkout, so a shim under `.probe-home` is skipped and a host yamllint
		// further down PATH answers instead.
		const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-yamllint-"));
		const previousPath = process.env.PATH;
		const previousProcessCwd = process.cwd();
		const spawn = vi.spyOn(safeSpawn, "safeSpawnAsync");
		try {
			const shim = path.join(shimDir, "yamllint");
			fs.writeFileSync(
				shim,
				// The shim answers with its LAST argument, the file target, so an argv
				// change ahead of it (the `--` terminator of #5544 round 2) cannot
				// desync the position it echoes.
				'#!/bin/sh\nlast=""\nfor arg in "$@"; do last="$arg"; done\n' +
					"printf '%s:1:1: [error] hermetic shim (%s)\\n' \"$last\" key-ordering\n",
			);
			fs.chmodSync(shim, 0o755);
			process.env.PATH = `${shimDir}${path.delimiter}${previousPath ?? ""}`;
			fs.cpSync(source, workspace, { recursive: true });
			const dispatchCwd = fixtureDispatchCwd(fixture, workspace);
			const filePath = path.join(workspace, fixture.file);
			const decoy = path.join(workspace, "host-cwd-decoy");
			fs.mkdirSync(decoy);
			fs.writeFileSync(
				path.join(decoy, ".yamllint"),
				"rules:\n  key-ordering: disable\n",
			);
			process.chdir(decoy);

			const { runners } = await dispatchLintDetailed(
				filePath,
				dispatchCwd,
				{ getFlag: (flag) => (flag === "no-delta" ? true : undefined) },
				{ blockingOnly: false },
			);
			const outcome = runners.find((row) => row.runnerId === "yamllint");
			const diagnostics = outcome?.result.diagnostics ?? [];
			const toolSpawn = spawn.mock.calls.find(([, args]) =>
				args?.includes("-f"),
			);

			expect(process.cwd()).toBe(decoy);
			if (!toolSpawn) {
				throw new Error(
					"yamllint spawn was not observed; the hermetic shim was not discovered",
				);
			}
			expect(toolSpawn[2]?.cwd).toBe(dispatchCwd);
			// #5544: the file argument is the dispatch-cwd-relative path. The CLI
			// matches its config's `ignore` globs against the string it is handed, so
			// an absolute one lets a glob that names an ancestor of the file exclude
			// the file from its own lint. The cwd pin above stays this row's subject.
			// #5544 round 2: `--` precedes the target, so a root-level file named
			// `-a.yml` cannot reach argparse as an option.
			expect(toolSpawn[1]).toEqual([
				"-f",
				"parsable",
				"--",
				path.relative(dispatchCwd, filePath),
			]);
			expect(toolSpawn[1]?.at(-1)).not.toBe(filePath);
			expect(diagnostics.map((diagnostic) => diagnostic.rule)).toContain(
				"key-ordering",
			);
			expect(diagnostics).toHaveLength(1);
			// The spawn is a bare `yamllint`, so the shim's own output is the proof
			// that the shim, not a host yamllint, was the binary that ran (#4996).
			expect(diagnostics[0]?.message).toContain("hermetic shim");
		} finally {
			process.chdir(previousProcessCwd);
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			spawn.mockRestore();
			fs.rmSync(workspace, { recursive: true, force: true });
			fs.rmSync(shimDir, { recursive: true, force: true });
		}
	});

	it("renders a missing tool through the shared visible skip classifier", () => {
		const verdict = classify({
			runnerId: "yamllint",
			result: {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
			},
		});

		expect(verdict).toEqual({
			state: "skip",
			detail: "runner skipped (tool/config unavailable)",
			diags: 0,
		});
	});
});
