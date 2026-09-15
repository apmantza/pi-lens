/**
 * Rust clippy runner for dispatch system
 *
 * Runs `cargo clippy` for Rust files to catch common mistakes.
 */

import { isAbsolute, resolve } from "node:path";
import { rustClient } from "../../rust-client.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { stripAnsi } from "../../sanitize.js";
import {
	getLazyInstallAttempt,
	tryLazyInstall,
} from "./utils/lazy-installer.js";
import {
	describeInstallAttempt,
	logAvailabilityDecision,
} from "./utils/availability-policy.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";
import { resolveRunnerCwdWithReason } from "../../tool-cwd.js";
import { createCwdCachedProbe } from "./utils/runner-helpers.js";

// Cached per-cwd `cargo clippy --version` probe (#120). Before this, the
// probe fired on every Rust file save in a project where clippy was already
// installed.
//
// `tryLazyInstall("rust-clippy", cwd)` mutates installed state, so on a
// false initial result the runner needs a way to bust the cache and re-probe
// after install. We can't `delete` a Promise mid-flight, so the safe path
// is: if the cached probe resolves false AND the install just succeeded,
// fall back to a one-shot fresh probe rather than reusing the cached false.
//
// The verdict is governed by the shared availability policy (#1494): a probe
// timeout expires on a cooldown, so only a genuinely absent clippy latches.
const CLIPPY_PROBE_BUDGET_MS = 8000;
let clippyProbeRevision = 0;

const makeClippyProbe = (cargoExe: string, flightKeyComponent = cargoExe) =>
	createCwdCachedProbe(
		(cwd) =>
			safeSpawnAsync(cargoExe, ["clippy", "--version"], {
				timeout: CLIPPY_PROBE_BUDGET_MS,
				cwd,
			}),
		{
			tool: "clippy",
			budgetMs: CLIPPY_PROBE_BUDGET_MS,
			flightKeyComponent,
		},
	);

const clippyAvailabilityByCargo = new Map<
	string,
	ReturnType<typeof makeClippyProbe>
>();
function getClippyProbe(cargoExe: string) {
	return (
		clippyAvailabilityByCargo.get(cargoExe) ?? refreshClippyProbe(cargoExe)
	);
}

/** Replace the cached probe so a post-install state is observed. */
function refreshClippyProbe(cargoExe: string) {
	const created = makeClippyProbe(
		cargoExe,
		`${cargoExe}#refresh-${++clippyProbeRevision}`,
	);
	clippyAvailabilityByCargo.set(cargoExe, created);
	return created;
}

const rustClippyRunner: RunnerDefinition = {
	id: "rust-clippy",
	appliesTo: ["rust"],
	priority: PRIORITY.SPECIALIZED_ANALYSIS,
	timeoutMs: 90_000,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Resolve cargo path using platform-aware lookup (handles ~/.cargo/bin on Windows)
		const cargoExe = await rustClient.findCargoPathAsync();
		if (!cargoExe) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const clippyProbe = getClippyProbe(cargoExe);
		if (!(await clippyProbe(ctx.cwd))) {
			// A timed-out probe is not evidence that clippy is missing, so it must
			// not drive an install. Skip this turn and let the policy re-probe once
			// its cooldown expires (#1494).
			if (clippyProbe.getVerdict(ctx.cwd).outcome === "transient") {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
			await tryLazyInstall("rust-clippy", ctx.cwd);
			// Bust the cwd-keyed cache so the post-install state is observed. Held in
			// a local: `refreshClippyProbe` REPLACES the cached probe, so calling it
			// again to read the verdict would spend a second probe.
			const refreshedProbe = refreshClippyProbe(cargoExe);
			if (!(await refreshedProbe(ctx.cwd))) {
				// #1537: clippy is still absent, and the interesting question is WHY —
				// "we tried `rustup component add` and the network failed" is a
				// different fact from "this machine has no rustup", and until now the
				// lazy installers recorded neither. Put the attempt beside the verdict
				// it produced (#1500), so a reader does not have to infer the install
				// from a runner that silently skipped.
				const verdict = refreshedProbe.getVerdict(ctx.cwd);
				logAvailabilityDecision({
					tool: "rust-clippy",
					verdict: "unavailable",
					outcome: verdict.outcome ?? "missing",
					cause: verdict.cause ?? "not-found",
					classifiedBy: "caller",
					evidence: describeInstallAttempt(
						getLazyInstallAttempt("rust-clippy", ctx.cwd),
					),
					elapsedMs: 0,
					latched: false,
				});
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		// The package root (where Cargo.toml is), through the shared cwd seam
		// (#2894): the shared language marker vocabulary includes `Cargo.toml`, so
		// this IS the walk this runner used to do with `findNearestContaining` — plus
		// the seam's dispatch-root and `$HOME` ceilings, which the hand-rolled
		// walk had neither of. The gate then asks about exactly the directory
		// cargo will run in, rather than about a separately-derived one.
		const cargoResolution = resolveRunnerCwdWithReason(ctx, "rust-clippy");
		const cargoDir = cargoResolution.cwd;
		if (cargoResolution.marker !== "Cargo.toml") {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Run cargo clippy on the package
		const result = await safeSpawnAsync(
			cargoExe,
			["clippy", "--message-format=json", "-q"],
			{
				timeout: 60000,
				cwd: cargoDir,
			},
		);

		const raw = stripAnsi(result.stdout + result.stderr);

		if (result.status === 0 && !raw.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse JSON output. span.file is relative to the package root, so pass
		// the cargo dir to resolve diagnostics to absolute paths for filtering.
		const allDiagnostics = parseClippyOutput(raw, ctx.filePath, cargoDir);

		if (allDiagnostics.length === 0) {
			// Non-parseable output
			return {
				status: "failed",
				diagnostics: [],
				semantic: "warning",
				rawOutput: raw.substring(0, 500),
			};
		}

		// Lint-style policy (#265 B1): `cargo clippy` compiles the whole crate, so
		// a crate-mate's pre-existing diagnostic must NOT fail the edited file's
		// turn. Filter to the edited file like golangci-lint — if the edited file
		// is clean, this turn succeeds even when siblings carry warnings/errors.
		const absEdited = resolve(ctx.filePath);
		const diagnostics = allDiagnostics.filter(
			(d) => resolve(d.filePath) === absEdited,
		);

		const hasErrors = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors
				? "blocking"
				: diagnostics.length > 0
					? "warning"
					: "none",
		};
	},
};

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
 * #1802 fix round: the original review claimed rustc/clippy's top-level
 * `compiler-message.level` is genuinely two-valued (error/warning). A live
 * `cargo clippy --message-format=json` repro falsified that: rustc_errors's
 * `Level` serializes SIX values, and top-level messages with a real primary
 * span are NOT limited to error/warning —
 *
 *   - `"error"` — a hard compiler/lint error.
 *   - `"warning"` — the common clippy-lint case.
 *   - `"note"` — DOES appear as a top-level message with a non-empty primary
 *     span (repro: an erroneous-constant note pointing at the offending
 *     expression), not only as a `message.children[].level` annotation.
 *   - `"help"` — a top-level suggestion-carrying message.
 *   - `"failure-note"` — observed with an empty `spans` array, so it is
 *     already filtered out by the `if (!span) continue` guard below; no
 *     diagnostic is ever built from it. Verified, not assumed.
 *   - `"error: internal compiler error"` — an ICE. The old `level === "error"`
 *     exact-match ternary silently mapped this to `"warning"`, because the
 *     string doesn't equal `"error"` — an ICE must never be under-reported,
 *     so it is normalized to `"error"` here explicitly.
 *
 * `note`/`help` don't have a `"blocking"`-worthy tier of their own in the
 * four-valued `Diagnostic.severity`, so they land on the two quiet tiers:
 * `note` → `hint`, `help` → `info`. Blocking stays derived from the
 * *normalized* severity (not the raw string), which is what makes the ICE
 * case blocking too instead of silently passing.
 */
export function normalizeClippyLevel(
	raw: string | undefined,
): Diagnostic["severity"] {
	if (raw === "error") return "error";
	if (
		typeof raw === "string" &&
		raw.startsWith("error: internal compiler error")
	) {
		return "error";
	}
	if (raw === "note") return "hint";
	if (raw === "help") return "info";
	// "warning", "failure-note" (unreachable here, see above), and anything
	// unrecognized fall back to "warning" — the tier every clippy diagnostic
	// reported at before this fix.
	return "warning";
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

export function parseClippyOutput(
	raw: string,
	fallbackPath: string,
	cargoDir?: string,
): Diagnostic[] {
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

			// span.file is relative to the package root; resolve to absolute when
			// the cargo dir is known so callers can filter by edited file (#265 B1).
			const rawFile = span.file || span.file_name;
			const filePath = rawFile
				? cargoDir && !isAbsolute(rawFile)
					? resolve(cargoDir, rawFile)
					: rawFile
				: fallbackPath;

			// #1802: preserve clippy's real six-level vocabulary instead of
			// collapsing it. See `normalizeClippyLevel` above for the verified
			// mapping and the repro that falsified the original "two-valued"
			// claim. Blocking is derived from the NORMALIZED severity so an ICE
			// (`"error: internal compiler error"`) is blocking too, not just an
			// exact-match `"error"` string.
			const normalizedSeverity = normalizeClippyLevel(message.level);
			diagnostics.push({
				id: `clippy-${message.code?.code || "unknown"}`,
				message: message.message || "Clippy warning",
				filePath,
				line: span.line_start || 0,
				column: span.column_start || 0,
				severity: normalizedSeverity,
				semantic: normalizedSeverity === "error" ? "blocking" : "warning",
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
