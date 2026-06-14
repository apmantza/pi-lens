/**
 * Rust clippy runner for dispatch system
 *
 * Runs `cargo clippy` for Rust files to catch common mistakes.
 */

import { dirname, join } from "node:path";
import { findNearestContaining } from "../../path-utils.js";
import { RustClient } from "../../rust-client.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import { tryLazyInstall } from "./utils/lazy-installer.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";
import { createCwdCachedProbe } from "./utils/runner-helpers.js";

const rustClient = new RustClient();

// Cached per-cwd `cargo clippy --version` probe (#120). Before this, the
// probe fired on every Rust file save in a project where clippy was already
// installed.
//
// `tryLazyInstall("rust-clippy", cwd)` mutates installed state, so on a
// false initial result the runner needs a way to bust the cache and re-probe
// after install. We can't `delete` a Promise mid-flight, so the safe path
// is: if the cached probe resolves false AND the install just succeeded,
// fall back to a one-shot fresh probe rather than reusing the cached false.
const probeClippy = (cargoExe: string) =>
	createCwdCachedProbe(async (cwd) => {
		const r = await safeSpawnAsync(cargoExe, ["clippy", "--version"], {
			timeout: 8000,
			cwd,
		});
		return !r.error && r.status === 0;
	});

const clippyProbeByCargo = new Map<string, ReturnType<typeof probeClippy>>();
function getClippyProbe(cargoExe: string) {
	const existing = clippyProbeByCargo.get(cargoExe);
	if (existing) return existing;
	const created = probeClippy(cargoExe);
	clippyProbeByCargo.set(cargoExe, created);
	return created;
}

const rustClippyRunner: RunnerDefinition = {
	id: "rust-clippy",
	appliesTo: ["rust"],
	priority: PRIORITY.SPECIALIZED_ANALYSIS,
	enabledByDefault: true,
	timeoutMs: 90_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Resolve cargo path using platform-aware lookup (handles ~/.cargo/bin on Windows)
		const cargoExe = await rustClient.findCargoPathAsync();
		if (!cargoExe) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const clippyProbe = getClippyProbe(cargoExe);
		if (!(await clippyProbe(ctx.cwd))) {
			await tryLazyInstall("rust-clippy", ctx.cwd);
			// Bust the cwd-keyed cache so the post-install state is observed.
			clippyProbeByCargo.set(cargoExe, probeClippy(cargoExe));
			if (!(await getClippyProbe(cargoExe)(ctx.cwd))) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		// Find the package root (where Cargo.toml is)
		const cargoToml = findCargoToml(ctx.filePath);
		if (!cargoToml) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run cargo clippy on the package
		const result = await safeSpawnAsync(
			cargoExe,
			["clippy", "--message-format=json", "-q"],
			{
				timeout: 60000,
				cwd: cargoToml.replace("Cargo.toml", ""),
			},
		);

		const raw = stripAnsi(result.stdout + result.stderr);

		if (result.status === 0 && !raw.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse JSON output
		const diagnostics = parseClippyOutput(raw, ctx.filePath);

		if (diagnostics.length === 0) {
			// Non-parseable output
			return {
				status: "failed",
				diagnostics: [],
				semantic: "warning",
				rawOutput: raw.substring(0, 500),
			};
		}

		const hasErrors = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

function findCargoToml(filePath: string): string | undefined {
	const dir = findNearestContaining(dirname(filePath), ["Cargo.toml"]);
	return dir ? join(dir, "Cargo.toml") : undefined;
}

interface ClippySpan {
	file?: string;
	file_name?: string;
	line_start?: number;
	column_start?: number;
	suggested_replacement?: string;
	suggestion_applicability?:
		| "MachineApplicable"
		| "MaybeIncorrect"
		| "HasPlaceholders"
		| "Unspecified";
}

interface ClippyMessage {
	code?: { code?: string };
	message?: string;
	level?: string;
	spans?: ClippySpan[];
}

/**
 * Find a machine-applicable suggested replacement across the message's spans.
 * Clippy emits one diagnostic per warning but can attach the auto-fix to a
 * span other than the primary one (e.g. a fix that rewrites a use-site AND
 * removes the now-unused import). We treat the diagnostic as fixable if any
 * span carries a MachineApplicable suggestion — that's the applicability
 * level clippy promises is safe for `cargo clippy --fix` to apply without
 * human review.
 */
function findMachineApplicableSpan(
	spans: ClippySpan[],
): ClippySpan | undefined {
	return spans.find(
		(s) =>
			typeof s.suggested_replacement === "string" &&
			s.suggestion_applicability === "MachineApplicable",
	);
}

export function parseClippyOutput(raw: string, filePath: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const lines = raw.split("\n").filter((l) => l.trim());

	for (const line of lines) {
		try {
			const msg = JSON.parse(line);
			if (msg.reason !== "compiler-message") continue;

			const message: ClippyMessage | undefined = msg.message;
			if (!message) continue;

			// Only include messages for this file or project-wide
			const spans = message.spans ?? [];
			const span = spans[0];
			if (!span) continue;

			const fixableSpan = findMachineApplicableSpan(spans);

			diagnostics.push({
				id: `clippy-${message.code?.code || "unknown"}`,
				message: message.message || "Clippy warning",
				filePath: span.file || span.file_name || filePath,
				line: span.line_start || 0,
				column: span.column_start || 0,
				severity: message.level === "error" ? "error" : "warning",
				semantic: message.level === "error" ? "blocking" : "warning",
				tool: "rust-clippy",
				rule: message.code?.code,
				defectClass: "correctness",
				fixable: fixableSpan !== undefined,
				fixSuggestion: fixableSpan?.suggested_replacement,
			});
		} catch {
			// Not a JSON line, skip
		}
	}

	return diagnostics;
}

export default rustClippyRunner;
