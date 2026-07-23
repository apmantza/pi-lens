import { afterEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	_resetProjectReportBuildGuardForTests,
	projectReport,
	renderCompactProjectReport,
} from "../../clients/project-report.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	getCachedReviewGraph,
} from "../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

async function warmGraph(cwd: string): Promise<void> {
	await buildOrUpdateGraph(cwd, [], new FactStore());
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
	_resetProjectReportBuildGuardForTests();
});

function makeEnv(prefix = "pi-lens-projreport-") {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return env;
}

describe("projectReport — cold path (#773)", () => {
	it("returns available:false with an actionable hint and never blocks, kicking a background build", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "src/a.ts", "export const a = 1;\n");

		const startedAt = Date.now();
		const report = await projectReport(env.tmpDir);
		const elapsedMs = Date.now() - startedAt;

		expect(report.available).toBe(false);
		expect(report.hint).toBeTruthy();
		expect(report.trust).toBeUndefined();
		expect(report.hubs).toBeUndefined();
		// The call must return immediately — it must never synchronously run a
		// full graph build on this path (#773's graph-cold contract).
		expect(elapsedMs).toBeLessThan(2000);

		// The background build was kicked off (deduped, fire-and-forget) — assert
		// it eventually populates the cache, proving it actually ran rather than
		// silently no-op'ing.
		await vi.waitFor(
			() => {
				expect(getCachedReviewGraph(env.tmpDir)).toBeDefined();
			},
			{ timeout: 10_000, interval: 100 },
		);
	});
});

describe("projectReport — warm path section shapes", () => {
	async function buildWarmFixture(cwd: string) {
		createTempFile(
			cwd,
			"clients/hub.ts",
			[
				"export function hubFn(x) {",
				"  if (x > 0) {",
				"    return 1;",
				"  } else if (x < 0) {",
				"    return -1;",
				"  } else {",
				"    return 0;",
				"  }",
				"}",
			].join("\n"),
		);
		for (let i = 1; i <= 3; i += 1) {
			createTempFile(
				cwd,
				`clients/consumer${i}.ts`,
				[
					"import { hubFn } from './hub';",
					`export function run${i}() { return hubFn(${i}); }`,
				].join("\n"),
			);
		}
		createTempFile(
			cwd,
			"entry/main.ts",
			[
				"import './consumer-alias';",
				"export function main() { return 1; }",
			].join("\n"),
		);
		// Give main.ts real fan-out so it qualifies as an entry point (near-zero
		// fan-in, high fan-out) rather than dead weight.
		createTempFile(
			cwd,
			"entry/consumer-alias.ts",
			"export const alias = 1;\n",
		);
		createTempFile(cwd, "isolated/dead.ts", "export const dead = 1;\n");
		await warmGraph(cwd);
	}

	it("computes all six sections with correct shapes", async () => {
		const env = makeEnv();
		await buildWarmFixture(env.tmpDir);

		const report = await projectReport(env.tmpDir);

		expect(report.available).toBe(true);

		// 1. Trust header.
		expect(report.trust).toBeDefined();
		expect(report.trust!.filesCovered).toBeGreaterThan(0);
		expect(report.trust!.coverage).toBeGreaterThan(0);
		expect(typeof report.trust!.graphBuiltAt).toBe("string");
		expect(Array.isArray(report.trust!.notes)).toBe(true);

		// 2. Hubs — hub.ts has 3 importers.
		expect(report.hubs).toBeDefined();
		const hub = report.hubs!.find((h) => h.file.endsWith("hub.ts"));
		expect(hub).toBeDefined();
		expect(hub!.fanIn).toBe(3);
		expect(hub!.suggestedNext).toEqual({ tool: "module_report", path: hub!.file });
		expect(typeof hub!.blastRadius).toBe("number");

		// 3. Entry points — main.ts has zero fan-in, one fan-out.
		expect(report.entryPoints).toBeDefined();
		const entry = report.entryPoints!.find((e) => e.file.endsWith("main.ts"));
		expect(entry).toBeDefined();
		expect(entry!.fanIn).toBe(0);
		expect(entry!.fanOut).toBeGreaterThan(0);

		// 4. Subsystem map.
		expect(report.subsystems).toBeDefined();
		expect(report.subsystems!.directories.length).toBeGreaterThan(0);
		expect(Array.isArray(report.subsystems!.edges)).toBe(true);
		expect(Array.isArray(report.subsystems!.cycles)).toBe(true);
		expect(Array.isArray(report.subsystems!.violations)).toBe(true);

		// 5. Risk hotspots — hub.ts has branching (complexity) and fan-in.
		expect(report.riskHotspots).toBeDefined();
		const hotspot = report.riskHotspots!.find((r) => r.file.endsWith("hub.ts"));
		expect(hotspot).toBeDefined();
		expect(hotspot!.maxComplexity).toBeGreaterThan(1);
		expect(hotspot!.score).toBe(hotspot!.fanIn * hotspot!.maxComplexity);

		// 6. Dead weight — dead.ts has zero fan-in and isn't an entry point
		// (zero fan-out too), and the disclaimer always travels with the section.
		expect(report.deadWeight).toBeDefined();
		expect(report.deadWeight!.disclaimer.length).toBeGreaterThan(0);
		expect(
			report.deadWeight!.files.some((f) => f.file.endsWith("dead.ts")),
		).toBe(true);
	});

	it("always includes the dead-weight disclaimer even when nothing qualifies", async () => {
		const env = makeEnv();
		// Every file here either imports or is imported — no dead weight.
		createTempFile(env.tmpDir, "a.ts", "export const a = 1;\n");
		createTempFile(env.tmpDir, "b.ts", "import { a } from './a';\nexport const b = a;\n");
		await warmGraph(env.tmpDir);

		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		expect(report.deadWeight!.disclaimer.length).toBeGreaterThan(0);

		const text = renderCompactProjectReport(report);
		expect(text).toContain("DEAD WEIGHT");
		expect(text).toContain(report.deadWeight!.disclaimer);
	});

	it("never reclassifies entry points past the display cap as dead weight", async () => {
		const env = makeEnv();
		createTempFile(env.tmpDir, "lib/shared.ts", "export const shared = 1;\n");
		// Three entry-point-like files (zero fan-in, real fan-out) — more than
		// the display cap below, so at least two overflow the entryPoints list.
		for (let i = 1; i <= 3; i += 1) {
			createTempFile(
				env.tmpDir,
				`entry/main${i}.ts`,
				[
					"import { shared } from '../lib/shared';",
					`export function main${i}() { return shared; }`,
				].join("\n"),
			);
		}
		await warmGraph(env.tmpDir);

		const report = await projectReport(env.tmpDir, { limit: 1 });
		expect(report.available).toBe(true);
		expect(report.entryPoints!.length).toBe(1);
		// The exclusion set is uncapped (#773: "zero-importer files that aren't
		// entry points") — the two overflow entry points must not appear here.
		expect(
			report.deadWeight!.files.some((f) => f.file.includes("entry/main")),
		).toBe(false);
	});

	it("scales every ranked list's cap with the single `limit` knob", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"lib/hub.ts",
			[
				"export function hubFn(x) {",
				"  if (x > 0) { return 1; } else { return 0; }",
				"}",
			].join("\n"),
		);
		for (let i = 1; i <= 5; i += 1) {
			createTempFile(
				env.tmpDir,
				`callers/c${i}.ts`,
				[
					"import { hubFn } from '../lib/hub';",
					`export function run${i}(x) {`,
					"  if (x > 1) { return hubFn(x); } else if (x < -1) { return -1; } else { return 0; }",
					"}",
				].join("\n"),
			);
		}
		await warmGraph(env.tmpDir);

		const uncapped = await projectReport(env.tmpDir, { limit: 50 });
		const capped = await projectReport(env.tmpDir, { limit: 1 });

		expect(capped.hubs!.length).toBeLessThanOrEqual(1);
		expect(capped.riskHotspots!.length).toBeLessThanOrEqual(1);
		expect(capped.entryPoints!.length).toBeLessThanOrEqual(1);
		// The uncapped run must never be MORE restrictive than the capped one.
		expect(uncapped.hubs!.length).toBeGreaterThanOrEqual(capped.hubs!.length);
	});
});

describe("projectReport — cycle and layering-violation detection", () => {
	it("detects a directory-level import cycle on a synthetic cyclic fixture", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"dirA/a.ts",
			[
				"import { b } from '../dirB/b';",
				"export const a = 1;",
				"export function useB() { return b; }",
			].join("\n"),
		);
		createTempFile(
			env.tmpDir,
			"dirB/b.ts",
			[
				"import { a } from '../dirA/a';",
				"export const b = 2;",
				"export function useA() { return a; }",
			].join("\n"),
		);
		await warmGraph(env.tmpDir);

		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		const cycle = report.subsystems!.cycles.find(
			(c) => c.dirs.includes("dirA") && c.dirs.includes("dirB"),
		);
		expect(cycle).toBeDefined();
		expect(cycle!.edgeCount).toBeGreaterThanOrEqual(2);
	});

	it("flags the minority direction as a layering violation", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"tools/t.ts",
			[
				"import { c1 } from '../clients/c1';",
				"export const t = 1;",
				"export function useC1() { return c1; }",
			].join("\n"),
		);
		for (let i = 1; i <= 3; i += 1) {
			createTempFile(
				env.tmpDir,
				`clients/c${i}.ts`,
				[
					"import { t } from '../tools/t';",
					`export const c${i} = 1;`,
					`export function useT${i}() { return t; }`,
				].join("\n"),
			);
		}
		await warmGraph(env.tmpDir);

		const report = await projectReport(env.tmpDir);
		expect(report.available).toBe(true);
		const violation = report.subsystems!.violations.find(
			(v) => v.from === "tools" && v.to === "clients",
		);
		expect(violation).toBeDefined();
		expect(violation!.count).toBeLessThan(violation!.dominantCount);
	});
});

describe("projectReport — focus re-ranking", () => {
	it("changes hub ordering to favor the focus term", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"clients/payments.ts",
			"export function chargeCard() { return 1; }\n",
		);
		for (let i = 1; i <= 2; i += 1) {
			createTempFile(
				env.tmpDir,
				`clients/payments-user${i}.ts`,
				[
					"import { chargeCard } from './payments';",
					`export function run${i}() { return chargeCard(); }`,
				].join("\n"),
			);
		}
		createTempFile(
			env.tmpDir,
			"clients/widgets.ts",
			"export function renderWidget() { return 1; }\n",
		);
		for (let i = 1; i <= 5; i += 1) {
			createTempFile(
				env.tmpDir,
				`clients/widgets-user${i}.ts`,
				[
					"import { renderWidget } from './widgets';",
					`export function run${i}() { return renderWidget(); }`,
				].join("\n"),
			);
		}
		await warmGraph(env.tmpDir);

		const unfocused = await projectReport(env.tmpDir);
		// Without a focus hint, widgets.ts (5 importers) outranks payments.ts (2).
		expect(unfocused.hubs![0].file).toContain("widgets");

		const focused = await projectReport(env.tmpDir, { focus: "payments charge" });
		expect(focused.hubs![0].file).toContain("payments");
	});
});
