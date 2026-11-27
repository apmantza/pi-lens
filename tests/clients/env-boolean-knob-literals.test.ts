/**
 * #5419: the boolean `PI_LENS_*` switches flip only on the literal `"0"` or
 * `"1"` (`docs/environment-variables.md` "Boolean-style variables").
 *
 * Every other value, including `false`, `off`, `true` and blank, is the
 * switch's default. Before #5419 the four accepted `false` or `off` as a
 * switch-off, which the documented rule does not allow.
 *
 * Recurrence: #5419 (maintainer decision 2026-11-08): the four outliers
 * `PI_LENS_REVERSE_DEPS_REUSE`, `PI_LENS_GRAPH_SEQ_FASTPATH`,
 * `PI_LENS_SNAPSHOT_PERSIST_SYNC` and `PI_LENS_READ_GUARD_LOG_SNAPSHOTS`.
 * Recurrence: #5267: `PI_LENS_DISABLE_ORPHAN_BACKSTOP`, the test-harness
 * opt-out for arming the orphan backstop — a loosening of its `=== "1"`
 * check to a presence check survived the round-1 suite until this row pinned
 * the literal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { reverseDepsReuseEnabled } from "../../clients/dispatch/integration.js";
import { orphanBackstopSchedulingDisabled } from "../../clients/instance-reaper.js";
import { seqFastpathEnabled } from "../../clients/review-graph/builder.js";
import { snapshotWorkerEnabled } from "../../clients/project-snapshot.js";

const saved = new Map<string, string | undefined>();

function setKnob(key: string, value: string | undefined): void {
	if (!saved.has(key)) saved.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
	vi.restoreAllMocks();
});

/**
 * Each raw value the table feeds a switch. `"0"` and `"1"` are the only literals
 * that flip one; `"false"`, `"off"` and `"true"` are the spellings the four
 * outliers accepted before #5419.
 */
const RAW_VALUES: ReadonlyArray<
	readonly [label: string, raw: string | undefined]
> = [
	["unset", undefined],
	["blank", ""],
	["zero", "0"],
	["one", "1"],
	["false", "false"],
	["off", "off"],
	["true", "true"],
];

interface Switch {
	env: string;
	/** The value the switch reads as when the variable is unset or not a literal. */
	defaultOn: boolean;
	/** The one literal that flips it away from `defaultOn`. */
	flipLiteral: "0" | "1";
	read(): boolean;
}

const SWITCHES: readonly Switch[] = [
	{
		env: "PI_LENS_REVERSE_DEPS_REUSE",
		defaultOn: true,
		flipLiteral: "0",
		read: () => reverseDepsReuseEnabled(),
	},
	{
		env: "PI_LENS_GRAPH_SEQ_FASTPATH",
		defaultOn: true,
		flipLiteral: "0",
		read: () => seqFastpathEnabled(),
	},
	// The snapshot switch reports whether the persist worker is used: `"1"`
	// forces the synchronous writer, so the worker is off only for that literal.
	{
		env: "PI_LENS_SNAPSHOT_PERSIST_SYNC",
		defaultOn: true,
		flipLiteral: "1",
		read: () => snapshotWorkerEnabled(),
	},
	// #5267: the harness opt-out for arming the orphan backstop. Arming is on
	// by default and only the literal `"1"` skips the timer; a check loosened
	// to presence (`!== undefined`) reddens every non-literal row here.
	{
		env: "PI_LENS_DISABLE_ORPHAN_BACKSTOP",
		defaultOn: false,
		flipLiteral: "1",
		read: () => orphanBackstopSchedulingDisabled(),
	},
];

describe("#5419 the switches flip only on their literal", () => {
	it.each(
		SWITCHES.flatMap((sw) =>
			RAW_VALUES.map(([label, raw]) => [sw.env, label, raw, sw] as const),
		),
	)("%s reads %s as the contract says", (_env, _label, raw, sw) => {
		setKnob(sw.env, raw);
		const flipped = raw === sw.flipLiteral;
		expect(sw.read()).toBe(flipped ? !sw.defaultOn : sw.defaultOn);
	});
});

describe("#5419 the read-guard snapshot-validation log switch flips only on 0", () => {
	// Module-load constant: every row re-imports the built module under its own
	// environment. Its default is on, and only the literal "0" turns it off.
	it.each(RAW_VALUES)(
		"PI_LENS_READ_GUARD_LOG_SNAPSHOTS reads %s as the contract says",
		async (_label, raw) => {
			setKnob("PI_LENS_READ_GUARD_VERBOSE", undefined);
			setKnob("PI_LENS_READ_GUARD_LOG", undefined);
			setKnob("PI_LENS_READ_GUARD_LOG_SNAPSHOTS", raw);
			vi.resetModules();
			const readGuardLogger =
				await import("../../clients/read-guard-logger.js");
			expect(readGuardLogger.shouldLogEvent("range_snapshot_validation")).toBe(
				raw !== "0",
			);
		},
	);
});
