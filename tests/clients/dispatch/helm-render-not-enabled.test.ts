/**
 * helm-render with render validation off reports a stated `not-enabled` skip
 * (#5042), so a denied `helm-lint` beside it no longer reads as a failed tool.
 *
 * Everything drives the PRODUCTION path: a real chart on disk, real config
 * files (global via `PI_LENS_HOME`, project via `.pi-lens.json`), and the real
 * `dispatchLintWithResult` over the session's default runner registry. Neither
 * runner under test spawns: `helm-lint` is denied before it can and
 * `helm-render` skips at its consent gate, so no helm binary is involved.
 *
 * Recurrence this guards (PR #5011 thread PRRT_kwDORt8rec6yH4jk): a bare
 * `skipped` from the opt-in runner was worded "a language tool is missing,
 * timed out, or failed to run" beside a denial, a failure no tool had.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import { clearCoverageNoticeState } from "../../../clients/dispatch/dispatcher.js";
import { dispatchLintWithResult } from "../../../clients/dispatch/integration.js";
import helmRenderRunner from "../../../clients/dispatch/runners/helm-render.js";
import {
	isNotApplicableSkipReason,
	reachedNoVerdict,
	RUNNER_SKIP_REASONS,
	type RunnerResult,
} from "../../../clients/dispatch/types.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { resetWorkspaceTopology } from "../../../clients/workspace-topology.js";
import { wireUserNotifier } from "../../../clients/user-notify.js";
import { makeRunnerCtx } from "../../support/runner-ctx.js";
import { capThenTimedOutSpawnResult } from "../../support/spawn-shapes.js";
import { useConfigPath } from "../../support/global-config.js";
import { removeTempDirSync } from "../test-utils.js";

// The one process boundary: the spawned binary. Render validation OFF never
// reaches it; the ON arm answers `helm` like a render that timed out.
const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

const setConfigPath = useConfigPath();

let tmpDir: string;
let globalDir: string;
let chartDir: string;
let template: string;
let previousHome: string | undefined;
let previousPath: string | undefined;

function writeProject(config: unknown): void {
	fs.writeFileSync(
		path.join(chartDir, ".pi-lens.json"),
		JSON.stringify(config),
	);
	resetProjectLensConfigCache();
}

/** A real chart: `Chart.yaml`, `values.yaml` and one rendered template. */
function writeChart(): void {
	fs.mkdirSync(path.join(chartDir, "templates"), { recursive: true });
	fs.writeFileSync(
		path.join(chartDir, "Chart.yaml"),
		"apiVersion: v2\nname: demo\nversion: 0.1.0\n",
	);
	fs.writeFileSync(path.join(chartDir, "values.yaml"), "replicas: 1\n");
	template = path.join(chartDir, "templates", "deployment.yaml");
	fs.writeFileSync(
		template,
		[
			"apiVersion: apps/v1",
			"kind: Deployment",
			"metadata:",
			"  name: demo",
			"spec:",
			"  replicas: {{ .Values.replicas }}",
			"",
		].join("\n"),
	);
}

async function dispatch() {
	clearCoverageNoticeState();
	return dispatchLintWithResult(
		template,
		chartDir,
		{ getFlag: () => false } as never,
		undefined,
		undefined,
		{ dedupeCoverageNotice: false, projectRoot: chartDir },
	);
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-helm-not-enabled-")),
	);
	globalDir = path.join(tmpDir, ".pi-lens");
	chartDir = path.join(tmpDir, "chart");
	fs.mkdirSync(globalDir, { recursive: true });
	previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = globalDir;
	setConfigPath(path.join(globalDir, "config.json"));
	resetProjectLensConfigCache();
	resetWorkspaceTopology();
	resetProjectTrust();
	resetDegradationLedger();
	wireUserNotifier(() => () => {});
	writeChart();
	// The availability checker looks `helm` up on disk before it spawns anything;
	// the stand-in is never executed because the spawn is mocked.
	const bin = path.join(tmpDir, "bin");
	fs.mkdirSync(bin);
	const stub = path.join(
		bin,
		process.platform === "win32" ? "helm.exe" : "helm",
	);
	fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(stub, 0o755);
	previousPath = process.env.PATH;
	process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
	safeSpawnAsync.mockReset();
	safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) =>
		args[0] === "template"
			? // A render that timed out: the runner reached no verdict.
				capThenTimedOutSpawnResult({
					outputTruncated: false,
					killedForOutputCap: false,
				})
			: { error: null, status: 0, stdout: "v3.14.0\n", stderr: "" },
	);
});

afterEach(() => {
	process.env.PATH = previousPath;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	resetProjectLensConfigCache();
	resetWorkspaceTopology();
	resetProjectTrust();
	removeTempDirSync(tmpDir);
});

describe("helm-render opt-out reads as the opt-in, not a failed tool (#5042)", () => {
	it("reports the stated not-enabled skip when render validation is off", async () => {
		writeProject({});
		const result = await helmRenderRunner.run(
			makeRunnerCtx(template, chartDir),
		);

		expect(result.status).toBe("skipped");
		expect(result.skipReason).toBe("not-enabled");
	});

	it("names no failed tool beside a denied helm-lint, and the file stays unconfirmed", async () => {
		writeProject({ dispatch: { disabledRunners: ["helm-lint"] } });

		const result = await dispatch();

		// Red on the merged #5011 base: the notice said "a language tool is
		// missing, timed out, or failed to run" though neither runner failed.
		expect(result.output).not.toContain("failed to run");
		expect(result.output).toContain("dispatch.disabledRunners");
		expect(result.output).toContain("so no runner checks these files");
		expect(result.unconfirmedStatus).toBe(
			"not checked (helm-lint disabled in config by dispatch.disabledRunners)",
		);
		// Unconfirmed, never clean: no runner reached a usable result.
		expect(result.coverage).toBeUndefined();
		expect(result.output).toContain("not a clean result");
	});

	it("still reads a render that is on and failing as a failure", async () => {
		// Render validation ON in a trusted project and the render times out: a
		// tool that failed, which the notice must keep naming.
		// Recurrence: admitting the opt-out must not hide a render that failed.
		writeProject({
			dispatch: { disabledRunners: ["helm-lint"] },
			helm: { renderValidation: { enabled: true } },
		});
		setProjectTrustState("trusted");

		const result = await dispatch();

		expect(
			safeSpawnAsync.mock.calls.some((call) => call[1][0] === "template"),
		).toBe(true);
		expect(result.output).toContain("failed to run");
		expect(result.output).toContain("dispatch.disabledRunners");
		expect(result.output).not.toContain("so no runner checks these files");
		expect(result.unconfirmedStatus).toContain("failed to run");
	});
});

describe("not-enabled in the skip taxonomy (#5042)", () => {
	it("is a stated reason that is not applicable, beside a denial", () => {
		expect(RUNNER_SKIP_REASONS).toContain("not-enabled");
		expect(isNotApplicableSkipReason("not-enabled")).toBe(true);
	});

	// What changes in `inconclusiveSources` for helm files: nothing. The
	// opt-out is a stated skip that still reached no verdict about the file, so
	// helm-render stays in `inconclusiveSources.runnerIds` exactly as the bare
	// skip put it there. Consumers (clients/pipeline.ts:2014 carry of recorded
	// blockers, :2981 owed ranges, clients/dispatch/types.ts checkedWholeFile,
	// clients/deferred-runner-blockers.ts:201) read the same value.
	it("keeps the opt-out in the no-verdict set, as the bare skip was", () => {
		const bare: RunnerResult = {
			status: "skipped",
			diagnostics: [],
			semantic: "none",
		};
		expect(reachedNoVerdict(bare)).toBe(true);
		expect(reachedNoVerdict({ ...bare, skipReason: "not-enabled" })).toBe(true);
		// The rest of the taxonomy is a verdict, unchanged.
		expect(reachedNoVerdict({ ...bare, skipReason: "no-files-matched" })).toBe(
			false,
		);
	});

	it("leaves inconclusiveSources.runnerIds naming helm-render for a chart file", async () => {
		writeProject({});

		const result = await dispatch();

		expect(result.inconclusiveSources?.runnerIds).toContain("helm-render");
	});
});
