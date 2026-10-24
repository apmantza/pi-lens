// real-home: read-only path probe for the maintainer's managed pyright (`~/.pi-lens/tools/node_modules/.bin/pyright-langserver`); the pinned home has no managed tools tree, so without the real home the effect case skips on the one host that has pyright.
// flake-shape: real-process-spawn — a real pyright-langserver child is the observation; only its own diagnostics can show whether a setting reached it.
/**
 * #4758 acceptance, over a real pyright: a setting pi-lens sends must change a
 * diagnostic, not only appear in a payload.
 *
 * Recurrence this prevents: pi-lens put `pythonPath` and `openFilesOnly` TOP
 * LEVEL in pyright's initialization blob and answered `workspace/configuration`
 * from that flat blob. pyright reads neither from `initializationOptions`; it
 * pulls the `python`, `python.analysis` and `pyright` sections, got `{}` for
 * each, and ran on its defaults. Every payload assertion passed, because the
 * payload was what pi-lens sent; only a real pyright shows what it applied.
 *
 * Production chain: `pyrightInitialization` (the builder `PythonServer.spawn`
 * calls on all three launch tiers), the user-override merge
 * (`mergeInitializationOptions`), the real `createLSPClient` and its
 * `workspace/configuration` handler, over stdio to a real
 * `pyright-langserver`. `PythonServer.spawn` itself is not driven here: its
 * project-trust gate is a spawn-scope permission this file does not own.
 *
 * Case one (the pi-lens setting): the interpreter pi-lens detected is an
 * executable whose `sys.path` carries a package the host python3 lacks. pyright
 * asks `python3` first, so only an applied `python.pythonPath` reveals that
 * package: `reveal_type` names its `int` instead of `Unknown`.
 * Case two (the control): a user's `python.analysis.typeCheckingMode` override
 * keeps reaching pyright after the builder's own keys are merged under it. That
 * case passes on the flat shape as well (the user's override already carried
 * sections); it pins acceptance 1's "overrides keep working".
 *
 * Skipped, with a named reason, when no `pyright-langserver` or no `python3`
 * exists: the unit lanes install no managed tools. Set
 * `PI_LENS_TEST_PYRIGHT_BIN` to point at one; otherwise PATH, then
 * `~/.pi-lens/tools/node_modules/.bin`, is searched. The harness pins HOME per
 * worker (#4789), so the managed candidate reads the real home through
 * `REAL_HOME`, a named read-only opt-out in
 * `tests/support/real-home-readers.ts`; it never writes there.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REAL_HOME } from "../../support/vitest-setup.js";
import { mergeInitializationOptions } from "../../../clients/lsp/client-registry.js";
import {
	createLSPClient,
	type LSPDiagnostic,
} from "../../../clients/lsp/client.js";
import { launchLSP, stopLSP } from "../../../clients/lsp/launch.js";
import { pyrightInitialization } from "../../../clients/lsp/server.js";
import { waitFor } from "../interleaving-kit.js";
import { pinFixtureHome, setupTestEnvironment } from "../test-utils.js";

function executableOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// not here
		}
	}
	return undefined;
}

function findPyright(): string | undefined {
	const override = process.env.PI_LENS_TEST_PYRIGHT_BIN;
	if (override) return fs.existsSync(override) ? override : undefined;
	const managed = path.join(
		REAL_HOME,
		".pi-lens",
		"tools",
		"node_modules",
		".bin",
		"pyright-langserver",
	);
	return (
		executableOnPath("pyright-langserver") ??
		(fs.existsSync(managed) ? managed : undefined)
	);
}

const PYRIGHT = findPyright();
const PYTHON3 =
	process.platform === "win32" ? undefined : executableOnPath("python3");
const CAN_RUN = PYRIGHT !== undefined && PYTHON3 !== undefined;
const WAIT_MS = 30_000;

describe.skipIf(!CAN_RUN)("pyright applies pi-lens settings (#4758)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let pinned: ReturnType<typeof pinFixtureHome> | undefined;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-pyright-4758-");
		// The child's HOME must not live under `env.tmpDir` (#4789/#4591): teardown
		// deletes that root, and a pyright process that outlives the case would
		// re-create it. `pinFixtureHome` puts it in the worker's scratch root.
		pinned = pinFixtureHome("pyright-4758");
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				// the server may already be gone
			}
			client = undefined;
		}
		if (proc) {
			try {
				await stopLSP(proc);
			} catch {
				// ignore
			}
			proc = undefined;
		}
		pinned?.restore();
		pinned = undefined;
		env.cleanup();
	});

	/** An interpreter whose sys.path holds `pilens_probe_pkg`, which host python3 lacks. */
	function writeProbeInterpreter(root: string): string {
		const site = path.join(root, "site");
		fs.mkdirSync(path.join(site, "pilens_probe_pkg"), { recursive: true });
		fs.writeFileSync(
			path.join(site, "pilens_probe_pkg", "__init__.py"),
			"VALUE: int = 1\n",
		);
		const interpreter = path.join(root, "probe-venv", "bin", "python");
		fs.mkdirSync(path.dirname(interpreter), { recursive: true });
		fs.writeFileSync(
			interpreter,
			`#!/bin/sh\nPYTHONPATH="${site}" exec "${PYTHON3}" "$@"\n`,
			{ mode: 0o755 },
		);
		return interpreter;
	}

	async function start(
		root: string,
		initialization: Record<string, unknown> | undefined,
	) {
		if (PYRIGHT === undefined) throw new Error("pyright unavailable");
		if (pinned === undefined) throw new Error("no pinned home");
		proc = await launchLSP(PYRIGHT, ["--stdio"], {
			cwd: root,
			env: { HOME: pinned.home },
		});
		client = await createLSPClient({
			serverId: "python",
			process: proc,
			root,
			initialization,
		});
		return client;
	}

	/**
	 * Open `text`, then wait until `done` holds. An exhausted wait throws with the
	 * last diagnostics snapshot, which is the red a setting that never applies
	 * produces.
	 */
	async function diagnosticsUntil(
		c: Awaited<ReturnType<typeof createLSPClient>>,
		file: string,
		text: string,
		done: (diagnostics: LSPDiagnostic[]) => boolean,
	): Promise<LSPDiagnostic[]> {
		await c.notify.open(file, text, "python");
		return waitFor(() => c.getDiagnostics(file), done, {
			timeoutMs: WAIT_MS,
			intervalMs: 250,
		});
	}

	const summary = (diagnostics: LSPDiagnostic[]): string =>
		JSON.stringify(diagnostics.map((d) => [d.code, d.message]));

	it("resolves a package through the interpreter pi-lens detected (python.pythonPath)", async () => {
		const root = env.tmpDir;
		const interpreter = writeProbeInterpreter(root);
		const file = path.join(root, "m.py");
		const text =
			"import pilens_probe_pkg\nreveal_type(pilens_probe_pkg.VALUE)\n";
		fs.writeFileSync(file, text);

		const c = await start(root, pyrightInitialization(interpreter));
		// Wait for the APPLIED answer, not the first reveal: pyright may analyse the
		// file once before its settings pull returns, and that early `Unknown` is
		// not the verdict. A setting that never applies runs the wait out.
		const diagnostics = await diagnosticsUntil(c, file, text, (all) =>
			all.some(
				(d) =>
					d.message.includes("pilens_probe_pkg.VALUE") &&
					d.message.includes('is "int"'),
			),
		);

		const reveal = diagnostics.find((d) =>
			d.message.includes("pilens_probe_pkg.VALUE"),
		);
		expect(reveal?.message, summary(diagnostics)).toContain('is "int"');
		expect(
			diagnostics.some((d) => d.code === "reportMissingImports"),
			summary(diagnostics),
		).toBe(false);
	}, 60_000);

	it("reports no unused import without the override (control for the strict case)", async () => {
		const root = env.tmpDir;
		const file = path.join(root, "m.py");
		const text = "import os\nx: int = 's'\n";
		fs.writeFileSync(file, text);

		const c = await start(root, pyrightInitialization());
		// The assignment error is present in every mode: waiting for it proves
		// pyright analysed the file, so the absence below is not a silent server.
		const diagnostics = await diagnosticsUntil(c, file, text, (all) =>
			all.some((d) => d.code === "reportAssignmentType"),
		);

		expect(
			diagnostics.some((d) => d.code === "reportAssignmentType"),
			summary(diagnostics),
		).toBe(true);
		expect(
			diagnostics.some((d) => d.code === "reportUnusedImport"),
			summary(diagnostics),
		).toBe(false);
	}, 60_000);

	it("keeps a user's python.analysis override working after the builder's keys are merged under it", async () => {
		const root = env.tmpDir;
		const file = path.join(root, "m.py");
		// Strict reports an unused import; standard does not.
		const text = "import os\nx: int = 's'\n";
		fs.writeFileSync(file, text);

		const merged = mergeInitializationOptions(pyrightInitialization(), {
			python: { analysis: { typeCheckingMode: "strict" } },
		});
		const c = await start(root, merged);
		const diagnostics = await diagnosticsUntil(c, file, text, (all) =>
			all.some((d) => d.code === "reportUnusedImport"),
		);

		expect(
			diagnostics.some((d) => d.code === "reportUnusedImport"),
			summary(diagnostics),
		).toBe(true);
	}, 60_000);
});
