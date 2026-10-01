/**
 * Delivery holds for the turn-end composer (#3813).
 *
 * A producer that marks something delivered (a latch, a drained queue, a
 * "retired after this delivery" record, a delivery counter) must not do it for
 * text `capTurnEndMessage` cuts. `handleTurnEnd` composes first and caps
 * last, so the producer cannot know at compose time; it registers a hold on
 * the part it produced, and the composer settles every hold once, after the
 * cap, against what the message actually kept.
 *
 * A hold carries one of two shapes, never both needed:
 *
 * - peek-then-commit: the producer left its state alone at compose time and
 *   `onDelivered` commits it (the past-EOF retirement, the dependency-drift
 *   count). A cut part commits nothing, so the state is still pending.
 * - drain-then-restore: the producer's state is already drained (a cascade
 *   run, a settled runner result, an auxiliary pair) and `onHeld` puts it
 *   back for the next turn.
 *
 * Reach rule, per part: the part is reached when it lies whole inside the kept
 * prefix, or when it LEADS the message and could not fit the cap even alone
 * (holding it would pin it forever, so its first delivery from the start is
 * its delivery). Anything else is held: a part the cap cut away, one that fits
 * alone yet was cut part-way, and an oversized part trailing others, of which
 * a sliver may show (#3813 review r1 F2).
 */

export interface DeliveryHold {
	/** The tier-array entry the hold rides on, as pushed (before any label). */
	part: string;
	/** The whole part reached the message: commit the producer's state. */
	onDelivered?: () => void;
	/** The cap cut the part: put the producer's state back. */
	onHeld?: () => void;
	/**
	 * False when the producer cannot keep the part for the next turn (a pair
	 * past its re-arm bound). Asked once, before the message is final, so a
	 * dropped part is neither promised in the marker nor counted as held.
	 */
	canHold?: () => boolean;
	/** The cap cut the part and `canHold` said no: record the loss. */
	onDropped?: () => void;
	/**
	 * A counter that only advances on a message the agent actually receives:
	 * not committed when the signature dedupe suppresses the turn (#1950 F1).
	 */
	skipOnSuppressed?: boolean;
}

/** One entry of the composed message: `raw` is what a hold names. */
export interface ComposedPart {
	raw: string;
	text: string;
}

export interface DeliveryHoldPlan {
	/** Cut parts that will stay pending, known before the message is final. */
	heldCount: number;
	/**
	 * Run each hold's callback once. `suppressed` is true when the message is
	 * not sent because it is identical to the last one delivered: its parts are
	 * text the agent already holds, so they settle as delivered.
	 */
	settle(options: {
		suppressed: boolean;
		isCurrentSession: () => boolean;
		onFault: (cause: unknown) => void;
	}): { delivered: number; held: number; dropped: number };
}

export function planDeliveryHolds(args: {
	holds: readonly DeliveryHold[];
	parts: readonly ComposedPart[];
	/** Chars of the `\n\n`-joined message the cap kept. */
	keptChars: number;
	separatorLength: number;
}): DeliveryHoldPlan {
	const byPart = new Map<string, DeliveryHold[]>();
	for (const hold of args.holds) {
		const queue = byPart.get(hold.part);
		if (queue) queue.push(hold);
		else byPart.set(hold.part, [hold]);
	}
	const settled: Array<{
		hold: DeliveryHold;
		reached: boolean;
		keeps: boolean;
	}> = [];
	let start = 0;
	for (const part of args.parts) {
		const end = start + part.text.length;
		const hold = byPart.get(part.raw)?.shift();
		if (hold) {
			const whole = end <= args.keptChars;
			// A part at offset 0 that the cap did not keep whole was cut by the cap
			// alone, so it could never fit: this delivery is its delivery.
			const leadsOversized = start === 0;
			const reached = whole || leadsOversized;
			settled.push({
				hold,
				reached,
				keeps: reached || (hold.canHold?.() ?? true),
			});
		}
		start = end + args.separatorLength;
	}
	return {
		heldCount: settled.reduce(
			(n, entry) => n + (entry.reached || !entry.keeps ? 0 : 1),
			0,
		),
		settle: ({ suppressed, isCurrentSession, onFault }) => {
			let delivered = 0;
			let held = 0;
			let dropped = 0;
			// A session replaced mid-turn owns none of this state any more.
			const live = isCurrentSession();
			for (const { hold, reached, keeps } of settled) {
				if (reached) delivered += 1;
				else if (keeps) held += 1;
				else dropped += 1;
				if (!live) continue;
				const run = reached
					? suppressed && hold.skipOnSuppressed
						? undefined
						: hold.onDelivered
					: keeps
						? hold.onHeld
						: hold.onDropped;
				if (!run) continue;
				try {
					run();
				} catch (cause) {
					onFault(cause);
				}
			}
			return { delivered, held, dropped };
		},
	};
}
