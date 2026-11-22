#!/usr/bin/env node
/**
 * Resolve the host version install-smoke.yml's PR-gating "newest-in-range"
 * lane installs: the npm dist-tag `latest` of the package, which must be a
 * stable release that satisfies the range declared in this repo's package.json
 * `peerDependencies`. There is no hand-kept ceiling (#5749, maintainer
 * decision 2026-11-22: the upper end of the tested host range is always the
 * latest pi); the floor is install-smoke.yml's PI_HOST_FLOOR_VERSION, read by
 * the floor cell. See scripts/lib/resolve-newest-in-range-host.mjs for the
 * acceptance logic and why the peer range is read from package.json rather
 * than duplicated as a workflow input.
 *
 * `npm view ... dist-tags --json` is retried with backoff (review S3a: a
 * registry 429/5xx must not kill this BLOCKING step on the first hiccup) —
 * see scripts/lib/retry.mjs. Exhaustion is a failure (this lane cannot proceed
 * without a resolved version) and never a fallback to an older host: the lane
 * fails closed, labelled distinctly in the log so it reads as "registry
 * unreachable after retrying", not "silently hung then died once".
 *
 * Usage: node scripts/resolve-newest-in-range-host.mjs <package-name>
 * Prints the resolved version to stdout on success, and (when run under
 * GitHub Actions) also appends `version=<resolved>` to $GITHUB_OUTPUT.
 *
 * Exit codes:
 *   0  resolved a version
 *   2  infra failure — bad usage, unreadable package.json, or no declared
 *      peerDependencies range
 *   3  the registry was unreachable after retrying, or its answer carried no
 *      `latest` dist-tag (`::error::infra: …`)
 *   4  the `latest` dist-tag is a prerelease, or does not satisfy the
 *      declared peerDependencies range
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { retryWithBackoff } from "./lib/retry.mjs";
import {
	isAcceptableLatestHost,
	readPeerRange,
} from "./lib/resolve-newest-in-range-host.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

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

function readLatestOnce(packageName) {
	try {
		const raw = execFileSync(
			"npm",
			["view", packageName, "dist-tags", "--json"],
			{ encoding: "utf-8", timeout: 60_000 },
		);
		const latest = JSON.parse(raw)?.latest;
		if (typeof latest !== "string") {
			return {
				ok: false,
				reason: `no "latest" dist-tag in npm view output: ${raw.slice(0, 200)}`,
			};
		}
		return { ok: true, value: latest };
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

	const retried = await retryWithBackoff(
		() => Promise.resolve(readLatestOnce(packageName)),
		{ attempts: ATTEMPTS, backoffMs: backoffMsFrom(env) },
	);
	if (!retried.ok) {
		console.error(
			`::error::infra: registry unreachable — npm view ${packageName} dist-tags --json failed ${ATTEMPTS} times (${retried.reasons.join("; ")})`,
		);
		fail(3, `npm view ${packageName} dist-tags --json: registry unreachable`);
		return;
	}

	const resolved = retried.value;
	if (!isAcceptableLatestHost(resolved, peerRange)) {
		fail(
			4,
			`the "latest" dist-tag of ${packageName} is "${resolved}", which is not a stable release satisfying peerDependencies range "${peerRange}"`,
		);
		return;
	}

	console.log(resolved);
	const githubOutput = env.GITHUB_OUTPUT;
	if (githubOutput) {
		fs.appendFileSync(githubOutput, `version=${resolved}\n`);
	}
}

if (isMainModule(import.meta.url)) {
	await main(process.argv.slice(2), process.env);
	process.exit(process.exitCode ?? 0);
}
