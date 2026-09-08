#!/usr/bin/env node
/**
 * Bounded, retrying wrapper around a single `npm` invocation, for CI network
 * calls that can hit a transient registry error (429/5xx/timeout) — the
 * install-smoke.yml host-range-smoke / host-latest-smoke lanes' `npm ci` and
 * `npm install` calls are all BLOCKING (or advisory-but-meant-to-succeed)
 * steps a registry hiccup must not silently kill the same way a real
 * dependency conflict does (#2613 review S3a). Same attempts/backoff shape
 * scripts/audit-prod-deps.mjs (#2579) established for the production-
 * dependency audit step; see scripts/lib/retry.mjs for the shared loop this
 * and scripts/resolve-newest-in-range-host.mjs (which needs to CAPTURE
 * `npm view`'s stdout, unlike this passthrough wrapper) both build on.
 *
 * Timeout, spawn-error, or NET_PATTERN-shaped failures are retryable.
 * Network evidence wins when it appears with a deterministic npm code:
 * losing a legitimate retry is worse than one redundant retry. Deterministic
 * npm errors (ERESOLVE, E404, EINTEGRITY, and ETARGET) stop after one attempt
 * when no network evidence appears. Unknown non-network failures retain the
 * previous retry behavior. On retryable exhaustion, this preserves the
 * origin/master annotation `::error::infra: registry unreachable — npm ...
 * failed 3 times`; deterministic failures print a plain `failed after N
 * attempt(s)` line instead. E404 stays deterministic because npm uses it for
 * a missing pinned version; transient mirror 404s are rare and the
 * install-smoke lane would resurface them.
 *
 * Usage: node scripts/npm-retry.mjs <npm subcommand + args...>
 * Test-only backoff override: NPM_RETRY_BACKOFF_MS="0,0,0" (comma-separated
 * ms) — see resolve-newest-in-range-host.mjs's identical override for why.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NET_PATTERN } from "./lib/ci-failure-classifier.mjs";
import { retryWithBackoff } from "./lib/retry.mjs";

const ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [0, 5_000, 15_000];
const BACKOFF_OVERRIDE_ENV_VAR = "NPM_RETRY_BACKOFF_MS";
const ATTEMPT_TIMEOUT_MS = 120_000;
const DETERMINISTIC_ERROR_PATTERN = /\b(?:ERESOLVE|E404|EINTEGRITY|ETARGET)\b/i;

/**
 * Classify one npm attempt. Network evidence is checked first so mixed output
 * cannot turn a recoverable registry failure into a one-attempt stop.
 * @param {string} stderr
 * @param {{ timedOut?: boolean, error?: Error, code?: number | null }} [run]
 * @returns {{ retryable: boolean, reason: string }}
 */
export function classifyNpmFailure(stderr, run = {}) {
	const networkMatch = NET_PATTERN.exec(stderr);
	if (run.timedOut) {
		return {
			retryable: true,
			reason: `timed out after ${ATTEMPT_TIMEOUT_MS}ms`,
		};
	}
	if (run.error) {
		return { retryable: true, reason: `spawn error: ${run.error.message}` };
	}
	if (networkMatch) {
		return { retryable: true, reason: `network error: ${networkMatch[0]}` };
	}
	const deterministicMatch = DETERMINISTIC_ERROR_PATTERN.exec(stderr);
	return {
		retryable: !deterministicMatch,
		reason: `exited ${run.code ?? 1}${deterministicMatch ? ` (${deterministicMatch[0]})` : ""}`,
	};
}

function backoffMsFrom(env) {
	const override = env?.[BACKOFF_OVERRIDE_ENV_VAR];
	if (!override) return DEFAULT_BACKOFF_MS;
	return override.split(",").map((v) => Number(v.trim()));
}

function runOnce(args) {
	return new Promise((resolvePromise) => {
		const child = spawn("npm", args, { stdio: ["inherit", "inherit", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			process.stderr.write(text);
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, ATTEMPT_TIMEOUT_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code, timedOut, stderr });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			resolvePromise({ code: null, timedOut: false, error: err, stderr });
		});
	});
}

export async function main(args, env) {
	if (args.length === 0) {
		console.error("usage: npm-retry.mjs <npm subcommand + args...>");
		return 2;
	}

	let lastCode = 1;
	const result = await retryWithBackoff(
		async (attempt) => {
			const run = await runOnce(args);
			lastCode = run.code ?? 1;
			if (run.code === 0) return { ok: true, value: run };
			const { retryable, reason } = classifyNpmFailure(run.stderr, run);
			console.error(`npm-retry: attempt ${attempt + 1} ${reason}`);
			return { ok: false, reason, retryable };
		},
		{ attempts: ATTEMPTS, backoffMs: backoffMsFrom(env) },
	);

	if (result.ok) {
		if (result.attempt > 0) {
			// stderr, not stdout (#2613 review follow-through): a caller that
			// captures this script's stdout for the wrapped command's OWN
			// output (scripts/resolve-newest-in-range-host.mjs's `npm view`,
			// captured via `$(...)`) must see ONLY that output — a diagnostic
			// line on stdout would silently corrupt the captured value the
			// moment a retry ever succeeds.
			console.error(`npm-retry: succeeded on attempt ${result.attempt + 1}`);
		}
		return 0;
	}

	const attemptsUsed = result.reasons.length;
	const networkRetry = result.reasons.some(
		(reason) =>
			reason.startsWith("timed out") ||
			reason.startsWith("spawn error") ||
			reason.startsWith("network error"),
	);
	const summary = networkRetry
		? `npm ${args.join(" ")} failed ${attemptsUsed} times`
		: `npm ${args.join(" ")} failed after ${attemptsUsed} attempt${attemptsUsed === 1 ? "" : "s"}`;
	if (networkRetry) {
		console.error(
			`::error::infra: registry unreachable — ${summary} (${result.reasons.join("; ")})`,
		);
	} else {
		console.error(`${summary} (${result.reasons.join("; ")})`);
	}
	return lastCode || 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await main(process.argv.slice(2), process.env);
}
