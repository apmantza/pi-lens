/**
 * A file of an LSP-capable kind that no language server's file matcher selects
 * is not applicable to the LSP lane (#5235 review F1), not "analysis
 * unavailable": nothing is missing, nothing failed, and no install can cure
 * it. A file a server DOES select, but whose server is not installed, still
 * carries the warning.
 *
 * Drives the production path: the real `dispatchLint` over the session's
 * default runner registry and the real server table, on real files in a
 * project dir. No runner is replaced.
 *
 * Recurrence this guards (PR #5238 review r1 F1): the groovy kind named
 * `Jenkinsfile`, `build.gradle` and `settings.gradle`, but `GroovyServer` lists
 * extensions only, so every write to them printed "Pi-lens groovy analysis
 * unavailable ... (not a clean result)" for a lane that could never run.
 */

import { uncheckedReason } from "../../support/dispatch-verdict.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { dispatchLint } from "../../../clients/dispatch/integration.js";
import {
	getServersForFileWithConfig,
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import type { RunnerResult } from "../../../clients/dispatch/types.js";
import { getFormatService } from "../../../clients/format-service.js";
import { BiomeClient } from "../../../clients/biome-client.js";
import { MetricsClient } from "../../../clients/metrics-client.js";
import { runPipeline } from "../../../clients/pipeline.js";
import { RuffClient } from "../../../clients/ruff-client.js";
import { resetSessionScopedState } from "../../../clients/runtime-session.js";
import {
	flushSessionStartLog,
	SESSIONSTART_LOG_FILE,
} from "../../../clients/sessionstart-logger.js";
import { setupTestEnvironment } from "../test-utils.js";

const UNAVAILABLE = "analysis unavailable";

let tmpDir: string;
let cleanupTmp: () => void;
let previousHome: string | undefined;
let previousPath: string | undefined;

async function writeAndDispatch(name: string, body: string): Promise<string> {
	const file = path.join(tmpDir, name);
	fs.writeFileSync(file, body);
	clearCoverageNoticeState();
	return dispatchLint(
		file,
		tmpDir,
		{ getFlag: () => false } as never,
		undefined,
		tmpDir,
	);
}

// The line the agent reads for a write: the real `runPipeline`, so the
// all-clear line (`buildAllClearOutput`) is what renders, not the notice alone.
async function writeAndRender(name: string, body: string): Promise<string> {
	const file = path.join(tmpDir, name);
	fs.writeFileSync(file, body);
	clearCoverageNoticeState();
	const result = await runPipeline(
		{
			filePath: file,
			cwd: tmpDir,
			toolName: "write",
			getFlag: () => false,
			dbg: () => {},
		},
		{
			biomeClient: new BiomeClient(),
			ruffClient: new RuffClient(),
			metricsClient: new MetricsClient(),
			getFormatService: () => getFormatService("lsp-name-only-coverage", false),
			fixedThisTurn: new Set<string>(),
		},
	);
	return result.output;
}

beforeEach(() => {
	// The shared setup plants the project-root marker, so the fixture is its
	// own root and an ancestor project cannot change which server or config
	// applies (shape 73).
	const env = setupTestEnvironment("pi-lens-lsp-name-only-");
	tmpDir = env.tmpDir;
	cleanupTmp = env.cleanup;
	// Empty home and an empty PATH: no managed or ambient language server can
	// exist, so the "server not installed" arm is the same on every machine.
	previousHome = process.env.PI_LENS_HOME;
	previousPath = process.env.PATH;
	process.env.PI_LENS_HOME = path.join(tmpDir, ".pi-lens");
	const emptyBin = path.join(tmpDir, "empty-bin");
	fs.mkdirSync(emptyBin);
	process.env.PATH = emptyBin;
});

afterEach(() => {
	vi.unstubAllEnvs();
	process.env.PATH = previousPath;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	// Config and trust are not session-scoped state (`resetSessionScopedState`
	// leaves them to their owners), so they are reset beside it.
	resetSessionScopedState(tmpDir);
	resetLSPConfigStateForTests();
	resetProjectLensConfigCache();
	resetProjectTrust();
	cleanupTmp();
});

describe("a name no language server selects is not 'analysis unavailable'", () => {
	it("keeps the groovy build and pipeline names off the warning", async () => {
		for (const name of ["Jenkinsfile", "build.gradle", "settings.gradle"]) {
			// Premise: the kind reaches the LSP lane, and no server selects the name.
			expect(getServersForFileWithConfig(path.join(tmpDir, name))).toEqual([]);
			const output = await writeAndDispatch(name, "plugins { id 'java' }\n");
			expect(output, name).not.toContain(UNAVAILABLE);
			expect(output, name).not.toContain("not a clean result");
		}
	});

	it("renders those names as not analyzed, never clean", async () => {
		// Recurrence this guards (PR #5238 verify r2, N1): the quiet answer left
		// `unconfirmedStatus` unset, so the all-clear line read "✓ Groovy clean"
		// for a file no tool analyzed. The rendered line is what the agent reads,
		// so it is driven through the real runPipeline.
		for (const name of ["Jenkinsfile", "build.gradle", "settings.gradle"]) {
			const line = await writeAndRender(name, "plugins { id 'java' }\n");
			expect(line, name).not.toContain("clean");
			expect(line, name).toContain("not analyzed");
			expect(line, name).not.toContain(UNAVAILABLE);
		}
	});

	it("still names a disabled primary instead of going quiet", async () => {
		// Recurrence this guards: the not-applicable skip rides the branch that
		// also reports a disabled primary (#4403). A skipReason set beside the
		// disabled cause would silence the denial's own notice.
		setProjectTrustState("trusted");
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ lsp: { disabledServers: ["groovy"] } }),
		);
		resetProjectLensConfigCache();
		await initLSPConfig(tmpDir);
		const output = await writeAndDispatch("A.groovy", "class A {}\n");
		expect(output).toContain("Primary LSP (groovy) is disabled in config");
	});

	it("still warns for a .groovy file whose server is not installed", async () => {
		// Negative control: a server DOES select the extension, so the lane is
		// applicable and its absence is a real coverage gap the notice must name.
		expect(
			getServersForFileWithConfig(path.join(tmpDir, "A.groovy")).map(
				(s) => s.id,
			),
		).toEqual(["groovy"]);
		// Recurrence this guards (PR #5238 review r3, greptile): the control ran
		// on an untrusted project, where `GroovyServer` (`executesProjectCode`) is
		// refused at the trust seam before `spawn`, so the warning proved the
		// trust refusal and said nothing about an uninstalled server. A trusted
		// project reaches `spawn`, which finds no launcher on the empty PATH and
		// says so in the session log (the log is silent under test mode).
		setProjectTrustState("trusted");
		await initLSPConfig(tmpDir);
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		await flushSessionStartLog();
		const logBefore = fs.existsSync(SESSIONSTART_LOG_FILE)
			? fs.statSync(SESSIONSTART_LOG_FILE).size
			: 0;
		const output = await writeAndDispatch("A.groovy", "class A {}\n");
		await flushSessionStartLog();
		expect(output).toContain("Pi-lens groovy analysis unavailable");
		expect(
			fs.readFileSync(SESSIONSTART_LOG_FILE).subarray(logBefore).toString(),
		).toContain("lsp launch groovy: not installed");
	});
});

// The quiet answer belongs to the language server's own "no server selects
// this file", not to any runner that says `no-files-matched`. Recurrence this
// guards: oxlint states the same reason when a config IGNORES the file, which
// is an unchecked file and must keep its notice. A primary group is
// `["lsp", "dotnet-build"]` for csharp; the second runner stands for any
// non-lsp runner of a primary group.
describe("only the lsp runner's no-files-matched silences the notice", () => {
	const NOT_APPLICABLE: RunnerResult = {
		status: "skipped",
		diagnostics: [],
		semantic: "none",
		skipReason: "no-files-matched",
	};
	const BARE_SKIP: RunnerResult = {
		status: "skipped",
		diagnostics: [],
		semantic: "none",
	};

	async function dispatchCsharp(
		rows: ReadonlyArray<readonly [string, RunnerResult]>,
	) {
		const registry = new RunnerRegistry();
		for (const [id, result] of rows) {
			registry.register({
				id,
				appliesTo: ["csharp"],
				priority: 10,
				async run() {
					return result;
				},
			});
		}
		const file = path.join(tmpDir, "Program.cs");
		fs.writeFileSync(file, "class P {}\n");
		const ctx = createDispatchContext(
			file,
			tmpDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);
		clearCoverageNoticeState();
		return dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: rows.map(([id]) => id) }],
			registry,
			undefined,
			{ dedupeCoverageNotice: false },
		);
	}

	it("stays quiet when the lsp row is the only primary row that ran", async () => {
		const result = await dispatchCsharp([["lsp", NOT_APPLICABLE]]);
		expect(result.output).not.toContain(UNAVAILABLE);
		expect(uncheckedReason(result)).toBe(
			"not analyzed (no language server handles this file)",
		);
	});

	it("keeps the notice when a non-lsp primary runner also states no-files-matched", async () => {
		const result = await dispatchCsharp([
			["lsp", NOT_APPLICABLE],
			["dotnet-build", NOT_APPLICABLE],
		]);
		expect(result.output).toContain(UNAVAILABLE);
	});

	it("keeps the notice when a sibling primary runner skipped without a reason", async () => {
		const result = await dispatchCsharp([
			["lsp", NOT_APPLICABLE],
			["dotnet-build", BARE_SKIP],
		]);
		expect(result.output).toContain(UNAVAILABLE);
	});
});
