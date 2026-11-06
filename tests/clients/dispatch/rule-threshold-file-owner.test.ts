/**
 * `rules.<id>.threshold` reads the EDITED FILE's config owner (#5292).
 *
 * `rules.disable`, `select` and `ignorePaths` already read the file-owner
 * layered resolution the dispatcher computes
 * ({@link resolveDispatchPolicyConfigForFile}); the two rule thresholds read
 * `ctx.projectConfig`, the session root's whole file, so with a root
 * `.pi-lens.json` threshold of 40 and a `pkg/.pi-lens.json` threshold of 5,
 * `pkg/a.ts` was judged by 40 and its own package's tighter setting never
 * applied. Every case below drives the real `createDispatchContext` +
 * `runProviders` + `dispatchForFile` path against real `.pi-lens.json` files
 * and real tree-sitter function facts on disk; the session cwd is the workspace
 * root, as in production (a cwd of the file's own directory would hide the
 * defect by resolving the nearest whole file).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { runProviders } from "../../../clients/dispatch/fact-runner.js";
import factRulesRunner from "../../../clients/dispatch/runners/fact-rules.js";
// The dispatch entry registers the fact providers and the fact rules, so the
// dispatch below runs the production registry rather than a hand-seeded one.
import "../../../clients/dispatch/integration.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { useConfigPath } from "../../support/global-config.js";
import { removeTempDirSync } from "../test-utils.js";

const setConfigPath = useConfigPath();

let tmpDir: string;
let repo: string;
let pkg: string;

/** Cyclomatic complexity 8 (1 + seven `if`s), nesting depth 1. */
const COMPLEX_SOURCE = `export function orderTotals(input: number): number {
	let total = input;
	if (total > 1) total += 1;
	if (total > 2) total += 2;
	if (total > 3) total += 3;
	if (total > 4) total += 4;
	if (total > 5) total += 5;
	if (total > 6) total += 6;
	if (total > 7) total += 7;
	return total;
}
`;

/** Eight distinct outgoing calls, cyclomatic complexity 1. */
const WIDE_SOURCE = `export function orchestrate(): number {
	let sum = 0;
	sum += loadUser();
	sum += loadCart();
	sum += priceItems();
	sum += applyCoupon();
	sum += taxOf();
	sum += shippingFor();
	sum += writeInvoice();
	sum += emitReceipt();
	return sum;
}
`;

function writeConfig(dir: string, config: unknown): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi-lens.json"), JSON.stringify(config));
}

/** The root's thresholds, deliberately looser than the package's. */
function rootConfig(rules: Record<string, unknown>): void {
	writeConfig(repo, { rules });
}

async function dispatchRules(
	filePath: string,
	content: string,
): Promise<Diagnostic[]> {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	const facts = new FactStore();
	const ctx = createDispatchContext(
		filePath,
		repo,
		{ getFlag: () => false },
		facts,
		false,
		undefined,
		repo,
	);
	const registry = new RunnerRegistry();
	registry.register(factRulesRunner);
	await runProviders(ctx);
	const result = await dispatchForFile(
		ctx,
		[{ mode: "all", runnerIds: ["fact-rules"], filterKinds: ["jsts"] }],
		registry,
	);
	return result.diagnostics;
}

function rulesOf(diagnostics: Diagnostic[]): string[] {
	return diagnostics.map((d) => d.rule ?? "").sort();
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-rule-threshold-owner-"),
	);
	repo = path.join(tmpDir, "repo");
	pkg = path.join(repo, "pkg");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	setConfigPath(path.join(tmpDir, "global", "config.json"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	resetProjectLensConfigCache();
	removeTempDirSync(tmpDir);
});

describe("rules.<id>.threshold — the dispatch reads the file's config owner", () => {
	it("flags pkg/a.ts with the nested package's high-complexity threshold", async () => {
		rootConfig({ "high-complexity": { threshold: 40 } });
		writeConfig(pkg, { rules: { "high-complexity": { threshold: 5 } } });

		const diagnostics = await dispatchRules(
			path.join(pkg, "a.ts"),
			COMPLEX_SOURCE,
		);

		expect(rulesOf(diagnostics)).toContain("high-complexity");
	});

	it("leaves the same body at the workspace root under the root's threshold", async () => {
		rootConfig({ "high-complexity": { threshold: 40 } });
		writeConfig(pkg, { rules: { "high-complexity": { threshold: 5 } } });

		const diagnostics = await dispatchRules(
			path.join(repo, "a.ts"),
			COMPLEX_SOURCE,
		);

		expect(rulesOf(diagnostics)).not.toContain("high-complexity");
	});

	it("flags pkg/a.ts with the nested package's high-fan-out threshold", async () => {
		rootConfig({ "high-fan-out": { threshold: 40 } });
		writeConfig(pkg, { rules: { "high-fan-out": { threshold: 5 } } });

		const diagnostics = await dispatchRules(
			path.join(pkg, "a.ts"),
			WIDE_SOURCE,
		);

		expect(rulesOf(diagnostics)).toContain("high-fan-out");
	});

	it("leaves the same wide body at the workspace root under the root's threshold", async () => {
		rootConfig({ "high-fan-out": { threshold: 40 } });
		writeConfig(pkg, { rules: { "high-fan-out": { threshold: 5 } } });

		const diagnostics = await dispatchRules(
			path.join(repo, "a.ts"),
			WIDE_SOURCE,
		);

		expect(rulesOf(diagnostics)).not.toContain("high-fan-out");
	});

	it("layers the two rules field by field across the two files", async () => {
		// The root sets a tight complexity threshold and a loose fan-out one; the
		// package tightens fan-out only. So each field is what makes its own rule
		// fire: fan-out only under the package's 5, complexity only under the
		// root's 5 (the default of 15 would leave CC 8 silent).
		rootConfig({
			"high-complexity": { threshold: 5 },
			"high-fan-out": { threshold: 40 },
		});
		writeConfig(pkg, { rules: { "high-fan-out": { threshold: 5 } } });

		const fanOut = await dispatchRules(path.join(pkg, "a.ts"), WIDE_SOURCE);
		expect(rulesOf(fanOut)).toContain("high-fan-out");

		const complex = await dispatchRules(path.join(pkg, "b.ts"), COMPLEX_SOURCE);
		expect(rulesOf(complex)).toContain("high-complexity");
	});

	// The project parser's rule for a threshold, kept by the file-owner read: a
	// value that is not positive falls back to the default, it does not flag
	// every function in the package. The parser also drops a non-number or a
	// non-finite one, and the config walk does the same before a tier merges.
	it("falls back to the default when the nested threshold is not positive", async () => {
		// The root threshold is tight on purpose: silence below proves the value
		// that applied is the rule default of 15, not the root's 5.
		rootConfig({ "high-complexity": { threshold: 5 } });
		writeConfig(pkg, { rules: { "high-complexity": { threshold: 0 } } });

		const diagnostics = await dispatchRules(
			path.join(pkg, "a.ts"),
			COMPLEX_SOURCE,
		);

		// CC 8 is below the default of 15, so nothing is flagged: had 0 been
		// honoured, every function would be, and had the root's 5 survived the
		// dropped nested value, this one would be.
		expect(rulesOf(diagnostics)).not.toContain("high-complexity");
	});
});

describe("rules.<id>.threshold — a project with no nested config is unchanged", () => {
	it("keeps a root threshold of 40 silent for a file in a plain subdirectory", async () => {
		rootConfig({
			"high-complexity": { threshold: 40 },
			"high-fan-out": { threshold: 40 },
		});
		fs.mkdirSync(pkg, { recursive: true });

		expect(
			rulesOf(await dispatchRules(path.join(pkg, "a.ts"), COMPLEX_SOURCE)),
		).not.toContain("high-complexity");
		expect(
			rulesOf(await dispatchRules(path.join(pkg, "b.ts"), WIDE_SOURCE)),
		).not.toContain("high-fan-out");
	});

	it("still honours a root threshold of 5 for a file in a plain subdirectory", async () => {
		rootConfig({
			"high-complexity": { threshold: 5 },
			"high-fan-out": { threshold: 5 },
		});
		fs.mkdirSync(pkg, { recursive: true });

		expect(
			rulesOf(await dispatchRules(path.join(pkg, "a.ts"), COMPLEX_SOURCE)),
		).toContain("high-complexity");
		expect(
			rulesOf(await dispatchRules(path.join(pkg, "b.ts"), WIDE_SOURCE)),
		).toContain("high-fan-out");
	});

	it("uses the built-in default with no config file at all", async () => {
		fs.mkdirSync(pkg, { recursive: true });

		// CC 8 and 8 calls: below the defaults of 15 and 20.
		expect(
			rulesOf(await dispatchRules(path.join(pkg, "a.ts"), COMPLEX_SOURCE)),
		).toEqual([]);
		expect(
			rulesOf(await dispatchRules(path.join(pkg, "b.ts"), WIDE_SOURCE)),
		).toEqual([]);
	});
});
