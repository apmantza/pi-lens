import type { CacheManager } from "../cache-manager.js";

export function consumeTurnEndFindings(
	cacheManager: CacheManager,
	cwd: string,
): { messages: Array<{ role: "user"; content: string }> } | undefined {
	const findings = cacheManager.readCache<{ content: string }>(
		"turn-end-findings",
		cwd,
	);
	if (!findings?.data?.content) return;

	cacheManager.writeCache(
		"turn-end-findings",
		null as unknown as { content: string },
		cwd,
	);

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
