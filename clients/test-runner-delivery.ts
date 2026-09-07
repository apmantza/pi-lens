/**
 * Automatic test-runner delivery for the post-agent idle window (#2366).
 *
 * Test results remain in `test-runner-findings` for pull diagnostics and the
 * commit guard. This module only stages an owner-qualified pointer and
 * appends a non-context custom entry after the host proves that the agent is
 * idle. Provenance validation stays in `peekTestFindings`, the one shared
 * delivery gate for this cache.
 */

import type {
	EntryRenderer,
	ExtensionAPI,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { CacheManager } from "./cache-manager.js";
import { emitBounded } from "./bounded-telemetry.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { peekTestFindings } from "./runtime-context.js";
import { fitLines } from "./tui-fit.js";
import type { Component } from "./deps/pi-tui.js";

const TEST_RUNNER_ENTRY_TYPE = "pilens:test-runner-findings";
const MAX_PENDING_DELIVERIES = 32;
const MAX_ENTRY_CONTENT = 12_000;

interface TestRunnerDeliveryEntry {
	content: string;
	sessionId: string;
	generation: number;
	targetCount: number;
	droppedDetailCount: number;
}

interface PendingDelivery {
	cwd: string;
	sessionId: string;
	ownerId?: string;
	generation: number;
	targetCount: number;
	createdAt: number;
	owner?: TestRunnerDeliveryOwner;
}

const pending = new Map<string, PendingDelivery>();

export interface TestRunnerDeliveryOwner {
	ownerId: string;
	pi: ExtensionAPI;
	cacheManager: CacheManager;
	runtime: RuntimeCoordinator;
	getCtx: () => {
		cwd?: string;
		isIdle?: () => boolean;
	};
}

function key(cwd: string, sessionId: string, ownerId?: string): string {
	// `cwd` comes from the same host session field at turn_end and settle. Keep
	// that canonical value unchanged so cache reads use the identical workspace
	// identity; dispatch contexts already normalize their own path fields.
	return `${ownerId ?? "direct"}\u0000${cwd}\u0000${sessionId}`;
}

function boundedContent(content: string): {
	content: string;
	droppedDetailCount: number;
} {
	if (content.length <= MAX_ENTRY_CONTENT)
		return { content, droppedDetailCount: 0 };
	return {
		content: `${content.slice(0, MAX_ENTRY_CONTENT)}\n[…details truncated]`,
		droppedDetailCount: content.length - MAX_ENTRY_CONTENT,
	};
}

function record(
	identity: string,
	outcome:
		| "staged"
		| "delivered"
		| "superseded"
		| "carried"
		| "capability-unavailable"
		| "delivery-failed",
	delivery: PendingDelivery,
	metadata: Record<string, unknown> = {},
): void {
	emitBounded(
		"test_runner_delivery",
		identity,
		{
			filePath: delivery.cwd,
			durationMs: 0,
			metadata: {
				outcome,
				sessionId: delivery.sessionId,
				generation: delivery.generation,
				targetCount: delivery.targetCount,
				deliveryBoundary: "agent_settled",
				ownership: "pi",
				droppedDetailCount: 0,
				...metadata,
			},
		},
		{
			capPerTurn: { limit: 8, turnIndex: delivery.generation },
			ledgerKind:
				outcome === "delivery-failed" || outcome === "capability-unavailable"
					? "test-runner-delivery"
					: undefined,
			reason: `test runner delivery ${outcome}`,
		},
	);
}

function prunePending(): void {
	while (pending.size > MAX_PENDING_DELIVERIES) {
		const oldest = pending.keys().next();
		if (oldest.done) return;
		pending.delete(oldest.value);
	}
}

/** Stage the newest result for this session. Clean results supersede failures. */
export function stageTestRunnerDelivery(args: {
	cwd: string;
	sessionId: string;
	owner?: TestRunnerDeliveryOwner;
	generation: number;
	targetCount: number;
	hasFindings: boolean;
}): void {
	const deliveryKey = key(args.cwd, args.sessionId, args.owner?.ownerId);
	const prior = pending.get(deliveryKey);
	if (prior && prior.generation > args.generation) {
		const superseded: PendingDelivery = {
			cwd: args.cwd,
			sessionId: args.sessionId,
			ownerId: args.owner?.ownerId,
			generation: args.generation,
			targetCount: args.targetCount,
			createdAt: Date.now(),
			owner: args.owner,
		};
		record(deliveryKey, "superseded", superseded, {
			currentGeneration: prior.generation,
		});
		return;
	}
	if (!args.hasFindings) {
		if (prior) {
			pending.delete(deliveryKey);
			record(deliveryKey, "superseded", {
				...prior,
				targetCount: args.targetCount,
				generation: args.generation,
			});
		}
		return;
	}
	const delivery: PendingDelivery = {
		cwd: args.cwd,
		sessionId: args.sessionId,
		ownerId: args.owner?.ownerId,
		generation: args.generation,
		targetCount: args.targetCount,
		createdAt: Date.now(),
		owner: args.owner,
	};
	pending.set(deliveryKey, delivery);
	prunePending();
	record(deliveryKey, "staged", delivery);
}

/** Deliver the latest staged result during a host-confirmed idle window. */
export function deliverTestRunnerFindings(args: {
	pi: ExtensionAPI;
	ctx: {
		cwd?: string;
		isIdle?: () => boolean;
	};
	cacheManager: CacheManager;
	runtime: RuntimeCoordinator;
	sessionId: string;
	ownerId?: string;
}): void {
	const cwd = args.ctx.cwd ?? process.cwd();
	const deliveryKey = key(cwd, args.sessionId, args.ownerId);
	const delivery = pending.get(deliveryKey);
	if (!delivery) return;
	const currentGeneration = args.cacheManager.readCache<{
		testRunGeneration?: number;
	}>("test-runner-findings", cwd)?.data?.testRunGeneration;
	if (
		currentGeneration !== undefined &&
		currentGeneration > delivery.generation
	) {
		pending.delete(deliveryKey);
		record(deliveryKey, "superseded", delivery, {
			currentGeneration,
		});
		return;
	}
	if (typeof args.ctx.isIdle !== "function") {
		pending.delete(deliveryKey);
		record(deliveryKey, "capability-unavailable", delivery, {
			reason: "host does not expose ctx.isIdle",
		});
		return;
	}
	try {
		if (!args.ctx.isIdle()) {
			record(deliveryKey, "carried", delivery);
			return;
		}
	} catch (error) {
		record(deliveryKey, "delivery-failed", delivery, {
			error: String(error).slice(0, 500),
		});
		return;
	}
	const findings = peekTestFindings(args.cacheManager, cwd, args.runtime, true);
	if (!findings) {
		pending.delete(deliveryKey);
		record(deliveryKey, "superseded", delivery);
		return;
	}
	// Recheck immediately before append. The host may accept a prompt between
	// the first check and this synchronous call.
	try {
		if (!args.ctx.isIdle()) {
			record(deliveryKey, "carried", delivery);
			return;
		}
	} catch (error) {
		record(deliveryKey, "delivery-failed", delivery, {
			error: String(error).slice(0, 500),
		});
		return;
	}
	// SAFETY: appendEntry is an optional host capability absent from older Pi SDKs.
	const appendEntry = (
		args.pi as unknown as {
			appendEntry?: (customType: string, data: TestRunnerDeliveryEntry) => void;
		}
	).appendEntry;
	if (typeof appendEntry !== "function") {
		pending.delete(deliveryKey);
		record(deliveryKey, "capability-unavailable", delivery);
		return;
	}
	const bounded = boundedContent(findings.messages[0]?.content ?? "");
	try {
		appendEntry.call(args.pi, TEST_RUNNER_ENTRY_TYPE, {
			...bounded,
			sessionId: delivery.sessionId,
			generation: delivery.generation,
			targetCount: delivery.targetCount,
		});
		pending.delete(deliveryKey);
		record(deliveryKey, "delivered", delivery, {
			droppedDetailCount: bounded.droppedDetailCount,
			ageMs: Math.max(0, Date.now() - delivery.createdAt),
		});
	} catch (error) {
		record(deliveryKey, "delivery-failed", delivery, {
			error: String(error).slice(0, 500),
		});
	}
}

/** Deliver only the result staged by this activation and settled session. */
export function deliverStagedTestRunnerFindings(args?: {
	cwd?: string;
	sessionId?: string;
	ownerId?: string;
}): void {
	if (!args?.cwd || !args.ownerId) return;
	const delivery = args.sessionId
		? pending.get(key(args.cwd, args.sessionId, args.ownerId))
		: [...pending.values()]
				.reverse()
				.find(
					(candidate) =>
						candidate.cwd === args.cwd && candidate.ownerId === args.ownerId,
				);
	if (!delivery?.owner) return;
	deliverTestRunnerFindings({
		pi: delivery.owner.pi,
		ctx: delivery.owner.getCtx(),
		cacheManager: delivery.owner.cacheManager,
		runtime: delivery.owner.runtime,
		sessionId: delivery.sessionId,
		ownerId: delivery.ownerId,
	});
}

export function registerTestRunnerEntryRenderer(pi: ExtensionAPI): boolean {
	// SAFETY: registerEntryRenderer is an optional host capability absent from older Pi SDKs.
	const register = (
		pi as unknown as {
			registerEntryRenderer?: (
				customType: string,
				renderer: EntryRenderer<TestRunnerDeliveryEntry>,
			) => void;
		}
	).registerEntryRenderer;
	if (typeof register !== "function") return false;
	try {
		register.call(pi, TEST_RUNNER_ENTRY_TYPE, renderTestRunnerEntry);
		return true;
	} catch {
		return false;
	}
}

type TestRunnerEntry = Parameters<EntryRenderer<TestRunnerDeliveryEntry>>[0];

function renderTestRunnerEntry(
	entry: TestRunnerEntry,
	_options: { expanded: boolean },
	theme: Theme,
): Component | undefined {
	const content = entry.data?.content;
	if (typeof content !== "string") return undefined;
	const lines = [
		theme.fg("error", "pi-lens test failures"),
		...content.split("\n"),
	];
	return {
		render: (width: number) => fitLines(lines, width),
		invalidate: () => {},
	};
}

/** Test-only reset; session ownership prevents cross-session consumption. */
export function _resetTestRunnerDeliveryForTests(): void {
	pending.clear();
}

/** Clear staged results when a primary session replaces the owning runtime. */
export function resetTestRunnerDelivery(): void {
	pending.clear();
}
