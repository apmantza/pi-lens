/**
 * helm render — rendered-manifest validation for Helm charts (#1283 Slice B).
 *
 * Slice A (`helm-lint`) checks the chart's SOURCE. This runner checks what the
 * chart actually PRODUCES: it renders the chart with `helm template` and then
 * validates the rendered manifests. Three defect classes only the rendered
 * output can show:
 *
 *   1. **the render itself fails** — a missing `values` key, a nil pointer in a
 *      template expression, a dependency declared in `Chart.yaml` but absent
 *      from `charts/`. `helm lint` passes on plenty of charts that cannot be
 *      installed;
 *   2. **the rendered document is not a Kubernetes object** — a conditional
 *      that produced an empty or headless document, so `apiVersion`/`kind` are
 *      missing. `helm template` does not require them;
 *   3. **the rendered object is insecure** — privileged containers, missing
 *      resource limits, host-path mounts. Trivy's misconfiguration engine reads
 *      those off the manifest, and it has never been able to see them for a
 *      Helm chart because the manifest did not exist on disk.
 *
 * ## Opt-in, because rendering EXECUTES the chart
 *
 * `helm template` evaluates Go templates from the repository, and a chart can
 * carry `lookup`, `getHostByName`, or arbitrary `tpl` expansion. That is a trust
 * boundary, not a lint, so it is **off by default** and enabled per project:
 *
 * ```json
 * { "helm": { "renderValidation": { "enabled": true } } }
 * ```
 *
 * With the switch absent the runner never spawns anything at all.
 *
 * ## Two gates, because the switch ships INSIDE the repository
 *
 * `.pi-lens.json` is a tracked file, so a cloned repository can arrive with the
 * switch already on — a malicious chart repo would authorize execution of its
 * own templates just by containing the config that says so. Consent from the
 * repo is therefore necessary but not sufficient: the render also requires
 * PROJECT TRUST from the host (`getProjectTrustState()`), the same gate that
 * governs LSP spawns and tool installs. In untrusted mode the runner refuses to
 * spawn and says trust is the reason, rather than skipping silently.
 *
 * The consent lookup is keyed off the WORKSPACE ROOT whose chart is about to
 * run, not `ctx.cwd`. Those differ, and keying on the cwd let an opt-in in one
 * directory authorize rendering a chart belonging to a different project root.
 *
 * The Trivy pass keeps Trivy's OWN consent switch (`trivy.enabled`), because
 * that is the switch that authorizes installing the binary. Opting into
 * rendering therefore gets render + manifest-shape validation; the IaC pass
 * needs both switches. When Trivy is opted in but unavailable, the runner says
 * so as an `info` diagnostic — a missing pass must never read as a clean one.
 *
 * ## No repo writes
 *
 * Rendering goes to a scratch directory under `os.tmpdir()`, removed on every
 * exit path. The chart directory is never touched, and `--dependency-update` is
 * deliberately NOT passed: it would fetch archives into `charts/`. A missing
 * dependency is reported as a finding instead.
 *
 * ## Source mapping
 *
 * A finding the agent cannot locate is noise. Rendered manifests carry helm's
 * own `# Source: <chart>/templates/<file>` annotation, and `--output-dir` mirrors
 * that layout on disk, so every rendered file maps back to the template that
 * produced it. Lines do not survive rendering, so a mapped diagnostic sits at
 * line 1 of the template and names the rendered file and line in its message.
 * When mapping fails the diagnostic attaches to `Chart.yaml` with the rendered
 * path in the message.
 *
 * Refs #1283
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logLatency } from "../../latency-logger.js";
import { PathKeyedMap } from "../../path-keyed-map.js";
import { normalizeMapKey } from "../../path-utils.js";
import { loadPiLensProjectConfig } from "../../project-lens-config.js";
import {
	getProjectTrustState,
	projectTrustDenialReason,
} from "../../project-trust.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import {
	killedForOutputCap,
	truncatedByOutputCap,
} from "../../spawn-output-cap.js";
import { isTrivyEnabled, resolveSeverityFloor } from "../../trivy-client.js";
import { findNearestDirWithMarker } from "../../workspace-topology.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { describeUnavailability } from "./utils/availability-policy.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";

const helm = createAvailabilityChecker("helm", ".exe");
const trivy = createAvailabilityChecker("trivy", ".exe");

const inFlightByChartRoot = new PathKeyedMap<Promise<RunnerResult>>(
	normalizeMapKey,
);

/**
 * Budget, stated deliberately. Both spawns are sequential, so the runner's own
 * ceiling is their sum plus slack — 85s, in the same band as the other heavy
 * per-edit runners (detekt, golangci-lint, rust-clippy at 90s) rather than above
 * them. The pass re-renders on every edit beneath a chart, with no freshness
 * cache; that cost is the reason the feature is opt-in, and a chart-tree content
 * stamp to skip an unchanged re-render is a tracked follow-up on #1283.
 */
const RENDER_TIMEOUT_MS = 30_000;
const TRIVY_TIMEOUT_MS = 45_000;
/** Rendered manifests we are willing to read back, so a chart cannot flood us. */
const MAX_RENDERED_FILES = 400;
/** Bytes of trivy report we retain. Truncation is reported, never parsed past. */
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
/**
 * Bytes of `helm template` output we retain. The manifests go to `--output-dir`,
 * so stdout is one short "wrote <path>" line per file — bounded near
 * {@link MAX_RENDERED_FILES} — and stderr carries template errors. 8 MiB is
 * therefore a blast-radius bound on a chart that loops or a helm that wedges,
 * not a working limit, and it is what makes `render.outputTruncated` reachable
 * at all (#2100).
 */
const MAX_RENDER_OUTPUT_BYTES = 8 * 1024 * 1024;

const SKIPPED: RunnerResult = {
	status: "skipped",
	diagnostics: [],
	semantic: "none",
};

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(
		normalizeMapKey(root),
		normalizeMapKey(candidate),
	);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

/**
 * Explicit opt-in for rendering. Rendering runs chart-authored template code,
 * so the default is OFF and only an explicit `helm.renderValidation.enabled`
 * in `.pi-lens.json` (the loader walks up, so `~/.pi-lens.json` enables it for
 * every project) turns it on. Exported for tests and gate-before-spawn callers.
 *
 * Pass the WORKSPACE ROOT of the chart about to render, not a process cwd: this
 * answers "did THIS project consent", and reading it from an unrelated cwd let
 * one directory's opt-in authorize another project root's chart.
 */
export function isHelmRenderEnabled(workspaceRoot: string): boolean {
	try {
		const config = loadPiLensProjectConfig(workspaceRoot);
		const helmConfig = (
			config.raw as
				| { helm?: { renderValidation?: { enabled?: unknown } } }
				| undefined
		)?.helm;
		return helmConfig?.renderValidation?.enabled === true;
	} catch {
		return false;
	}
}

/**
 * Resolve a helm source reference (`<chartName>/templates/x.yaml`, as it appears
 * in `# Source:` annotations and template error messages) to the template file
 * on disk. Helm prefixes every reference with the chart NAME, which is not a
 * directory under the chart root, so the first segment is dropped. Returns null
 * when the result would not be a real file inside the chart.
 *
 * A `# Source:` annotation is content the CHART wrote, which is the same trust
 * boundary the opt-in exists for, so containment has to hold on every OS. The
 * textual `isWithin` fold is not enough on its own: `normalizeFilePath` only
 * canonicalizes through `realpath` on win32, so on Linux and macOS a symlinked
 * template passes the string test and is then followed by `stat`. Two checks
 * close it, and BOTH are needed (recurring defect shape 2 — verify on the CI OS,
 * not the host):
 *
 *   * `lstat` for the LEAF: a symlink is not `isFile()`, so a linked template is
 *     rejected rather than followed;
 *   * `realpath` containment for the ANCESTORS: `lstat` says nothing about a
 *     symlinked directory mid-path, so `templates/` (or `charts/child/`) being a
 *     link out of the tree would still resolve to a regular file with a
 *     perfectly chart-relative textual path.
 *
 * `realChartRoot` lets a caller resolving many references for ONE chart hoist
 * the root's canonicalization out of the loop: at the 400-manifest cap this
 * function runs up to four times per manifest, and the root's realpath is the
 * same answer every time. Omit it and the root is canonicalized per call.
 */
export function resolveTemplateSource(
	sourceRef: string,
	chartRoot: string,
	realChartRoot?: string,
): string | null {
	const segments = sourceRef
		.split(/[\\/]+/)
		.filter((segment) => segment && segment !== ".");
	if (segments.length < 2) return null;
	const candidate = path.resolve(chartRoot, ...segments.slice(1));
	if (!isWithin(chartRoot, candidate)) return null;
	try {
		if (!fs.lstatSync(candidate).isFile()) return null;
		// Canonicalize both sides: comparing a resolved path against an
		// unresolved root would reject every chart that legitimately lives under
		// a symlinked parent (a /tmp or /home symlink, or a linked worktree).
		const root = realChartRoot ?? fs.realpathSync(chartRoot);
		if (!isWithin(root, fs.realpathSync(candidate))) return null;
	} catch {
		return null;
	}
	return candidate;
}

/**
 * Canonicalize a chart root once per pass, for the `realChartRoot` argument
 * above. Falls back to the uncanonicalized root when realpath fails, which
 * keeps containment conservative rather than skipping the check.
 */
function canonicalChartRoot(chartRoot: string): string {
	try {
		return fs.realpathSync(chartRoot);
	} catch {
		return chartRoot;
	}
}

function chartYaml(chartRoot: string): string {
	return path.join(chartRoot, "Chart.yaml");
}

const HELM_INSTALL_HINT = "https://helm.sh/docs/intro/install/";
const TRIVY_INSTALL_HINT =
	"https://trivy.dev/latest/getting-started/installation/";

/** Helm's own provenance comment, written into every rendered document. */
const SOURCE_ANNOTATION = /^#\s*Source:\s*(\S+)\s*$/m;

/** Template extensions a helm source reference can name. */
const TEMPLATE_EXTENSION = /\.(?:ya?ml|tpl)$/i;

/**
 * Pull the first `<chart>/templates/x.yaml[:line]` reference out of one line of
 * helm output. Tokenized rather than pattern-matched on purpose: the obvious
 * regex for "a slashed path with an optional `:line`" nests two unbounded
 * negated character classes and backtracks super-linearly on a long error line.
 */
export function extractTemplateRef(
	line: string,
): { ref: string; line?: number } | null {
	for (const token of line.split(/[\s(),<>"']+/)) {
		const parts = token.split(":");
		const ref = parts[0];
		if (!ref.includes("/")) continue;
		if (!TEMPLATE_EXTENSION.test(ref)) continue;
		const lineNumber = /^\d+$/.test(parts[1] ?? "")
			? Number(parts[1])
			: undefined;
		return { ref, line: lineNumber };
	}
	return null;
}

/**
 * Where a rendered-manifest finding belongs. Prefer the `# Source:` annotation
 * helm writes into the manifest; fall back to the `--output-dir` layout, which
 * mirrors the same reference as a directory path; fall back to `Chart.yaml`
 * with the rendered path named in the message.
 */
export function mapRenderedToSource(options: {
	renderedContent: string;
	renderedPath: string;
	outputDir: string;
	chartRoot: string;
	/** Canonicalized chart root, hoisted by the per-pass caller. */
	realChartRoot?: string;
}): { filePath: string; mapped: boolean } {
	const { chartRoot, realChartRoot } = options;
	const annotation = SOURCE_ANNOTATION.exec(options.renderedContent);
	if (annotation) {
		const resolved = resolveTemplateSource(
			annotation[1],
			chartRoot,
			realChartRoot,
		);
		if (resolved) return { filePath: resolved, mapped: true };
	}
	const relative = path.relative(options.outputDir, options.renderedPath);
	if (relative && !relative.startsWith("..")) {
		const resolved = resolveTemplateSource(relative, chartRoot, realChartRoot);
		if (resolved) return { filePath: resolved, mapped: true };
	}
	return { filePath: chartYaml(chartRoot), mapped: false };
}

/**
 * Turn a failed `helm template` into findings about the CHART. A render that
 * exits non-zero is a real defect the user needs (#1487): the chart cannot be
 * installed. It is NOT a runner failure — that distinction is made by the
 * caller, on the spawn outcome, before this parser is reached.
 *
 * Helm reports template faults as
 * `Error: template: <chart>/templates/x.yaml:12:9: executing ...` and parse
 * faults as `Error: parse error at (<chart>/templates/x.yaml:5): ...`. Anything
 * unrecognized still becomes one diagnostic on `Chart.yaml`, so a render that
 * failed can never come back empty.
 */
export function parseHelmTemplateFailure(
	raw: string,
	chartRoot: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const text = raw.trim();
	const realRoot = canonicalChartRoot(chartRoot);
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("Error:")) continue;
		const location = extractTemplateRef(trimmed);
		const resolved = location
			? resolveTemplateSource(location.ref, chartRoot, realRoot)
			: null;
		const chartName = path.basename(chartRoot);
		diagnostics.push({
			id: `helm-render-error-${diagnostics.length + 1}`,
			message: resolved
				? trimmed
				: `${trimmed} (helm template failed for chart ${chartName})`,
			filePath: resolved ?? chartYaml(chartRoot),
			line: resolved ? (location?.line ?? 1) : 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "helm-render",
			rule: "render-failed",
			fixable: false,
		});
	}
	if (diagnostics.length === 0) {
		diagnostics.push({
			id: "helm-render-error-1",
			message: `helm template failed: ${(text || "no output").slice(0, 400)}`,
			filePath: chartYaml(chartRoot),
			line: 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "helm-render",
			rule: "render-failed",
			fixable: false,
		});
	}
	return diagnostics;
}

/**
 * Every rendered YAML document must declare `apiVersion` and `kind`. `helm
 * template` does not check this, and a conditional that renders a headless
 * fragment (or nothing but whitespace under a `---`) installs as a no-op that
 * silently drops the object the chart was supposed to create.
 *
 * This is the manifest-shape half of "schema validation". Full OpenAPI schema
 * checking (kubeconform) needs another binary plus installer, availability and
 * gate wiring, and is deliberately out of Slice B's scope.
 */
export function checkManifestShape(options: {
	renderedContent: string;
	renderedRelativePath: string;
	sourcePath: string;
	sourceMapped: boolean;
}): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const documents = options.renderedContent.split(/^---\s*$/m);
	documents.forEach((document, index) => {
		const meaningful = document
			.split(/\r?\n/)
			.filter((line) => line.trim() && !line.trim().startsWith("#"));
		if (meaningful.length === 0) return;
		const missing: string[] = [];
		if (!/^apiVersion:\s*\S/m.test(document)) missing.push("apiVersion");
		if (!/^kind:\s*\S/m.test(document)) missing.push("kind");
		if (missing.length === 0) return;
		const where = options.sourceMapped
			? `rendered ${options.renderedRelativePath}`
			: `rendered ${options.renderedRelativePath} (source template could not be resolved)`;
		diagnostics.push({
			id: `helm-render-shape-${options.renderedRelativePath}-${index}`,
			message: `Rendered document ${index + 1} is missing ${missing.join(" and ")} — it is not a Kubernetes object (${where}).`,
			filePath: options.sourcePath,
			line: 1,
			column: 1,
			severity: "warning",
			semantic: "warning",
			tool: "helm-render",
			rule: "manifest-shape",
			fixable: false,
		});
	});
	return diagnostics;
}

/**
 * The outcome of reading a Trivy report. `understood: false` means the report
 * could not be read at all — an empty body, invalid JSON, or a shape without a
 * `Results` array. That is NOT the same answer as "no misconfigurations", and
 * the caller must not let it settle as a clean pass (recurring defect shape 10:
 * a producer error read as "0 findings = clean").
 */
export interface RenderedTrivyReport {
	understood: boolean;
	diagnostics: Diagnostic[];
	/** Why the report could not be read; undefined when it could. */
	problem?: string;
}

/**
 * Map `trivy config --format json` over the rendered tree onto source
 * templates. Deliberately separate from `trivy-config.ts`'s parser: that one
 * pins every finding to the single file it was handed, while this one has to
 * read each result's `Target` and route it back through the render mapping —
 * and it has to distinguish an unreadable report from an empty one.
 */
export function parseRenderedTrivyOutput(
	raw: string,
	locate: (target: string) => { filePath: string; detail: string },
): RenderedTrivyReport {
	if (!raw.trim()) {
		return { understood: false, diagnostics: [], problem: "empty report" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			understood: false,
			diagnostics: [],
			problem: "report was not valid JSON",
		};
	}
	const results = (parsed as { Results?: unknown })?.Results;
	if (!Array.isArray(results)) {
		return {
			understood: false,
			diagnostics: [],
			problem: "report carried no Results array",
		};
	}

	const diagnostics: Diagnostic[] = [];
	for (const entry of results) {
		if (!entry || typeof entry !== "object") continue;
		const target = (entry as { Target?: unknown }).Target;
		const rows = (entry as { Misconfigurations?: unknown }).Misconfigurations;
		if (!Array.isArray(rows)) continue;
		const located = locate(typeof target === "string" ? target : "");
		for (const row of rows) {
			if (!row || typeof row !== "object") continue;
			const misconfig = row as Record<string, unknown>;
			const id = typeof misconfig.ID === "string" ? misconfig.ID : undefined;
			if (!id) continue;
			const cause = (misconfig.CauseMetadata ?? {}) as { StartLine?: unknown };
			const renderedLine =
				typeof cause.StartLine === "number" && cause.StartLine > 0
					? cause.StartLine
					: undefined;
			const severity =
				typeof misconfig.Severity === "string"
					? misconfig.Severity.toUpperCase()
					: "UNKNOWN";
			const title =
				typeof misconfig.Title === "string" && misconfig.Title
					? misconfig.Title
					: id;
			const resolution =
				typeof misconfig.Resolution === "string" && misconfig.Resolution
					? ` ${misconfig.Resolution}`
					: "";
			const at = renderedLine
				? `${located.detail}:${renderedLine}`
				: located.detail;
			diagnostics.push({
				id: `helm-render-${id}-${diagnostics.length + 1}`,
				message: `[${id}] ${title} (${severity}) in ${at}.${resolution}`.trim(),
				filePath: located.filePath,
				line: 1,
				column: 1,
				severity: severity === "CRITICAL" ? "error" : "warning",
				semantic: severity === "CRITICAL" ? "blocking" : "warning",
				defectClass: "safety",
				tool: "helm-render",
				rule: id,
				fixable: false,
			});
		}
	}
	return { understood: true, diagnostics };
}

/**
 * The runner could not start. Helm is the only tool that can reach this: an
 * absent trivy leaves the render findings standing and is reported as a pass
 * gap instead, so there is no second arm to generalize for.
 */
function helmUnavailableResult(cwd: string): RunnerResult {
	const verdict = helm.getVerdict(cwd);
	return {
		status: "failed",
		diagnostics: [],
		semantic: "warning",
		// One failureKind for both arms — a consumer must read this as "the runner
		// could not start", never as a chart finding. Whether the absence is
		// durable or a probe timeout is the MESSAGE's job, and the availability
		// seam has already logged the decision with its honest cause.
		failureKind: "unavailable",
		failureMessage: describeUnavailability({
			tool: "helm",
			installHint: HELM_INSTALL_HINT,
			outcome: verdict.outcome,
			cause: verdict.cause,
			elapsedMs: verdict.elapsedMs,
			retryAfterMs: verdict.retryAtMs
				? Math.max(0, verdict.retryAtMs - Date.now())
				: undefined,
		}).slice(0, 300),
	};
}

function failedResult(kind: string, message: string): RunnerResult {
	return {
		status: "failed",
		diagnostics: [],
		semantic: "warning",
		failureKind: kind,
		failureMessage: message.slice(0, 200),
	};
}

/**
 * The flags pi-lens itself puts on the command line. If helm complains about one
 * of THESE, the complaint is about us, not about the chart.
 */
const OUR_RENDER_FLAGS = ["--output-dir"] as const;

/**
 * True when helm's output is a rejection of OUR invocation rather than a verdict
 * on the chart: `unknown flag`, `unknown shorthand flag`, `flag provided but not
 * defined`, or an `unknown command`, naming one of our own flags. helm v2 has no
 * `template --output-dir` at all, and a wrapper shim can reject it too. Without
 * this, a tooling mismatch is reported to the user as a broken chart — the #1487
 * lesson inverted.
 *
 * Returns the matched flag (for the message) or null.
 */
function rejectedOurInvocation(output: string): string | null {
	if (!output) return null;
	const complaint =
		/unknown flag|unknown shorthand flag|flag provided but not defined|unknown command|unrecognized (?:flag|option)/i.test(
			output,
		);
	if (!complaint) return null;
	for (const flag of OUR_RENDER_FLAGS) {
		if (output.includes(flag)) return flag;
	}
	// A flag complaint that names none of our flags could still be ours (helm
	// wording drift), but it could equally come from a chart's own hook or a
	// plugin. Stay conservative: only OUR flag names buy the runner-error verdict.
	return null;
}

/** Classify a spawn that never produced a verdict about the chart. */
function spawnFailureKind(result: {
	failure?: string;
	spawnFailure?: { kind?: string };
}): string | null {
	const typed = result.spawnFailure?.kind;
	if (typed === "tool-not-found") return "unavailable";
	if (typed === "timeout" || result.failure === "timeout") return "timeout";
	if (typed === "killed" || result.failure === "aborted") return "aborted";
	if (result.failure) return "server_error";
	return null;
}

/**
 * Walk the scratch tree for rendered manifests. `truncated` is load-bearing: a
 * chart bigger than the cap is only PARTLY validated, and a partial pass that
 * reports no findings would read as a clean one (recurring defect shape 10), so
 * the caller turns the flag into a visible diagnostic.
 *
 * `withFileTypes` gives `lstat`-shaped entries, so a symlink is neither
 * `isDirectory()` nor `isFile()` and the walk cannot be led out of the scratch
 * directory. Keep it that way.
 */
function collectRenderedFiles(root: string): {
	files: string[];
	truncated: boolean;
} {
	const files: string[] = [];
	const stack = [root];
	let truncated = false;
	while (stack.length > 0 && !truncated) {
		const dir = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
				if (files.length >= MAX_RENDERED_FILES) {
					truncated = true;
					break;
				}
				files.push(full);
			}
		}
	}
	return {
		files: files.sort((left, right) => left.localeCompare(right)),
		truncated,
	};
}

function summarize(diagnostics: Diagnostic[]): RunnerResult {
	let semantic: RunnerResult["semantic"] = "none";
	if (diagnostics.some((item) => item.severity === "error")) {
		semantic = "blocking";
	} else if (diagnostics.length > 0) {
		semantic = "warning";
	}
	return { status: "succeeded", diagnostics, semantic };
}

/** One rendered manifest, paired with the template it came from. */
interface RenderedManifest {
	renderedPath: string;
	relativePath: string;
	content: string;
	sourcePath: string;
	sourceMapped: boolean;
}

/** Read the rendered tree back and resolve each file to its source template. */
function readRenderedTree(
	outputDir: string,
	chartRoot: string,
): { manifests: RenderedManifest[]; truncated: boolean; unreadable: number } {
	const manifests: RenderedManifest[] = [];
	const walk = collectRenderedFiles(outputDir);
	// Hoisted: the chart root's realpath is one answer for the whole pass, and
	// the mapping below asks for it up to four times per manifest.
	const realChartRoot = canonicalChartRoot(chartRoot);
	let unreadable = 0;
	for (const renderedPath of walk.files) {
		let content: string;
		try {
			content = fs.readFileSync(renderedPath, "utf-8");
		} catch {
			unreadable += 1;
			continue;
		}
		const mapping = mapRenderedToSource({
			renderedContent: content,
			renderedPath,
			outputDir,
			chartRoot,
			realChartRoot,
		});
		manifests.push({
			renderedPath,
			relativePath: path.relative(outputDir, renderedPath),
			content,
			sourcePath: mapping.filePath,
			sourceMapped: mapping.mapped,
		});
	}
	return { manifests, truncated: walk.truncated, unreadable };
}

type CoverageRule =
	| "iac-pass-unavailable"
	| "iac-pass-failed"
	| "iac-report-unreadable"
	| "render-truncated"
	// Distinct from `render-truncated` on purpose (#2100 review F1): helm
	// COMPLETED and `--output-dir` wrote the whole tree, so every manifest was
	// validated — only the stdout we never parse was capped. Sharing the
	// `render-truncated` id would also collide with the walk's own gap.
	| "render-output-truncated"
	| "rendered-file-unreadable"
	| "render-empty"
	| "render-untrusted";

/**
 * One `info` diagnostic saying part of the pass did not happen. Zero findings
 * from a pass that did not fully run must never read as a clean pass (recurring
 * defect shape 10), and a silent exclusion needs a record (shape 8).
 */
function coverageGap(
	chartRoot: string,
	rule: CoverageRule,
	message: string,
): Diagnostic {
	return {
		id: `helm-render-${rule}`,
		message,
		filePath: chartYaml(chartRoot),
		line: 1,
		column: 1,
		severity: "info",
		semantic: "warning",
		tool: "helm-render",
		rule,
		fixable: false,
	};
}

/**
 * The Trivy half of the pass. Returns the findings it produced, or a single gap
 * diagnostic when it could not run — never an empty "clean" answer.
 *
 * Exported for a real-binary regression test (refs #1757) — this is the ONE
 * seam that spawns `trivy config` for the rendered-manifest pass, so an
 * integration test needs to call it directly rather than driving the whole
 * chart-render pipeline (which additionally requires a real `helm` binary).
 */
export async function runIacPass(options: {
	chartRoot: string;
	cwd: string;
	outputDir: string;
	manifests: RenderedManifest[];
}): Promise<Diagnostic[]> {
	const { chartRoot, cwd, outputDir } = options;
	const trivyCmd = await resolveAvailableOrInstall(trivy, "trivy", cwd);
	if (!trivyCmd) {
		const verdict = trivy.getVerdict(cwd);
		return [
			coverageGap(
				chartRoot,
				"iac-pass-unavailable",
				`Rendered-manifest IaC checks did not run: ${describeUnavailability({
					tool: "trivy",
					installHint: TRIVY_INSTALL_HINT,
					outcome: verdict.outcome,
					cause: verdict.cause,
					elapsedMs: verdict.elapsedMs,
				})}`,
			),
		];
	}

	const scan = await safeSpawnAsync(
		trivyCmd,
		[
			"config",
			// `--quiet` alone suppresses both the progress bar and log output.
			// `--no-progress` is NOT a `config` subcommand flag (unlike `fs`,
			// which does accept it) — trivy 0.73.0 exits 1 with 7662 bytes of
			// usage text on stdout ("FATAL unknown flag: --no-progress") when
			// it's passed here, which the exit-status check below now catches,
			// but the flag itself made every real invocation of this pass fail
			// before it ever scanned a rendered manifest (refs #1757; verified
			// against the real installed binary, not assumed).
			"--quiet",
			"--format",
			"json",
			"--severity",
			resolveSeverityFloor(cwd).join(","),
			outputDir,
		],
		{
			cwd,
			timeout: TRIVY_TIMEOUT_MS,
			deadlineAt: Date.now() + TRIVY_TIMEOUT_MS,
			resourceLabel: "helm-render-trivy",
			// The report is the whole rendered tree's misconfigurations; cap what we
			// hold in memory rather than trusting the chart's size (shape 9).
			maxOutputBytes: MAX_REPORT_BYTES,
		},
	);
	// FIRST (#2100): hitting the cap makes safe-spawn SIGTERM trivy, so a
	// truncated report also arrives as a killed spawn with a null status. Read
	// after the gate below, this said "the IaC pass failed" when what actually
	// happened is that WE stopped reading. A timed-out or aborted scan carries
	// the flag too and stays with the failure gate, which names its real cause.
	if (truncatedByOutputCap(scan)) {
		return [
			coverageGap(
				chartRoot,
				"iac-report-unreadable",
				`Rendered-manifest IaC checks did not run: the trivy report exceeded ${MAX_REPORT_BYTES} bytes and was truncated before parsing.`,
			),
		];
	}
	const scanFailure = spawnFailureKind(scan);
	// `trivy config` is not given `--exit-code`, so it exits 0 whenever it
	// completed. ANY nonzero status is therefore a real error, with or without
	// something on stdout — the earlier "nonzero AND no output" gate let a
	// half-written report through as a completed pass.
	if (scanFailure || scan.status !== 0) {
		const why = scanFailure ?? `exit ${scan.status}`;
		const detail = (scan.stderr || scan.error?.message || "no output").slice(
			0,
			200,
		);
		return [
			coverageGap(
				chartRoot,
				"iac-pass-failed",
				`Rendered-manifest IaC checks failed to complete (${why}): ${detail}`,
			),
		];
	}

	const sourceByRendered = new PathKeyedMap<{
		filePath: string;
		detail: string;
	}>(normalizeMapKey);
	for (const manifest of options.manifests) {
		sourceByRendered.set(manifest.renderedPath, {
			filePath: manifest.sourcePath,
			detail: manifest.relativePath,
		});
	}
	const report = parseRenderedTrivyOutput(scan.stdout || "", (target) => {
		const hit = sourceByRendered.get(path.resolve(outputDir, target));
		return (
			hit ?? {
				filePath: chartYaml(chartRoot),
				detail: target || "rendered manifest",
			}
		);
	});
	if (!report.understood) {
		// trivy exited 0 but we cannot read what it said. "No misconfigurations"
		// and "unreadable report" are different answers (defect shape 10).
		return [
			coverageGap(
				chartRoot,
				"iac-report-unreadable",
				`Rendered-manifest IaC checks produced no readable result (${report.problem}), so the manifests are UNSCANNED rather than clean.`,
			),
		];
	}
	return report.diagnostics;
}

/**
 * One record per render pass, so what this runner did is answerable from
 * latency.log rather than inferred: whether it rendered, how many manifests it
 * validated, whether the walk was truncated, whether the IaC pass was asked
 * for, and how many diagnostics came out. The availability seam logs its own
 * decision, which covers only the tool-probe arm.
 */
function logRenderPass(
	filePath: string,
	chartRoot: string,
	startedAt: number,
	metadata: Record<string, unknown>,
): void {
	logLatency({
		type: "phase",
		phase: "helm_render_pass",
		filePath,
		durationMs: Date.now() - startedAt,
		metadata: { chartRoot, ...metadata },
	});
}

/**
 * Remove the scratch tree. Deliberately swallowing: a cleanup that throws out
 * of a `finally` would DISCARD the result the caller was about to return, so a
 * chart with a real blocking finding would be reported as a runner exception
 * with zero diagnostics because temp-dir removal lost a race with an AV scanner
 * (recurring defect shape 10, from the cleanup side). The leak is logged, and
 * the OS reclaims the directory.
 */
export function discardScratchDir(
	outputDir: string,
	filePath: string,
	remove: (target: string) => void = (target) =>
		fs.rmSync(target, { recursive: true, force: true }),
): void {
	try {
		remove(outputDir);
	} catch (error) {
		logLatency({
			type: "phase",
			phase: "helm_render_scratch_leak",
			filePath,
			durationMs: 0,
			metadata: {
				outputDir,
				error: error instanceof Error ? error.message : String(error),
			},
		});
	}
}

async function renderAndValidate(
	chartRoot: string,
	cwd: string,
	filePath: string,
): Promise<RunnerResult> {
	const startedAt = Date.now();
	const helmCmd = await resolveAvailableOrInstall(helm, "helm", cwd);
	if (!helmCmd) return helmUnavailableResult(cwd);

	const outputDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-helm-render-"),
	);
	try {
		const render = await safeSpawnAsync(
			helmCmd,
			["template", "pi-lens-render", chartRoot, "--output-dir", outputDir],
			{
				cwd,
				timeout: RENDER_TIMEOUT_MS,
				deadlineAt: Date.now() + RENDER_TIMEOUT_MS,
				resourceLabel: "helm-render",
				maxOutputBytes: MAX_RENDER_OUTPUT_BYTES,
			},
		);

		const renderOutput = [render.stdout, render.stderr]
			.filter(Boolean)
			.join("\n");
		// `killedForOutputCap` is platform-neutral. POSIX usually reports SIGTERM,
		// but Windows reports status 1 with no failure or signal. A timed-out or
		// aborted render retains its own classification.
		const renderCapped = truncatedByOutputCap(render);
		if (killedForOutputCap(render)) {
			// helm was cut off mid-render, so the scratch tree is a PREFIX —
			// reading it back would report the manifests we never saw as clean
			// (shape 10). Not parsed as a chart failure either: helm never reported
			// a verdict, and `parseHelmTemplateFailure` synthesizes a BLOCKING
			// "helm template failed" finding when it sees no `Error:` line, which
			// would blame the chart for our own cap (the #1487 inversion).
			logRenderPass(filePath, chartRoot, startedAt, {
				outcome: "render-truncated",
				diagnostics: 1,
			});
			return summarize([
				coverageGap(
					chartRoot,
					"render-truncated",
					`helm template produced more than ${MAX_RENDER_OUTPUT_BYTES} bytes and was stopped mid-render, so the rendered manifests are UNCHECKED rather than clean.`,
				),
			]);
		}

		const startupFailure = spawnFailureKind(render);
		if (startupFailure) {
			// The runner never got a verdict about the chart. Reporting this as a
			// chart finding would blame the user's chart for our own missing tool
			// (#1487); reporting nothing would read as clean (defect shape 10).
			logRenderPass(filePath, chartRoot, startedAt, {
				outcome: "runner-failed",
				failureKind: startupFailure,
			});
			return failedResult(
				startupFailure,
				render.error?.message || `helm template ${startupFailure}`,
			);
		}
		if (render.status !== 0) {
			// Before blaming the chart: did helm reject OUR OWN command line? An old
			// helm (v2 has no `helm template --output-dir`) or a wrapper shim exits
			// non-zero on the invocation, which says nothing about the chart.
			// Reporting that as a chart finding is the #1487 inversion, upside down.
			const ourFlag = rejectedOurInvocation(renderOutput);
			if (ourFlag) {
				logRenderPass(filePath, chartRoot, startedAt, {
					outcome: "runner-failed",
					failureKind: "invocation_rejected",
					flag: ourFlag,
				});
				return failedResult(
					"invocation_rejected",
					`helm rejected pi-lens's own invocation (${ourFlag}); this is a helm/pi-lens compatibility problem, not a chart defect: ${renderOutput.trim().slice(0, 160)}`,
				);
			}
			// A failed RENDER is a real diagnostic: the chart cannot be installed.
			const diagnostics = parseHelmTemplateFailure(renderOutput, chartRoot);
			if (renderCapped) {
				// helm reported this failure itself, but we kept only a prefix of
				// what it said, so the report above may be missing errors.
				diagnostics.push(
					coverageGap(
						chartRoot,
						"render-truncated",
						"helm template output was truncated, so this failure report may be incomplete.",
					),
				);
			}
			logRenderPass(filePath, chartRoot, startedAt, {
				outcome: "render-failed",
				diagnostics: diagnostics.length,
			});
			return summarize(diagnostics);
		}

		const tree = readRenderedTree(outputDir, chartRoot);
		const diagnostics: Diagnostic[] = [];
		for (const manifest of tree.manifests) {
			diagnostics.push(
				...checkManifestShape({
					renderedContent: manifest.content,
					renderedRelativePath: manifest.relativePath,
					sourcePath: manifest.sourcePath,
					sourceMapped: manifest.sourceMapped,
				}),
			);
		}
		if (renderCapped) {
			// helm exited 0, so `--output-dir` holds the COMPLETE tree and every
			// manifest above was validated from disk — the cap only cost us the
			// "wrote <path>" lines on stdout, which this runner never parses.
			// Recorded rather than silent (shape 8), but deliberately not an
			// UNCHECKED claim: nothing was skipped (review F1).
			diagnostics.push(
				coverageGap(
					chartRoot,
					"render-output-truncated",
					`helm template printed more than ${MAX_RENDER_OUTPUT_BYTES} bytes and its stdout was truncated. The rendered manifests were still validated from disk; only helm's own progress output was lost.`,
				),
			);
		}
		if (tree.truncated) {
			// A partly-validated chart reported as clean is the shape-10 trap.
			diagnostics.push(
				coverageGap(
					chartRoot,
					"render-truncated",
					`This chart rendered more than ${MAX_RENDERED_FILES} manifests; only the first ${MAX_RENDERED_FILES} were validated, so the rest are UNCHECKED rather than clean.`,
				),
			);
		}
		if (tree.unreadable > 0) {
			// Same asymmetry as truncation, one level down: a manifest we could not
			// read back was not validated, so its silence is not evidence.
			diagnostics.push(
				coverageGap(
					chartRoot,
					"rendered-file-unreadable",
					`${tree.unreadable} rendered manifest(s) could not be read back from the scratch directory and are UNCHECKED rather than clean.`,
				),
			);
		}
		if (tree.manifests.length === 0) {
			// helm exited 0 and produced nothing readable. That is not a clean
			// chart, it is an unknown one — an all-templates-disabled values file,
			// a chart with no templates, or a scratch directory we failed to walk.
			diagnostics.push(
				coverageGap(
					chartRoot,
					"render-empty",
					"helm template succeeded but produced no manifests to validate, so this chart is UNVALIDATED rather than clean. Check whether the chart's values disable every template.",
				),
			);
		}

		// The IaC pass keeps trivy's own consent switch — that switch authorizes
		// installing the binary and pulling its policy bundle.
		const iacRequested = isTrivyEnabled(cwd);
		if (iacRequested) {
			diagnostics.push(
				...(await runIacPass({
					chartRoot,
					cwd,
					outputDir,
					manifests: tree.manifests,
				})),
			);
		}
		logRenderPass(filePath, chartRoot, startedAt, {
			outcome: "rendered",
			manifests: tree.manifests.length,
			truncated: tree.truncated,
			unreadable: tree.unreadable,
			iacRequested,
			diagnostics: diagnostics.length,
		});
		return summarize(diagnostics);
	} finally {
		discardScratchDir(outputDir, filePath);
	}
}

const helmRenderRunner: RunnerDefinition = {
	id: "helm-render",
	appliesTo: ["yaml", "helm-template"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,
	timeoutMs: RENDER_TIMEOUT_MS + TRIVY_TIMEOUT_MS + 10_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();
		const workspaceRoot = path.resolve(ctx.projectRoot ?? cwd);

		// Gate 1 — consent, read from the project whose chart would run. Keying
		// this on `cwd` let an opt-in in one directory authorize a DIFFERENT
		// project root's chart.
		if (!isHelmRenderEnabled(workspaceRoot)) return SKIPPED;

		const startDir = path.dirname(path.resolve(ctx.filePath));
		const discovered = findNearestDirWithMarker(startDir, "chartYamlPath");
		if (!discovered) return SKIPPED;
		const chartRoot = path.resolve(discovered);
		if (!isWithin(workspaceRoot, chartRoot)) return SKIPPED;

		// Gate 2 — project trust. `.pi-lens.json` is a TRACKED file, so consent
		// can arrive inside a cloned repository: a hostile chart repo would
		// authorize execution of its own templates simply by shipping the switch.
		// Trust is the host's answer, not the repo's, so it cannot be forged by
		// content. Same gate as LSP spawns and tool installs.
		if (getProjectTrustState() === "untrusted") {
			// Not a silent skip: the user asked for this pass, and "no findings"
			// must not be how they learn it never ran (defect shape 10).
			logRenderPass(ctx.filePath, chartRoot, Date.now(), {
				outcome: "refused-untrusted",
			});
			return summarize([
				coverageGap(
					chartRoot,
					"render-untrusted",
					`Helm rendered-manifest validation did not run: ${projectTrustDenialReason() ?? "project trust denied"}. Rendering executes this chart's own templates, so it needs host trust in addition to the \`helm.renderValidation.enabled\` switch — and that switch is a tracked file a cloned repository can set for itself.`,
				),
			]);
		}

		const existing = inFlightByChartRoot.get(chartRoot);
		if (existing) return existing;
		const promise = renderAndValidate(chartRoot, cwd, ctx.filePath).finally(
			() => {
				if (inFlightByChartRoot.get(chartRoot) === promise)
					inFlightByChartRoot.delete(chartRoot);
			},
		);
		inFlightByChartRoot.set(chartRoot, promise);
		return promise;
	},
};

export default helmRenderRunner;
