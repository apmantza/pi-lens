/**
 * helm-render runner — rendered-manifest validation (#1283 Slice B).
 *
 * The environment is mocked (tool presence, spawn results), never the behavior
 * under test: the opt-in gate reads a real `.pi-lens.json` through the real
 * project-config loader, chart discovery walks the real workspace topology over
 * real chart fixtures on disk, and source mapping resolves against the real
 * template files. The `helm template` mock writes rendered manifests into the
 * scratch directory the runner actually passed it, so `--output-dir` layout and
 * `# Source:` mapping are exercised rather than asserted about.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import {
	capKilledOnWindowsSpawnResult,
	capKilledSpawnResult,
	capThenAbortedSpawnResult,
	capThenTimedOutSpawnResult,
} from "../../../support/spawn-shapes.js";

const { safeSpawnAsync, resolveToolCommandWithInstallFallback } = vi.hoisted(
	() => ({
		safeSpawnAsync: vi.fn(),
		resolveToolCommandWithInstallFallback: vi.fn(),
	}),
);

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));
vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		resolveToolCommandWithInstallFallback,
	}),
);

const { resetProjectLensConfigCache } =
	await import("../../../../clients/project-lens-config.js");
const { resetProjectTrust, setProjectTrustState } =
	await import("../../../../clients/project-trust.js");
const { resetWorkspaceTopology } =
	await import("../../../../clients/workspace-topology.js");
const {
	default: helmRenderRunner,
	checkManifestShape,
	discardScratchDir,
	extractTemplateRef,
	isHelmRenderEnabled,
	mapRenderedToSource,
	parseHelmTemplateFailure,
	parseRenderedTrivyOutput,
	resolveTemplateSource,
} = await import("../../../../clients/dispatch/runners/helm-render.js");

const fixtures = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"fixtures",
	"helm-render",
);

let workspace: string;

/** Copy a chart fixture into the temp workspace and return its root. */
function installChart(name: "valid-chart" | "broken-chart"): string {
	const dest = path.join(workspace, name);
	fs.cpSync(path.join(fixtures, name), dest, { recursive: true });
	return dest;
}

/** Every path under the chart plus its bytes, so an in-place edit shows up. */
function chartContentFingerprint(chartRoot: string): string[] {
	const entries = fs.readdirSync(chartRoot, {
		recursive: true,
		withFileTypes: true,
	});
	const rows: string[] = [];
	for (const entry of entries) {
		// SAFETY: Node's recursive Dirent entries expose one of these parent fields.
		const parent = entry as unknown as { parentPath?: string; path?: string };
		const full = path.join(
			parent.parentPath ?? parent.path ?? chartRoot,
			entry.name,
		);
		if (!entry.isFile()) {
			rows.push(`dir ${path.relative(chartRoot, full)}`);
			continue;
		}
		rows.push(
			`file ${path.relative(chartRoot, full)} ${fs.readFileSync(full, "utf-8")}`,
		);
	}
	return rows.sort((left, right) => left.localeCompare(right));
}

function optIn(config: Record<string, unknown>): void {
	fs.writeFileSync(
		path.join(workspace, ".pi-lens.json"),
		JSON.stringify(config),
	);
	resetProjectLensConfigCache();
}

function outputDirFrom(args: string[]): string {
	const index = args.indexOf("--output-dir");
	if (index < 0)
		throw new Error("helm template was called without --output-dir");
	return args[index + 1];
}

interface SpawnStub {
	status: number | null;
	stdout?: string;
	stderr?: string;
	failure?: string;
	signal?: NodeJS.Signals;
	spawnFailure?: { kind: string };
	error?: Error;
	outputTruncated?: boolean;
	killedForOutputCap?: boolean;
}

/**
 * Drive the two spawns the runner makes. `render` may write rendered manifests
 * into the real scratch directory; `scan` answers the trivy pass.
 */
function stubSpawns(options: {
	render: SpawnStub | ((outputDir: string) => SpawnStub);
	scan?: SpawnStub;
}): { renderedIn: () => string | undefined } {
	let capturedOutputDir: string | undefined;
	safeSpawnAsync.mockImplementation(
		async (_cmd: string, args: string[]): Promise<SpawnStub> => {
			if (args[0] === "template") {
				capturedOutputDir = outputDirFrom(args);
				return typeof options.render === "function"
					? options.render(capturedOutputDir)
					: options.render;
			}
			if (args[0] === "config") {
				return options.scan ?? { status: 0, stdout: "{}", stderr: "" };
			}
			throw new Error(`unexpected spawn: ${args.join(" ")}`);
		},
	);
	return { renderedIn: () => capturedOutputDir };
}

function writeRendered(
	outputDir: string,
	relativePath: string,
	content: string,
): void {
	const target = path.join(outputDir, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

const RENDERED_DEPLOYMENT = [
	"---",
	"# Source: pi-lens-render-valid/templates/deployment.yaml",
	"apiVersion: apps/v1",
	"kind: Deployment",
	"metadata:",
	"  name: pi-lens-render-web",
	"",
].join("\n");

beforeEach(() => {
	workspace = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-helm-render-test-")),
	);
	resolveToolCommandWithInstallFallback.mockReset();
	resolveToolCommandWithInstallFallback.mockResolvedValue("helm");
	safeSpawnAsync.mockReset();
	resetProjectLensConfigCache();
	resetWorkspaceTopology();
	resetProjectTrust();
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
	resetProjectLensConfigCache();
	resetWorkspaceTopology();
	resetProjectTrust();
});

describe("helm-render opt-in gate", () => {
	it("spawns nothing when the project has not opted in", async () => {
		const chart = installChart("valid-chart");
		stubSpawns({ render: { status: 0 } });

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({ status: "skipped", diagnostics: [] });
		expect(resolveToolCommandWithInstallFallback).not.toHaveBeenCalled();
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("stays off when other pi-lens settings exist but the render switch does not", async () => {
		const chart = installChart("valid-chart");
		optIn({ trivy: { enabled: true }, helm: { renderValidation: {} } });
		stubSpawns({ render: { status: 0 } });

		const result = await helmRenderRunner.run(
			makeRunnerCtx(path.join(chart, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);

		expect(result.status).toBe("skipped");
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(isHelmRenderEnabled(workspace)).toBe(false);
	});

	it("skips a chart that sits outside the workspace root even with the switch on", async () => {
		// Recurrence (#2556, shape 83): the workspace gate is `isWithinIdentity`'s
		// answer, and nothing else pinned it for the render runner.
		const outside = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-helm-render-outside-")),
		);
		try {
			const chart = path.join(outside, "valid-chart");
			fs.cpSync(path.join(fixtures, "valid-chart"), chart, { recursive: true });
			optIn({ helm: { renderValidation: { enabled: true } } });
			stubSpawns({ render: { status: 0 } });

			const result = await helmRenderRunner.run(
				makeRunnerCtx(path.join(chart, "values.yaml"), workspace, {
					kind: "yaml",
					projectRoot: workspace,
				}),
			);

			expect(result).toMatchObject({ status: "skipped", diagnostics: [] });
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("refuses to render an untrusted project even with the switch on", async () => {
		// `.pi-lens.json` is a TRACKED file: a hostile chart repo can arrive with
		// consent already granted, authorizing execution of its own templates.
		// Trust is the host's answer and cannot be forged by repo content.
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		setProjectTrustState("untrusted");
		stubSpawns({ render: { status: 0 } });

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(resolveToolCommandWithInstallFallback).not.toHaveBeenCalled();
		// And the refusal is legible — not a silent skip the user reads as clean.
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].rule).toBe("render-untrusted");
		expect(result.diagnostics[0].message).toContain("trust");
		expect(result.semantic).not.toBe("none");
	});

	it("reads consent from the chart's project root, not an unrelated cwd", async () => {
		// The scoping hole: consent granted in one directory must not authorize
		// rendering a chart that belongs to a different project root.
		const otherProject = path.join(workspace, "consenting-elsewhere");
		fs.mkdirSync(otherProject, { recursive: true });
		fs.writeFileSync(
			path.join(otherProject, ".pi-lens.json"),
			JSON.stringify({ helm: { renderValidation: { enabled: true } } }),
		);
		const chartProject = path.join(workspace, "no-consent-project");
		fs.mkdirSync(chartProject, { recursive: true });
		fs.cpSync(
			path.join(fixtures, "valid-chart"),
			path.join(chartProject, "chart"),
			{ recursive: true },
		);
		resetProjectLensConfigCache();
		stubSpawns({ render: { status: 0 } });

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chartProject, "chart", "templates", "deployment.yaml"),
				otherProject,
				{ kind: "yaml", projectRoot: chartProject },
			),
		);

		expect(result.status).toBe("skipped");
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("renders once the switch is explicitly true", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		expect(isHelmRenderEnabled(workspace)).toBe(true);
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "wrote manifests", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({ status: "succeeded", semantic: "none" });
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		expect(safeSpawnAsync.mock.calls[0][1].slice(0, 3)).toEqual([
			"template",
			"pi-lens-render",
			path.resolve(chart),
		]);
	});
});

describe("helm-render failure semantics", () => {
	it("reports a failed render as chart findings mapped to the template", async () => {
		const chart = installChart("broken-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: {
				status: 1,
				stdout: "",
				stderr:
					'Error: template: pi-lens-render-broken/templates/deployment.yaml:12:20: executing "pi-lens-render-broken/templates/deployment.yaml" at <.Values.image.registry.host>: nil pointer evaluating interface {}.host',
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.status).toBe("succeeded");
		expect(result.semantic).toBe("blocking");
		expect(result.failureKind).toBeUndefined();
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			line: 12,
			severity: "error",
			rule: "render-failed",
			tool: "helm-render",
		});
	});

	it("never reads a failed render as clean, even when the error is unrecognized", async () => {
		const chart = installChart("broken-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: { status: 1, stdout: "", stderr: "panic: something went wrong" },
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(path.join(chart, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);

		expect(result.semantic).toBe("blocking");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].filePath).toBe(path.join(chart, "Chart.yaml"));
		expect(result.diagnostics[0].message).toContain("something went wrong");
	});

	it("reports an absent helm as runner-unavailable, not as chart findings", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		resolveToolCommandWithInstallFallback.mockResolvedValue(null);
		stubSpawns({ render: { status: 0 } });

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({
			status: "failed",
			failureKind: "unavailable",
			diagnostics: [],
		});
		// The message must send the user to an install, not to their chart.
		expect(result.failureMessage).toContain("helm not available");
		expect(result.failureMessage).toContain("helm.sh");
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	// #5411: a timeout is the budget ending the run: the `did-not-run` skip every
	// seam runner reports, never a broken chart and no longer `failed/timeout`.
	it("reports a timed-out render as a did-not-run skip, never as a broken chart", async () => {
		resetDegradationLedger();
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: {
				status: null,
				stdout: "",
				stderr: "",
				failure: "timeout",
				spawnFailure: { kind: "timeout" },
				error: new Error("opaque failure"),
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({
			status: "skipped",
			skipFault: "did-not-run",
			diagnostics: [],
		});
		expect(
			getDegradationSummary()
				.find((entry) => entry.kind === "runner-empty-result")
				?.latestReasons.map((entry) => entry.subject),
		).toEqual(["helm-render"]);
	});

	it.each([
		["tool-not-found", "unavailable"],
		["killed", "aborted"],
	])(
		"reports a %s render spawn failure as a runner failure, never as a broken chart",
		async (kind, failureKind) => {
			const chart = installChart("valid-chart");
			optIn({ helm: { renderValidation: { enabled: true } } });
			stubSpawns({
				render: {
					status: null,
					stdout: "",
					stderr: "",
					failure: kind === "timeout" ? "timeout" : "aborted",
					spawnFailure: { kind },
					error: new Error("opaque failure"),
				},
			});

			const result = await helmRenderRunner.run(
				makeRunnerCtx(
					path.join(chart, "templates", "deployment.yaml"),
					workspace,
					{ kind: "yaml", projectRoot: workspace },
				),
			);

			expect(result).toMatchObject({ status: "failed", failureKind });
			expect(result.diagnostics).toEqual([]);
		},
	);
});

describe("helm-render rendered-manifest checks", () => {
	it("maps a trivy misconfiguration back to the source template", async () => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		const renderedRelative = path.join(
			"pi-lens-render-valid",
			"templates",
			"deployment.yaml",
		);
		stubSpawns({
			render: (outputDir) => {
				writeRendered(outputDir, renderedRelative, RENDERED_DEPLOYMENT);
				return { status: 0, stdout: "", stderr: "" };
			},
			scan: {
				status: 0,
				stdout: JSON.stringify({
					Results: [
						{
							Target: renderedRelative.split(path.sep).join("/"),
							Misconfigurations: [
								{
									ID: "KSV011",
									Title: "CPU not limited",
									Severity: "HIGH",
									CauseMetadata: { StartLine: 4 },
								},
							],
						},
					],
				}),
				stderr: "",
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.status).toBe("succeeded");
		expect(result.semantic).toBe("warning");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			rule: "KSV011",
			severity: "warning",
			defectClass: "safety",
		});
		// Lines do not survive rendering, so the rendered coordinates go in the
		// message and the diagnostic sits at the top of the template.
		expect(result.diagnostics[0].line).toBe(1);
		expect(result.diagnostics[0].message).toContain("deployment.yaml:4");
	});

	// #4689 batch 2 (clients/dispatch/runners/helm-render.ts, the trivy-target
	// lookup): the map of rendered manifests is a `PathKeyedMap(normalizeMapKey)`,
	// so a target that spells the scratch directory through a link must find the
	// manifest the walk recorded under its real path. The `path.resolve` around
	// that lookup is a join, not an identity derivation, so it stays (the map
	// derives the identity); the cell passes on master and the mutation row in
	// the PR body (plain `Map`) is its proof.
	it("maps a trivy target that spells the scratch directory through a link (#4689)", async (ctx) => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		const renderedRelative = path.join(
			"pi-lens-render-valid",
			"templates",
			"deployment.yaml",
		);
		const outputLink = path.join(workspace, "scratch-link");
		let linkTarget: string | undefined;
		stubSpawns({
			render: (outputDir) => {
				writeRendered(outputDir, renderedRelative, RENDERED_DEPLOYMENT);
				try {
					fs.symlinkSync(outputDir, outputLink, "dir");
					linkTarget = path.join(outputLink, renderedRelative);
				} catch {
					// the cell skips below
				}
				return { status: 0, stdout: "", stderr: "" };
			},
			scan: {
				status: 0,
				get stdout() {
					return JSON.stringify({
						Results: [
							{
								Target: linkTarget,
								Misconfigurations: [
									{
										ID: "KSV011",
										Title: "CPU not limited",
										Severity: "HIGH",
										CauseMetadata: { StartLine: 4 },
									},
								],
							},
						],
					});
				},
				stderr: "",
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		if (linkTarget === undefined) return ctx.skip("symlinks unavailable");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			rule: "KSV011",
		});
	});

	it("flags a rendered document that is not a Kubernetes object", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					[
						"---",
						"# Source: pi-lens-render-valid/templates/deployment.yaml",
						"metadata:",
						"  name: headless",
						"",
					].join("\n"),
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			rule: "manifest-shape",
			severity: "warning",
		});
		expect(result.diagnostics[0].message).toContain("apiVersion and kind");
	});

	it("says so when the IaC pass was requested but trivy is unavailable", async () => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		resolveToolCommandWithInstallFallback.mockImplementation(
			async (_cwd: string, toolId: string) =>
				toolId === "helm" ? "helm" : null,
		);
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		// Zero findings from a pass that never ran must not read as clean.
		expect(result.semantic).not.toBe("none");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			rule: "iac-pass-unavailable",
			filePath: path.join(chart, "Chart.yaml"),
		});
	});

	it("skips the IaC pass entirely when trivy is not opted in", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({ status: "succeeded", semantic: "none" });
		expect(
			safeSpawnAsync.mock.calls.map(
				(call: unknown[]) => (call[1] as string[])[0],
			),
		).toEqual(["template"]);
	});

	it("reports an IaC pass that failed to complete instead of an empty clean result", async () => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
			scan: { status: 2, stdout: "", stderr: "FATAL policy bundle download" },
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].rule).toBe("iac-pass-failed");
		expect(result.semantic).toBe("warning");
	});

	it("writes nothing into the chart and removes its scratch directory", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		// Names AND contents: a name-list comparison would miss an in-place edit.
		const before = chartContentFingerprint(chart);
		const stub = stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(chartContentFingerprint(chart)).toEqual(before);
		const scratch = stub.renderedIn();
		expect(scratch).toBeTruthy();
		// Realpath BOTH sides: the runner builds the dir from
		// `scannerReportParentDir()`, which answers `os.tmpdir()` unless a harness
		// sets the override, and `os.tmpdir()` is a symlink on macOS
		// (/var/folders -> /private/var/folders), so a raw-prefix comparison is
		// host-dependent. The expected side stays `os.tmpdir()` on purpose: it is an
		// independent reading of the host, and the cell below pins the override.
		expect(fs.realpathSync(path.dirname(scratch as string))).toBe(
			fs.realpathSync(os.tmpdir()),
		);
		expect(fs.existsSync(scratch as string)).toBe(false);
	});

	// Recurrence: #4133 gave every scanner whose report directory is created
	// with `mkdtempSync` the `scannerReportParentDir` seam, so a harness that
	// SIGKILLs the child before the `finally` strands the directory inside a root
	// it removes. The render scratch directory stayed on a raw `os.tmpdir()`.
	it("renders into a scratch directory under the owned scanner root", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		const scannerRoot = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scanner-root-")),
		);
		vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", scannerRoot);
		try {
			const stub = stubSpawns({
				render: (outputDir) => {
					writeRendered(
						outputDir,
						path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
						RENDERED_DEPLOYMENT,
					);
					return { status: 0, stdout: "", stderr: "" };
				},
			});

			await helmRenderRunner.run(
				makeRunnerCtx(
					path.join(chart, "templates", "deployment.yaml"),
					workspace,
					{ kind: "yaml", projectRoot: workspace },
				),
			);

			const scratch = stub.renderedIn();
			expect(scratch).toBeTruthy();
			expect(fs.realpathSync(path.dirname(scratch as string))).toBe(
				scannerRoot,
			);
			expect(path.basename(scratch as string)).toContain(
				"pi-lens-helm-render-",
			);
		} finally {
			vi.unstubAllEnvs();
			fs.rmSync(scannerRoot, { recursive: true, force: true });
		}
	});

	it("says the manifests are unscanned when trivy exits 0 with an unreadable report", async () => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
			scan: { status: 0, stdout: "<!doctype html>not a report", stderr: "" },
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.semantic).not.toBe("none");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].rule).toBe("iac-report-unreadable");
		expect(result.diagnostics[0].message).toContain("UNSCANNED");
	});

	it("reports a nonzero trivy exit even when it printed something", async () => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
			// `trivy config` gets no --exit-code, so nonzero always means it broke —
			// a partial report on stdout must not buy it a pass.
			scan: {
				status: 1,
				stdout: '{"Results":[',
				stderr: "FATAL failed to download policy bundle",
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].rule).toBe("iac-pass-failed");
		expect(result.diagnostics[0].message).toContain("failed to complete");
	});

	// #2100: the render spawn had no output cap at all, so its "render-truncated"
	// guard could never fire. A cap kill has different POSIX and Windows exit
	// shapes, so this runner uses safe-spawn's ownership field instead.
	// A chart whose render we cut short is UNCHECKED, not a runner abort.
	it.each([
		["POSIX", capKilledSpawnResult],
		["Windows", capKilledOnWindowsSpawnResult],
	] as const)(
		"says the render is truncated when the output cap killed helm on %s",
		async (_platform, resultFactory) => {
			const chart = installChart("valid-chart");
			optIn({ helm: { renderValidation: { enabled: true } } });
			stubSpawns({
				render: (outputDir) => {
					writeRendered(
						outputDir,
						path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
						RENDERED_DEPLOYMENT,
					);
					return resultFactory({ stdout: "wrote a.yaml\nwrote b.yaml\n" });
				},
			});

			const result = await helmRenderRunner.run(
				makeRunnerCtx(
					path.join(chart, "templates", "deployment.yaml"),
					workspace,
					{ kind: "yaml", projectRoot: workspace },
				),
			);

			expect(result.failureKind).toBeUndefined();
			// Exactly one diagnostic, and it is the coverage gap. We stopped helm, so
			// a synthesized "helm template failed" finding would blame the chart for
			// our own cap (#1487).
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].rule).toBe("render-truncated");
			expect(result.diagnostics[0].message).toContain("UNCHECKED");
			expect(result.semantic).toBe("warning");
		},
	);

	// #2100 review F1: helm exiting 0 means it FINISHED writing --output-dir, so
	// the tree on disk is complete and every manifest is still checkable. The
	// first version of this fix returned the coverage gap alone and skipped the
	// walk, dropping real manifest findings and claiming UNCHECKED for a tree
	// that was fully checked.
	it("still validates the rendered tree when only helm's stdout was capped", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					// No apiVersion/kind: a real manifest-shape finding to lose.
					[
						"---",
						"# Source: pi-lens-render-valid/templates/deployment.yaml",
						"metadata:",
						"  name: headless",
						"",
					].join("\n"),
				);
				return {
					status: 0,
					stdout: "wrote a.yaml\n",
					stderr: "",
					outputTruncated: true,
				};
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		const rules = result.diagnostics.map(
			(item: { rule?: string }) => item.rule,
		);
		expect(rules).toContain("manifest-shape");
		// Recorded, but as lost stdout — not as an UNCHECKED coverage claim, and
		// under its own rule so it cannot collide with the walk's own gap.
		expect(rules).toContain("render-output-truncated");
		expect(rules).not.toContain("render-truncated");
		const notes = result.diagnostics.filter(
			(item: { rule?: string }) => item.rule === "render-output-truncated",
		);
		expect(notes).toHaveLength(1);
		expect(notes[0].message).not.toContain("UNCHECKED");
		expect(notes[0].message).toContain("validated from disk");
	});

	// #2100 review F2: a timed-out or aborted render carries outputTruncated too,
	// and those endings keep their own classification rather than becoming a
	// truncation verdict.
	it.each([
		["timed out", capThenTimedOutSpawnResult, { status: "skipped" }],
		[
			"aborted",
			capThenAbortedSpawnResult,
			{ status: "failed", failureKind: "aborted" },
		],
	])(
		"keeps reporting a %s render as such when it also hit the cap",
		async (_label, shape, expected) => {
			const chart = installChart("valid-chart");
			optIn({ helm: { renderValidation: { enabled: true } } });
			stubSpawns({ render: shape({ stdout: "wrote a.yaml\n" }) });

			const result = await helmRenderRunner.run(
				makeRunnerCtx(
					path.join(chart, "templates", "deployment.yaml"),
					workspace,
					{ kind: "yaml", projectRoot: workspace },
				),
			);

			expect(result).toMatchObject(expected);
			expect(result.diagnostics).toEqual([]);
		},
	);

	it("keeps a truncated render's own failure report when helm did exit nonzero", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: {
				status: 1,
				stdout: "",
				stderr:
					"Error: template: valid-chart/templates/deployment.yaml:3:1: bad\n",
				outputTruncated: true,
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.semantic).toBe("blocking");
		expect(
			result.diagnostics.map((item: { rule?: string }) => item.rule),
		).toEqual(["render-failed", "render-truncated"]);
	});

	it("caps helm template output so the truncation guard can fire at all", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({ render: { status: 0, stdout: "", stderr: "" } });

		await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"helm",
			expect.arrayContaining(["template"]),
			expect.objectContaining({ maxOutputBytes: 8 * 1024 * 1024 }),
		);
	});

	it("says the manifests are unscanned when the output cap killed trivy", async () => {
		const chart = installChart("valid-chart");
		optIn({
			helm: { renderValidation: { enabled: true } },
			trivy: { enabled: true },
		});
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
			scan: capKilledSpawnResult({ stdout: '{"Results":[' }),
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].rule).toBe("iac-report-unreadable");
		expect(result.diagnostics[0].message).toContain("truncated");
		// Pinned alongside the guard: drop the cap and the guard goes dormant.
		expect(safeSpawnAsync).toHaveBeenCalledWith(
			expect.any(String),
			expect.arrayContaining(["config"]),
			expect.objectContaining({
				resourceLabel: "helm-render-trivy",
				maxOutputBytes: 8 * 1024 * 1024,
			}),
		);
	});

	it("says so when the rendered tree is larger than the validation cap", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: (outputDir) => {
				for (let index = 0; index < 405; index += 1) {
					writeRendered(
						outputDir,
						path.join("pi-lens-render-valid", "templates", `m${index}.yaml`),
						RENDERED_DEPLOYMENT,
					);
				}
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		// A partly-validated chart must not report as fully clean.
		expect(result.semantic).toBe("warning");
		const truncated = result.diagnostics.filter(
			(item: { rule?: string }) => item.rule === "render-truncated",
		);
		expect(truncated).toHaveLength(1);
		expect(truncated[0].message).toContain("UNCHECKED");
	});

	it("blames itself, not the chart, when helm rejects its own flags", async () => {
		// helm v2 has no `template --output-dir`, and a wrapper shim can reject it
		// too. Exit status alone would report that as a broken chart — the #1487
		// lesson upside down.
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: {
				status: 1,
				stdout: "",
				stderr: "Error: unknown flag: --output-dir\n",
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result).toMatchObject({
			status: "failed",
			failureKind: "invocation_rejected",
			diagnostics: [],
		});
		expect(result.failureMessage).toContain("not a chart defect");
	});

	it("says the chart is unvalidated when a successful render produces nothing", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		// Exit 0, empty scratch dir — every template disabled by values, or a walk
		// that found nothing. Unknown, not clean.
		stubSpawns({ render: { status: 0, stdout: "", stderr: "" } });

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		expect(result.semantic).not.toBe("none");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].rule).toBe("render-empty");
		expect(result.diagnostics[0].message).toContain("UNVALIDATED");
	});

	it("says so when a rendered manifest cannot be read back", async (ctx) => {
		// The walk requires `isFile()`, so the read failure has to be a real
		// permission denial. `chmod` is a no-op on Windows, so probe first and skip
		// honestly rather than asserting something this host cannot produce.
		const probe = path.join(workspace, "chmod-probe.yaml");
		fs.writeFileSync(probe, "x\n");
		fs.chmodSync(probe, 0o000);
		let chmodBites = false;
		try {
			fs.readFileSync(probe, "utf-8");
		} catch {
			chmodBites = true;
		}
		fs.chmodSync(probe, 0o600);
		if (!chmodBites) {
			ctx.skip();
			return;
		}

		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "readable.yaml"),
					RENDERED_DEPLOYMENT,
				);
				const denied = path.join(
					outputDir,
					"pi-lens-render-valid",
					"templates",
					"denied.yaml",
				);
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "denied.yaml"),
					RENDERED_DEPLOYMENT,
				);
				fs.chmodSync(denied, 0o000);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);

		const gaps = result.diagnostics.filter(
			(item: { rule?: string }) => item.rule === "rendered-file-unreadable",
		);
		expect(gaps).toHaveLength(1);
		expect(gaps[0].message).toContain("UNCHECKED");
	});

	it("reports every Error line from a multi-fault render", async () => {
		const chart = installChart("broken-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: {
				status: 1,
				stdout: "",
				stderr: [
					"Error: template: pi-lens-render-broken/templates/deployment.yaml:12:20: nil pointer",
					"Error: An error occurred while checking for chart dependencies: missing in charts/ directory: redis",
				].join("\n"),
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(path.join(chart, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);

		expect(result.diagnostics).toHaveLength(2);
		expect(result.diagnostics.map((item: { id: string }) => item.id)).toEqual([
			"helm-render-error-1",
			"helm-render-error-2",
		]);
		expect(result.diagnostics[0].filePath).toBe(
			path.join(chart, "templates", "deployment.yaml"),
		);
		expect(result.diagnostics[1].filePath).toBe(path.join(chart, "Chart.yaml"));
	});

	it("runs for a .tpl helper under the helm-template file kind", async () => {
		const chart = installChart("valid-chart");
		fs.writeFileSync(
			path.join(chart, "templates", "_helpers.tpl"),
			'{{- define "x.name" -}}x{{- end -}}\n',
		);
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({
			render: (outputDir) => {
				writeRendered(
					outputDir,
					path.join("pi-lens-render-valid", "templates", "deployment.yaml"),
					RENDERED_DEPLOYMENT,
				);
				return { status: 0, stdout: "", stderr: "" };
			},
		});

		const result = await helmRenderRunner.run(
			makeRunnerCtx(path.join(chart, "templates", "_helpers.tpl"), workspace, {
				kind: "helm-template",
				projectRoot: workspace,
			}),
		);

		expect(result.status).toBe("succeeded");
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("deduplicates concurrent edits by chart root", async () => {
		const chart = installChart("valid-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		let settle!: (value: SpawnStub) => void;
		safeSpawnAsync.mockReturnValue(
			new Promise<SpawnStub>((resolve) => {
				settle = resolve;
			}),
		);

		const first = helmRenderRunner.run(
			makeRunnerCtx(
				path.join(chart, "templates", "deployment.yaml"),
				workspace,
				{ kind: "yaml", projectRoot: workspace },
			),
		);
		const second = helmRenderRunner.run(
			makeRunnerCtx(path.join(chart, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);
		await vi.waitFor(() => expect(safeSpawnAsync).toHaveBeenCalledTimes(1));
		settle({ status: 0, stdout: "", stderr: "" });
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		// Both callers must be answered — a dedupe that drops the second caller's
		// result would also pass a call-count-only assertion.
		expect(secondResult).toBe(firstResult);
	});

	it("does not collapse two different charts into one render", async () => {
		// The counterpart to the test above: a key that is too BROAD (e.g. keyed on
		// the workspace) is invisible to a call-count assertion on one chart.
		const first = installChart("valid-chart");
		const second = installChart("broken-chart");
		optIn({ helm: { renderValidation: { enabled: true } } });
		stubSpawns({ render: { status: 0, stdout: "", stderr: "" } });

		await helmRenderRunner.run(
			makeRunnerCtx(path.join(first, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);
		await helmRenderRunner.run(
			makeRunnerCtx(path.join(second, "values.yaml"), workspace, {
				kind: "yaml",
				projectRoot: workspace,
			}),
		);

		expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
		const chartArgs = safeSpawnAsync.mock.calls.map(
			(call: unknown[]) => (call[1] as string[])[2],
		);
		expect(chartArgs).toEqual([path.resolve(first), path.resolve(second)]);
	});
});

describe("helm-render source mapping", () => {
	it("drops helm's chart-name prefix and confines the result to the chart", () => {
		const chart = installChart("valid-chart");
		expect(
			resolveTemplateSource(
				"pi-lens-render-valid/templates/deployment.yaml",
				chart,
			),
		).toBe(path.join(chart, "templates", "deployment.yaml"));

		// A traversal aimed at a file that REALLY EXISTS outside the chart. The
		// earlier `/etc/passwd` literal passed on Windows for the wrong reason —
		// the existence check alone rejected it — so it never exercised the
		// containment test on this host (defect shapes 2 and 7).
		const outsideFile = path.join(workspace, "outside-secret.yaml");
		fs.writeFileSync(outsideFile, "secret: true\n");
		expect(fs.existsSync(outsideFile)).toBe(true);
		expect(
			resolveTemplateSource("chart/../outside-secret.yaml", chart),
		).toBeNull();

		expect(
			resolveTemplateSource("chart/templates/absent.yaml", chart),
		).toBeNull();
	});

	it("refuses a template that is a symlink out of the chart", (ctx) => {
		const chart = installChart("valid-chart");
		const outsideFile = path.join(workspace, "outside-secret.yaml");
		fs.writeFileSync(outsideFile, "secret: true\n");
		const link = path.join(chart, "templates", "linked.yaml");
		try {
			fs.symlinkSync(outsideFile, link);
		} catch {
			// Unprivileged Windows returns EPERM. Report the gap as a SKIP rather
			// than returning early: a silent pass would claim coverage this host
			// never had, and Linux CI is where this case is actually exercised.
			ctx.skip();
			return;
		}
		// The textual containment fold does not canonicalize on Linux/macOS, so
		// the lstat check is what stops a chart-authored `# Source:` from pointing
		// a diagnostic at a file outside the chart tree.
		expect(
			resolveTemplateSource(
				"pi-lens-render-valid/templates/linked.yaml",
				chart,
			),
		).toBeNull();
	});

	it("refuses a template behind a symlinked DIRECTORY", (ctx) => {
		// lstat only inspects the leaf. A linked `templates/` resolves to a real
		// regular file whose textual path is perfectly chart-relative, so the
		// realpath containment check is what closes this one.
		const chart = installChart("valid-chart");
		const outsideDir = path.join(workspace, "outside-templates");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "sneaky.yaml"), "kind: Pod\n");
		const linkedDir = path.join(chart, "linked-templates");
		try {
			fs.symlinkSync(outsideDir, linkedDir, "dir");
		} catch {
			ctx.skip();
			return;
		}
		expect(fs.existsSync(path.join(linkedDir, "sneaky.yaml"))).toBe(true);
		expect(
			resolveTemplateSource(
				"pi-lens-render-valid/linked-templates/sneaky.yaml",
				chart,
			),
		).toBeNull();
	});

	it("still resolves a chart that lives under a symlinked parent", (ctx) => {
		// The counterpart guard: canonicalizing only the candidate would reject
		// every chart beneath a symlinked parent (a linked /tmp, /home, or git
		// worktree), which is the common case on macOS.
		const realParent = path.join(workspace, "real-parent");
		fs.mkdirSync(realParent, { recursive: true });
		fs.cpSync(path.join(fixtures, "valid-chart"), path.join(realParent, "c"), {
			recursive: true,
		});
		const linkedParent = path.join(workspace, "linked-parent");
		try {
			fs.symlinkSync(realParent, linkedParent, "dir");
		} catch {
			ctx.skip();
			return;
		}
		const chartViaLink = path.join(linkedParent, "c");
		expect(
			resolveTemplateSource(
				"pi-lens-render-valid/templates/deployment.yaml",
				chartViaLink,
			),
		).toBe(path.join(chartViaLink, "templates", "deployment.yaml"));
	});

	it("prefers the # Source annotation, then the output-dir layout, then Chart.yaml", () => {
		const chart = installChart("valid-chart");
		const outputDir = path.join(workspace, "out");
		const rendered = path.join(
			outputDir,
			"pi-lens-render-valid",
			"templates",
			"deployment.yaml",
		);

		expect(
			mapRenderedToSource({
				renderedContent:
					"# Source: pi-lens-render-valid/templates/deployment.yaml\nkind: Deployment\n",
				renderedPath: path.join(outputDir, "elsewhere.yaml"),
				outputDir,
				chartRoot: chart,
			}),
		).toEqual({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			mapped: true,
		});

		expect(
			mapRenderedToSource({
				renderedContent: "kind: Deployment\n",
				renderedPath: rendered,
				outputDir,
				chartRoot: chart,
			}),
		).toEqual({
			filePath: path.join(chart, "templates", "deployment.yaml"),
			mapped: true,
		});

		expect(
			mapRenderedToSource({
				renderedContent: "# Source: other/templates/gone.yaml\n",
				renderedPath: path.join(outputDir, "other", "templates", "gone.yaml"),
				outputDir,
				chartRoot: chart,
			}),
		).toEqual({ filePath: path.join(chart, "Chart.yaml"), mapped: false });
	});
});

describe("mapRenderedToSource layout reading (#2556)", () => {
	// #2556 RECURRENCE GUARDED: the output-dir layout fallback read
	// `path.relative(outputDir, rendered).startsWith("..")`, so a rendered
	// directory named `..pkg` (inside outputDir) was read as a parent step and
	// the finding fell back to Chart.yaml.
	it("maps a rendered file under a ..-named output subdirectory by layout", () => {
		const chart = installChart("valid-chart");
		const outputDir = path.join(workspace, "out");
		const decide = (rendered: string) =>
			mapRenderedToSource({
				renderedContent: "kind: Deployment\n",
				renderedPath: rendered,
				outputDir,
				chartRoot: chart,
			});

		// A rendered file OUTSIDE outputDir has no layout. Plant a chart file where
		// its absolute spelling would resolve if that spelling were read as a
		// layout (`resolveTemplateSource` drops the first segment), so a guard
		// that lets the absolute spelling through maps it onto the decoy.
		const outside = path.join(workspace, "zz", "templates", "deployment.yaml");
		const decoy = path.join(
			chart,
			...outside
				.split(/[\\/]+/)
				.filter(Boolean)
				.slice(1),
		);
		fs.mkdirSync(path.dirname(decoy), { recursive: true });
		fs.writeFileSync(decoy, "kind: Decoy\n");

		expect({
			dotDotNamed: decide(
				path.join(outputDir, "..pkg", "templates", "deployment.yaml"),
			),
			outsideOutputDir: decide(outside),
		}).toEqual({
			dotDotNamed: {
				filePath: path.join(chart, "templates", "deployment.yaml"),
				mapped: true,
			},
			outsideOutputDir: {
				filePath: path.join(chart, "Chart.yaml"),
				mapped: false,
			},
		});
	});
});

describe("parseHelmTemplateFailure", () => {
	it("keeps one diagnostic per Error line and always produces at least one", () => {
		const chartRoot = path.resolve("chart-root");
		expect(parseHelmTemplateFailure("", chartRoot)).toHaveLength(1);
		expect(parseHelmTemplateFailure("", chartRoot)[0].filePath).toBe(
			path.join(chartRoot, "Chart.yaml"),
		);

		const dependency = parseHelmTemplateFailure(
			"Error: An error occurred while checking for chart dependencies: found in Chart.yaml, but missing in charts/ directory: redis",
			chartRoot,
		);
		expect(dependency).toHaveLength(1);
		expect(dependency[0].message).toContain("missing in charts/");
		expect(dependency[0].severity).toBe("error");
	});

	it("ignores non-error chatter around the failure", () => {
		const diagnostics = parseHelmTemplateFailure(
			[
				"walk.go:74: found symbolic link in path",
				"Error: parse error at (chart/templates/x.yaml:5): unclosed action",
			].join("\n"),
			path.resolve("chart-root"),
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("unclosed action");
	});
});

describe("discardScratchDir", () => {
	it("swallows a cleanup failure so it cannot discard the run's result", () => {
		// The cleanup runs in a `finally`. A throw there would replace the
		// RunnerResult the caller was about to return — so a chart with a real
		// blocking finding would surface as a runner exception with zero
		// diagnostics, purely because temp-dir removal lost a race with an AV
		// scanner (defect shape 10, from the cleanup side).
		const failing = (): void => {
			const error = new Error("EBUSY: resource busy or locked") as Error & {
				code: string;
			};
			error.code = "EBUSY";
			throw error;
		};
		expect(() =>
			discardScratchDir(path.join(workspace, "scratch"), "x.yaml", failing),
		).not.toThrow();
	});

	it("removes the directory on the normal path", () => {
		const scratch = path.join(workspace, "scratch-real");
		fs.mkdirSync(path.join(scratch, "nested"), { recursive: true });
		fs.writeFileSync(path.join(scratch, "nested", "m.yaml"), "kind: Pod\n");
		discardScratchDir(scratch, "x.yaml");
		expect(fs.existsSync(scratch)).toBe(false);
	});
});

describe("extractTemplateRef", () => {
	it("finds the first slashed template reference and its line", () => {
		expect(
			extractTemplateRef(
				'Error: template: c/templates/deploy.yaml:12:20: executing "c/templates/deploy.yaml" at <.Values.a.b>: nil pointer',
			),
		).toEqual({ ref: "c/templates/deploy.yaml", line: 12 });
		expect(
			extractTemplateRef("Error: parse error at (c/templates/x.tpl:5): boom"),
		).toEqual({ ref: "c/templates/x.tpl", line: 5 });
		// No line number, and a bare filename with no directory is not a reference.
		expect(extractTemplateRef("Error: c/templates/x.yaml is bad")).toEqual({
			ref: "c/templates/x.yaml",
			line: undefined,
		});
		expect(
			extractTemplateRef("Error: values.yaml is missing a key"),
		).toBeNull();
	});

	it("stays linear on a slash-dense line with no template reference", () => {
		// The regex this replaced was `([^\s(),:]+\/[^\s(),:]+\.(?:ya?ml|tpl))…`:
		// two unbounded negated classes either side of a `/`, so the catastrophic
		// input is SLASH-DENSE with no matching extension. Measured on the old
		// pattern: 7648ms, against 0.18ms for a line with no slash at all — the
		// first version of this test used the latter shape and therefore passed on
		// the pre-fix regex, proving nothing (defect shape 7).
		//
		// helm's own output is the input here, and #2100's 8 MiB render cap bounds
		// the TOTAL retained bytes, not any single line, so the line length is
		// still not ours to bound.
		const slashDense = `Error: ${"a/".repeat(1600)}X`;
		const started = Date.now();
		expect(extractTemplateRef(slashDense)).toBeNull();
		expect(Date.now() - started).toBeLessThan(500);
	});
});

describe("checkManifestShape", () => {
	it("flags only documents that carry content but no object identity", () => {
		const diagnostics = checkManifestShape({
			renderedContent: [
				"---",
				"# Source: c/templates/a.yaml",
				"apiVersion: v1",
				"kind: Service",
				"---",
				"# a comment-only document is not a defect",
				"---",
				"metadata:",
				"  name: headless",
				"",
			].join("\n"),
			renderedRelativePath: "c/templates/a.yaml",
			sourcePath: "/repo/chart/templates/a.yaml",
			sourceMapped: true,
		});
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("missing apiVersion and kind");
		expect(diagnostics[0].filePath).toBe("/repo/chart/templates/a.yaml");
	});
});

describe("parseRenderedTrivyOutput", () => {
	it("reports an unreadable report as not understood, never as empty-clean", () => {
		const locate = (target: string) => ({
			filePath: `/repo/chart/templates/${path.basename(target || "unknown")}`,
			detail: target,
		});
		// "Could not read the report" and "no misconfigurations" are DIFFERENT
		// answers; collapsing them is how a failed scan reads as clean.
		for (const raw of ["not json", "", '{"Results":"nope"}']) {
			const report = parseRenderedTrivyOutput(raw, locate);
			expect(report.understood, raw).toBe(false);
			expect(report.diagnostics).toEqual([]);
			expect(report.problem).toBeTruthy();
		}
		const empty = parseRenderedTrivyOutput('{"Results":[]}', locate);
		expect(empty.understood).toBe(true);
		expect(empty.diagnostics).toEqual([]);
	});

	it("routes each result through its own target", () => {
		const locate = (target: string) => ({
			filePath: `/repo/chart/templates/${path.basename(target || "unknown")}`,
			detail: target,
		});
		const report = parseRenderedTrivyOutput(
			JSON.stringify({
				Results: [
					{
						Target: "c/templates/a.yaml",
						Misconfigurations: [
							{ ID: "KSV001", Severity: "CRITICAL", CauseMetadata: {} },
							{ Severity: "HIGH" },
						],
					},
					{ Target: "c/templates/b.yaml", Misconfigurations: [] },
				],
			}),
			locate,
		);
		expect(report.understood).toBe(true);
		expect(report.diagnostics).toHaveLength(1);
		expect(report.diagnostics[0]).toMatchObject({
			filePath: "/repo/chart/templates/a.yaml",
			rule: "KSV001",
			severity: "error",
			semantic: "blocking",
		});
	});
});
