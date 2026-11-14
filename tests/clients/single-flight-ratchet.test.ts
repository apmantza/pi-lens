import { describe, expect, it } from "vitest";

import {
	classifyInFlightSpellings,
	findInFlightDeclarations,
	scanInFlightDeclarations,
	scanInFlightSpellings,
} from "../../tests/support/single-flight-scan.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

/**
 * Every hand-rolled in-flight declaration `clients/` still carries, and why.
 *
 * `clients/single-flight.ts` (#1753) owns the share, the clear-in-finally, the
 * successor check, and the trailing-rerun bit. Two sites are converted; these
 * are not. A NEW entry has to be added here on purpose, with a reason someone
 * reads — which is the whole ratchet. "Not migrated yet" is an acceptable
 * reason; silence is not.
 *
 * Keys are `clients/`-relative-path:symbol.
 */
const EXEMPTIONS: Record<string, string> = {
	// ── The `ensureInFlight` availability family: #1753's migration backlog ──
	// Identical shape to the two converted sites (biome-client, sg-runner):
	// a latch short-circuit, then at-most-one probe/auto-install. #1753 converts
	// two as proof and burns the rest down opportunistically.
	"dead-code-client.ts:ensureInFlight":
		"backlog: ensureAvailable family, #1753",
	"dependency-checker.ts:ensureInFlight":
		"backlog: ensureAvailable family, #1753",
	"knip-client.ts:ensureInFlight": "backlog: ensureAvailable family, #1753",
	"installer/index.ts:ensureInFlight":
		"backlog: ensureTool's per-tool install map, #1753",

	// ── Per-key result-sharing maps: same primitive, different payload ──
	"dead-code-client.ts:inFlight": "backlog: per-cwd analyze dedupe, #1753",
	"dependency-checker.ts:checkInFlight": "backlog: per-key check dedupe, #1753",
	"dependency-checker.ts:scanInFlight": "backlog: per-root scan dedupe, #1753",
	"knip-client.ts:inFlight": "backlog: per-cwd analyze dedupe, #1753",
	"security-scan-client.ts:inFlight": "backlog: per-cwd scan dedupe, #1753",
	"jscpd-client.ts:inFlight": "backlog: per-cwd analyze dedupe, #1753",
	"dispatch/runners/helm-lint.ts:inFlightByChartRoot":
		"backlog: per-chart-root dedupe, #1753",
	"dispatch/runners/helm-render.ts:inFlightByChartRoot":
		"backlog: per-chart-root dedupe, #1753",
	"dispatch/runners/utils/lazy-installer.ts:inFlight":
		"backlog: per-tool install dedupe, #1753",
	"dispatch/runners/utils/runner-helpers.ts:managedVerifyInFlight":
		"backlog: #1674's generation-guarded verify map, #1753",
	"dispatch/runners/utils/runner-helpers.ts:resolveInstallInFlightByCwd":
		"backlog: #1674's per-cwd install map, #1753",
	"lsp/config.ts:configInFlight": "backlog: per-workspace config load, #1753",
	"mcp/session.ts:inFlightIpcTurnEnds":
		"backlog: per-cwd Stop-hook pass (#1274), #1753",
	"installer/index.ts:_probeCacheWriteInFlight":
		"backlog: single probe-cache flush, #1753",
	// Skip, not share: a second pre-edit capture of a file while one runs
	// returns `in-flight` instead of joining it, so a write never waits out the
	// remaining bound of a capture the tool_call already abandoned.
	"dispatch/integration.ts:preEditCapturesInFlight":
		"skip-not-join by design: a joined capture would make a write wait on an abandoned one, #4483",
	// Found by review round 1's widened regex: an interface member, which the
	// modifier-only version of this scan never saw. ClientRegistry's
	// `ensureClientForServer` (moved out of lsp/index.ts by #2372 slice 3) is
	// the primitive's shape line for line, identity-checked clear included —
	// the highest-value migration left on this list.
	"lsp/client-registry.ts:inFlight":
		"backlog: LSP spawn dedupe keyed serverId:root, with an " +
		"identity-checked clear in ensureClientForServer's finally — " +
		"hand-rolled singleFlight, #1753",
	"lsp/index.ts:inFlight":
		"alias: LSPState.inFlight holds ClientRegistry's own inFlight Map " +
		"(#2372 slice 3) for the service's readers; the owner is " +
		"lsp/client-registry.ts:inFlight, backlog #1753",

	// ── Not the primitive's shape: these hold no promise per key ──
	"ndjson-logger.ts:inFlightBatch":
		"exempt: the BATCH of queue items one writer is currently flushing, not " +
		"a per-key promise registry — there is one writer per file and nothing " +
		"joins it",
	"project-report.ts:inFlightGraphBuilds":
		"exempt: a Set<string> re-entry guard, not a shared promise per key — " +
		"nothing joins a running build, the second caller simply skips",
	"runtime-coordinator.ts:_startupScansInFlight":
		"exempt: a Map<string, number> COUNTER of outstanding scans, not a " +
		"promise registry — it answers how many, never which promise to join",
	"runtime-tool-result.ts:inFlightPipelines":
		"exempt: a nested map of pipeline RECORDS (state a turn reads and " +
		"mutates), not a dedupe of concurrent callers onto one promise",

	// Landed with #1746 while this branch was open, which is what retired its
	// forward declaration. A single slot rather than a keyed map, and its clear
	// is unconditional ON PURPOSE: #1746's own review round proved an identity
	// check there unreachable, because the slot has one writer and every other
	// caller returns early while it is non-null. Migrating it would hand it a
	// check it does not need, so it is backlog on the merits of dedupe, not of
	// correctness.
	"installer/managed-tool-refresh.ts:refreshInFlight":
		"backlog: #1730's managed-tool refresh latch — a single slot with a " +
		"deliberately unconditional clear, migrate opportunistically, #1753",
};

/**
 * Exemptions written for declarations that are not on this branch YET.
 *
 * Normally an exemption naming a declaration that does not exist is a lie the
 * next reader would trust, and the stale check fails it. This set is the one
 * narrow exception, for a symbol an open PR declares and this branch cannot see
 * yet. Writing the entry ahead of time means neither PR has to be held for the
 * other, and neither author has to notice the interaction.
 *
 * The cost is real and bounded. Two failure modes, handled differently:
 *
 * - The declaration LANDS and the entry parks here forever. The retirement test
 *   below fails that, so the entry has to move into `EXEMPTIONS` where the
 *   normal stale check governs it again. Review round 2 proved this is needed:
 *   creating the declaration locally left all tests green, so nothing but
 *   convention was moving the entry.
 * - The declaration NEVER lands, because its PR is abandoned. Nothing mechanical
 *   catches that, since "not yet" and "never" look identical from here. The size
 *   bound keeps the blast radius to a couple of keys, and a person reading this
 *   comment is the backstop.
 *
 * Empty in steady state, and empty right now. Its one entry so far,
 * `installer/managed-tool-refresh.ts:refreshInFlight`, landed with #1746 while
 * this branch was open. The retirement test below caught it on the first real
 * occasion, and it now sits in `EXEMPTIONS` under the ordinary stale check.
 */
const FORWARD_DECLARED = new Set<string>([]);

describe("singleFlight ratchet (#1753)", () => {
	it(
		"flags every hand-rolled in-flight declaration outside the primitive",
		() => {
			const unexplained = scanInFlightDeclarations().filter(
				(d) => !EXEMPTIONS[d.key],
			);
			expect(
				unexplained.map((d) => `${d.file}:${d.line} ${d.symbol}`),
				"New at-most-one-in-flight state must use createSingleFlight() from " +
					"clients/single-flight.ts (#1753). If it genuinely is not that shape, " +
					"add it to EXEMPTIONS in this file with a reason that says why.",
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"classifies every inFlight spelling in clients/ (#4429)",
		() => {
			// Recurrence: #4411 review F3, a population scanner that skipped five
			// spellings it did not recognise and passed. Every needle hit must land
			// in a role (single-flight-scan.ts); an unknown position reds here.
			expect(scanInFlightSpellings().unclassified).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"has no stale exemptions",
		() => {
			// A site that gets migrated (or deleted) must take its entry with it.
			// Otherwise the list rots into a lie, and the next reader trusts it.
			const live = new Set(scanInFlightDeclarations().map((d) => d.key));
			const stale = Object.keys(EXEMPTIONS).filter(
				(key) => !live.has(key) && !FORWARD_DECLARED.has(key),
			);
			expect(stale, "these exemptions no longer match any declaration").toEqual(
				[],
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"retires a forward declaration once its declaration lands",
		() => {
			const live = new Set(scanInFlightDeclarations().map((d) => d.key));
			const landed = [...FORWARD_DECLARED].filter((key) => live.has(key));
			expect(landed, "move these out of FORWARD_DECLARED").toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("keeps the forward-declaration set small", () => {
		// A forward declaration is a merge-window device: it exists only while a
		// PR that declares the symbol is open alongside this one. More than a
		// couple at once means the set is being used as a general escape hatch
		// from the stale check, which is the one thing it must not become.
		expect(FORWARD_DECLARED.size).toBeLessThanOrEqual(2);
	});

	it("keeps every forward declaration listed in EXEMPTIONS", () => {
		// A forward declaration only suppresses the stale check. It must still
		// carry a reason like any other entry, or it would be a bare hole.
		const orphans = [...FORWARD_DECLARED].filter((key) => !EXEMPTIONS[key]);
		expect(orphans).toEqual([]);
	});

	it("gives every exemption a reason", () => {
		const thin = Object.entries(EXEMPTIONS).filter(
			([, reason]) => reason.trim().length < 20,
		);
		expect(thin.map(([key]) => key)).toEqual([]);
	});

	it("does not exempt the two converted sites", () => {
		// biome-client and sg-runner are the #1753 proof migrations. If either
		// reappears here, the conversion was reverted and this list would quietly
		// bless it.
		const converted = Object.keys(EXEMPTIONS).filter(
			(key) =>
				key.startsWith("biome-client.ts:") || key.startsWith("sg-runner.ts:"),
		);
		expect(converted).toEqual([]);
	});
});

describe("singleFlight ratchet — the scan itself", () => {
	it("catches a hand-rolled class field", () => {
		const found = findInFlightDeclarations(
			"fake-client.ts",
			[
				"export class FakeClient {",
				"\tprivate ensureInFlight: Promise<boolean> | null = null;",
				"}",
			].join("\n"),
		);
		expect(found.map((d) => d.symbol)).toEqual(["ensureInFlight"]);
		expect(found[0].key).toBe("fake-client.ts:ensureInFlight");
		expect(found[0].line).toBe(2);
	});

	it("catches a hand-rolled module-level map", () => {
		const found = findInFlightDeclarations(
			"fake.ts",
			"const inFlightByCwd = new Map<string, Promise<void>>();\n",
		);
		expect(found.map((d) => d.symbol)).toEqual(["inFlightByCwd"]);
	});

	it("does not fire on a comment or a string that merely names one", () => {
		// The false-positive mode `session-state-scan.ts` documents: a doc
		// comment naming a field must not read as a declaration of it.
		const found = findInFlightDeclarations(
			"fake.ts",
			[
				"/** const ensureInFlight: Promise<boolean> | null = null; */",
				'const label = "const ensureInFlight = null;";',
			].join("\n"),
		);
		expect(found).toEqual([]);
	});

	it("catches a modifier-less class field that carries a type annotation", () => {
		// Review round 1's finding: the migrated sites' exact field minus the
		// word `private`. A modifier-only regex sails past it.
		const found = findInFlightDeclarations(
			"fake-client.ts",
			[
				"export class FakeClient {",
				"\tprobeInFlight: Promise<void> | null = null;",
				"}",
			].join("\n"),
		);
		expect(found.map((d) => d.symbol)).toEqual(["probeInFlight"]);
	});

	it("catches an optional modifier-less field", () => {
		const found = findInFlightDeclarations(
			"fake.ts",
			"interface State {\n\tinFlight?: Map<string, Promise<void>>;\n}\n",
		);
		expect(found.map((d) => d.symbol)).toEqual(["inFlight"]);
	});

	it("catches a #private class field", () => {
		const found = findInFlightDeclarations(
			"fake-client.ts",
			"class C {\n\t#ensureInFlight = new Map<string, Promise<void>>();\n}\n",
		);
		expect(found.map((d) => d.symbol)).toEqual(["ensureInFlight"]);
	});

	it.each([
		[
			"an override field",
			"class C {\n\toverride inFlight: Promise<void> | null = null;\n}\n",
		],
		[
			"a declare field",
			"class C {\n\tdeclare inFlight: Map<string, Promise<void>>;\n}\n",
		],
		[
			"an accessor field",
			"class C {\n\taccessor inFlight = new Map<string, Promise<void>>();\n}\n",
		],
		[
			"an unannotated modifier-less field",
			"class C {\n\tinFlight = new Map<string, Promise<void>>();\n}\n",
		],
		["a one-line class", "class C { private inFlight = new Map(); }\n"],
		[
			"a second declarator",
			"let ready = false, inFlight = new Map<string, Promise<void>>();\n",
		],
		["a module-level destructuring", "const { inFlight } = makeState();\n"],
		[
			"a multi-line constructor parameter property",
			"class C {\n\tconstructor(\n\t\tprivate readonly inFlight = new Map<string, Promise<void>>(),\n\t) {}\n}\n",
		],
		[
			"a one-line constructor parameter property",
			"class C { constructor(private inFlight: Map<string, Promise<void>>) {} }\n",
		],
		[
			"an override parameter property",
			"class C extends B { constructor(override inFlight?: Promise<void>) { super(); } }\n",
		],
	])(
		"counts a declaration the regex scan missed: %s (#4429)",
		(_name, source) => {
			// Shape 34: the regex enumerated three line-leading spellings; the AST
			// reads the grammar position, so each of these is the same declaration.
			expect(
				findInFlightDeclarations("fake.ts", source).map((d) => d.symbol),
			).toEqual(["inFlight"]);
		},
	);

	it("reports a spelling it cannot classify, with its file and line (#4429)", () => {
		// The fail-closed branch: an enum member and an import alias are
		// positions the role table does not know, so they red, never skip.
		const scan = classifyInFlightSpellings(
			"fake.ts",
			[
				"const ready = true;",
				"enum Phase { inFlight }",
				'import inFlight = require("./state");',
			].join("\n"),
		);
		expect(scan.declarations).toEqual([]);
		expect(scan.unclassified).toEqual([
			"unclassified spelling at fake.ts:2: enum Phase { inFlight } (property_identifier under enum_body)",
			'unclassified spelling at fake.ts:3: import inFlight = require("./state"); (identifier under import_require_clause)',
		]);
	});

	it("ignores an unclassifiable spelling inside a comment or a string (#4429)", () => {
		const scan = classifyInFlightSpellings(
			"fake.ts",
			[
				"// enum Phase { inFlight }",
				'/* import inFlight = require("./state"); */',
				'const text = "enum Phase { inFlight }";',
			].join("\n"),
		);
		expect(scan).toEqual({ declarations: [], unclassified: [] });
	});

	it("classifies a method signature as a name, not state (#4532)", () => {
		// `hasNotifyInFlight?(filePath: string): boolean` on `LSPClient` is a
		// question the touch gate asks the queue. Reading it as state would put a
		// method on the burn-down list and hide the real fields beside it.
		const scan = classifyInFlightSpellings(
			"fake.ts",
			[
				"interface Client {",
				"\tgetSentContent?(filePath: string): { hash: string } | undefined;",
				"\thasNotifyInFlight?(filePath: string): boolean;",
				"}",
			].join("\n"),
		);
		expect(scan).toEqual({ declarations: [], unclassified: [] });
	});

	it("classifies parameters and function locals as locals, not state (#4429)", () => {
		// `lsp/client-registry.ts`'s `onSpawnInFlight` parameter was a regex
		// false positive with an exemption; a parameter holds no module state.
		const scan = classifyInFlightSpellings(
			"fake.ts",
			[
				"function f(",
				"\tonSpawnInFlight?: (id: string) => void,",
				") {",
				"\tconst inFlight = new Map();",
				"\ttry {} catch (inFlightError) {}",
				"\tfor (const inFlightItem of inFlight.values()) void inFlightItem;",
				"}",
			].join("\n"),
		);
		expect(scan).toEqual({ declarations: [], unclassified: [] });
	});

	it("does not fire on a bare assignment to an existing field", () => {
		// `this.ensureInFlight = null` is the clear, not a new declaration.
		const found = findInFlightDeclarations(
			"fake.ts",
			"\t\t\tensureInFlight = null;\n",
		);
		expect(found).toEqual([]);
	});
});
