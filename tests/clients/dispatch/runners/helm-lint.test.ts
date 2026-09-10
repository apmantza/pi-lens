import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import {
	capFastExitSpawnResult,
	capKilledSpawnResult,
	capThenAbortedSpawnResult,
	capThenTimedOutSpawnResult,
} from "../../../support/spawn-shapes.js";

const { safeSpawnAsync, resolveAvailableOrInstall } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	resolveAvailableOrInstall: vi.fn(),
}));

// `importOriginal`, not a bare stub: the cap-kill test below builds the REAL
// truncation result, and that needs safe-spawn's own `SpawnFailureError`.
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
		createAvailabilityChecker: () => ({ getOutcome: () => "success" }),
		resolveAvailableOrInstall,
	}),
);

const { default: helmLintRunner, parseHelmLintOutput } =
	await import("../../../../clients/dispatch/runners/helm-lint.js");

function context(filePath: string, projectRoot: string): DispatchContext {
	return {
		filePath,
		projectRoot,
		cwd: projectRoot,
		kind: filePath.endsWith(".tpl") ? "helm-template" : "yaml",
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: false,
		facts: {} as DispatchContext["facts"],
		hasTool: async () => true,
		log: () => undefined,
	};
}

function createChart(root: string, relativeFile: string): string {
	fs.mkdirSync(path.join(root, "templates"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "Chart.yaml"),
		"apiVersion: v2\nname: test\nversion: 0.1.0\n",
	);
	const filePath = path.join(root, relativeFile);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "value\n");
	return filePath;
}

describe("helm-lint runner", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-helm-lint-"));
		resolveAvailableOrInstall.mockReset();
		resolveAvailableOrInstall.mockResolvedValue("helm");
		safeSpawnAsync.mockReset();
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	it("parses info, warning, and error lines as successful findings", async () => {
		const filePath = createChart(workspace, "templates/deployment.yaml");
		safeSpawnAsync.mockResolvedValue({
			status: 1,
			stdout: [
				"[INFO] Chart.yaml: icon is recommended",
				"[WARNING] templates/deployment.yaml: deprecated API",
				"[ERROR] templates/deployment.yaml:3: invalid template",
			].join("\n"),
			stderr: "Error: 1 chart(s) linted, 1 chart(s) failed",
		});

		const result = await helmLintRunner.run(context(filePath, workspace));

		expect(result.status).toBe("succeeded");
		expect(result.semantic).toBe("blocking");
		expect(result.failureKind).toBeUndefined();
		expect(result.diagnostics.map((d) => d.severity)).toEqual([
			"info",
			"warning",
			"error",
		]);
		expect(result.diagnostics[2].line).toBe(3);
	});

	it("uses the tpl file kind and lints the nearest nested chart", async () => {
		createChart(workspace, "templates/parent.yaml");
		const subchart = path.join(workspace, "charts", "child");
		const helper = createChart(subchart, "templates/_helpers.tpl");

		await helmLintRunner.run(context(helper, workspace));

		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"helm",
			["lint", path.resolve(subchart)],
			expect.objectContaining({
				cwd: workspace,
				timeout: 30_000,
				deadlineAt: expect.any(Number),
				resourceLabel: "helm-lint",
			}),
		);
	});

	it("passes the resolved cwd through the real dispatcher for a nested chart", async () => {
		const projectRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-helm-dispatch-"),
		);
		try {
			const callerCwd = path.join(projectRoot, "caller");
			const chartRoot = path.join(projectRoot, "project", "charts", "child");
			const filePath = createChart(chartRoot, "templates/deployment.yaml");
			fs.mkdirSync(callerCwd, { recursive: true });
			fs.mkdirSync(path.join(projectRoot, "project", ".git"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(projectRoot, "project", ".git", "HEAD"),
				"ref: refs/heads/main\n",
			);

			const registry = new RunnerRegistry();
			registry.register(helmLintRunner);
			const ctx = createDispatchContext(
				filePath,
				callerCwd,
				{ getFlag: () => false },
				new FactStore(),
				undefined,
				undefined,
				projectRoot,
			);

			await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["helm-lint"] }],
				registry,
			);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"helm",
				["lint", path.resolve(chartRoot)],
				expect.objectContaining({ cwd: path.join(projectRoot, "project") }),
			);
		} finally {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it("deduplicates concurrent edits by canonical chart root", async () => {
		const first = createChart(workspace, "templates/first.yaml");
		const second = createChart(workspace, "templates/second.yaml");
		let settle!: (value: {
			status: number;
			stdout: string;
			stderr: string;
		}) => void;
		safeSpawnAsync.mockReturnValue(
			new Promise((resolve) => {
				settle = resolve;
			}),
		);

		const firstRun = helmLintRunner.run(context(first, workspace));
		const secondRun = helmLintRunner.run(context(second, workspace));
		await vi.waitFor(() => expect(safeSpawnAsync).toHaveBeenCalledTimes(1));
		settle({ status: 0, stdout: "", stderr: "" });
		await Promise.all([firstRun, secondRun]);

		expect(resolveAvailableOrInstall).toHaveBeenCalledTimes(1);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
	});

	it("skips files with no chart and chart roots outside the workspace", async () => {
		const plain = path.join(workspace, "plain.yaml");
		fs.writeFileSync(plain, "value: true\n");
		expect(await helmLintRunner.run(context(plain, workspace))).toMatchObject({
			status: "skipped",
		});

		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-helm-outside-"),
		);
		try {
			const outsideFile = createChart(outside, "values.yaml");
			expect(
				await helmLintRunner.run(context(outsideFile, workspace)),
			).toMatchObject({
				status: "skipped",
			});
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it.each([
		["tool-not-found", "unavailable"],
		["timeout", "timeout"],
		["killed", "aborted"],
	])(
		"classifies typed %s spawn failures without errno text",
		async (kind, failureKind) => {
			const filePath = createChart(workspace, "values.yaml");
			safeSpawnAsync.mockResolvedValue({
				status: null,
				stdout: "",
				stderr: "",
				failure: kind === "timeout" ? "timeout" : "aborted",
				spawnFailure: { kind },
				error: new Error("opaque failure"),
			});

			const result = await helmLintRunner.run(context(filePath, workspace));

			expect(result).toMatchObject({ status: "failed", failureKind });
			expect(result.diagnostics).toEqual([]);
		},
	);

	it("reports nonzero unparseable output as parser failure, never clean", async () => {
		const filePath = createChart(workspace, "Chart.yaml");
		safeSpawnAsync.mockResolvedValue({
			status: 2,
			stdout: "unexpected protocol text",
			stderr: "",
		});

		expect(
			await helmLintRunner.run(context(filePath, workspace)),
		).toMatchObject({
			status: "failed",
			failureKind: "parser_error",
			diagnostics: [],
		});
	});

	it("does not treat a warning-only nonzero exit or truncated output as complete", async () => {
		const filePath = createChart(workspace, "values.yaml");
		safeSpawnAsync.mockResolvedValueOnce({
			status: 1,
			stdout: "[WARNING] values.yaml: suspicious value",
			stderr: "helm crashed after warning",
		});
		expect(
			await helmLintRunner.run(context(filePath, workspace)),
		).toMatchObject({
			status: "failed",
			failureKind: "parser_error",
		});

		safeSpawnAsync.mockResolvedValueOnce(
			capFastExitSpawnResult({
				stdout: "[INFO] Chart.yaml: icon is recommended",
			}),
		);
		expect(
			await helmLintRunner.run(context(filePath, workspace)),
		).toMatchObject({
			status: "failed",
			failureKind: "parser_error",
		});
	});

	// #2100: the cap kill is a SIGTERM, so it also carries `spawnFailure.kind
	// === "killed"` and `failure === "signal"`. Read in the old order those two
	// answered first and the truncation was reported as a server_error — the
	// output we threw away, described as helm misbehaving.
	it("reports a cap-killed lint as truncated, not as a server error", async () => {
		const filePath = createChart(workspace, "values.yaml");
		safeSpawnAsync.mockResolvedValueOnce(
			capKilledSpawnResult({
				stdout: "[INFO] Chart.yaml: icon is recommended",
			}),
		);

		expect(
			await helmLintRunner.run(context(filePath, workspace)),
		).toMatchObject({
			status: "failed",
			failureKind: "parser_error",
			failureMessage: "helm lint output was truncated before parsing completed",
		});
	});

	// #2100 review F2: `outputTruncated` rides along on timeout/abort results
	// too — safe-spawn spreads it into every branch. Those endings own their own
	// classification; only the cap's own kill is a truncation verdict.
	it.each([
		["timed out", capThenTimedOutSpawnResult, "timeout"],
		["aborted", capThenAbortedSpawnResult, "aborted"],
	])(
		"keeps reporting a %s lint as such when it also hit the cap",
		async (_label, shape, failureKind) => {
			const filePath = createChart(workspace, "values.yaml");
			safeSpawnAsync.mockResolvedValueOnce(
				shape({ stdout: "[INFO] Chart.yaml: icon is recommended" }),
			);

			expect(
				await helmLintRunner.run(context(filePath, workspace)),
			).toMatchObject({ status: "failed", failureKind });
		},
	);

	it("caps helm lint output so the truncation guard can fire at all", async () => {
		const filePath = createChart(workspace, "values.yaml");

		await helmLintRunner.run(context(filePath, workspace));

		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"helm",
			["lint", path.dirname(filePath)],
			expect.objectContaining({ maxOutputBytes: 8 * 1024 * 1024 }),
		);
	});
});

describe("parseHelmLintOutput", () => {
	it("confines paths from Helm output to the chart", () => {
		const chartRoot = path.resolve("chart-root");
		const [diagnostic] = parseHelmLintOutput(
			"[ERROR] ../../escaped.yaml:1: invalid",
			chartRoot,
		);
		expect(diagnostic.filePath).toBe(path.join(chartRoot, "Chart.yaml"));
	});
});

// #1342 review: helm indents multi-line detail under its [LEVEL] header —
// continuations must fold into the diagnostic message, not vanish.
describe("parseHelmLintOutput continuations", () => {
	it("appends indented continuation lines to the preceding diagnostic", () => {
		const raw = [
			"[ERROR] templates/deploy.yaml: unable to parse YAML",
			"	error converting YAML to JSON: yaml: line 12:",
			"	  mapping values are not allowed in this context",
			"[WARNING] templates/svc.yaml: icon is recommended",
		].join("\n");
		const diagnostics = parseHelmLintOutput(raw, "/repo/chart");
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics[0].message).toContain("unable to parse YAML");
		expect(diagnostics[0].message).toContain("error converting YAML to JSON");
		expect(diagnostics[0].message).toContain("mapping values are not allowed");
		expect(diagnostics[1].message).toContain("icon is recommended");
		expect(diagnostics[1].message).not.toContain("mapping values");
	});
});
