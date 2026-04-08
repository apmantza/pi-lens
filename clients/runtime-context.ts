import type { CacheManager } from "./cache-manager.js";

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
				content: `[pi-lens] End-of-turn findings:\n\n${findings.data.content}`,
			},
		],
	};
}

export function consumeSessionStartGuidance(
	cacheManager: CacheManager,
	cwd: string,
): { messages: Array<{ role: "system"; content: string }> } | undefined {
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
				role: "system",
				content: `[pi-lens] Session guidance:\n\n${guidance.data.content}`,
			},
		],
	};
}
