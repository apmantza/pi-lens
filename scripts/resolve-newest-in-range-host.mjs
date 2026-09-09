#!/usr/bin/env node
/**
 * Resolve the newest published version of a package that satisfies BOTH the
 * range declared in this repo's package.json `peerDependencies` AND the
 * repo-owned `PI_HOST_SUPPORTED_RANGE` ceiling — what install-smoke.yml's
 * PR-gating "newest-in-range" lane installs (#2613, the #2590 recurrence).
 * See scripts/lib/resolve-newest-in-range-host.mjs for the pure selection
 * logic, why the peer range is read from package.json rather than
 * duplicated as a workflow input, and why a SECOND, repo-owned range is
 * required (review S1: the peer range is `"*"` today — unbounded on its
 * own, which would make this lane silently equal `@latest`).
 *
 * `npm view ... versions --json` is retried with backoff (review S3a: a
 * registry 429/5xx must not kill this BLOCKING step on the first hiccup) —
 * see scripts/lib/retry.mjs. Exhaustion is still a failure (this lane cannot
 * proceed without a resolved version), but is labelled distinctly in the
 * log so it reads as "registry unreachable after retrying", not "silently
 * hung then died once".
 *
 * Usage: node scripts/resolve-newest-in-range-host.mjs <package-name>
 * Prints the resolved version to stdout on success, and (when run under
 * GitHub Actions) also appends `version=<resolved>` to $GITHUB_OUTPUT.
 *
 * Exit codes:
 *   0  resolved a version
 *   2  infra failure — bad usage, unreadable package.json, or no declared
 *      peerDependencies range
 *   3  the registry was unreachable after retrying (`::error::infra: …`)
 *   4  PI_HOST_SUPPORTED_RANGE is unset, or the intersected range matched no
 *      published, non-prerelease version
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { retryWithBackoff } from "./lib/retry.mjs";
import {
	pickNewestInRange,
	readPeerRange,
	readSupportedRangeEnv,
	SUPPORTED_RANGE_ENV_VAR,
} from "./lib/resolve-newest-in-range-host.mjs";

const ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [0, 5_000, 15_000];
// Test-only override (never a production lever): a real 20s backoff would
// make the retry-exhaustion test a genuine wall-clock wait, multiplying this
// file's flake-shape footprint beyond the real-process-spawn it already
// carries. Comma-separated ms values, e.g. "0,0,0".
const BACKOFF_OVERRIDE_ENV_VAR = "RESOLVE_NEWEST_RETRY_BACKOFF_MS";

function backoffMsFrom(env) {
	const override = env?.[BACKOFF_OVERRIDE_ENV_VAR];
	if (!override) return DEFAULT_BACKOFF_MS;
	return override.split(",").map((v) => Number(v.trim()));
}

function fail(code, message) {
	console.error(message);
	process.exitCode = code;
}

function readVersionsOnce(packageName) {
	try {
		const raw = execFileSync(
			"npm",
			["view", packageName, "versions", "--json"],
			{ encoding: "utf-8", timeout: 60_000 },
		);
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return {
				ok: false,
				reason: `unexpected npm view output: ${raw.slice(0, 200)}`,
			};
		}
		return { ok: true, value: parsed };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { ok: false, reason };
	}
}

export async function main(argv, env) {
	const packageName = argv[0];
	if (!packageName) {
		fail(2, "usage: resolve-newest-in-range-host.mjs <package-name>");
		return;
	}

	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
	} catch (err) {
		fail(
			2,
			`cannot read package.json: ${err instanceof Error ? err.message : err}`,
		);
		return;
	}

	let peerRange;
	try {
		peerRange = readPeerRange(pkg, packageName);
	} catch (err) {
		fail(2, err instanceof Error ? err.message : String(err));
		return;
	}

	let supportedRange;
	try {
		supportedRange = readSupportedRangeEnv(env);
	} catch (err) {
		fail(4, err instanceof Error ? err.message : String(err));
		return;
	}

	const retried = await retryWithBackoff(
		() => Promise.resolve(readVersionsOnce(packageName)),
		{ attempts: ATTEMPTS, backoffMs: backoffMsFrom(env) },
	);
	if (!retried.ok) {
		console.error(
			`::error::infra: registry unreachable — npm view ${packageName} versions --json failed ${ATTEMPTS} times (${retried.reasons.join("; ")})`,
		);
		fail(3, `npm view ${packageName} versions --json: registry unreachable`);
		return;
	}

	const resolved = pickNewestInRange(retried.value, [
		peerRange,
		supportedRange,
	]);
	if (!resolved) {
		fail(
			4,
			`no published, non-prerelease version of ${packageName} satisfies peerDependencies range "${peerRange}" intersected with ${SUPPORTED_RANGE_ENV_VAR}="${supportedRange}"`,
		);
		return;
	}

	console.log(resolved);
	const githubOutput = env.GITHUB_OUTPUT;
	if (githubOutput) {
		fs.appendFileSync(githubOutput, `version=${resolved}\n`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await main(process.argv.slice(2), process.env);
	process.exit(process.exitCode ?? 0);
}
