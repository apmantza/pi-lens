/**
 * #5410: trivy, helm, golangci-lint, detekt and java each had two or more
 * private availability checkers; they now ask the one registry resolver
 * (`resolveToolCommandWithInstallFallback`).
 *
 * Driven through the production entries (`dispatchForFile` over the real
 * runners, `runAutofix`, `runIacPass`), the real checker, the real trust seam
 * and the real installer lookups. Only the child process (`safe-spawn`) is
 * doubled; installs stay off through the suite's `PI_LENS_DISABLE_TOOL_INSTALL`
 * default.
 *
 * Recurrence pinned: two checkers for one binary kept two latches per cwd, so
 * the lint runner and its sibling (the autofix lane, the render pass, the
 * second runner) each spawned the same `--version` probe, and a verdict one
 * of them reached (trust change, timeout cooldown) was invisible to the other.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RunnerRegistry,
	createDispatchContext,
	dispatchForFile,
} from "../../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import type { RunnerDefinition } from "../../../../clients/dispatch/types.js";
import { resetDispatchAvailabilityState } from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { resetProjectLensConfigCache } from "../../../../clients/project-lens-config.js";
import { runAutofix } from "../../../../clients/pipeline.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../../clients/project-trust.js";
import { resetWorkspaceTopology } from "../../../../clients/workspace-topology.js";
import { RuffClient } from "../../../../clients/ruff-client.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, spawnCalls, probeMode } = vi.hoisted(() => {
	const spawnCalls: Array<{
		cmd: string;
		args: readonly string[];
		cwd: string | undefined;
	}> = [];
	const probeMode: Record<string, "ok" | "timeout" | "reject"> = {};
	const safeSpawnAsync = vi.fn(
		async (
			cmd: string,
			args: readonly string[] = [],
			opts: { cwd?: string } = {},
		) => {
			spawnCalls.push({ cmd: String(cmd), args, cwd: opts.cwd });
			const fs = await import("node:fs");
			const path = await import("node:path");
			const onDisk = path.isAbsolute(cmd)
				? fs.existsSync(cmd)
				: (process.env.PATH ?? "")
						.split(path.delimiter)
						.some((dir) => dir && fs.existsSync(path.join(dir, cmd)));
			if (!onDisk) {
				return {
					error: new Error(`spawn ${cmd} ENOENT`),
					status: null,
					stdout: "",
					stderr: "",
					spawnFailure: { kind: "tool-not-found" },
				};
			}
			const isProbe =
				args.includes("--version") ||
				args.includes("-version") ||
				(args[0] === "version" && args[1] === "--short");
			if (isProbe) {
				const tool = path.basename(String(cmd)).replace(/\.(exe|bat)$/, "");
				const mode = probeMode[tool] ?? "ok";
				if (mode === "timeout") {
					return {
						error: new Error("timed out"),
						status: null,
						stdout: "",
						stderr: "",
						failure: "timeout",
						spawnFailure: { kind: "timeout" },
					};
				}
				if (mode === "reject") {
					return { error: null, status: 2, stdout: "", stderr: "bad flag" };
				}
				return { error: null, status: 0, stdout: "1.0.0\n", stderr: "" };
			}
			return { error: null, status: 0, stdout: "", stderr: "" };
		},
	);
	return { safeSpawnAsync, spawnCalls, probeMode };
});
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

const WINDOWS_EXT: Record<string, string> = {
	"golangci-lint": ".exe",
	detekt: ".bat",
	helm: ".exe",
	trivy: ".exe",
	java: ".exe",
};

/** The project-local rung of a tool at exactly `root`: `.venv/bin/<tool>`. */
function plantTool(root: string, tool: string): string {
	const bin = path.join(root, ".venv", "bin");
	fs.mkdirSync(bin, { recursive: true });
	const file = path.join(
		bin,
		process.platform === "win32" ? `${tool}${WINDOWS_EXT[tool]}` : tool,
	);
	fs.writeFileSync(file, "#!/bin/sh\n");
	fs.chmodSync(file, 0o755);
	return file;
}

const probesOf = (binary: string) =>
	spawnCalls.filter(
		(call) =>
			call.cmd === binary &&
			(call.args.includes("--version") ||
				call.args.includes("-version") ||
				call.args[0] === "version"),
	);

describe("one availability ladder per binary (#5410)", () => {
	let pathEnv: ReturnType<typeof setupTestEnvironment>;
	let workspace: ReturnType<typeof setupTestEnvironment>;
	const dbgLines: string[] = [];

	beforeEach(() => {
		pathEnv = setupTestEnvironment("pi-lens-5410fold-path-");
		workspace = setupTestEnvironment("pi-lens-5410fold-ws-");
		vi.stubEnv("PATH", pathEnv.tmpDir);
		setProjectTrustState("trusted");
		resetDispatchAvailabilityState();
		resetProjectLensConfigCache();
		resetWorkspaceTopology();
		spawnCalls.length = 0;
		dbgLines.length = 0;
		for (const key of Object.keys(probeMode)) delete probeMode[key];
		safeSpawnAsync.mockClear();
	});
	afterEach(() => {
		pathEnv.cleanup();
		workspace.cleanup();
		resetProjectTrust();
		resetProjectLensConfigCache();
		resetWorkspaceTopology();
		resetDispatchAvailabilityState();
		vi.unstubAllEnvs();
	});

	const autofix = (file: string, cwd: string) =>
		runAutofix(
			file,
			cwd,
			() => false,
			(line: string) => dbgLines.push(line),
			{
				ruffClient: new RuffClient(),
				biomeClient: {} as never,
				fixedThisTurn: new Set(),
			},
		);

	async function dispatch(
		file: string,
		cwd: string,
		runner: RunnerDefinition,
	): Promise<void> {
		const registry = new RunnerRegistry();
		registry.register(runner);
		await dispatchForFile(
			createDispatchContext(
				file,
				cwd,
				{ getFlag: () => false },
				new FactStore(),
			),
			[{ mode: "all", runnerIds: [runner.id] }],
			registry,
		);
	}

	// Recurrence: the lint runner and the autofix lane each held a checker for
	// golangci-lint, so one cwd paid two probes.
	it("probes golangci-lint once across the lint runner and the fix", async () => {
		const root = workspace.tmpDir;
		const tool = plantTool(root, "golangci-lint");
		fs.writeFileSync(path.join(root, ".golangci.yml"), "version: '2'\n");
		fs.writeFileSync(path.join(root, "go.mod"), "module x\n");
		const file = path.join(root, "main.go");
		fs.writeFileSync(file, "package main\n");
		await dispatch(
			file,
			root,
			(await import("../../../../clients/dispatch/runners/golangci-lint.js"))
				.default,
		);
		expect(probesOf(tool)).toHaveLength(1);
		await autofix(file, root);
		expect(probesOf(tool)).toHaveLength(1);
		expect(
			spawnCalls.some((c) => c.cmd === tool && c.args.includes("--fix")),
		).toBe(true);
	});

	// Recurrence: same pair for detekt.
	it("probes detekt once across the lint runner and the fix", async () => {
		const root = workspace.tmpDir;
		const tool = plantTool(root, "detekt");
		fs.writeFileSync(path.join(root, "detekt.yml"), "build:\n");
		const file = path.join(root, "Main.kt");
		fs.writeFileSync(file, "fun main() {}\n");
		await dispatch(
			file,
			root,
			(await import("../../../../clients/dispatch/runners/detekt.js")).default,
		);
		expect(probesOf(tool)).toHaveLength(1);
		await autofix(file, root);
		expect(probesOf(tool)).toHaveLength(1);
		expect(
			spawnCalls.some(
				(c) => c.cmd === tool && c.args.includes("--auto-correct"),
			),
		).toBe(true);
	});

	// Recurrence: helm-lint and helm-render each held a helm checker.
	it("probes helm once across helm-lint and helm-render", async () => {
		const root = workspace.tmpDir;
		const tool = plantTool(root, "helm");
		fs.mkdirSync(path.join(root, "chart", "templates"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "chart", "Chart.yaml"),
			"apiVersion: v2\nname: test\nversion: 0.1.0\n",
		);
		const file = path.join(root, "chart", "templates", "deployment.yaml");
		fs.writeFileSync(file, "kind: Deployment\n");
		fs.writeFileSync(
			path.join(root, ".pi-lens.json"),
			JSON.stringify({ helm: { renderValidation: { enabled: true } } }),
		);
		resetProjectLensConfigCache();
		await dispatch(
			file,
			root,
			(await import("../../../../clients/dispatch/runners/helm-lint.js"))
				.default,
		);
		expect(probesOf(tool)).toHaveLength(1);
		await dispatch(
			file,
			root,
			(await import("../../../../clients/dispatch/runners/helm-render.js"))
				.default,
		);
		expect(
			spawnCalls.some((c) => c.cmd === tool && c.args[0] === "template"),
		).toBe(true);
		expect(probesOf(tool)).toHaveLength(1);
	});

	// Recurrence: trivy-config and helm-render's IaC pass each held a trivy
	// checker.
	it("probes trivy once across trivy-config and the rendered-manifest pass", async () => {
		const root = workspace.tmpDir;
		const tool = plantTool(root, "trivy");
		fs.writeFileSync(
			path.join(root, ".pi-lens.json"),
			JSON.stringify({ trivy: { enabled: true } }),
		);
		resetProjectLensConfigCache();
		const file = path.join(root, "main.tf");
		fs.writeFileSync(file, 'resource "x" "y" {}\n');
		await dispatch(
			file,
			root,
			(await import("../../../../clients/dispatch/runners/trivy-config.js"))
				.default,
		);
		expect(probesOf(tool)).toHaveLength(1);
		const { runIacPass } =
			await import("../../../../clients/dispatch/runners/helm-render.js");
		await runIacPass({
			chartRoot: root,
			cwd: root,
			outputDir: root,
			manifests: [],
		});
		expect(
			spawnCalls.some((c) => c.cmd === tool && c.args[0] === "config"),
		).toBe(true);
		expect(probesOf(tool)).toHaveLength(1);
	});

	// Control (green before the fold): the wording of an absent helm and a helm
	// whose probe timed out comes from the typed verdict the shared ladder holds.
	it("words an absent and a timed-out helm from the ladder's verdict", async () => {
		const root = workspace.tmpDir;
		fs.mkdirSync(path.join(root, "chart", "templates"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "chart", "Chart.yaml"),
			"apiVersion: v2\nname: test\nversion: 0.1.0\n",
		);
		const file = path.join(root, "chart", "templates", "deployment.yaml");
		fs.writeFileSync(file, "kind: Deployment\n");
		const lint = (
			await import("../../../../clients/dispatch/runners/helm-lint.js")
		).default;
		const absent = await lint.run({
			...createDispatchContext(
				file,
				root,
				{ getFlag: () => false },
				new FactStore(),
			),
			projectRoot: root,
		});
		expect(absent.failureMessage).toBe("helm unavailable (missing)");
		resetDispatchAvailabilityState();
		plantTool(root, "helm");
		probeMode.helm = "timeout";
		const stalled = await lint.run({
			...createDispatchContext(
				file,
				root,
				{ getFlag: () => false },
				new FactStore(),
			),
			projectRoot: root,
		});
		expect(stalled.failureMessage).toBe("helm unavailable (transient)");
	});

	// Control (green before the fold, moved from the mocked spotbugs-runner
	// test): the Java verdict wording survives the move to the shared id.
	it.each([
		["absent", undefined, "runtime-missing"],
		["timed out", "timeout", "probe-incomplete"],
		["rejecting its version probe", "reject", "probe-rejected"],
	] as const)(
		"words a Java runtime that is %s as %s for spotbugs",
		async (_label, mode, reason) => {
			const root = workspace.tmpDir;
			if (mode) {
				// On PATH, the last rung: a rejecting project shim would fall through
				// to it (#5437 F1), so only the last rung's verdict is the answer.
				const onPath = path.join(
					pathEnv.tmpDir,
					process.platform === "win32" ? "java.exe" : "java",
				);
				fs.writeFileSync(onPath, "#!/bin/sh\n");
				fs.chmodSync(onPath, 0o755);
				probeMode.java = mode;
			}
			fs.mkdirSync(path.join(root, "target", "classes"), { recursive: true });
			fs.writeFileSync(path.join(root, "target", "classes", "A.class"), "x");
			const file = path.join(root, "A.java");
			fs.writeFileSync(file, "class A {}\n");
			const spotbugs = (
				await import("../../../../clients/dispatch/runners/spotbugs.js")
			).default;
			const result = await spotbugs.run({
				...createDispatchContext(
					file,
					root,
					{ getFlag: () => false },
					new FactStore(),
				),
				projectRoot: root,
			});
			expect(result.skipReason).toBe(reason);
		},
	);
});
