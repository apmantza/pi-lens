// flake-shape: real-process-spawn — the defect IS the child process's own exit decision (#2507: libuv finds no referenced handle mid `lsp_diagnostics` and Node exits 0), so the observation has to be a real headless child's exit code and stdout; nothing in-process can watch its own event loop decide to drain, and any in-process double would assert the fixture author's model of the loop instead of the loop.
/**
 * #2507 — a headless pi child must not exit 0 in the middle of a tool call.
 *
 * The reporter's shape, reduced: `pi --mode json -p --no-extensions
 * --extension pi-lens`, stdin ignored, no TUI, no other extension holding a
 * socket or timer. pi-lens unrefs the LSP child, all three of its stdio pipes
 * (`clients/lsp/launch.ts#unrefLspProcessHandles`) and several waiting timers,
 * so once `lsp_diagnostics` reaches an await whose only pending handle is
 * unref'd, the loop drains and the process exits 0 — no error, no result, no
 * `turn_end`. Measured against pyright by the reporter; reproduced here
 * against the repo's own fake LSP fixture, registered for `.py` through the
 * ordinary `.pi-lens.json` custom-server surface.
 *
 * TWO properties, in one child run, because they pull in opposite directions
 * and a fix for either alone is a regression for the other:
 *
 *  1. the child must still be alive when the tool call settles (the defect);
 *  2. the child must still exit BY ITSELF once it has settled (the reason
 *     those handles are unref'd in the first place — a settled one-shot
 *     `pi --print` may not be pinned open by a lingering language server).
 *
 * The child is spawned with `stdio: ["ignore", …]` — the reporter's `< /dev/null`
 * — and never calls `process.exit()`, so its exit is genuinely the event
 * loop's own decision, not the fixture's.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const CHILD_FIXTURE = fileURLToPath(
	new URL("../../fixtures/headless-lsp-tool-child.mjs", import.meta.url),
);
const FAKE_LSP_SERVER = fileURLToPath(
	new URL("../../fixtures/fake-lsp-server.mjs", import.meta.url),
);

/**
 * Generous relative to the ~2s the child actually needs (measured), tight
 * relative to the 360s a LEAKED keep-alive would pin the process open for —
 * which is what makes property 2 above fail loudly instead of hanging the
 * lane.
 */
const CHILD_TIMEOUT_MS = 45_000;

interface ChildRun {
	code: number | null;
	/** Non-null only when the spawn's own timeout had to kill it — i.e. it
	 *  never exited on its own. */
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

function runHeadlessChild(cwd: string, home: string): Promise<ChildRun> {
	return new Promise((resolve, reject) => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		// Probe hygiene (#2506): every logger/ledger this child touches writes
		// under the fixture's own home, never the maintainer's `~/.pi-lens`.
		env.PI_LENS_HOME = home;
		env.PILENS_DATA_DIR = home;
		// A real headless child is not a vitest worker: leaving the test-mode
		// signals in would exercise a code path production never takes.
		delete env.VITEST;
		delete env.PI_LENS_TEST_MODE;
		// Bound the two long waits so the run stays short. Neither creates the
		// defect's window: the drain the fix closes happens the instant nothing
		// referenced remains, whatever the remaining budget is.
		env.PI_LENS_LSP_WARMUP_TIMEOUT_MS = "5000";
		env.PI_LENS_LSP_DIAGNOSTICS_WAIT_MS = "1500";

		const child = spawn(process.execPath, [CHILD_FIXTURE], {
			cwd,
			env,
			// stdin `ignore` is load-bearing: an inherited/piped stdin is itself a
			// referenced handle and would mask the drain entirely.
			stdio: ["ignore", "pipe", "pipe"],
			// Node's own spawn bound rather than a hand-rolled timer: a child that
			// never exits on its own comes back with `signal: "SIGKILL"`, which is
			// exactly what the second case below asserts against.
			timeout: CHILD_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			resolve({ code, signal, stdout, stderr });
		});
	});
}

describe("#2507 headless child, in-flight lsp_diagnostics", () => {
	let tmpRoot: string;
	let run: ChildRun;

	beforeAll(async () => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2507-"));
		const project = path.join(tmpRoot, "project");
		const home = path.join(tmpRoot, "home");
		fs.mkdirSync(project);
		fs.mkdirSync(home);
		fs.writeFileSync(
			path.join(project, ".pi-lens.json"),
			JSON.stringify(
				{
					lsp: {
						servers: {
							"fake-python": {
								name: "fake-python",
								command: process.execPath,
								args: [FAKE_LSP_SERVER],
								extensions: [".py"],
							},
						},
						// The managed pyright/ty candidates would try to install or probe
						// real binaries; the defect is in the wait, not in which server
						// does the answering.
						disabledServers: ["python", "ty", "ruff"],
					},
				},
				null,
				2,
			),
		);
		fs.writeFileSync(
			path.join(project, "pyproject.toml"),
			'[project]\nname="p"\n',
		);
		fs.writeFileSync(path.join(project, "mod.py"), "value = undefined_name\n");
		run = await runHeadlessChild(project, home);
	}, CHILD_TIMEOUT_MS + 15_000);

	afterAll(() => {
		if (tmpRoot) removeTempDirSync(tmpRoot);
	});

	it("stays alive until the tool call settles", () => {
		const context = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
		// The pre-fix child prints these two lines and then vanishes with code 0.
		expect(run.stdout, context).toContain("tool-start");
		expect(run.stdout, context).toContain("tool-resolved:");
		expect(run.code, context).toBe(0);
	});

	it("still exits on its own once the tool call is done", () => {
		const context = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
		// A keep-alive that is never released is the inverse defect: the lingering
		// language server would pin a settled one-shot process open, which is the
		// exact thing `unrefLspProcessHandles` exists to prevent. A child still
		// alive at the spawn's own timeout comes back SIGKILLed, never `null`.
		expect(run.signal, context).toBeNull();
		expect(run.code, context).toBe(0);
	});
});
