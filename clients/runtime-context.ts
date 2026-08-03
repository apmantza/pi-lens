import type { CacheManager } from "./cache-manager.js";
import type { TurnEndFindingsCache } from "./git-guard.js";

export function consumeTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
): { messages: Array<{ role: "user"; content: string }> } | undefined {
	const findings = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content || findings.data.consumed === true) return;

	// A blocker record is also the opt-in commit gate's durable state. Mark the
	// context message consumed without deleting the record; clean/advisory-only
	// records retain the historical consume-and-clear behavior.
	if (
		findings.data.hasBlockers === true &&
		typeof findings.data.sessionId === "string"
	) {
		cacheManager.writeCache(
			"turn-end-findings",
			{ ...findings.data, consumed: true },
			cwd,
		);
	} else {
		cacheManager.clearCache("turn-end-findings", cwd);
	}

	return {
		messages: [
			{
				role: "user",
				content: `[pi-lens automated check — not a user request] Address 🔴 blockers before continuing; ℹ️ advisories are informational only.\n\n${findings.data.content}`,
			},
		],
	};
}

export function consumeTestFindings(
	cacheManager: CacheManager,
	cwd: string,
): { messages: Array<{ role: "user"; content: string }> } | undefined {
	const findings = cacheManager.readCache<{ content: string }>(
		"test-runner-findings",
		cwd,
	);
	if (!findings?.data?.content) return;

	cacheManager.writeCache(
		"test-runner-findings",
		null as unknown as { content: string },
		cwd,
	);

	return {
		messages: [
			{
				role: "user",
				content: `[pi-lens automated check — not a user request] Test failures detected last turn — fix before continuing:\n\n${findings.data.content}`,
			},
		],
	};
}

export function consumeSessionStartGuidance(
	cacheManager: CacheManager,
	cwd: string,
): { messages: Array<{ role: "user"; content: string }> } | undefined {
	const guidance = cacheManager.readCache<{ content: string }>(
		"session-start-guidance",
		cwd,
	);
	if (!guidance?.data?.content) return;

	cacheManager.writeCache(
		"session-start-guidance",
		null as unknown as { content: string },
		cwd,
	);

	return {
		messages: [
			{
				role: "user",
				content: `[pi-lens automated context — not a user request]\n\n${guidance.data.content}`,
			},
		],
	};
}
