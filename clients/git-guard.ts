import type { CacheManager } from "./cache-manager.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";

function getShellCommand(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const raw = input as { command?: unknown; cmd?: unknown };
	if (typeof raw.command === "string") return raw.command;
	if (typeof raw.cmd === "string") return raw.cmd;
	return "";
}

export function isGitCommitOrPushAttempt(toolName: string, input: unknown): boolean {
	if (toolName !== "bash") return false;
	const cmd = getShellCommand(input).toLowerCase();
	if (!cmd) return false;
	return /(^|\s|&&|;|\|)git\s+(commit|push)(\s|$)/.test(cmd);
}

export function evaluateGitGuard(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
): { block: boolean; reason?: string } {
	const pending = cacheManager.readCache<{ content: string }>(
		"turn-end-findings",
		cwd,
	);
	const turnEndHasBlockers = !!pending?.data?.content;

	if (!runtime.gitGuardHasBlockers && !turnEndHasBlockers) {
		return { block: false };
	}

	const details = runtime.gitGuardSummary
		? `\n${runtime.gitGuardSummary}`
		: "";
	return {
		block: true,
		reason: `🔴 COMMIT BLOCKED (--lens-guard): unresolved blockers must be fixed before commit/push.${details}\nRun /lens-booboo for full details, then commit again.`,
	};
}
