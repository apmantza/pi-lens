import { getServersForFileWithConfig } from "./config.js";

export function groupFilesByPrimaryServer(
	files: readonly string[],
): Array<{ files: string[]; multiServer: boolean }> {
	const byServer = new Map<string, { files: string[]; multiServer: boolean }>();
	for (const filePath of files) {
		const servers = getServersForFileWithConfig(filePath);
		const primary = servers[0]?.id ?? "none";
		const group = byServer.get(primary);
		const fallbackFamilyHeads = new Map<string, string>();
		const familyHeads = servers.map((server) => {
			const head = server.fallbackFor
				? (fallbackFamilyHeads.get(server.fallbackFor) ?? server.fallbackFor)
				: server.id;
			fallbackFamilyHeads.set(server.id, head);
			return head;
		});
		const multiServer = new Set(familyHeads).size > 1;
		if (group) {
			group.files.push(filePath);
			if (multiServer) group.multiServer = true;
		} else {
			byServer.set(primary, { files: [filePath], multiServer });
		}
	}
	return [...byServer.values()];
}

export async function runPerServerGroups<
	G extends { files: readonly string[]; multiServer?: boolean },
>(
	groups: readonly G[],
	concurrency: number,
	processGroup: (group: G) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	let nextGroup = 0;
	const workers = Math.min(Math.max(1, concurrency), groups.length);
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (!signal?.aborted) {
				const gi = nextGroup;
				nextGroup += 1;
				if (gi >= groups.length) break;
				await processGroup(groups[gi]!);
			}
			return true;
		}),
	);
}
