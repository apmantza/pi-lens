/**
 * Coverage gate for the shared availability policy (#1476).
 *
 * #1467 fixed four clients that each latched a timed-out probe as a permanent
 * "tool is not installed" verdict. Its class sweep still missed three more, and
 * the #1476 sweep found three beyond those — including `ctx.hasTool`, the
 * generic seam every CLI runner gates on. The next tool would have been the
 * eleventh. This test DERIVES the consumer list from the source tree and fails
 * when a consumer it can SEE decides availability with its own copy of the rule.
 *
 * It is not a proof that no such consumer exists, and it must not be cited as
 * one. A verification round invented twelve shapes it does not catch — accessor
 * pairs, WeakMap and symbol-keyed stores, cross-module probe helpers, spawn
 * behind a constructor-assigned indirection, string-union verdicts — and three
 * of those are already idiomatic in this repo. Five sites it could not see are
 * now migrated — `createCwdCachedProbe` with its eslint, credo and rust-clippy
 * consumers (#1494), `formatters.ts` (#1495), `package-manager.ts` (#1496) —
 * and the last two are STILL invisible to it, which is the clearest statement of
 * the limit: they probe with `which <command>`, so there is no version flag for
 * the pre-filter to find. A fix the gate cannot see is also a regression the gate
 * cannot catch, and that residual is tracked in #1499.
 *
 * The first version of this gate was regexes and a review broke it seven ways in
 * one sitting. Treating a gate as proof is how that happened; every widening
 * below is pinned by a fixture so the next narrowing is visible.
 *
 * ## Structural, and per unit
 *
 * The analysis lives in `tests/support/availability-gate.ts` and runs on the
 * real AST (`@ast-grep/napi`), not on file text. Two properties come from that
 * and both were bought with review findings:
 *
 *   * "routed through the policy" means an `import_statement` node binds a
 *     policy symbol. A `// route this through availability-policy.js` comment
 *     used to clear a file. It no longer parses as anything at all.
 *   * the unit of judgement is a top-level declaration, not a file. The
 *     file-level gate cleared `runner-helpers.ts` and `govulncheck-client.ts`
 *     because each already imported the policy for a DIFFERENT memo, hiding two
 *     of the seven sites this change migrates.
 *
 * A unit is a consumer when it spawns a version probe AND parks the verdict in
 * state that outlives the call. It must then reach the shared policy: directly,
 * via `createAvailabilityChecker`, or by extending `SecurityScanClient`.
 *
 * ## The known-gap baseline
 *
 * `KNOWN_GAPS` is a shrink-only list of latches that predate this gate and are
 * tracked separately. It is not the hand-maintained roster #883 warned about:
 * nothing is added to it silently — a NEW unrouted consumer fails the gate, and
 * a baseline entry that stops being flagged ALSO fails, so a fix cannot leave
 * dead scaffolding behind.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type AvailabilityUnit,
	analyzeAvailabilityUnits,
	scanClientsTree,
	unitId,
} from "../support/availability-gate.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/**
 * Hand-rolled latches that predate this gate. Each is a real instance of the
 * shape, filed for its own fix; none may grow without a review noticing.
 */
const KNOWN_GAPS: ReadonlyArray<{ id: string; why: string }> = [];

/** Every consumer the #1467/#1476 sweeps migrated; the scan must still see them. */
const KNOWN_CONSUMERS = [
	"clients/biome-client.ts::BiomeClient",
	// The three `createCwdCachedProbe` consumers #1494 migrated. They are visible
	// to the scan only because the helper is now a recognised policy factory: the
	// verdict they park is a handle it built, so de-routing one flags here.
	"clients/dispatch/runners/credo.ts::probeCredo",
	"clients/dispatch/runners/eslint.ts::getEslintProbe",
	"clients/dispatch/runners/rust-clippy.ts::refreshClippyProbe",
	"clients/pipeline.ts::tryEslintFix",
	"clients/dead-code-client.ts::PythonDeadCodeClient",
	"clients/dependency-checker.ts::DependencyChecker",
	"clients/dispatch/dispatcher.ts::checkToolAvailability",
	"clients/dispatch/runners/utils/runner-helpers.ts::createAvailabilityChecker",
	// The second latch in the same file — invisible to a per-file gate.
	"clients/dispatch/runners/utils/runner-helpers.ts::isSgAvailableAsync",
	"clients/go-client.ts::GoClient",
	"clients/govulncheck-client.ts::GovulncheckClient",
	"clients/jscpd-client.ts::jscpdAvailability",
	"clients/knip-client.ts::KnipClient",
	"clients/rust-client.ts::RustClient",
	"clients/sg-runner.ts::SgRunner",
];

/**
 * The seven ways a reviewer broke the regex version of this gate, each written
 * as it would appear in `clients/`. Every one must read as an unrouted
 * consumer. They are the gate's own regression suite: widening the vocabulary
 * without a fixture is how the gate silently narrows again.
 */
const EVASIONS: ReadonlyArray<{
	name: string;
	source: string;
	expectedGoverned?: boolean;
}> = [
	{
		// A verification round found this one escaping, and the cause was a bug
		// rather than a scoping choice: memo writes resolve against the DECLARED
		// name, and the analyser took the last dot segment, so `registry.toolAvailable`
		// looked up a declaration called `toolAvailable` and found nothing. The
		// same slip let a nested `cached.entries.set(...)` through.
		name: "a verdict parked on a module-level registry object",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			const registry: { toolAvailable: boolean | null } = { toolAvailable: null };
			export async function hasTool(): Promise<boolean> {
				if (registry.toolAvailable !== null) return registry.toolAvailable;
				const probe = await safeSpawnAsync("newtool", ["--version"], {});
				registry.toolAvailable = probe.status === 0;
				return registry.toolAvailable;
			}
		`,
	},
	{
		name: "a Map<string, boolean> cwd cache instead of an `avail`-named field",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			const cacheByCwd = new Map<string, boolean>();
			export async function hasTool(cwd: string): Promise<boolean> {
				const hit = cacheByCwd.get(cwd);
				if (hit !== undefined) return hit;
				const probe = await safeSpawnAsync("newtool", ["--version"], { cwd });
				cacheByCwd.set(cwd, probe.status === 0);
				return probe.status === 0;
			}
		`,
	},
	{
		name: "a field named `installed`",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			export class NewToolClient {
				private installed: boolean | null = null;
				async ensureAvailable(): Promise<boolean> {
					if (this.installed !== null) return this.installed;
					const probe = await safeSpawnAsync("newtool", ["--version"], {});
					this.installed = probe.status === 0;
					return this.installed;
				}
			}
		`,
	},
	{
		name: "a closure factory holding `let cached`",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			export function createNewToolProbe(): () => Promise<boolean> {
				let cached: boolean | null = null;
				return async () => {
					if (cached !== null) return cached;
					const probe = await safeSpawnAsync("newtool", ["--version"], {});
					cached = probe.status === 0;
					return cached;
				};
			}
		`,
	},
	{
		name: "a probe flag hoisted into a const rather than written as a literal",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			const VERSION_ARGS = ["--version"];
			export class NewToolClient {
				private toolAvailable: boolean | null = null;
				async ensureAvailable(): Promise<boolean> {
					if (this.toolAvailable !== null) return this.toolAvailable;
					const probe = await safeSpawnAsync("newtool", VERSION_ARGS, {});
					this.toolAvailable = probe.status === 0;
					return this.toolAvailable;
				}
			}
		`,
	},
	{
		name: "a probe that asks with `-v`",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			export class NewToolClient {
				private toolAvailable: boolean | null = null;
				async ensureAvailable(): Promise<boolean> {
					if (this.toolAvailable !== null) return this.toolAvailable;
					const probe = await safeSpawnAsync("newtool", ["-v"], {});
					this.toolAvailable = probe.status === 0;
					return this.toolAvailable;
				}
			}
		`,
	},
	{
		name: "an optional boolean field with no initialiser",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			export class NewToolClient {
				private fooAvailable?: boolean;
				async ensureAvailable(): Promise<boolean> {
					if (this.fooAvailable !== undefined) return this.fooAvailable;
					const probe = await safeSpawnAsync("newtool", ["--version"], {});
					this.fooAvailable = probe.status === 0;
					return this.fooAvailable;
				}
			}
		`,
	},
	{
		// Pins the #1476 follow-up widening: `createToolchainAvailability` counts
		// as routed ONLY when it is the shared helper. A same-named factory from
		// anywhere else is a private copy of the rule, which is the defect.
		name: "a lookalike availability factory imported from outside the policy",
		source: `
			import { createToolchainAvailability } from "./tool-checks.js";
			export class NewToolClient {
				private readonly availability = createToolchainAvailability({
					tool: "newtool",
					probeArgs: ["--version"],
				});
				async ensureAvailable(): Promise<boolean> {
					return this.availability.isAvailable();
				}
			}
		`,
	},
	{
		// The #1494 review probe. Routing propagates along the call edge a unit
		// inherits its probe from, and the first version of that let a hand-rolled
		// latch launder itself: park a permanent `Promise<boolean>` per cwd, hand
		// the spawn to the ROUTED factory, and the unit read as routed while its
		// own memo still latched a timeout for the life of the process. A memo that
		// holds a boolean verdict never inherits its helper's routing.
		name: "a hand-rolled boolean latch that delegates its spawn to a routed helper",
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			const toolAvailableByCwd = new Map<string, Promise<boolean>>();
			export function getToolProbe(cmd: string) {
				return (cwd: string) => {
					const hit = toolAvailableByCwd.get(cwd);
					if (hit) return hit;
					const probed = makeToolProbe(cmd)(cwd);
					toolAvailableByCwd.set(cwd, probed);
					return probed;
				};
			}
		`,
	},
	{
		// #1552. `isBooleanVerdictShape` was a BLACKLIST: inherit routing unless
		// the unit's own memo "looks boolean". A string-union verdict never spells
		// "boolean" and never spells a factory name either — it is neither a
		// latch nor a handle, and the blacklist waved it through anyway.
		name: "a string-union verdict that is neither boolean nor a policy handle",
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			const toolAvailableByCwd = new Map<string, "yes" | "no">();
			export function getToolProbe(cmd: string) {
				return async (cwd: string) => {
					const hit = toolAvailableByCwd.get(cwd);
					if (hit !== undefined) return hit === "yes";
					const probed = await makeToolProbe(cmd)(cwd);
					toolAvailableByCwd.set(cwd, probed ? "yes" : "no");
					return probed;
				};
			}
		`,
	},
	{
		// #1552. The same laundering shape as the `Promise<boolean>` probe above,
		// but the boolean is reached through a type alias. A blacklist that
		// text-matches `\bboolean\b` on the memo's own type never sees it — the
		// alias's own declaration is the only place the word appears — so it
		// misclassifies the memo as "not boolean" and inherits routing it never
		// earned. The whitelist does not need to catch this spelling: an alias
		// name is not a factory name either, so it is refused by default.
		name: "a hand-rolled boolean latch reached through a type alias",
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			type ToolVerdict = boolean;
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			const toolAvailableByCwd = new Map<string, ToolVerdict>();
			export function getToolProbe(cmd: string) {
				return (cwd: string) => {
					const hit = toolAvailableByCwd.get(cwd);
					if (hit !== undefined) return Promise.resolve(hit);
					const probed = makeToolProbe(cmd)(cwd);
					probed.then((verdict) => toolAvailableByCwd.set(cwd, verdict));
					return probed;
				};
			}
		`,
	},
	{
		// #1552 round 2. The whitelist's own shape check read `writtenValue` — the
		// WRITE's inlined expression — alongside the declaration's own type/value,
		// so inlining the routed wrapper's call straight into the `.set(...)`
		// site let its name leak into a plain `Map<string, boolean>` latch's
		// shape and pass it off as a handle, even though the DECLARATION never
		// mentions a factory or a wrapper at all.
		name: "a hand-rolled boolean latch whose write inlines the routed wrapper's call",
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			const toolAvailableByCwd = new Map<string, boolean>();
			export async function getToolProbe(cmd: string, cwd: string): Promise<boolean> {
				const hit = toolAvailableByCwd.get(cwd);
				if (hit !== undefined) return hit;
				toolAvailableByCwd.set(cwd, await makeToolProbe(cmd)(cwd));
				return toolAvailableByCwd.get(cwd) ?? false;
			}
		`,
	},
	{
		// #1552 round 2. `findMemo`'s `sessionFact` early return fired before the
		// `policyHandleOnly` branch, so ANY unit that records a session fact read
		// as holding a policy handle regardless of shape — `setSessionFact`
		// records a value, it never calls a `POLICY_FACTORY`, so this must never
		// grant inheritance on its own.
		name: "a session-fact latch that delegates its spawn to a routed helper",
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			export async function checkToolAvailability(cmd: string, cwd: string): Promise<boolean> {
				const probed = await makeToolProbe(cmd)(cwd);
				setSessionFact("toolAvailable", probed);
				return probed;
			}
		`,
	},
	{
		// #1552's own second probe: a genuine boolean reached through
		// `ReturnType<typeof asVerdict>` rather than a plain type alias — a
		// distinct indirection shape from the alias probe above. The whitelist
		// does not need to catch this spelling either: `asVerdict` is not a
		// factory and never appears in `policyHandles`, so it is refused by
		// default the same way the alias is.
		name: "a hand-rolled boolean latch reached through ReturnType<typeof asVerdict>",
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			function asVerdict(v: boolean): boolean {
				return v;
			}
			const toolAvailableByCwd = new Map<string, ReturnType<typeof asVerdict>>();
			export function getToolProbe(cmd: string) {
				return (cwd: string) => {
					const hit = toolAvailableByCwd.get(cwd);
					if (hit !== undefined) return Promise.resolve(hit);
					const probed = makeToolProbe(cmd)(cwd);
					probed.then((verdict) => toolAvailableByCwd.set(cwd, verdict));
					return probed;
				};
			}
		`,
	},
	{
		// #1582 residual 1. Type aliases are outside this text-anchored
		// analyser's resolution boundary, so a legitimate handle reads as
		// unrouted. It should flip to true if alias indirection is supported;
		// either direction must remain pinned so the blind spot cannot drift.
		name: "a routed handle hidden behind a type alias",
		expectedGoverned: false,
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			type ToolHandle = ReturnType<typeof makeToolProbe>;
			const toolAvailableByCwd = new Map<string, ToolHandle>();
			export function getToolProbe(cmd: string) {
				return (cwd: string) => {
					const hit = toolAvailableByCwd.get(cwd);
					if (hit) return hit;
					const probed = makeToolProbe(cmd)(cwd);
					toolAvailableByCwd.set(cwd, probed);
					return probed;
				};
			}
		`,
	},
	{
		// #1582 residual 2. A decoy un-nested ReturnType mention in a
		// branded intersection makes the text-anchored type arm report a
		// boolean memo as governed. It should flip to false if the arm is
		// narrowed to the memo's actual type; pin the current false positive.
		name: "a decoy type-arm mention in a branded intersection",
		expectedGoverned: true,
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			const toolAvailableByCwd = new Map<
				string,
				boolean & { __handle?: ReturnType<typeof makeToolProbe> }
			>();
			export async function getToolProbe(cmd: string, cwd: string): Promise<boolean> {
				const hit = toolAvailableByCwd.get(cwd);
				if (hit !== undefined) return hit;
				const verdict = await makeToolProbe(cmd)(cwd);
				toolAvailableByCwd.set(cwd, verdict);
				return verdict;
			}
		`,
	},
	{
		// #1582 residual 3. isDirectCall baseName-splits on dots, so a
		// member call on a local object can spoof the direct-call arm. It
		// should flip to false if the full callee path is checked.
		name: "a member-call spoof of the direct-call arm",
		expectedGoverned: true,
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			const shims = { createCwdCachedProbe: (x: string) => x };
			const toolAvailableByCwd = new Map<string, ReturnType<typeof makeToolProbe>>();
			const wrapped = shims.createCwdCachedProbe("newtool");
			export function getToolProbe(cmd: string) {
				return (cwd: string) => {
					const hit = toolAvailableByCwd.get(cwd);
					if (hit) return hit;
					const probed = makeToolProbe(cmd)(cwd);
					toolAvailableByCwd.set(cwd, probed);
					return probed;
				};
			}
		`,
	},
	{
		// #1566 (NE1). The whitelist's handle-name check was a bare `\bname\b`
		// substring test over the memo's declared type, so a type that merely
		// MENTIONS the wrapper's name still passed even after unwrapping it all
		// the way down to a plain boolean. `ReturnType<ReturnType<typeof
		// makeToolProbe>>` takes the wrapper's own return type apart twice, and
		// `Awaited<...>` strips the outer promise, landing on the same bare
		// `boolean` the blacklist used to catch by word alone — the handle's
		// name is present in the text, but the memo does not hold the handle.
		name: "a boolean latch typed by unwrapping the wrapper's own return type",
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			const toolAvailableByCwd = new Map<
				string,
				Awaited<ReturnType<ReturnType<typeof makeToolProbe>>>
			>();
			export async function getToolProbe(cmd: string, cwd: string): Promise<boolean> {
				const hit = toolAvailableByCwd.get(cwd);
				if (hit !== undefined) return hit;
				const verdict = await makeToolProbe(cmd)(cwd);
				toolAvailableByCwd.set(cwd, verdict);
				return verdict;
			}
		`,
	},
	{
		// #1566 (NE2). Same laundering as NE1, from the other direction: the
		// handle's name shows up only as a bare CALL ARGUMENT to an unrelated
		// helper, never as the memo's own type. `emptyCache<boolean>` is what
		// actually shapes the memo — a boolean map — and `makeToolProbe` is
		// merely handed to it, the way a probe factory might be handed to a
		// scheduler. Master's blacklist caught this one by luck (the word
		// "boolean" in the call's own type argument); the whitelist has no
		// such luck to fall back on and must refuse on shape, not on which
		// names appear in the text.
		name: "a boolean cache from a helper that merely takes the wrapper as an argument",
		source: `
			import { createCwdCachedProbe } from "./dispatch/runners/utils/runner-helpers.js";
			import { safeSpawnAsync } from "./safe-spawn.js";
			import { emptyCache } from "./cache-utils.js";
			function makeToolProbe(cmd: string) {
				return createCwdCachedProbe(
					(cwd) => safeSpawnAsync(cmd, ["--version"], { timeout: 5000, cwd }),
					{ tool: "newtool" },
				);
			}
			const cache = emptyCache<boolean>(makeToolProbe);
			export async function getToolProbe(cmd: string, cwd: string): Promise<boolean> {
				const hit = cache.get(cwd);
				if (hit !== undefined) return hit;
				const verdict = await makeToolProbe(cmd)(cwd);
				cache.set(cwd, verdict);
				return verdict;
			}
		`,
	},
	{
		name: "the defect shape plus a comment that names availability-policy.js",
		source: `
			import { safeSpawnAsync } from "./safe-spawn.js";
			// TODO: route this through availability-policy.js
			export class NewToolClient {
				private toolAvailable: boolean | null = null;
				async ensureAvailable(): Promise<boolean> {
					if (this.toolAvailable !== null) return this.toolAvailable;
					const probe = await safeSpawnAsync("newtool", ["--version"], {});
					this.toolAvailable = probe.status === 0;
					return this.toolAvailable;
				}
			}
		`,
	},
];

/** The positive control: the same client, migrated. It must pass. */
const COMPLIANT = `
	import { safeSpawnAsync } from "./safe-spawn.js";
	import {
		classifyProbeFailure,
		createAvailabilityLatch,
	} from "./dispatch/runners/utils/availability-policy.js";
	export class NewToolClient {
		private readonly availabilityLatch = createAvailabilityLatch();
		async ensureAvailable(): Promise<boolean> {
			const memo = this.availabilityLatch.read();
			if (memo !== null) return memo;
			const probe = await safeSpawnAsync("newtool", ["--version"], {});
			if (probe.status === 0) {
				this.availabilityLatch.noteAvailable();
				return true;
			}
			const { outcome, cause } = classifyProbeFailure(probe);
			this.availabilityLatch.noteUnavailable(outcome, cause);
			return false;
		}
	}
`;

describe("availability policy coverage (#1476)", () => {
	let consumers: AvailabilityUnit[];

	beforeAll(async () => {
		consumers = await scanClientsTree(repoRoot);
	});

	it("every availability consumer routes through the shared policy", () => {
		const baseline = new Set(KNOWN_GAPS.map((gap) => gap.id));
		const unrouted = consumers
			.filter((unit) => !unit.governed)
			.map(unitId)
			.filter((id) => !baseline.has(id));
		expect(
			unrouted,
			[
				"These units decide tool availability with their own copy of the rule.",
				"Route them through clients/dispatch/runners/utils/availability-policy.ts",
				"(directly, via createAvailabilityChecker, or via SecurityScanClient) so a",
				"timed-out probe cannot latch as 'the tool is not installed' (#1467/#1476).",
			].join(" "),
		).toEqual([]);
	});

	it("the known-gap baseline is still accurate", () => {
		// A baseline entry that stopped being flagged is scaffolding around a fix
		// that already landed; deleting it is part of the fix.
		const flagged = new Set(
			consumers.filter((unit) => !unit.governed).map(unitId),
		);
		const stale = KNOWN_GAPS.map((gap) => gap.id).filter(
			(id) => !flagged.has(id),
		);
		expect(
			stale,
			"These KNOWN_GAPS entries are no longer flagged — delete them.",
		).toEqual([]);
	});

	it("the derived set actually covers the known consumers", () => {
		// Guards the scan itself: an analysis that stopped matching would make the
		// assertion above pass over an empty set — defect shape 7, a vacuous test.
		const ids = consumers.map(unitId);
		for (const known of KNOWN_CONSUMERS) {
			expect(ids).toContain(known);
		}
	});

	describe("the gate catches every shape the review evaded it with", () => {
		for (const evasion of EVASIONS) {
			it(evasion.name, async () => {
				const units = await analyzeAvailabilityUnits(
					evasion.source,
					"clients/new-tool-client.ts",
				);
				expect(
					units.map((unit) => unit.unit),
					"the analysis did not recognise this as an availability consumer",
				).not.toEqual([]);
				const expectedGoverned = evasion.expectedGoverned ?? false;
				expect(
					units.filter((unit) => unit.governed).map((unit) => unit.unit),
					"the known blind verdict changed; update this pin only with a deliberate analyser improvement",
				).toEqual(expectedGoverned ? units.map((unit) => unit.unit) : []);
			});
		}
	});

	it("flags a second hand-rolled latch beside a compliant one", async () => {
		// The per-FILE gate cleared this shape, and that is how two of the seven
		// sites this change migrates stayed invisible: the file already imported
		// the policy, for a different memo.
		const units = await analyzeAvailabilityUnits(
			`
				import { safeSpawnAsync } from "./safe-spawn.js";
				import { createAvailabilityLatch } from "./dispatch/runners/utils/availability-policy.js";
				export class MigratedClient {
					private readonly availabilityLatch = createAvailabilityLatch();
					async ensureAvailable(): Promise<boolean> {
						const memo = this.availabilityLatch.read();
						if (memo !== null) return memo;
						const probe = await safeSpawnAsync("newtool", ["--version"], {});
						if (probe.status === 0) {
							this.availabilityLatch.noteAvailable();
							return true;
						}
						this.availabilityLatch.noteUnavailable("missing", "not-found");
						return false;
					}
				}
				let secondToolAvailable: boolean | null = null;
				export async function isSecondToolAvailable(): Promise<boolean> {
					if (secondToolAvailable !== null) return secondToolAvailable;
					const probe = await safeSpawnAsync("secondtool", ["--version"], {});
					secondToolAvailable = probe.status === 0;
					return secondToolAvailable;
				}
			`,
			"clients/two-latches.ts",
		);
		expect(
			units.filter((unit) => !unit.governed).map((unit) => unit.unit),
		).toEqual(["isSecondToolAvailable"]);
		expect(
			units.filter((unit) => unit.governed).map((unit) => unit.unit),
		).toEqual(["MigratedClient"]);
	});

	it("follows a probe that lives one helper away from the latch", async () => {
		// `runner-helpers.ts` pre-#1476: the `--version` literal and the spawn sat
		// in `probeAstGrepCommandAsync` while the latch sat in `isSgAvailableAsync`.
		const units = await analyzeAvailabilityUnits(
			`
				import { safeSpawnAsync } from "./safe-spawn.js";
				let toolAvailable: boolean | null = null;
				async function probeTool(cmd: string): Promise<boolean> {
					const check = await safeSpawnAsync(cmd, ["--version"], { timeout: 5000 });
					return !check.error && check.status === 0;
				}
				export async function isToolAvailableAsync(): Promise<boolean> {
					if (toolAvailable !== null) return toolAvailable;
					toolAvailable = await probeTool("newtool");
					return toolAvailable;
				}
			`,
			"clients/helper-split.ts",
		);
		expect(units.map((unit) => unit.unit)).toContain("isToolAvailableAsync");
		expect(units.filter((unit) => unit.governed)).toEqual([]);
	});

	it("a migrated client passes the gate", async () => {
		const units = await analyzeAvailabilityUnits(
			COMPLIANT,
			"clients/new-tool-client.ts",
		);
		expect(units.map((unit) => unit.unit)).toEqual(["NewToolClient"]);
		expect(units[0]?.governed).toBe(true);
	});

	it("a client that delegates its lifecycle to the shared helper is routed", async () => {
		// The #1476 follow-up moved the latch, the in-flight dedupe and the
		// decision records out of `go-client.ts` and `rust-client.ts` and into
		// `toolchain-availability.ts`. The clients must stay VISIBLE as consumers
		// — a refactor that made them vanish from the scan would read as green
		// while removing them from the gate's coverage.
		const units = await analyzeAvailabilityUnits(
			`
				import { createToolchainAvailability } from "./dispatch/runners/utils/toolchain-availability.js";
				export class NewToolClient {
					private readonly availability = createToolchainAvailability({
						tool: "newtool",
						probeArgs: ["--version"],
					});
					async ensureAvailable(): Promise<boolean> {
						return this.availability.isAvailable();
					}
				}
			`,
			"clients/new-tool-client.ts",
		);
		expect(units.map((unit) => unit.unit)).toEqual(["NewToolClient"]);
		expect(units[0]?.governed).toBe(true);
	});

	it("a client with no probe is not a consumer at all", async () => {
		// The scan must not drag in every module that happens to own a cache.
		const units = await analyzeAvailabilityUnits(
			`
				const cacheByCwd = new Map<string, boolean>();
				export function rememberTrust(cwd: string, trusted: boolean): void {
					cacheByCwd.set(cwd, trusted);
				}
			`,
			"clients/trust-cache.ts",
		);
		expect(units).toEqual([]);
	});
});
