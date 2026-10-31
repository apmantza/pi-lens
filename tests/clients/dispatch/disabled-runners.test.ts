/**
 * `dispatch.disabledRunners` — the operator's runner denial list.
 *
 * Everything drives the PRODUCTION path: real config files on disk (global via
 * `PI_LENS_HOME`, project via `.pi-lens.json`), the real `resolvePiLensConfig`,
 * the real `createDispatchContext` and the real `dispatchForFile`. Only the
 * runners are stand-ins, because the property under test is whether a tool
 * would have been spawned: each stand-in counts its own `when` and `run` calls,
 * and a control arm with no config proves the counter sees a run.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePiLensConfig } from "../../../clients/config-resolve.js";
import { resetDegradationLedger } from "../../../clients/degradation-ledger.js";
import {
	disabledRunnersOf,
	DISABLED_BY_CONFIG_SKIP_REASON,
} from "../../../clients/dispatch/disabled-runners.js";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	registerRunnerId,
	resetRunnerIdentityForTests,
} from "../../../clients/dispatch/known-runner-ids.js";
import {
	RUNNER_SKIP_REASONS,
	type RunnerDefinition,
	type RunnerGroup,
	type RunnerResult,
} from "../../../clients/dispatch/types.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { resetIgnoredConfigWarnCache } from "../../../clients/config-warn.js";
import { wireUserNotifier } from "../../../clients/user-notify.js";
import { removeTempDirSync } from "../test-utils.js";
import { useConfigPath } from "../../support/global-config.js";
const setConfigPath = useConfigPath();

interface Counters {
	whenCalls: number;
	runCalls: number;
}

/** A runner that records every call and answers with `result`. */
function countingRunner(
	id: string,
	result: RunnerResult,
): { runner: RunnerDefinition; counters: Counters } {
	const counters: Counters = { whenCalls: 0, runCalls: 0 };
	return {
		counters,
		runner: {
			id,
			appliesTo: ["jsts"],
			priority: 10,
			when() {
				counters.whenCalls += 1;
				return true;
			},
			async run() {
				counters.runCalls += 1;
				return result;
			},
		},
	};
}

const SKIPPED: RunnerResult = {
	status: "skipped",
	diagnostics: [],
	semantic: "none",
};
const SUCCEEDED: RunnerResult = {
	status: "succeeded",
	diagnostics: [],
	semantic: "none",
};

/** The dotnet-build failure a real build would report: a blocking finding. */
const BLOCKING_BUILD: RunnerResult = {
	status: "failed",
	failureKind: "blocking_diagnostics",
	semantic: "blocking",
	diagnostics: [
		{
			id: "CS1002",
			message: "; expected",
			filePath: "a.ts",
			severity: "error",
			semantic: "blocking",
			tool: "dotnet-build",
			rule: "CS1002",
			line: 1,
		},
	],
};

let tmpDir: string;
let globalDir: string;
let projectDir: string;
let previousHome: string | undefined;
const notified: string[] = [];

function writeGlobal(config: unknown): void {
	fs.mkdirSync(globalDir, { recursive: true });
	fs.writeFileSync(path.join(globalDir, "config.json"), JSON.stringify(config));
}

function writeProject(config: unknown, dir = projectDir): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi-lens.json"), JSON.stringify(config));
}

function resolutionAt(dir: string) {
	return resolvePiLensConfig({
		cwd: dir,
		globalDir,
		globalConfigPath: path.join(globalDir, "config.json"),
		homeDir: tmpDir,
	});
}

function contextFor(facts = new FactStore()) {
	return createDispatchContext(
		path.join(projectDir, "a.ts"),
		projectDir,
		{ getFlag: () => false },
		facts,
		false,
	);
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-disabled-runners-"));
	globalDir = path.join(tmpDir, ".pi-lens");
	projectDir = path.join(tmpDir, "proj");
	fs.mkdirSync(projectDir, { recursive: true });
	previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = globalDir;
	setConfigPath(path.join(globalDir, "config.json"));
	resetProjectLensConfigCache();
	resetIgnoredConfigWarnCache();
	resetDegradationLedger();
	resetRunnerIdentityForTests();
	for (const id of ["lsp", "dotnet-build", "javac"]) registerRunnerId(id);
	notified.length = 0;
	wireUserNotifier(() => (message) => {
		notified.push(message);
	});
});

afterEach(() => {
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	resetProjectLensConfigCache();
	resetRunnerIdentityForTests();
	removeTempDirSync(tmpDir);
});

describe("dispatch.disabledRunners — resolution", () => {
	it("is the union of every tier, so a project adds to the global denial", () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-build"] } });
		writeProject({ dispatch: { disabledRunners: ["javac"] } });

		const { runners } = disabledRunnersOf(resolutionAt(projectDir));

		expect(runners.map((runner) => runner.id)).toEqual([
			"dotnet-build",
			"javac",
		]);
	});

	it("cannot be lifted by a nearer tier that omits or empties the list", () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-build"] } });
		writeProject({ dispatch: { disabledRunners: [] } });

		const { runners } = disabledRunnersOf(resolutionAt(projectDir));

		expect(runners.map((runner) => runner.id)).toEqual(["dotnet-build"]);
	});

	it("attributes each member to the tier that contributed it", () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-build"] } });
		writeProject({ dispatch: { disabledRunners: ["javac"] } });

		const { runners } = disabledRunnersOf(resolutionAt(projectDir));
		const tiers = new Map(
			runners.map((runner) => [runner.id, runner.decidedBy?.tier]),
		);

		expect(tiers.get("dotnet-build")).toBe("global");
		expect(tiers.get("javac")).toBe("project");
		expect(
			runners.find((runner) => runner.id === "javac")?.decidedBy?.file,
		).toBe(path.join(fs.realpathSync(projectDir), ".pi-lens.json"));
	});

	it("collapses a runner denied at two tiers to one entry", () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-build"] } });
		writeProject({ dispatch: { disabledRunners: ["dotnet-build"] } });

		const { runners } = disabledRunnersOf(resolutionAt(projectDir));

		expect(runners.map((runner) => runner.id)).toEqual(["dotnet-build"]);
	});

	it("drops an unknown id with a PILENS_CFG_0005 record naming the entry", () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-bild", "javac"] } });

		const resolved = disabledRunnersOf(resolutionAt(projectDir));

		expect(resolved.runners.map((runner) => runner.id)).toEqual(["javac"]);
		expect(resolved.records).toHaveLength(1);
		expect(resolved.records[0]).toMatchObject({
			code: "PILENS_CFG_0005",
			file: path.join(globalDir, "config.json"),
			key: "/dispatch/disabledRunners/0",
			tier: "global",
		});
		expect(resolved.records[0]?.reason).toContain('"dotnet-bild"');
	});

	it("keeps entries unvalidated while no runner registry exists yet", () => {
		resetRunnerIdentityForTests();
		writeGlobal({ dispatch: { disabledRunners: ["not-registered-yet"] } });

		const resolved = disabledRunnersOf(resolutionAt(projectDir));

		expect(resolved.runners.map((runner) => runner.id)).toEqual([
			"not-registered-yet",
		]);
		expect(resolved.records).toEqual([]);
	});

	it("drops a non-string member at the schema with a record, keeping the rest", () => {
		writeGlobal({ dispatch: { disabledRunners: [7, "javac"] } });

		const resolution = resolutionAt(projectDir);

		expect(disabledRunnersOf(resolution).runners.map((r) => r.id)).toEqual([
			"javac",
		]);
		expect(
			resolution.records.some((record) =>
				record.key.startsWith("/dispatch/disabledRunners"),
			),
		).toBe(true);
	});
});

describe("dispatch.disabledRunners — dispatch", () => {
	const fallbackGroup: RunnerGroup[] = [
		{ mode: "fallback", runnerIds: ["lsp", "dotnet-build"] },
	];

	function registryWith(lsp: RunnerResult, build: RunnerResult) {
		const registry = new RunnerRegistry();
		const lspRunner = countingRunner("lsp", lsp);
		const buildRunner = countingRunner("dotnet-build", build);
		registry.register(lspRunner.runner);
		registry.register(buildRunner.runner);
		return { registry, lsp: lspRunner.counters, build: buildRunner.counters };
	}

	it("control: with nothing disabled the fallback runner runs after a skipped lsp", async () => {
		const { registry, lsp, build } = registryWith(SKIPPED, BLOCKING_BUILD);

		const result = await dispatchForFile(contextFor(), fallbackGroup, registry);

		expect(lsp.runCalls).toBe(1);
		expect(build.runCalls).toBe(1);
		expect(result.hasBlockers).toBe(true);
	});

	it("never spawns a disabled runner, and records a stated skip rather than a failure", async () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-build"] } });
		const { registry, lsp, build } = registryWith(SKIPPED, BLOCKING_BUILD);

		const result = await dispatchForFile(contextFor(), fallbackGroup, registry);

		expect(build.runCalls).toBe(0);
		// Not even the precondition ran: `when` is where a runner probes its tool.
		expect(build.whenCalls).toBe(0);
		expect(lsp.runCalls).toBe(1);
		expect(result.hasBlockers).toBe(false);
		const latency = result.latencyReport?.runners.find(
			(runner) => runner.runnerId === "dotnet-build",
		);
		expect(latency).toMatchObject({
			status: "skipped",
			skipReason: DISABLED_BY_CONFIG_SKIP_REASON,
		});
		expect(latency?.failureKind).toBeUndefined();
	});

	it("is not a runner that reached no verdict", async () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-build"] } });
		const { registry } = registryWith(SUCCEEDED, BLOCKING_BUILD);

		const result = await dispatchForFile(contextFor(), fallbackGroup, registry);

		expect(result.inconclusiveSources?.runnerIds ?? []).not.toContain(
			"dotnet-build",
		);
	});

	it("lets the next runner of a fallback group run when the first is disabled", async () => {
		writeProject({ dispatch: { disabledRunners: ["lsp"] } });
		const { registry, lsp, build } = registryWith(SUCCEEDED, SUCCEEDED);

		const result = await dispatchForFile(
			contextFor(),
			[{ mode: "fallback", runnerIds: ["lsp", "dotnet-build"] }],
			registry,
		);

		expect(lsp.runCalls).toBe(0);
		expect(build.runCalls).toBe(1);
		expect(
			result.latencyReport?.runners.map(
				(runner) => `${runner.runnerId}:${runner.status}`,
			),
		).toEqual(["lsp:skipped", "dotnet-build:succeeded"]);
	});

	it("leaves the other runners of the group running when one is disabled", async () => {
		writeProject({ dispatch: { disabledRunners: ["dotnet-build"] } });
		const { registry, lsp } = registryWith(SUCCEEDED, BLOCKING_BUILD);

		await dispatchForFile(
			contextFor(),
			[{ mode: "all", runnerIds: ["lsp", "dotnet-build"] }],
			registry,
		);

		expect(lsp.runCalls).toBe(1);
	});

	it("honors a denial that only the global tier states, from a project with its own empty list", async () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-build"] } });
		writeProject({ dispatch: { disabledRunners: [] } });
		const { registry, build } = registryWith(SKIPPED, BLOCKING_BUILD);

		await dispatchForFile(contextFor(), fallbackGroup, registry);

		expect(build.runCalls).toBe(0);
	});

	it("leaves a file nothing checked unconfirmed rather than clean when the only fallback is disabled", async () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-build"] } });
		const csharp = path.join(projectDir, "Program.cs");
		fs.writeFileSync(csharp, "class P {}\n");
		const registry = new RunnerRegistry();
		for (const id of ["lsp", "dotnet-build"]) {
			registry.register({
				...countingRunner(id, id === "lsp" ? SKIPPED : BLOCKING_BUILD).runner,
				appliesTo: ["csharp"],
			});
		}
		const ctx = createDispatchContext(
			csharp,
			projectDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);

		const result = await dispatchForFile(ctx, fallbackGroup, registry);

		expect(result.hasBlockers).toBe(false);
		expect(result.coverage).not.toBe("fallback");
		expect(result.coverage).not.toBe("primary");
		expect(result.unconfirmedStatus).toBeDefined();
	});

	it("names dispatch.disabledRunners when every runner of the file is denied", async () => {
		writeProject({ dispatch: { disabledRunners: ["lsp", "dotnet-build"] } });
		const csharp = path.join(projectDir, "Program.cs");
		fs.writeFileSync(csharp, "class P {}\n");
		const registry = new RunnerRegistry();
		for (const id of ["lsp", "dotnet-build"]) {
			registry.register({
				...countingRunner(id, SUCCEEDED).runner,
				appliesTo: ["csharp"],
			});
		}
		const ctx = createDispatchContext(
			csharp,
			projectDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);

		clearCoverageNoticeState();
		const first = await dispatchForFile(ctx, fallbackGroup, registry);
		const again = await dispatchForFile(ctx, fallbackGroup, registry);

		expect(first.output).toContain("dispatch.disabledRunners");
		expect(first.output).not.toContain("lsp.disabledServers");
		expect(first.unconfirmedStatus).toContain("dispatch.disabledRunners");
		expect(first.unconfirmedStatus).not.toContain("lsp.disabledServers");
		// One note per session, then the status line alone.
		expect(again.output).not.toContain("dispatch.disabledRunners");
		expect(again.unconfirmedStatus).toContain("dispatch.disabledRunners");
	});

	it("keeps the LSP's own cause when a cold lsp and a denied runner both left the file unchecked", async () => {
		writeGlobal({ dispatch: { disabledRunners: ["dotnet-build"] } });
		const csharp = path.join(projectDir, "Program.cs");
		fs.writeFileSync(csharp, "class P {}\n");
		const registry = new RunnerRegistry();
		registry.register({
			...countingRunner("lsp", {
				...SKIPPED,
				primaryUnavailableCause: "unstarted",
			}).runner,
			appliesTo: ["csharp"],
		});
		registry.register({
			...countingRunner("dotnet-build", BLOCKING_BUILD).runner,
			appliesTo: ["csharp"],
		});
		const ctx = createDispatchContext(
			csharp,
			projectDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);

		clearCoverageNoticeState();
		const result = await dispatchForFile(ctx, fallbackGroup, registry);

		expect(result.unconfirmedStatus).toContain("could not be started");
		// Both surfaces name the runner's denial beside the LSP's cause.
		expect(result.unconfirmedStatus).toContain("dispatch.disabledRunners");
		expect(result.output).toContain("failed to run");
		expect(result.output).toContain("dispatch.disabledRunners");
	});

	it("still names a sibling runner's failure when another runner is denied", async () => {
		writeProject({ dispatch: { disabledRunners: ["lsp"] } });
		const csharp = path.join(projectDir, "Program.cs");
		fs.writeFileSync(csharp, "class P {}\n");
		const registry = new RunnerRegistry();
		registry.register({
			...countingRunner("lsp", SUCCEEDED).runner,
			appliesTo: ["csharp"],
		});
		// A tool that broke: no verdict, no stated skip reason.
		registry.register({
			...countingRunner("dotnet-build", {
				status: "failed",
				diagnostics: [],
				semantic: "none",
			}).runner,
			appliesTo: ["csharp"],
		});
		const ctx = createDispatchContext(
			csharp,
			projectDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);

		clearCoverageNoticeState();
		const result = await dispatchForFile(ctx, fallbackGroup, registry);

		expect(result.output).toContain("failed to run");
		expect(result.output).toContain("dispatch.disabledRunners");
		expect(result.output).not.toContain("so no runner checks these files");
		expect(result.unconfirmedStatus).toContain("failed to run");
		expect(result.unconfirmedStatus).toContain("dispatch.disabledRunners");
	});

	// PR #5011 thread PRRT_kwDORt8rec6yH4jk: a denied runner next to a sibling
	// that skipped with a stated not-applicable reason (nothing for it to check)
	// was worded "a language tool is missing, timed out, or failed to run", a
	// failure no tool had. The file stays unconfirmed; only the cause changes.
	async function deniedLspNextTo(sibling: RunnerResult) {
		writeProject({ dispatch: { disabledRunners: ["lsp"] } });
		const csharp = path.join(projectDir, "Program.cs");
		fs.writeFileSync(csharp, "class P {}\n");
		const registry = new RunnerRegistry();
		registry.register({
			...countingRunner("lsp", SUCCEEDED).runner,
			appliesTo: ["csharp"],
		});
		registry.register({
			...countingRunner("dotnet-build", sibling).runner,
			appliesTo: ["csharp"],
		});
		const ctx = createDispatchContext(
			csharp,
			projectDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);
		clearCoverageNoticeState();
		return dispatchForFile(ctx, fallbackGroup, registry);
	}

	it.each([
		"no-files-matched",
		"configured-non-biome-linter",
		"dialect-unsupported",
		"not-enabled",
	] as const)(
		"words a sibling's stated not-applicable skip (%s) as config only, not a failed tool",
		async (skipReason) => {
			const result = await deniedLspNextTo({ ...SKIPPED, skipReason });

			expect(result.output).toContain("so no runner checks these files");
			expect(result.output).toContain("not a clean result");
			expect(result.output).not.toContain("failed to run");
			expect(result.unconfirmedStatus).toBe(
				"not checked (lsp disabled in config by dispatch.disabledRunners)",
			);
		},
	);

	it("still reads a sibling skip that states no reason as a failed tool", async () => {
		// The helm-render shape: a bare skipped result is not a listed reason.
		const result = await deniedLspNextTo(SKIPPED);

		expect(result.output).toContain("failed to run");
		expect(result.output).toContain("dispatch.disabledRunners");
		expect(result.unconfirmedStatus).toContain("failed to run");
	});

	// Recurrence: PR #5034 (the "no primary language server answered" wording)
	// and PR #5011 (the `deniedNote` suffix and the `onlySwitchedOff` arm) each
	// rewrote the one `unconfirmedStatus` expression; the merge kept one side
	// and the other's wording pin (`toContain`) went stale. One exact assertion
	// per row of the expression, so a merge that drops either side reds here.
	// Rows: (cause set | unset) x (denied | not denied) x (only switched off).
	it.each([
		{
			row: "cause set, no denial",
			lsp: { ...SKIPPED, primaryUnavailableCause: "unstarted" as const },
			build: SKIPPED,
			denied: undefined,
			status:
				"no primary language server answered (it could not be started, or was still starting)",
		},
		{
			row: "cause set, denied runner",
			lsp: { ...SKIPPED, primaryUnavailableCause: "unstarted" as const },
			build: BLOCKING_BUILD,
			denied: "dotnet-build",
			status:
				"no primary language server answered (it could not be started, or was still starting); dotnet-build disabled in config by dispatch.disabledRunners",
		},
		{
			row: "no cause, denied, only switched off",
			lsp: SUCCEEDED,
			build: { ...SKIPPED, skipReason: "no-files-matched" as const },
			denied: "lsp",
			status:
				"not checked (lsp disabled in config by dispatch.disabledRunners)",
		},
		{
			row: "no cause, denied, a tool failed",
			lsp: SUCCEEDED,
			build: SKIPPED,
			denied: "lsp",
			status:
				"not fully checked (a language tool is missing, timed out, or failed to run; lsp disabled in config by dispatch.disabledRunners)",
		},
		{
			row: "no cause, no denial",
			lsp: SKIPPED,
			build: SKIPPED,
			denied: undefined,
			status:
				"not fully checked (a language tool is missing, timed out, or failed to run)",
		},
	])("words the unconfirmed status for $row exactly", async (row) => {
		if (row.denied)
			writeProject({ dispatch: { disabledRunners: [row.denied] } });
		const csharp = path.join(projectDir, "Program.cs");
		fs.writeFileSync(csharp, "class P {}\n");
		const registry = new RunnerRegistry();
		registry.register({
			...countingRunner("lsp", row.lsp).runner,
			appliesTo: ["csharp"],
		});
		registry.register({
			...countingRunner("dotnet-build", row.build).runner,
			appliesTo: ["csharp"],
		});
		const ctx = createDispatchContext(
			csharp,
			projectDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);
		clearCoverageNoticeState();

		const result = await dispatchForFile(ctx, fallbackGroup, registry);

		expect(result.unconfirmedStatus).toBe(row.status);
	});

	// Recurrence: round 4 admitted three reasons and pinned two, and nothing
	// pinned the closed direction, so a change that admitted the whole taxonomy
	// (or dropped one entry) shipped green. Every taxonomy reason outside the
	// admitted three, the denial's own `disabled-by-config` aside, must still
	// read as a failed tool. A reason moved onto the admitted list reds here
	// until this list names it too, so the admission is a decision made twice.
	const ADMITTED = [
		"no-files-matched",
		"configured-non-biome-linter",
		"dialect-unsupported",
		"not-enabled",
	];
	it.each(
		RUNNER_SKIP_REASONS.filter(
			(reason) =>
				reason !== DISABLED_BY_CONFIG_SKIP_REASON && !ADMITTED.includes(reason),
		),
	)(
		"still reads a taxonomy skip outside the admitted reasons (%s) as a failed tool",
		async (skipReason) => {
			// covered-by-primary defers to a lane whose answer is exactly what the
			// denial removed.
			const result = await deniedLspNextTo({ ...SKIPPED, skipReason });

			expect(result.output).toContain("failed to run");
			expect(result.output).not.toContain("so no runner checks these files");
			expect(result.unconfirmedStatus).toContain("failed to run");
		},
	);

	it("still names a sibling runner's failure when lsp.disabledServers turned the primary off", async () => {
		const csharp = path.join(projectDir, "Program.cs");
		fs.writeFileSync(csharp, "class P {}\n");
		const registry = new RunnerRegistry();
		registry.register({
			...countingRunner("lsp", {
				...SKIPPED,
				primaryUnavailableCause: "disabled",
				disabledPrimaryServerIds: ["csharp"],
			}).runner,
			appliesTo: ["csharp"],
		});
		registry.register({
			...countingRunner("dotnet-build", {
				status: "failed",
				diagnostics: [],
				semantic: "none",
			}).runner,
			appliesTo: ["csharp"],
		});
		const ctx = createDispatchContext(
			csharp,
			projectDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);

		clearCoverageNoticeState();
		const result = await dispatchForFile(ctx, fallbackGroup, registry);

		expect(result.output).toContain("failed to run");
		expect(result.output).not.toContain(
			"so no language server checks these files",
		);
		expect(result.unconfirmedStatus).toContain(
			"no primary language server answered",
		);
	});

	it("names both keys when lsp.disabledServers and dispatch.disabledRunners deny the file's checkers", async () => {
		writeGlobal({
			dispatch: { disabledRunners: ["dotnet-build"] },
			lsp: { disabledServers: ["csharp"] },
		});
		const csharp = path.join(projectDir, "Program.cs");
		fs.writeFileSync(csharp, "class P {}\n");
		const registry = new RunnerRegistry();
		registry.register({
			...countingRunner("lsp", {
				...SKIPPED,
				primaryUnavailableCause: "disabled",
				disabledPrimaryServerIds: ["csharp"],
			}).runner,
			appliesTo: ["csharp"],
		});
		registry.register({
			...countingRunner("dotnet-build", SUCCEEDED).runner,
			appliesTo: ["csharp"],
		});
		const ctx = createDispatchContext(
			csharp,
			projectDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);

		clearCoverageNoticeState();
		const result = await dispatchForFile(ctx, fallbackGroup, registry);

		expect(result.output).toContain("lsp.disabledServers");
		expect(result.output).toContain("dispatch.disabledRunners");
		expect(result.unconfirmedStatus).toContain("dispatch.disabledRunners");
	});

	it("honors a denial in a nested .pi-lens.json over the workspace root", async () => {
		const repo = path.join(tmpDir, "repo");
		const pkg = path.join(repo, "pkg");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		writeProject({ dispatch: { disabledRunners: ["dotnet-build"] } }, pkg);
		const csharp = path.join(pkg, "Program.cs");
		fs.writeFileSync(csharp, "class P {}\n");
		fs.writeFileSync(path.join(pkg, "pkg.csproj"), "<Project />\n");
		const registry = new RunnerRegistry();
		const build = countingRunner("dotnet-build", BLOCKING_BUILD);
		registry.register({ ...build.runner, appliesTo: ["csharp"] });
		const ctx = createDispatchContext(
			csharp,
			repo,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);

		const result = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: ["dotnet-build"] }],
			registry,
		);

		expect(build.counters.runCalls).toBe(0);
		expect(result.hasBlockers).toBe(false);
	});

	it("falls back to the workspace root for a file outside it", async () => {
		const repo = path.join(tmpDir, "repo");
		fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
		writeProject({ dispatch: { disabledRunners: ["javac"] } }, repo);
		const registry = new RunnerRegistry();
		const javac = countingRunner("javac", BLOCKING_BUILD);
		registry.register(javac.runner);
		const ctx = createDispatchContext(
			path.join(tmpDir, "outside", "a.ts"),
			repo,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);

		await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: ["javac"] }],
			registry,
		);

		expect(javac.counters.runCalls).toBe(0);
	});

	it("warns once about an unknown id and still skips the valid one", async () => {
		writeGlobal({
			dispatch: { disabledRunners: ["dotnet-bild", "dotnet-build"] },
		});
		const { registry, build } = registryWith(SKIPPED, BLOCKING_BUILD);

		await dispatchForFile(contextFor(), fallbackGroup, registry);
		await dispatchForFile(contextFor(), fallbackGroup, registry);

		expect(build.runCalls).toBe(0);
		const warnings = notified.filter((message) =>
			message.includes("dotnet-bild"),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("PILENS_CFG_0005");
	});

	// PR #5011 round 5, F16 (greptile thread PRRT_kwDORt8rec6yJQYq): the unknown
	// entries were reported raw, so a pasted list of 100 typo'd ids sent 100
	// notifications while every other config producer is bounded by
	// MAX_MIGRATION_RECORDS (20, one slot held for the suppression count).
	it("bounds the notices for a long list of unknown ids to 19 plus one suppression record", async () => {
		const unknown = Array.from({ length: 25 }, (_, i) => `no-such-runner-${i}`);
		writeProject({
			dispatch: { disabledRunners: ["dotnet-build", ...unknown] },
		});
		const { registry } = registryWith(SKIPPED, BLOCKING_BUILD);

		await dispatchForFile(contextFor(), fallbackGroup, registry);

		expect(notified.filter((m) => m.includes("PILENS_CFG_0005"))).toHaveLength(
			19,
		);
		const suppression = notified.filter((m) => m.includes("PILENS_CFG_0007"));
		expect(suppression).toHaveLength(1);
		expect(suppression[0]).toContain("6 further config notices");
		expect(suppression[0]).toContain(".pi-lens.json");
	});

	// PR #5011 round 6, F20 (greptile thread PRRT_kwDORt8rec6yJ-Og): the
	// suppression record took its file and tier from list member zero, so a
	// global list that overflowed into the project list named the global file
	// ("global config notices for config.json") for notices the project's
	// `.pi-lens.json` produced. The anchor is the records' own last entry, the
	// highest-precedence document, as config-resolve's documentAnchor does.
	it("anchors the suppression record at the document whose records overflowed, not at member zero", async () => {
		const unknown = (tag: string) =>
			Array.from({ length: 15 }, (_, i) => `no-such-${tag}-${i}`);
		writeGlobal({ dispatch: { disabledRunners: unknown("global") } });
		writeProject({ dispatch: { disabledRunners: unknown("project") } });
		const { registry } = registryWith(SKIPPED, BLOCKING_BUILD);

		await dispatchForFile(contextFor(), fallbackGroup, registry);

		const suppression = notified.filter((m) => m.includes("PILENS_CFG_0007"));
		expect(suppression).toHaveLength(1);
		expect(suppression[0]).toContain("11 further config notices");
		expect(suppression[0]).toContain("project config notices");
		expect(suppression[0]).toContain(".pi-lens.json");
		expect(suppression[0]).not.toContain("global config notices");
	});

	it("reports every unknown id when the list is within the bound", async () => {
		const unknown = Array.from({ length: 19 }, (_, i) => `no-such-runner-${i}`);
		writeProject({ dispatch: { disabledRunners: unknown } });
		const { registry } = registryWith(SKIPPED, BLOCKING_BUILD);

		await dispatchForFile(contextFor(), fallbackGroup, registry);

		expect(notified.filter((m) => m.includes("PILENS_CFG_0005"))).toHaveLength(
			19,
		);
		expect(notified.filter((m) => m.includes("PILENS_CFG_0007"))).toHaveLength(
			0,
		);
	});
});
