/**
 * Automatic test-runner delivery for the post-agent idle window (#2366).
 *
 * Test results remain in `test-runner-findings` for pull diagnostics and the
 * commit guard. This module stages an owner-qualified pointer and marks it
 * eligible for the next context build after the host proves that the agent is
 * idle. Provenance validation stays in `peekTestFindings`, the one shared
 * delivery gate for this cache.
 */

import type { CacheManager } from "./cache-manager.js";
import { emitBounded } from "./bounded-telemetry.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { consumeTestFindings, peekTestFindings } from "./runtime-context.js";

const MAX_PENDING_DELIVERIES = 32;

interface PendingDelivery {
	cwd: string;
	sessionId: string;
	ownerId?: string;
	generation: number;
	targetCount: number;
	createdAt: number;
	eligible: boolean;
	rehydrated?: boolean;
	owner?: TestRunnerDeliveryOwner;
}

const pending = new Map<string, PendingDelivery>();

export interface TestRunnerDeliveryOwner {
	ownerId: string;
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

function record(
	identity: string,
	outcome:
		| "staged"
		| "eligible"
		| "delivered"
		| "superseded"
		| "carried"
		| "foreign-session"
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
				outcome === "delivery-failed" ? "test-runner-delivery" : undefined,
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
			eligible: false,
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
		eligible: false,
		owner: args.owner,
	};
	pending.set(deliveryKey, delivery);
	prunePending();
	record(deliveryKey, "staged", delivery);
}

/** Mark the latest staged result eligible during a host-confirmed idle window. */
export function deliverTestRunnerFindings(args: {
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
		record(deliveryKey, "superseded", delivery, { currentGeneration });
		return;
	}
	if (typeof args.ctx.isIdle !== "function") {
		pending.delete(deliveryKey);
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
	if (!peekTestFindings(args.cacheManager, cwd, args.runtime, true)) {
		pending.delete(deliveryKey);
		record(deliveryKey, "superseded", delivery);
		return;
	}
	// Recheck immediately before marking eligible. The host may accept a prompt
	// between the first check and this synchronous call.
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
	delivery.eligible = true;
	const current = args.cacheManager.readCache<{
		content: string;
		testRunGeneration?: number;
		[key: string]: unknown;
	}>("test-runner-findings", cwd)?.data;
	if (!current?.content || current.testRunGeneration !== delivery.generation) {
		pending.delete(deliveryKey);
		return;
	}
	args.cacheManager.writeCache(
		"test-runner-findings",
		{
			...current,
			deliveryEligible: {
				sessionId: delivery.sessionId,
				generation: delivery.generation,
				eligibleAt: Date.now(),
			},
		},
		cwd,
	);
	record(deliveryKey, "eligible", delivery, {
		ageMs: Math.max(0, Date.now() - delivery.createdAt),
	});
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
		ctx: delivery.owner.getCtx(),
		cacheManager: delivery.owner.cacheManager,
		runtime: delivery.owner.runtime,
		sessionId: delivery.sessionId,
		ownerId: delivery.ownerId,
	});
}

/** Consume the result made eligible by the settled idle boundary. */
export function consumeStagedTestRunnerFindings(args: {
	cwd: string;
	sessionId: string;
	ownerId?: string;
	cacheManager: CacheManager;
	runtime: RuntimeCoordinator;
}): ReturnType<typeof consumeTestFindings> {
	const deliveryKey = key(args.cwd, args.sessionId, args.ownerId);
	let delivery = pending.get(deliveryKey);
	const persisted = args.cacheManager.readCache<{
		content: string;
		testRunGeneration?: number;
		deliveryEligible?: {
			sessionId: string;
			generation: number;
			eligibleAt: number;
		};
	}>("test-runner-findings", args.cwd)?.data;
	const eligible = persisted?.deliveryEligible;
	if (!delivery && persisted?.content && eligible) {
		const sameSession = eligible.sessionId === args.sessionId;
		if (!sameSession) {
			const foreignDelivery: PendingDelivery = {
				cwd: args.cwd,
				sessionId: eligible.sessionId,
				generation: eligible.generation,
				targetCount: 0,
				createdAt: eligible.eligibleAt,
				eligible: true,
				rehydrated: true,
			};
			record(deliveryKey, "foreign-session", foreignDelivery, {
				currentSessionId: args.sessionId,
				currentOwnerId: args.ownerId,
				reason: "session-mismatch",
			});
			return undefined;
		}
		delivery = {
			cwd: args.cwd,
			sessionId: args.sessionId,
			ownerId: args.ownerId,
			generation: eligible.generation,
			targetCount: 0,
			createdAt: eligible.eligibleAt,
			eligible: true,
			rehydrated: true,
		};
		pending.set(deliveryKey, delivery);
	}
	if (!delivery?.eligible) return undefined;
	const currentGeneration = persisted?.testRunGeneration;
	if (currentGeneration !== delivery.generation) {
		pending.delete(deliveryKey);
		record(deliveryKey, "superseded", delivery, { currentGeneration });
		return undefined;
	}
	const findings = consumeTestFindings(
		args.cacheManager,
		args.cwd,
		args.runtime,
	);
	if (!findings) {
		pending.delete(deliveryKey);
		record(deliveryKey, "superseded", delivery);
		return undefined;
	}
	pending.delete(deliveryKey);
	record(deliveryKey, "delivered", delivery, {
		ageMs: Math.max(0, Date.now() - delivery.createdAt),
		rehydrated: delivery.rehydrated === true,
	});
	return findings;
}

/** Test-only reset; session ownership prevents cross-session consumption. */
export function _resetTestRunnerDeliveryForTests(): void {
	pending.clear();
}

/** Clear staged results when a primary session replaces the owning runtime. */
export function resetTestRunnerDelivery(): void {
	pending.clear();
}
