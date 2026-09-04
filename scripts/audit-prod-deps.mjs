// Bounded, retrying wrapper around `npm audit --omit=dev --audit-level=high`
// for CI (ci.yml "Audit production dependencies").
//
// Why not the bare command: on 2026-09-04 the registry's audit endpoints
// degraded — each call hung ~5 minutes and then answered 400 ("Invalid
// package tree") from the retired quick endpoint — so a lockfile master had
// passed an hour earlier redded every PR's lint job. That is a registry
// outage, not a vulnerability, and the two must not fail the same way.
//
// Contract:
// - a real high/critical finding in PRODUCTION deps fails the step (exit 1)
//   exactly as before;
// - a registry/transport error is retried (bounded per attempt, backoff) and,
//   if every attempt fails, the step passes with a visible GitHub warning
//   annotation naming the outage — Dependabot security updates remain the
//   backstop for the window;
// - anything unparseable is treated as a transport error, never as clean.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ATTEMPTS = 3;
export const ATTEMPT_TIMEOUT_MS = 120_000;
export const BACKOFF_MS = [0, 15_000, 45_000];

/**
 * Decide what one `npm audit --json` attempt means.
 * @param {{ code: number | null, stdout: string, timedOut: boolean }} run
 * @returns {{ kind: "clean" } | { kind: "vulnerable", summary: string } | { kind: "transport", reason: string }}
 */
export function decideAudit(run) {
	if (run.timedOut) {
		return {
			kind: "transport",
			reason: `timed out after ${ATTEMPT_TIMEOUT_MS}ms`,
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(run.stdout);
	} catch {
		return { kind: "transport", reason: "audit output was not JSON" };
	}
	if (!parsed || typeof parsed !== "object") {
		return { kind: "transport", reason: "audit output was not an object" };
	}
	if (parsed.error) {
		const e = parsed.error;
		const detail = [e.code, e.summary ?? e.message].filter(Boolean).join(": ");
		return {
			kind: "transport",
			reason: detail || "audit endpoint returned an error",
		};
	}
	const counts = parsed.metadata?.vulnerabilities;
	if (!counts || typeof counts !== "object") {
		return {
			kind: "transport",
			reason: "audit output has no metadata.vulnerabilities",
		};
	}
	const high = Number(counts.high ?? 0);
	const critical = Number(counts.critical ?? 0);
	if (!Number.isFinite(high) || !Number.isFinite(critical)) {
		return {
			kind: "transport",
			reason: "vulnerability counts were not numbers",
		};
	}
	if (high + critical > 0) {
		const names = Object.entries(parsed.vulnerabilities ?? {})
			.filter(
				([, v]) => v && (v.severity === "high" || v.severity === "critical"),
			)
			.map(([name, v]) => `${name} (${v.severity})`);
		return {
			kind: "vulnerable",
			summary: `${high} high, ${critical} critical: ${names.join(", ") || "see npm audit"}`,
		};
	}
	if (run.code !== 0) {
		// npm exits non-zero for endpoint errors even when it printed a
		// vulnerability-free object; never read that as clean.
		return {
			kind: "transport",
			reason: `npm audit exited ${run.code} without findings`,
		};
	}
	return { kind: "clean" };
}

function runAuditOnce() {
	return new Promise((resolve) => {
		// Windows needs a shell for npm's .cmd shim; pass the whole command as one
		// argv entry rather than `shell: true` + args (DEP0190). CI runs on Linux;
		// the SIGKILL below may leave npm's child alive on Windows, which only
		// affects a local run.
		const args = ["audit", "--omit=dev", "--audit-level=high", "--json"];
		const child =
			process.platform === "win32"
				? spawn("cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], {
						stdio: ["ignore", "pipe", "inherit"],
					})
				: spawn("npm", args, { stdio: ["ignore", "pipe", "inherit"] });
		let stdout = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, ATTEMPT_TIMEOUT_MS);
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, timedOut });
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: null, stdout, timedOut });
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main() {
	const reasons = [];
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		if (BACKOFF_MS[attempt]) await sleep(BACKOFF_MS[attempt]);
		const verdict = decideAudit(await runAuditOnce());
		if (verdict.kind === "clean") {
			console.log(
				`audit: no high/critical vulnerabilities in production deps (attempt ${attempt + 1})`,
			);
			return 0;
		}
		if (verdict.kind === "vulnerable") {
			console.error(`audit: ${verdict.summary}`);
			return 1;
		}
		reasons.push(`attempt ${attempt + 1}: ${verdict.reason}`);
		console.error(`audit: transport failure, ${reasons[reasons.length - 1]}`);
	}
	const msg = `npm audit endpoint unavailable after ${ATTEMPTS} attempts (${reasons.join("; ")}) — production-dependency audit SKIPPED this run; Dependabot security updates remain the backstop`;
	console.log(`::warning title=npm audit skipped::${msg}`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `> ⚠️ ${msg}\n`);
	}
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await main();
}
