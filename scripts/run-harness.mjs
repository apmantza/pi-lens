import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function usage() {
	console.error(
		"Usage: node scripts/run-harness.mjs <case-dir> [--model provider/model] [--pi-bin /path/to/pi]",
	);
}

function timestampDirName() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function copyDir(source, target) {
	fs.cpSync(source, target, { recursive: true });
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stringifySnippet(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function readTextIfExists(filePath) {
	return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function normalizeText(value) {
	return typeof value === "string" ? value.replace(/\r\n/g, "\n") : value;
}

function toNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function classifyFailure(toolName, text, isError) {
	const normalized = normalizeText(text || "");
	if (!normalized && !isError) return null;
	if (/Could not find edits\[\d+\]/i.test(normalized)) {
		return { kind: "edit_mismatch", toolName, recovered: null };
	}
	if (/File was modified by auto-format\/fix/i.test(normalized)) {
		return { kind: "file_changed_notice", toolName, recovered: null };
	}
	if (/Auto-fixed/i.test(normalized)) {
		return { kind: "autofix_notice", toolName, recovered: null };
	}
	if (
		/read-guard|BLIND WRITE|BLOCKED|File modified since read/i.test(normalized)
	) {
		return { kind: "read_guard", toolName, recovered: null };
	}
	if (/Unknown provider|provider.*incompat|schema/i.test(normalized)) {
		return { kind: "provider_or_schema", toolName, recovered: null };
	}
	if (/No module named /i.test(normalized)) {
		return { kind: "missing_module", toolName, recovered: null };
	}
	if (/Command exited with code/i.test(normalized) || isError) {
		return { kind: "tool_error", toolName, recovered: null };
	}
	return null;
}

function fileChanged(sourceRoot, targetRoot, relativePath) {
	const source = normalizeText(
		readTextIfExists(path.join(sourceRoot, relativePath)),
	);
	const target = normalizeText(
		readTextIfExists(path.join(targetRoot, relativePath)),
	);
	return source !== target;
}

function parseArgs(argv) {
	const args = [...argv];
	const result = { caseDir: undefined, model: undefined, piBin: undefined };
	while (args.length > 0) {
		const arg = args.shift();
		if (!arg) continue;
		if (arg === "--model") {
			result.model = args.shift();
			continue;
		}
		if (arg === "--pi-bin") {
			result.piBin = args.shift();
			continue;
		}
		if (!result.caseDir) {
			result.caseDir = arg;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return result;
}

const {
	caseDir,
	model: modelOverride,
	piBin: piBinOverride,
} = parseArgs(process.argv.slice(2));
if (!caseDir) {
	usage();
	process.exit(1);
}

const resolvedCaseDir = path.resolve(repoRoot, caseDir);
const caseFile = path.join(resolvedCaseDir, "case.json");
const promptFile = path.join(resolvedCaseDir, "prompt.txt");
const workspaceSource = path.join(resolvedCaseDir, "workspace");

if (!fs.existsSync(caseFile)) throw new Error(`Missing case file: ${caseFile}`);
if (!fs.existsSync(promptFile))
	throw new Error(`Missing prompt file: ${promptFile}`);
if (!fs.existsSync(workspaceSource)) {
	throw new Error(`Missing workspace directory: ${workspaceSource}`);
}

const manifest = readJson(caseFile);
const prompt = fs.readFileSync(promptFile, "utf8").trim();
const model =
	modelOverride || manifest.model || process.env.PI_LENS_HARNESS_MODEL;
if (!model) {
	throw new Error(
		"No model configured. Set it in case.json, pass --model, or export PI_LENS_HARNESS_MODEL.",
	);
}

function splitProviderModel(modelId) {
	if (typeof modelId !== "string") return { provider: null, model: modelId };
	const slashIndex = modelId.indexOf("/");
	if (slashIndex <= 0) return { provider: null, model: modelId };
	return {
		provider: modelId.slice(0, slashIndex),
		model: modelId.slice(slashIndex + 1),
	};
}

const selectedModel = splitProviderModel(model);

const runRoot = path.join(
	repoRoot,
	".harness",
	"runs",
	timestampDirName(),
	manifest.name,
);
const workspaceDir = path.join(runRoot, "workspace");
const harnessPromptFile = path.join(workspaceDir, "HARNESS_PROMPT.txt");
ensureDir(runRoot);
copyDir(workspaceSource, workspaceDir);
fs.writeFileSync(path.join(runRoot, "prompt.txt"), `${prompt}\n`, "utf8");
fs.writeFileSync(harnessPromptFile, `${prompt}\n`, "utf8");
fs.writeFileSync(
	path.join(runRoot, "manifest.json"),
	JSON.stringify(manifest, null, 2),
);

const startupMode =
	manifest.startupMode === "full" || manifest.startupMode === "quick"
		? manifest.startupMode
		: "quick";
const allowedTools = Array.isArray(manifest.allowedTools)
	? manifest.allowedTools
	: ["read", "write", "edit", "bash"];

const piArgs = [
	"--print",
	"--mode",
	"json",
	"--no-session",
	"--thinking",
	"low",
	"--no-extensions",
	"--extension",
	path.join(repoRoot, "index.ts"),
	"--tools",
	allowedTools.join(","),
];
if (selectedModel.provider) {
	piArgs.push("--provider", selectedModel.provider);
}
piArgs.push("--model", selectedModel.model, "@HARNESS_PROMPT.txt");

function runPi(args, cwd, piBinOverride) {
	const env = {
		...process.env,
		PI_LENS_STARTUP_MODE: startupMode,
	};
	const appData = process.env.APPDATA || process.env.Roaming || "";
	const configuredPiBin = piBinOverride || process.env.PI_HARNESS_PI_BIN;
	const attempts = [];
	if (configuredPiBin) attempts.push([configuredPiBin, args]);
	if (process.platform === "win32") {
		attempts.push(
			[path.join(appData, "npm", "pi.cmd"), args],
			[
				path.join(appData, "npm", "npx.cmd"),
				["@mariozechner/pi-coding-agent", ...args],
			],
			["pi.cmd", args],
			["pi", args],
			["npx.cmd", ["@mariozechner/pi-coding-agent", ...args]],
		);
	} else {
		attempts.push(
			["pi", args],
			["npx", ["@mariozechner/pi-coding-agent", ...args]],
		);
	}

	for (const [command, commandArgs] of attempts) {
		const result = spawnSync(command, commandArgs, {
			cwd,
			encoding: "utf8",
			maxBuffer: 20 * 1024 * 1024,
			env,
			shell:
				process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command)),
		});
		if (result.error) continue;
		return { command, args: commandArgs, result };
	}

	return {
		command: "pi",
		args,
		result: {
			stdout: "",
			stderr: "",
			status: null,
			signal: null,
			error: new Error("Unable to locate pi or npx on PATH."),
		},
	};
}

const startedAt = Date.now();
const execution = runPi(piArgs, workspaceDir, piBinOverride);
const child = execution.result;
const durationMs = Date.now() - startedAt;

const stdout = child.stdout || "";
const stderr = child.stderr || "";
fs.writeFileSync(path.join(runRoot, "stdout.jsonl"), stdout, "utf8");
fs.writeFileSync(path.join(runRoot, "stderr.txt"), stderr, "utf8");

const events = [];
for (const line of stdout.split(/\r?\n/)) {
	if (!line.trim()) continue;
	try {
		events.push(JSON.parse(line));
	} catch {
		// Keep raw output on disk; summary stays best-effort.
	}
}

const toolCalls = [];
const toolResults = [];
const toolTimeline = [];
const turnTimeline = [];
const failures = [];
let assistantText = "";
let sessionInfo = null;
let firstAssistantTimestamp = null;
let firstToolCallTimestamp = null;
let finalAssistantTimestamp = null;
let promptTimestamp = null;
const activeToolCalls = new Map();
for (const event of events) {
	if (event?.type === "session") {
		sessionInfo = {
			id: event.id || null,
			version: event.version || null,
			timestamp: event.timestamp || null,
			cwd: event.cwd || null,
		};
	}
	if (event?.type === "message_start" && event?.message?.role === "user") {
		promptTimestamp = toNumber(event.message.timestamp);
	}
	if (event?.type === "turn_end") {
		const assistantMessage = event.message || {};
		const turnStartedAt = toNumber(assistantMessage.timestamp);
		const toolResultTimestamps = Array.isArray(event.toolResults)
			? event.toolResults
					.map((result) => toNumber(result?.timestamp))
					.filter((value) => value !== null)
			: [];
		const turnEndedAt =
			toolResultTimestamps.length > 0
				? Math.max(...toolResultTimestamps)
				: turnStartedAt;
		turnTimeline.push({
			index: turnTimeline.length + 1,
			stopReason: assistantMessage.stopReason || null,
			startedAt: turnStartedAt,
			endedAt: turnEndedAt,
			durationMs:
				turnStartedAt !== null && turnEndedAt !== null
					? Math.max(0, turnEndedAt - turnStartedAt)
					: null,
			provider: assistantMessage.provider || null,
			model: assistantMessage.model || null,
			usage: assistantMessage.usage || null,
			toolCallCount: Array.isArray(assistantMessage.content)
				? assistantMessage.content.filter((item) => item?.type === "toolCall")
						.length
				: 0,
		});
		if (firstAssistantTimestamp === null && turnStartedAt !== null) {
			firstAssistantTimestamp = turnStartedAt;
		}
		if (turnEndedAt !== null) {
			finalAssistantTimestamp = turnEndedAt;
		}
	}
	if (event?.type === "tool_execution_start") {
		toolCalls.push({ toolName: event.toolName, args: event.args });
		activeToolCalls.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			startedAt: null,
		});
		if (firstToolCallTimestamp === null && turnTimeline.length > 0) {
			firstToolCallTimestamp = turnTimeline[turnTimeline.length - 1].startedAt;
		}
	}
	if (event?.type === "tool_execution_end") {
		const resultSnippet = stringifySnippet(event.result).slice(0, 1000);
		toolResults.push({
			toolName: event.toolName,
			isError: Boolean(event.isError),
			resultSnippet,
		});
		const activeCall = activeToolCalls.get(event.toolCallId) || {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: undefined,
			startedAt: null,
		};
		const timelineEntry = {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: activeCall.args,
			startedAt: activeCall.startedAt,
			endedAt: null,
			durationMs: null,
			isError: Boolean(event.isError),
			resultSnippet,
		};
		toolTimeline.push(timelineEntry);
		activeToolCalls.delete(event.toolCallId);
		const failure = classifyFailure(
			event.toolName,
			resultSnippet,
			Boolean(event.isError),
		);
		if (failure) {
			failures.push({
				...failure,
				toolCallId: event.toolCallId,
				message: resultSnippet.slice(0, 300),
			});
		}
	}
	if (
		event?.type === "message_update" &&
		event?.assistantMessageEvent?.type === "text_delta" &&
		typeof event.assistantMessageEvent.delta === "string"
	) {
		assistantText += event.assistantMessageEvent.delta;
	}
}

const expectedFiles = Array.isArray(manifest.expectedFiles)
	? manifest.expectedFiles.map((relativePath) => ({
			path: relativePath,
			exists: fs.existsSync(path.join(workspaceDir, relativePath)),
		}))
	: [];

const expectedToolCalls = Array.isArray(manifest.expectedToolCalls)
	? manifest.expectedToolCalls.map((toolName) => ({
			toolName,
			called: toolCalls.some((call) => call.toolName === toolName),
		}))
	: [];

const forbiddenChangedFiles = Array.isArray(manifest.forbiddenChangedFiles)
	? manifest.forbiddenChangedFiles.map((relativePath) => ({
			path: relativePath,
			changed: fileChanged(workspaceSource, workspaceDir, relativePath),
		}))
	: [];

const forbiddenToolCalls = Array.isArray(manifest.forbiddenToolCalls)
	? manifest.forbiddenToolCalls.map((toolName) => ({
			toolName,
			called: toolCalls.some((call) => call.toolName === toolName),
		}))
	: [];

const expectedRuntimeMarkers = Array.isArray(manifest.expectedRuntimeMarkers)
	? manifest.expectedRuntimeMarkers.map((marker) => {
			const haystack = `${assistantText}\n${toolResults
				.map((result) => result.resultSnippet)
				.join("\n")}`;
			return { marker, seen: haystack.includes(marker) };
		})
	: [];

const runtimeText = `${assistantText}\n${toolResults
	.map((result) => result.resultSnippet)
	.join("\n")}`;
const runtimeSignals = {
	pipeline: /runtime|auto-format|Auto-fixed|clean ·|Successfully wrote/i.test(
		runtimeText,
	),
	dispatch:
		/dispatch|diagnostic/i.test(runtimeText) ||
		failures.some((failure) => failure.kind === "tool_error") ||
		/tool_error|missing_module/.test(
			failures.map((failure) => failure.kind).join(" "),
		),
	lsp:
		toolCalls.some((call) => call.toolName === "lsp_navigation") ||
		/\bLSP\b/i.test(runtimeText),
	readGuard: /read-guard|BLIND WRITE|BLOCKED|File modified since read/i.test(
		runtimeText,
	),
	fileChangedNotice:
		/File was modified by auto-format\/fix|re-read the file/i.test(runtimeText),
	autofix: /Auto-fixed/i.test(runtimeText),
};

for (const failure of failures) {
	const recoverySeen =
		failure.kind === "edit_mismatch"
			? toolResults.some(
					(result) =>
						result.toolName === "edit" &&
						!result.isError &&
						result.resultSnippet.includes("Successfully replaced"),
				)
			: failure.kind === "missing_module"
				? toolResults.some(
						(result) =>
							result.toolName === "bash" &&
							!result.isError &&
							/demo_total =|Invoice #/i.test(result.resultSnippet),
					)
				: failure.kind === "read_guard"
					? toolCalls.some((call) => call.toolName === "read")
					: null;
	failure.recovered = recoverySeen;
}

const session = {
	id: sessionInfo?.id || null,
	version: sessionInfo?.version || null,
	startedAt: sessionInfo?.timestamp || null,
	cwd: sessionInfo?.cwd || workspaceDir,
	provider:
		turnTimeline.find((turn) => turn.provider)?.provider ||
		selectedModel.provider ||
		null,
	model: turnTimeline.find((turn) => turn.model)?.model || selectedModel.model,
	tools: allowedTools,
	extension: path.join(repoRoot, "index.ts"),
};

const timing = {
	wallMs: durationMs,
	timeToFirstAssistantMs:
		promptTimestamp !== null && firstAssistantTimestamp !== null
			? Math.max(0, firstAssistantTimestamp - promptTimestamp)
			: null,
	timeToFirstToolMs:
		promptTimestamp !== null && firstToolCallTimestamp !== null
			? Math.max(0, firstToolCallTimestamp - promptTimestamp)
			: null,
	firstPromptTimestamp: promptTimestamp,
	firstAssistantTimestamp,
	firstToolCallTimestamp,
	finalAssistantTimestamp,
	slowestTurn:
		turnTimeline.length > 0
			? turnTimeline.reduce((slowest, turn) =>
					(slowest?.durationMs || 0) >= (turn.durationMs || 0) ? slowest : turn,
				)
			: null,
};

const workflow = {
	turnCount: turnTimeline.length,
	toolCallCount: toolCalls.length,
	failedToolCalls: toolResults.filter((result) => result.isError).length,
	bashCallCount: toolCalls.filter((call) => call.toolName === "bash").length,
	readCallCount: toolCalls.filter((call) => call.toolName === "read").length,
	writeCallCount: toolCalls.filter((call) => call.toolName === "write").length,
	editCallCount: toolCalls.filter((call) => call.toolName === "edit").length,
	readBeforeFirstMutation: (() => {
		const firstMutationIndex = toolCalls.findIndex(
			(call) => call.toolName === "write" || call.toolName === "edit",
		);
		if (firstMutationIndex < 0) return null;
		return toolCalls
			.slice(0, firstMutationIndex)
			.some((call) => call.toolName === "read");
	})(),
	diagnosticsSurfaced:
		/diagnostic|clean ·|Found \d+ error|All checks passed|No module named|Could not find edits/i.test(
			runtimeText,
		),
	autoformatNoticeSeen: /modified by auto-format\/fix/i.test(runtimeText),
	autofixNoticeSeen: /Auto-fixed/i.test(runtimeText),
	lspUsed: toolCalls.some((call) => call.toolName === "lsp_navigation"),
	fileChangedNoticeSeen: runtimeSignals.fileChangedNotice,
	readGuardTriggered: runtimeSignals.readGuard,
	recoveredFailures: failures.filter((failure) => failure.recovered === true)
		.length,
};

const expectedWorkflow = manifest.expectedWorkflow || {};
const workflowChecks = [];
if (Object.hasOwn(expectedWorkflow, "readBeforeFirstMutation")) {
	workflowChecks.push({
		key: "readBeforeFirstMutation",
		expected: expectedWorkflow.readBeforeFirstMutation,
		actual: workflow.readBeforeFirstMutation,
		passed:
			workflow.readBeforeFirstMutation ===
			expectedWorkflow.readBeforeFirstMutation,
	});
}
if (Object.hasOwn(expectedWorkflow, "autoformatNoticeSeen")) {
	workflowChecks.push({
		key: "autoformatNoticeSeen",
		expected: expectedWorkflow.autoformatNoticeSeen,
		actual: workflow.autoformatNoticeSeen,
		passed:
			workflow.autoformatNoticeSeen === expectedWorkflow.autoformatNoticeSeen,
	});
}
if (Object.hasOwn(expectedWorkflow, "autofixNoticeSeen")) {
	workflowChecks.push({
		key: "autofixNoticeSeen",
		expected: expectedWorkflow.autofixNoticeSeen,
		actual: workflow.autofixNoticeSeen,
		passed: workflow.autofixNoticeSeen === expectedWorkflow.autofixNoticeSeen,
	});
}
if (Object.hasOwn(expectedWorkflow, "lspUsed")) {
	workflowChecks.push({
		key: "lspUsed",
		expected: expectedWorkflow.lspUsed,
		actual: workflow.lspUsed,
		passed: workflow.lspUsed === expectedWorkflow.lspUsed,
	});
}
if (Object.hasOwn(expectedWorkflow, "fileChangedNoticeSeen")) {
	workflowChecks.push({
		key: "fileChangedNoticeSeen",
		expected: expectedWorkflow.fileChangedNoticeSeen,
		actual: workflow.fileChangedNoticeSeen,
		passed:
			workflow.fileChangedNoticeSeen === expectedWorkflow.fileChangedNoticeSeen,
	});
}
if (Object.hasOwn(expectedWorkflow, "readGuardTriggered")) {
	workflowChecks.push({
		key: "readGuardTriggered",
		expected: expectedWorkflow.readGuardTriggered,
		actual: workflow.readGuardTriggered,
		passed: workflow.readGuardTriggered === expectedWorkflow.readGuardTriggered,
	});
}

const maxFailedToolCalls =
	typeof manifest.maxFailedToolCalls === "number"
		? manifest.maxFailedToolCalls
		: null;
const maxToolCallCount =
	typeof manifest.maxToolCallCount === "number"
		? manifest.maxToolCallCount
		: null;
const allowedFailureKinds = Array.isArray(manifest.allowedFailureKinds)
	? manifest.allowedFailureKinds
	: null;
const disallowedFailures = allowedFailureKinds
	? failures.filter((failure) => !allowedFailureKinds.includes(failure.kind))
	: [];

const success =
	child.status === 0 &&
	expectedFiles.every((entry) => entry.exists) &&
	expectedToolCalls.every((entry) => entry.called) &&
	forbiddenChangedFiles.every((entry) => !entry.changed) &&
	forbiddenToolCalls.every((entry) => !entry.called) &&
	expectedRuntimeMarkers.every((entry) => entry.seen) &&
	workflowChecks.every((check) => check.passed) &&
	(maxFailedToolCalls === null ||
		workflow.failedToolCalls <= maxFailedToolCalls) &&
	(maxToolCallCount === null || workflow.toolCallCount <= maxToolCallCount) &&
	disallowedFailures.length === 0;

const summary = {
	name: manifest.name,
	description: manifest.description || "",
	model,
	startupMode,
	cwd: workspaceDir,
	command: execution.command,
	commandArgs: execution.args,
	durationMs,
	exitCode: child.status,
	signal: child.signal,
	error: child.error ? String(child.error) : null,
	success,
	session,
	timing,
	workflow,
	expectedFiles,
	expectedToolCalls,
	expectedWorkflow,
	workflowChecks,
	maxFailedToolCalls,
	maxToolCallCount,
	allowedFailureKinds,
	disallowedFailures,
	forbiddenChangedFiles,
	forbiddenToolCalls,
	expectedRuntimeMarkers,
	runtimeSignals,
	allowedTools,
	toolCallCount: toolCalls.length,
	toolsUsed: [...new Set(toolCalls.map((call) => call.toolName))],
	toolCalls,
	toolResults,
	toolTimeline,
	turnTimeline,
	failures,
	assistantText: assistantText.trim(),
	stderrSnippet: stderr.slice(0, 4000),
};

const compactSummary = {
	name: manifest.name,
	success,
	exitCode: child.status,
	startupMode,
	durationMs,
	session: {
		provider: session.provider,
		model: session.model,
		startedAt: session.startedAt,
	},
	timing: {
		wallMs: timing.wallMs,
		timeToFirstAssistantMs: timing.timeToFirstAssistantMs,
		timeToFirstToolMs: timing.timeToFirstToolMs,
	},
	workflow,
	runtimeSignals,
	toolsUsed: summary.toolsUsed,
	toolCallCount: summary.toolCallCount,
	failureKinds: [...new Set(failures.map((failure) => failure.kind))],
	failedWorkflowChecks: workflowChecks
		.filter((check) => !check.passed)
		.map((check) => ({
			key: check.key,
			expected: check.expected,
			actual: check.actual,
		})),
	exceededMaxFailedToolCalls:
		maxFailedToolCalls !== null && workflow.failedToolCalls > maxFailedToolCalls
			? { actual: workflow.failedToolCalls, max: maxFailedToolCalls }
			: null,
	exceededMaxToolCallCount:
		maxToolCallCount !== null && workflow.toolCallCount > maxToolCallCount
			? { actual: workflow.toolCallCount, max: maxToolCallCount }
			: null,
	disallowedFailureKinds: [
		...new Set(disallowedFailures.map((failure) => failure.kind)),
	],
	missingExpectedFiles: expectedFiles
		.filter((entry) => !entry.exists)
		.map((entry) => entry.path),
	missingExpectedToolCalls: expectedToolCalls
		.filter((entry) => !entry.called)
		.map((entry) => entry.toolName),
	changedForbiddenFiles: forbiddenChangedFiles
		.filter((entry) => entry.changed)
		.map((entry) => entry.path),
	calledForbiddenTools: forbiddenToolCalls
		.filter((entry) => entry.called)
		.map((entry) => entry.toolName),
	missingRuntimeMarkers: expectedRuntimeMarkers
		.filter((entry) => !entry.seen)
		.map((entry) => entry.marker),
	artifacts: {
		runRoot,
		summary: path.join(runRoot, "summary.json"),
		compactSummary: path.join(runRoot, "compact-summary.json"),
		stdout: path.join(runRoot, "stdout.jsonl"),
		stderr: path.join(runRoot, "stderr.txt"),
		workspace: workspaceDir,
	},
};

fs.writeFileSync(
	path.join(runRoot, "summary.json"),
	JSON.stringify(summary, null, 2),
	"utf8",
);
fs.writeFileSync(
	path.join(runRoot, "compact-summary.json"),
	JSON.stringify(compactSummary, null, 2),
	"utf8",
);

console.log(JSON.stringify(compactSummary, null, 2));
if (!summary.success) process.exitCode = 1;
