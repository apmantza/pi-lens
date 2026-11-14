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
import {
	createAvailabilityChecker,
	resetDispatchAvailabilityState,
	resolveToolCommandWithInstallFallback,
	toolBinaryVerdict,
	toolOnPath,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { resetProjectLensConfigCache } from "../../../../clients/project-lens-config.js";
import { runAutofix } from "../../../../clients/pipeline.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../../clients/project-trust.js";
import { resetWorkspaceTopology } from "../../../../clients/workspace-topology.js";
import { RuffClient } from "../../../../clients/ruff-client.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, spawnCalls, probeMode, probeGate } = vi.hoisted(() => {
	const spawnCalls: Array<{
		cmd: string;
		args: readonly string[];
		cwd: string | undefined;
	}> = [];
	const probeMode: Record<string, "ok" | "timeout" | "reject"> = {};
	// When set, a version probe waits on it: the probe is in flight until released.
	const probeGate: { current?: Promise<void> } = {};
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
				await probeGate.current;
				const tool = path.basename(String(cmd)).replace(/\.(exe|bat)$/, "");
				// helm 4 has no --version flag, an old JVM has no --version and the
				// spotbugs launcher rejects it: each answers only its own spelling, so a registry row
				// with the wrong versionArgs reads as a rejected binary (#4453).
				const spelling =
					tool === "helm"
						? args[0] === "version"
						: tool === "java" || tool === "spotbugs"
							? args.includes("-version")
							: true;
				const mode = spelling ? (probeMode[tool] ?? "ok") : "reject";
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
	return { safeSpawnAsync, spawnCalls, probeMode, probeGate };
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
	spotbugs: ".bat",
	ktfmt: "",
	bundle: ".bat",
	rubocop: "",
};

/**
 * The project-local rung of a tool at exactly `root`: `.venv/bin/<tool>`, or
 * the `binDir` (relative to `root`) a caller names.
 */
function plantTool(
	root: string,
	tool: string,
	binDir: string = path.join(".venv", "bin"),
): string {
	const bin = path.join(root, binDir);
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
		probeGate.current = undefined;
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
		vi.restoreAllMocks();
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

	// Recurrence (#5410 remainder): the ktfmt autofix lane kept a module-level
	// checker of its own, so the registry never held its verdict, the
	// `node_modules/.bin` rung the registry ladder walks was missing from it,
	// and no reader could ask what the lane decided.
	it("resolves a ktfmt autofix through the registry ladder", async () => {
		const root = workspace.tmpDir;
		const shim = plantTool(root, "ktfmt", path.join("node_modules", ".bin"));
		fs.writeFileSync(path.join(root, "build.gradle.kts"), "// ktfmt {}\n");
		fs.writeFileSync(path.join(root, ".ktfmt"), "");
		const file = path.join(root, "Main.kt");
		fs.writeFileSync(file, "fun main() {}\n");
		await autofix(file, root);
		expect(probesOf(shim)).toHaveLength(1);
		expect(
			spawnCalls.some((c) => c.cmd === shim && c.args.includes(file)),
		).toBe(true);
		expect(toolBinaryVerdict("ktfmt", root).outcome).toBe("success");
	});

	// Recurrence: spotbugs held its own checker, so the registry could not
	// answer for it (the spec row is what the runner's checker lacked).
	it("resolves spotbugs through the registry ladder", async () => {
		const root = workspace.tmpDir;
		plantTool(root, "java");
		const shim = plantTool(root, "spotbugs");
		fs.mkdirSync(path.join(root, "target", "classes"), { recursive: true });
		fs.writeFileSync(path.join(root, "target", "classes", "A.class"), "x");
		const file = path.join(root, "A.java");
		fs.writeFileSync(file, "class A {}\n");
		await dispatch(
			file,
			root,
			(await import("../../../../clients/dispatch/runners/spotbugs.js"))
				.default,
		);
		expect(probesOf(shim)).toHaveLength(1);
		expect(toolBinaryVerdict("spotbugs", root).outcome).toBe("success");
	});

	// Recurrence (#4776, moved from the java probe this fold deleted): a caller
	// that arrives after pi's trust answer changed joined the probe a caller
	// under the old answer had in flight, and took its answer for the new
	// trust. The checker's own in-flight table now carries the trust it
	// started under.
	it("starts its own probe when trust changed under an in-flight one", async () => {
		const tool = path.join(
			pathEnv.tmpDir,
			process.platform === "win32" ? "trivy.exe" : "trivy",
		);
		fs.writeFileSync(tool, "#!/bin/sh\n");
		fs.chmodSync(tool, 0o755);
		const checker = createAvailabilityChecker("trivy", ".exe");
		let release: () => void = () => {};
		probeGate.current = new Promise<void>((resolve) => {
			release = resolve;
		});
		setProjectTrustState("untrusted");
		const before = checker.isAvailableAsync(workspace.tmpDir);
		setProjectTrustState("trusted");
		const after = checker.isAvailableAsync(workspace.tmpDir);
		release();
		await Promise.all([before, after]);
		expect(probesOf("trivy")).toHaveLength(2);
	});

	// Recurrence: the LSP launcher hands `java` to jdtls by its bare name, so a
	// project's own `.venv/bin/java` is no answer to "does java run from PATH".
	it("answers whether the bare command runs on PATH, not whether a project has it", async () => {
		// The PATH probe keys on the process's directory; plant the shim there.
		vi.spyOn(process, "cwd").mockReturnValue(workspace.tmpDir);
		plantTool(workspace.tmpDir, "java");
		expect(await toolOnPath("java")).toBe(false);
		const onPath = path.join(
			pathEnv.tmpDir,
			process.platform === "win32" ? "java.exe" : "java",
		);
		fs.writeFileSync(onPath, "#!/bin/sh\n");
		fs.chmodSync(onPath, 0o755);
		resetDispatchAvailabilityState();
		expect(await toolOnPath("java")).toBe(true);
	});

	// Recurrence (#5410 remainder): rubocop's bundler form resolved by spawning
	// `bundle exec rubocop --version` on every run and every fix, with no memo
	// and no decision row, and by a verify that read `bundle` alone; a Gemfile
	// that names rubocop on a host without bundler skipped the runner while a
	// working rubocop sat on PATH.
	describe("rubocop's bundler form", () => {
		const putOnPath = (name: string) => {
			const file = path.join(
				pathEnv.tmpDir,
				process.platform === "win32" ? `${name}.bat` : name,
			);
			fs.writeFileSync(file, "#!/bin/sh\n");
			fs.chmodSync(file, 0o755);
			return file;
		};
		const setup = () => {
			const root = workspace.tmpDir;
			fs.writeFileSync(path.join(root, "Gemfile"), "gem 'rubocop'\n");
			fs.writeFileSync(path.join(root, ".rubocop.yml"), "AllCops: {}\n");
			const file = path.join(root, "a.rb");
			fs.writeFileSync(file, "x = 1\n");
			return { root, file };
		};

		it("probes bundle once across the rubocop runner and the fix", async () => {
			putOnPath("bundle");
			const { root, file } = setup();
			const runner = (
				await import("../../../../clients/dispatch/runners/rubocop.js")
			).default;
			await dispatch(file, root, runner);
			await dispatch(file, root, runner);
			await autofix(file, root);
			expect(probesOf("bundle")).toHaveLength(1);
			expect(
				spawnCalls.filter(
					(c) => c.args.includes("exec") && c.args.includes("-a"),
				),
			).toHaveLength(1);
		});

		it("runs the rubocop on PATH when the Gemfile names it and bundler is absent", async () => {
			putOnPath("rubocop");
			const { root, file } = setup();
			await dispatch(
				file,
				root,
				(await import("../../../../clients/dispatch/runners/rubocop.js"))
					.default,
			);
			expect(
				spawnCalls.some(
					(c) => c.cmd === "rubocop" && c.args.includes("--format"),
				),
			).toBe(true);
		});
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
		// The pass scanned the rendered tree (its `outputDir` is the last argument),
		// so a pass that never resolved trivy cannot satisfy this.
		expect(
			spawnCalls.some(
				(c) =>
					c.cmd === tool && c.args[0] === "config" && c.args.at(-1) === root,
			),
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

	// Control (green before the fold): helm-render and its IaC pass word an
	// unusable binary from the ladder's typed verdict too.
	it("words a helm and a trivy whose probe timed out from the verdict", async () => {
		const root = workspace.tmpDir;
		plantTool(root, "helm");
		plantTool(root, "trivy");
		probeMode.helm = "timeout";
		probeMode.trivy = "timeout";
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
		const render = (
			await import("../../../../clients/dispatch/runners/helm-render.js")
		).default;
		const rendered = await render.run({
			...createDispatchContext(
				file,
				root,
				{ getFlag: () => false },
				new FactStore(),
			),
			projectRoot: root,
		});
		expect(rendered.failureMessage).toContain("availability probe timed out");
		const { runIacPass } =
			await import("../../../../clients/dispatch/runners/helm-render.js");
		const gaps = await runIacPass({
			chartRoot: root,
			cwd: root,
			outputDir: root,
			manifests: [],
		});
		expect(gaps.map((gap) => gap.message).join("\n")).toContain(
			"availability probe timed out",
		);
	});

	// A tool the runner could not use is worded from the ladder's verdict for
	// that tool id, never from a checker the runner kept for itself.
	describe.each([
		{
			tool: "golangci-lint",
			runner: "golangci-lint",
			// An installable tool with the install switch off.
			absent: "install-disabled",
			file: "main.go",
			setup: (root: string) => {
				fs.writeFileSync(path.join(root, ".golangci.yml"), "version: '2'\n");
				fs.writeFileSync(path.join(root, "go.mod"), "module x\n");
			},
		},
		{
			tool: "detekt",
			runner: "detekt",
			// No installer entry, so the install switch is not the cause.
			absent: "not-installed",
			file: "Main.kt",
			setup: (root: string) =>
				fs.writeFileSync(path.join(root, "detekt.yml"), "build:\n"),
		},
		{
			tool: "trivy",
			runner: "trivy-config",
			absent: "install-disabled",
			file: "main.tf",
			setup: (root: string) => {
				fs.writeFileSync(
					path.join(root, ".pi-lens.json"),
					JSON.stringify({ trivy: { enabled: true } }),
				);
				resetProjectLensConfigCache();
			},
		},
	])("$runner skip reason", ({ tool, runner, absent, file, setup }) => {
		it.each([
			{ label: "absent", mode: undefined, reason: absent },
			{ label: "timed out", mode: "timeout", reason: "probe-incomplete" },
			{
				label: "rejecting its version probe",
				mode: "reject",
				reason: "probe-rejected",
			},
		] as const)(
			"words a tool that is $label as $reason",
			async ({ mode, reason }) => {
				const root = workspace.tmpDir;
				setup(root);
				if (mode) {
					// On PATH, the last rung, so only its verdict is the answer.
					const onPath = path.join(
						pathEnv.tmpDir,
						process.platform === "win32" ? `${tool}${WINDOWS_EXT[tool]}` : tool,
					);
					fs.writeFileSync(onPath, "#!/bin/sh\n");
					fs.chmodSync(onPath, 0o755);
					probeMode[tool] = mode;
				}
				const target = path.join(root, file);
				fs.writeFileSync(target, "x\n");
				const definition = (
					await import(`../../../../clients/dispatch/runners/${runner}.js`)
				).default as RunnerDefinition;
				const result = await definition.run({
					...createDispatchContext(
						target,
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

	// #5539 review r1, F4: the node_modules/.bin rung is a listed behaviour change
	// for the five folded tools, so each pins it per trust state through the real
	// resolver. Recurrence: a ladder without NODE_MODULES_BIN_DIRS drops the
	// project shim of an npm-installed tool, and no cell read that rung.
	describe.each(Object.keys(WINDOWS_EXT))(
		"%s node_modules/.bin rung",
		(tool) => {
			const nodeModulesBin = path.join("node_modules", ".bin");
			it("resolves the project shim once pi trusts the project", async () => {
				setProjectTrustState("trusted");
				const shim = plantTool(workspace.tmpDir, tool, nodeModulesBin);
				expect(
					await resolveToolCommandWithInstallFallback(workspace.tmpDir, tool),
				).toBe(shim);
			});
			it("refuses the same shim while the project is untrusted", async () => {
				setProjectTrustState("untrusted");
				plantTool(workspace.tmpDir, tool, nodeModulesBin);
				expect(
					await resolveToolCommandWithInstallFallback(workspace.tmpDir, tool),
				).toBeNull();
			});
		},
	);
});
