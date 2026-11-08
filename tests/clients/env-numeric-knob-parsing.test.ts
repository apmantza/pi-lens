/**
 * #5419: one parse for the non-negative integer `PI_LENS_*` knobs.
 *
 * Every knob in the table reads its value through the production reader the
 * built module exports (or, for a module-load constant, through a fresh import
 * of the built module). The contract the table pins, for every knob:
 *
 * - unset, blank and whitespace-only values mean the default;
 * - an explicit `0` is a value, not the default (before #5419 it was the
 *   default for the five `Math.max(0, parseInt(…) || d)` constants, and a blank
 *   value was 0 for the `Number(raw) >= 0` readers);
 * - a non-numeric or negative value means the default.
 *
 * Recurrence: #5419 (alignment family 7, env tunables): `""` disabled
 * `PI_LENS_CASCADE_SETTLE_WAIT_MS` and `PI_LENS_LSP_DRIFT_CHECK_MS`, `"0"`
 * could not disable touch debounce, and `"abc"` made the tool-refresh and
 * warmup timers 1 ms.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cascadeSettleWaitMs } from "../../clients/cascade-budget.js";
import {
	maxPerSession,
	refreshIntervalMs,
	refreshTimeoutMs,
	retryIntervalMs,
} from "../../clients/installer/managed-tool-refresh.js";
import { driftCheckIntervalMs } from "../../clients/lsp/document-drift.js";
import {
	_resetModuleReportConfigForTests,
	getLspBudgetMs,
} from "../../clients/module-report-lsp.js";
import { declarationLookIntervalMs } from "../../clients/out-of-band-changes.js";
import {
	graphCheckpointMinIntervalMs,
	graphPersistDebounceMs,
} from "../../clients/review-graph/builder.js";
import { scheduleManagedToolRefresh } from "../../clients/runtime-session.js";
import { wordIndexPersistDebounceMs } from "../../clients/word-index.js";

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

/** The raw values the table feeds every knob. `0` and `7` are the two values. */
const RAW_VALUES: ReadonlyArray<
	readonly [label: string, raw: string | undefined]
> = [
	["unset", undefined],
	["blank", ""],
	["whitespace", "   "],
	["zero", "0"],
	["non-numeric", "abc"],
	["negative", "-1"],
	["infinity", "Infinity"],
	["fraction", "7.9"],
	["seven", "7"],
];

/**
 * The contract, per raw value: explicit 0 is a value, a fraction floors to its
 * integer, and every other value (unset, blank, non-numeric, negative,
 * non-finite) is the default.
 */
function expectedFor(
	raw: string | undefined,
	defaultValue: number,
	zeroIsDefault = false,
): number {
	if (raw === "0") return zeroIsDefault ? defaultValue : 0;
	if (raw === "7" || raw === "7.9") return 7;
	return defaultValue;
}

interface Reader {
	env: string;
	defaultValue: number;
	read(): number;
}

const READERS: readonly Reader[] = [
	{
		env: "PI_LENS_CASCADE_SETTLE_WAIT_MS",
		defaultValue: 5000,
		read: () => cascadeSettleWaitMs(),
	},
	{
		env: "PI_LENS_LSP_DRIFT_CHECK_MS",
		defaultValue: 10_000,
		read: () => driftCheckIntervalMs(),
	},
	{
		env: "PI_LENS_DECLARATION_LOOK_MS",
		defaultValue: 2000,
		read: () => declarationLookIntervalMs(),
	},
	{
		env: "PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS",
		defaultValue: 1500,
		read: () => graphPersistDebounceMs(),
	},
	{
		env: "PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS",
		defaultValue: 5000,
		read: () => graphCheckpointMinIntervalMs(),
	},
	{
		env: "PI_LENS_WORD_INDEX_PERSIST_DEBOUNCE_MS",
		defaultValue: 1500,
		read: () => wordIndexPersistDebounceMs(),
	},
	{
		env: "PI_LENS_MODULE_REPORT_LSP_BUDGET_MS",
		defaultValue: 0,
		read: () => {
			_resetModuleReportConfigForTests();
			return getLspBudgetMs();
		},
	},
	{
		env: "PI_LENS_TOOL_REFRESH_INTERVAL_MS",
		defaultValue: 7 * 24 * 60 * 60 * 1000,
		read: () => refreshIntervalMs(),
	},
	{
		env: "PI_LENS_TOOL_REFRESH_RETRY_MS",
		defaultValue: 24 * 60 * 60 * 1000,
		read: () => retryIntervalMs(),
	},
	{
		env: "PI_LENS_TOOL_REFRESH_MAX_PER_SESSION",
		defaultValue: 1,
		read: () => maxPerSession(),
	},
	{
		env: "PI_LENS_INSTALL_TIMEOUT_MS",
		defaultValue: 120_000,
		read: () => refreshTimeoutMs(),
	},
];

describe("#5419 numeric knobs read blank as unset and 0 as a value", () => {
	it.each(
		READERS.flatMap((reader) =>
			RAW_VALUES.map(
				([label, raw]) => [reader.env, label, raw, reader] as const,
			),
		),
	)("%s reads %s as the contract says", (_env, _label, raw, reader) => {
		setKnob(reader.env, raw);
		expect(reader.read()).toBe(expectedFor(raw, reader.defaultValue));
	});
});

describe("#5419 the touch, settle and early-unblock constants read the same contract", () => {
	// Module-load constants: each row re-imports the built module under the
	// row's environment. The five knobs share the row's raw value.
	// The nav wait is the one positive-or-default knob (#5419 F1): a 0 budget
	// reaches getClientForFile as "no timeout", so 0 reads as the default.
	const LSP_KNOBS: ReadonlyArray<
		readonly [
			env: string,
			constant: string,
			defaultValue: number,
			zeroIsDefault?: boolean,
		]
	> = [
		[
			"PI_LENS_LSP_NAV_CLIENT_WAIT_MS",
			"NAV_CLIENT_WAIT_TIMEOUT_MS",
			1500,
			true,
		],
		["PI_LENS_LSP_TOUCH_DEBOUNCE_MS", "TOUCH_DEBOUNCE_MS", 1500],
		[
			"PI_LENS_LSP_DIAGNOSTICS_SEMANTIC_THRESHOLD_MS",
			"DIAGNOSTICS_SEMANTIC_SETTLE_THRESHOLD_MS",
			250,
		],
		[
			"PI_LENS_LSP_DIAGNOSTICS_SEMANTIC_SETTLE_MS",
			"DIAGNOSTICS_SEMANTIC_SETTLE_WAIT_MS",
			400,
		],
		["PI_LENS_LSP_EARLY_UNBLOCK_GRACE_MS", "EARLY_UNBLOCK_GRACE_MS", 400],
	];

	it.each(RAW_VALUES)(
		"LSP constants read %s as the contract says",
		async (_label, raw) => {
			for (const [env] of LSP_KNOBS) setKnob(env, raw);
			vi.resetModules();
			const lsp =
				(await import("../../clients/lsp/index.js")) as unknown as Record<
					string,
					number
				>;
			for (const [, constant, defaultValue, zeroIsDefault] of LSP_KNOBS) {
				expect(lsp[constant], constant).toBe(
					expectedFor(raw, defaultValue, zeroIsDefault),
				);
			}
		},
	);

	// The tool-call nav budget reads the same knob (#5419 F1). Its own knob
	// PI_LENS_TOOLCALL_NAV_TOUCH_MS, when set, takes precedence; this row leaves
	// it unset so the shared knob is the one read.
	it.each(RAW_VALUES)(
		"LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS reads %s as the nav knob's positive rule",
		async (_label, raw) => {
			setKnob("PI_LENS_TOOLCALL_NAV_TOUCH_MS", undefined);
			setKnob("PI_LENS_LSP_NAV_CLIENT_WAIT_MS", raw);
			vi.resetModules();
			const toolCall =
				(await import("../../clients/runtime-tool-call.js")) as unknown as Record<
					string,
					number
				>;
			expect(toolCall.LSP_TOOLCALL_NAV_TOUCH_BUDGET_MS).toBe(
				expectedFor(raw, 1500, true),
			);
		},
	);
});

describe("#5419 the tool-refresh delay reads the same contract", () => {
	it.each(RAW_VALUES)(
		"PI_LENS_TOOL_REFRESH_DELAY_MS reads %s as the contract says",
		(_label, raw) => {
			setKnob("PI_LENS_TOOL_REFRESH_DELAY_MS", raw);
			// The timer is the clock boundary: a no-op stub records the delay the
			// scheduler asked for without arming a real 30 s timer.
			const setTimeoutSpy = vi
				.spyOn(globalThis, "setTimeout")
				.mockImplementation((() => ({
					unref: () => undefined,
				})) as unknown as typeof setTimeout);
			scheduleManagedToolRefresh(() => undefined, false);
			expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(
				expectedFor(raw, 30_000),
			);
		},
	);
});
