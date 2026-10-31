/**
 * Inline `pi-lens-ignore` comments and stored dispositions read the file each
 * finding NAMES (#5044).
 *
 * The dispatch output filter matched every finding of a run against the EDITED
 * file's content and path. A runner that reports on several files (helm-lint
 * attributes chart-level findings to `chart/Chart.yaml`, helm-lint.ts:55) let a
 * `# pi-lens-ignore: error` comment in a template hide the blocking Chart.yaml
 * error, and anchored a Chart.yaml mark under the template's path. This is the
 * shape #5011 round 8 (F24) fixed for rule policy.
 *
 * Each case writes a real chart to disk and drives the real
 * `createDispatchContext` + `dispatchForFile`; only the runner is a stand-in
 * (no `helm` binary on the host), fed by the real `parseHelmLintOutput`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
	markDisposition,
} from "../../../clients/diagnostic-dispositions.js";
import { applyInlineBlockerPolicy } from "../../../clients/inline-blocker-dispositions.js";
import { judgeDeferredRunnerFindings } from "../../../clients/deferred-runner-blockers.js";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { applyPushedFindingPolicy } from "../../../clients/dispatch/finding-policy.js";
import { fileContentProvider } from "../../../clients/dispatch/facts/file-content.js";
import type { PendingRunnerFindings } from "../../../clients/dispatch/pending-runner-findings.js";
import { parseHelmLintOutput } from "../../../clients/dispatch/runners/helm-lint.js";
import type {
	Diagnostic,
	RunnerGroup,
} from "../../../clients/dispatch/types.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { useConfigPath } from "../../support/global-config.js";
import { removeTempDirSync } from "../test-utils.js";

const setConfigPath = useConfigPath();

const CHART_ERROR = "chart metadata is missing these dependencies: sub";
const TEMPLATE_ERROR = "templates/deploy.yaml: unable to parse YAML";

let tmpDir: string;
let repo: string;
let chart: string;
let template: string;
let chartYaml: string;
let previousDataDir: string | undefined;

function writeChart(opts: { template: string; chartYaml?: string }): void {
	fs.mkdirSync(path.join(chart, "templates"), { recursive: true });
	fs.writeFileSync(chartYaml, opts.chartYaml ?? "name: chart\n");
	fs.writeFileSync(template, opts.template);
}

/** helm-lint's two errors for this chart: one on the template, one on Chart.yaml. */
function helmErrors(
	messages: string[] = [TEMPLATE_ERROR, CHART_ERROR],
	level: "ERROR" | "WARNING" = "ERROR",
): Diagnostic[] {
	return parseHelmLintOutput(
		messages.map((m) => `[${level}] ${m}`).join("\n"),
		chart,
	);
}

async function dispatchTemplate(
	diagnostics: () => Diagnostic[],
	edited: string = template,
): Promise<string[]> {
	const registry = new RunnerRegistry();
	registry.register({
		id: "helm-lint",
		appliesTo: ["yaml", "helm-template"],
		priority: 10,
		async run() {
			return {
				status: "succeeded",
				diagnostics: diagnostics(),
				semantic: "blocking",
			};
		},
	});
	const facts = new FactStore();
	const ctx = createDispatchContext(
		edited,
		path.dirname(edited),
		{ getFlag: () => false },
		facts,
		false,
		undefined,
		repo,
	);
	// The edited file's content reaches the filter through the fact the
	// production pipeline's `fact.file.content` provider records.
	await fileContentProvider.run(ctx, facts);
	const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["helm-lint"] }];
	return (await dispatchForFile(ctx, groups, registry)).diagnostics
		.map((d) => path.relative(repo, d.filePath))
		.sort();
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-supp-owner-"));
	repo = path.join(tmpDir, "repo");
	chart = path.join(repo, "chart");
	template = path.join(chart, "templates", "deploy.yaml");
	chartYaml = path.join(chart, "Chart.yaml");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	setConfigPath(path.join(tmpDir, "global", "config.json"));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
	resetProjectLensConfigCache();
	_resetDeferredForTests();
	_resetStateCacheForTests();
});

afterEach(() => {
	resetProjectLensConfigCache();
	_resetDeferredForTests();
	_resetStateCacheForTests();
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	removeTempDirSync(tmpDir);
});

const BOTH = [
	path.join("chart", "Chart.yaml"),
	path.join("chart", "templates", "deploy.yaml"),
];

describe("inline pi-lens-ignore — read from the file the finding names", () => {
	it("control: a template header that suppresses nothing delivers both errors", async () => {
		writeChart({ template: "kind: ConfigMap\n" });

		expect(await dispatchTemplate(helmErrors)).toEqual(BOTH);
	});

	// Recurrence: #5044, the edited template's comment hid Chart.yaml's blocking
	// error because every finding was matched against the template's content.
	it("keeps a Chart.yaml error that a comment in the edited template names", async () => {
		writeChart({ template: "# pi-lens-ignore: error\nkind: ConfigMap\n" });

		const kept = await dispatchTemplate(helmErrors);

		expect(kept).toEqual([path.join("chart", "Chart.yaml")]);
	});

	// Direction 2 of the same shape: the owner's own comment was never read.
	it("hides a Chart.yaml error that Chart.yaml's own comment names", async () => {
		writeChart({
			template: "kind: ConfigMap\n",
			chartYaml: "# pi-lens-ignore: error\nname: chart\n",
		});

		const kept = await dispatchTemplate(helmErrors);

		expect(kept).toEqual([path.join("chart", "templates", "deploy.yaml")]);
	});

	it("control: each file's error is hidden by that file's own comment", async () => {
		writeChart({
			template: "# pi-lens-ignore: error\nkind: ConfigMap\n",
			chartYaml: "# pi-lens-ignore: error\nname: chart\n",
		});

		expect(await dispatchTemplate(helmErrors)).toEqual([]);
	});

	// Fail closed: the comment that would hide the finding lives in a file the
	// filter cannot trust, so the finding stays.
	it("keeps a finding whose file was deleted before the filter ran", async () => {
		writeChart({ template: "# pi-lens-ignore: error\nkind: ConfigMap\n" });
		fs.rmSync(chartYaml);

		expect(await dispatchTemplate(helmErrors)).toEqual([
			path.join("chart", "Chart.yaml"),
		]);
	});

	// Recurrence: a fix that routed every finding through the owner read would
	// stop trusting the edited file itself when it lies outside the project root.
	it("still hides the edited file's own finding under its own comment outside the root", async () => {
		writeChart({ template: "kind: ConfigMap\n" });
		const edited = path.join(tmpDir, "outside", "edited.yaml");
		fs.mkdirSync(path.dirname(edited), { recursive: true });
		fs.writeFileSync(edited, "# pi-lens-ignore: error\nkey: v\n");

		const kept = await dispatchTemplate(
			() => [{ ...helmErrors([CHART_ERROR])[0]!, filePath: edited }],
			edited,
		);

		expect(kept).toEqual([]);
	});

	it("keeps a finding on a file outside the workspace root", async () => {
		writeChart({ template: "# pi-lens-ignore: error\nkind: ConfigMap\n" });
		const outside = path.join(tmpDir, "outside", "values.yaml");
		fs.mkdirSync(path.dirname(outside), { recursive: true });
		fs.writeFileSync(outside, "# pi-lens-ignore: error\nkey: v\n");

		const kept = await dispatchTemplate(() => [
			{ ...helmErrors([CHART_ERROR])[0]!, filePath: outside },
		]);

		expect(kept).toEqual([path.relative(repo, outside)]);
	});
});

describe("dispositions — anchored on the file the finding names", () => {
	function mark(
		filePath: string,
		disposition: "suppress" | "false-positive",
		d: Diagnostic,
	): void {
		markDisposition(
			repo,
			{
				cwd: repo,
				filePath,
				tool: d.tool,
				rule: d.rule,
				message: d.message,
				line: d.line,
				content: fs.readFileSync(filePath, "utf-8"),
			},
			disposition,
			"probe",
		);
	}

	/** Two findings with one tool, rule and message, on two files. A warning
	 * unless `level` says otherwise: a weak suppress mark never drops a blocking
	 * finding (diagnostic-dispositions.ts F1), only a false-positive mark does. */
	function sameMessage(level: "ERROR" | "WARNING" = "WARNING"): Diagnostic[] {
		const [onChart] = helmErrors([CHART_ERROR], level);
		return [
			{ ...onChart!, id: "a", filePath: template, line: 1 },
			{ ...onChart!, id: "b", filePath: chartYaml, line: 1 },
		];
	}

	// Recurrence: #5044, a mark made on the template finding was derived under
	// ctx.filePath for EVERY finding, so it also hid the Chart.yaml finding.
	it("does not let a mark on the template's finding hide the same finding on Chart.yaml", async () => {
		writeChart({ template: "kind: ConfigMap\n" });
		const [onTemplate] = sameMessage();
		mark(template, "suppress", onTemplate!);

		expect(await dispatchTemplate(sameMessage)).toEqual([
			path.join("chart", "Chart.yaml"),
		]);
	});

	// Direction 2: a mark on the Chart.yaml finding was anchored under the
	// template's path, so it never matched and the finding stayed visible.
	it("applies a mark made on Chart.yaml's finding while the edit is the template", async () => {
		writeChart({ template: "kind: ConfigMap\n" });
		const [, onChart] = sameMessage();
		mark(chartYaml, "suppress", onChart!);

		expect(await dispatchTemplate(sameMessage)).toEqual([
			path.join("chart", "templates", "deploy.yaml"),
		]);
	});

	it("binds a false-positive mark to Chart.yaml's own line, not the template's", async () => {
		writeChart({ template: "kind: ConfigMap\n" });
		const [, onChart] = sameMessage("ERROR");
		mark(chartYaml, "false-positive", onChart!);

		expect(await dispatchTemplate(() => sameMessage("ERROR"))).toEqual([
			path.join("chart", "templates", "deploy.yaml"),
		]);
	});

	// Recurrence: #5044 for the strict anchor: both files hold the same line, so
	// a false-positive mark on the template's blocking error, anchored under
	// ctx.filePath for every finding, also hid Chart.yaml's.
	it("does not let a false-positive mark on the template's blocking error hide Chart.yaml's", async () => {
		writeChart({
			template: "kind: ConfigMap\n",
			chartYaml: "kind: ConfigMap\n",
		});
		const [onTemplate] = sameMessage("ERROR");
		mark(template, "false-positive", onTemplate!);

		expect(await dispatchTemplate(() => sameMessage("ERROR"))).toEqual([
			path.join("chart", "Chart.yaml"),
		]);
	});

	// Fail closed: a weak mark needs no content, but the owner file cannot be
	// read, so nothing about it is trusted and the finding stays.
	it("keeps a marked finding whose file was deleted before the filter ran", async () => {
		writeChart({ template: "kind: ConfigMap\n" });
		const [, onChart] = sameMessage();
		mark(chartYaml, "suppress", onChart!);
		fs.rmSync(chartYaml);

		expect(await dispatchTemplate(sameMessage)).toEqual(BOTH);
	});
});

/**
 * The same shape one door over (#5044 class sweep): a collect-later runner's
 * settled answer (`judgeDeferredRunnerFindings`, read by the turn-end
 * late-runner lane and the commit gate) matched every finding against the
 * dispatched file's bytes. helm-lint is the live population: its chart-level
 * error names `Chart.yaml` while the edit is a template.
 */
describe("pushed findings — a deferred runner's answer reads the file each finding names", () => {
	function pendingAnswer(diagnostics: Diagnostic[]): PendingRunnerFindings {
		return {
			filePath: template,
			cwd: repo,
			projectRoot: repo,
			runnerId: "helm-lint",
			markedAtMs: Date.now(),
			result: { status: "succeeded", diagnostics, semantic: "blocking" },
		};
	}

	function keptFiles(diagnostics: Diagnostic[]): string[] {
		return judgeDeferredRunnerFindings(pendingAnswer(diagnostics), repo, {
			quiet: true,
		})
			.kept.map((d) => path.relative(repo, d.filePath))
			.sort();
	}

	it("control: a template header that suppresses nothing delivers the Chart.yaml error", () => {
		writeChart({ template: "kind: ConfigMap\n" });

		expect(keptFiles(helmErrors([CHART_ERROR]))).toEqual([
			path.join("chart", "Chart.yaml"),
		]);
	});

	// Recurrence: #5044 in the deferred drain, the template's comment hid the
	// Chart.yaml error the slow runner reported.
	it("keeps a Chart.yaml error that a comment in the dispatched template names", () => {
		writeChart({ template: "# pi-lens-ignore: error\nkind: ConfigMap\n" });

		expect(keptFiles(helmErrors([CHART_ERROR]))).toEqual([
			path.join("chart", "Chart.yaml"),
		]);
	});

	it("hides a Chart.yaml error that Chart.yaml's own comment names", () => {
		writeChart({
			template: "kind: ConfigMap\n",
			chartYaml: "# pi-lens-ignore: error\nname: chart\n",
		});

		expect(keptFiles(helmErrors([CHART_ERROR]))).toEqual([]);
	});

	// Recurrence: lens_diagnostics' unreadable-file branch documents that the
	// rule policy reads no content and must still apply; an unreadable-owner
	// branch that skipped it would let `rules.<id>.disable` stop working there.
	it("still applies the rule policy to a finding on a file it cannot read", () => {
		writeChart({ template: "kind: ConfigMap\n" });
		fs.rmSync(chartYaml);
		const onChart = helmErrors([CHART_ERROR]);
		const push = () =>
			applyPushedFindingPolicy(onChart, {
				cwd: repo,
				filePath: template,
				content: "kind: ConfigMap\n",
			});

		expect(push().kept).toHaveLength(1);

		fs.writeFileSync(
			path.join(repo, ".pi-lens.json"),
			JSON.stringify({ rules: { helm: { disable: ["error"] } } }),
		);
		resetProjectLensConfigCache();

		expect(push().kept).toEqual([]);
	});

	// Recurrence: an ownership test that compared spellings as text would stop
	// trusting the edited file itself, outside the root, when a runner spells it
	// through a link.
	// lane: Unit tests (ubuntu shards); the link spelling needs a POSIX symlink.
	it.skipIf(process.platform === "win32")(
		"treats a link spelling of the edited file as the edited file",
		() => {
			writeChart({ template: "kind: ConfigMap\n" });
			const edited = path.join(tmpDir, "outside", "edited.yaml");
			fs.mkdirSync(path.dirname(edited), { recursive: true });
			fs.writeFileSync(edited, "# pi-lens-ignore: error\nkey: v\n");
			const link = path.join(tmpDir, "outside-link");
			fs.symlinkSync(path.dirname(edited), link, "dir");
			const spelled = path.join(link, "edited.yaml");

			const { kept } = applyPushedFindingPolicy(
				[{ ...helmErrors([CHART_ERROR])[0]!, filePath: spelled }],
				{
					cwd: repo,
					filePath: edited,
					content: fs.readFileSync(edited, "utf8"),
				},
			);

			expect(kept).toEqual([]);
		},
	);
});

/**
 * #5044 r2 F1: the turn-end inline-blocker lane kept its own per-file loop, so
 * it hid, from an outside-root file, a finding the dispatcher had kept. It now
 * calls the same `applyFindingPolicyByOwner`. Everything below is the real
 * `applyInlineBlockerPolicy`, over real files.
 */
describe("inline-blocker lane — one per-owner seam with the dispatcher", () => {
	function outcome(
		diagnostics: Diagnostic[],
		recordPath: string = template,
	): { kept: number; suppressed: number } {
		const { kept, suppressed } = applyInlineBlockerPolicy(
			{ filePath: recordPath, summary: "helm", diagnostics },
			repo,
		);
		return { kept, suppressed };
	}

	// Recurrence: r2 F1, the reviewer's probe: dispatch kept an outside-root
	// finding that this lane then suppressed under the file's own comment.
	it("keeps a finding on a file outside the project root under its own comment", () => {
		writeChart({ template: "kind: ConfigMap\n" });
		const outside = path.join(tmpDir, "outside", "values.yaml");
		fs.mkdirSync(path.dirname(outside), { recursive: true });
		fs.writeFileSync(outside, "# pi-lens-ignore: error\nkey: v\n");

		expect(
			outcome([{ ...helmErrors([CHART_ERROR])[0]!, filePath: outside }]),
		).toEqual({ kept: 1, suppressed: 0 });
	});

	it("control: hides a Chart.yaml error under Chart.yaml's own comment, not the template's", () => {
		writeChart({
			template: "# pi-lens-ignore: error\nkind: ConfigMap\n",
			chartYaml: "name: chart\n",
		});
		expect(outcome(helmErrors([CHART_ERROR]))).toEqual({
			kept: 1,
			suppressed: 0,
		});

		fs.writeFileSync(chartYaml, "# pi-lens-ignore: error\nname: chart\n");
		expect(outcome(helmErrors([CHART_ERROR]))).toEqual({
			kept: 0,
			suppressed: 1,
		});
	});

	// Recurrence: a project-relative path resolved against the host's working
	// directory instead of the project root would read nothing and stay visible.
	it("resolves a project-relative finding path against the project root", () => {
		writeChart({
			template: "kind: ConfigMap\n",
			chartYaml: "# pi-lens-ignore: error\nname: chart\n",
		});
		const relative = path.relative(repo, chartYaml);

		expect(
			outcome([{ ...helmErrors([CHART_ERROR])[0]!, filePath: relative }]),
		).toEqual({ kept: 0, suppressed: 1 });
	});
});

/** #5044 r2 F3: two claims of `applyFindingPolicyByOwner` had no cell. */
describe("applyFindingPolicyByOwner — result order and a finding with no path", () => {
	// Recurrence: a result rebuilt from the per-file groups would list the
	// edited file's findings first and reorder the agent's output.
	it("keeps the input order across files", () => {
		writeChart({ template: "kind: ConfigMap\n" });
		const [onChart, onTemplate, onChartAgain] = helmErrors([
			CHART_ERROR,
			TEMPLATE_ERROR,
			"icon is recommended",
		]);

		const { kept } = applyPushedFindingPolicy(
			[onChart!, onTemplate!, onChartAgain!],
			{ cwd: repo, filePath: template, content: "kind: ConfigMap\n" },
		);

		expect(kept.map((d) => path.relative(repo, d.filePath))).toEqual([
			path.join("chart", "Chart.yaml"),
			path.join("chart", "templates", "deploy.yaml"),
			path.join("chart", "Chart.yaml"),
		]);
	});

	// Recurrence: a baseline record with no path (hand-built, dispatcher-flow)
	// belongs to the edited file, not to an unreadable group of its own.
	it("judges a finding with no path by the edited file's content", () => {
		writeChart({ template: "# pi-lens-ignore: error\nkind: ConfigMap\n" });
		const pathless = {
			...helmErrors([CHART_ERROR])[0]!,
			filePath: undefined as unknown as string,
		};

		const { kept } = applyPushedFindingPolicy([pathless], {
			cwd: repo,
			filePath: template,
			content: fs.readFileSync(template, "utf8"),
		});

		expect(kept).toEqual([]);
	});
});
