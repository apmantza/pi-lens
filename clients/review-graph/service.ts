import type { FactStore } from "../dispatch/fact-store.js";
import { computeImpactCascade as computeImpactCascadeImpl } from "./query.js";
import { buildOrUpdateGraph as buildOrUpdateGraphImpl } from "./builder.js";
import { formatImpactCascade as formatImpactCascadeImpl } from "./format.js";
import type {
	ImpactCascadeResult,
	ReviewGraph,
} from "./types.js";

const CHANGED_SYMBOLS_PREFIX = "session.reviewGraph.changedSymbols:";
const ENTITY_SNAPSHOT_PREFIX = "session.reviewGraph.entitySnapshot:";

export async function buildOrUpdateGraph(
	cwd: string,
	changedFiles: string[],
	facts: FactStore,
): Promise<ReviewGraph> {
	return buildOrUpdateGraphImpl(cwd, changedFiles, facts);
}

export function computeImpactCascade(
	graph: ReviewGraph,
	changedFile: string,
): ImpactCascadeResult {
	return computeImpactCascadeImpl(graph, changedFile);
}

export function formatImpactCascade(
	result: ImpactCascadeResult,
): string | undefined {
	return formatImpactCascadeImpl(result);
}

export function recordEntitySnapshotDiff(
	facts: FactStore,
	filePath: string,
	nextSnapshot: Map<string, string>,
): { added: string[]; removed: string[]; modified: string[] } {
	const prev =
		facts.getSessionFact<Map<string, string>>(`${ENTITY_SNAPSHOT_PREFIX}${filePath}`) ??
		new Map<string, string>();
	const added: string[] = [];
	const removed: string[] = [];
	const modified: string[] = [];

	for (const [key, value] of nextSnapshot.entries()) {
		if (!prev.has(key)) added.push(key);
		else if (prev.get(key) !== value) modified.push(key);
	}
	for (const key of prev.keys()) {
		if (!nextSnapshot.has(key)) removed.push(key);
	}

	const changedSymbols = [
		...new Set(
			[...added, ...modified, ...removed]
				.map((key) => key.split(":")[1])
				.filter(Boolean),
		),
	];
	facts.setSessionFact(`${ENTITY_SNAPSHOT_PREFIX}${filePath}`, new Map(nextSnapshot));
	facts.setSessionFact(`${CHANGED_SYMBOLS_PREFIX}${filePath}`, changedSymbols);
	return { added, removed, modified };
}
