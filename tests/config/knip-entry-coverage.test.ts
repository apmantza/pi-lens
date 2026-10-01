import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	realHarnessInclude,
	wallClockBudgetInclude,
} from "../../vitest.config.js";
import { getWin32LaneFiles } from "../../scripts/lib/win32-gate-population.mjs";
import { auditRegistry } from "../support/sweep-kit.js";

/**
 * knip.jsonc's `entry` list must cover every script a GitHub Actions
 * workflow or a `.claude/settings.json` hook invokes directly with
 * `node <path>` — otherwise that script silently becomes a knip "unused
 * file" the moment nothing else in the repo happens to import it (#2698).
 *
 * This walks the WORKFLOW/HOOK side (the actual `run:`/`command` strings),
 * not knip's own reachability graph — it is a governance check on the
 * config's coverage of a specific, enumerable input set, not a
 * re-implementation of knip's dependency resolution.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { parse: parseJson5 } = require("json5") as {
	parse: (source: string) => unknown;
};

// `node <path>` invocations only — the interesting case for "did the config
// forget this script", not every binary a step happens to run.
const NODE_INVOCATION =
	/\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:mjs|ts|js))\b/g;

function scriptPathsInText(text: string): Set<string> {
	const found = new Set<string>();
	for (const match of text.matchAll(NODE_INVOCATION)) {
		const candidate = match[1];
		if (candidate.startsWith("scripts/") || candidate.startsWith("mcp/")) {
			found.add(candidate);
		}
	}
	return found;
}

function scriptPathsFromWorkflows(): Set<string> {
	const dir = resolve(repoRoot, ".github/workflows");
	const found = new Set<string>();
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
		const raw = readFileSync(resolve(dir, name), "utf8");
		const doc = yaml.load(raw) as {
			jobs?: Record<string, { steps?: Array<{ run?: unknown }> }>;
		};
		for (const job of Object.values(doc.jobs ?? {})) {
			for (const step of job.steps ?? []) {
				if (typeof step.run === "string") {
					for (const p of scriptPathsInText(step.run)) found.add(p);
				}
			}
		}
	}
	return found;
}

function scriptPathsFromClaudeHooks(): Set<string> {
	const raw = readFileSync(resolve(repoRoot, ".claude/settings.json"), "utf8");
	const settings = JSON.parse(raw) as {
		hooks?: Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>>;
	};
	const found = new Set<string>();
	for (const entries of Object.values(settings.hooks ?? {})) {
		for (const entry of entries) {
			for (const hook of entry.hooks ?? []) {
				if (typeof hook.command === "string") {
					for (const p of scriptPathsInText(hook.command)) found.add(p);
				}
			}
		}
	}
	return found;
}

/**
 * `.js` -> `.ts` compiled-sibling normalization, same rule
 * scripts/run-knip.mjs applies before invoking knip: a workflow that runs
 * the checked-in `scripts/download-grammars.js` is really exercising its
 * `scripts/download-grammars.ts` source, which is what knip's `entry` list
 * has to cover.
 */
function normalize(scriptPath: string): string {
	if (!scriptPath.endsWith(".js")) return scriptPath;
	const tsSibling = `${scriptPath.slice(0, -".js".length)}.ts`;
	return existsSync(resolve(repoRoot, tsSibling)) ? tsSibling : scriptPath;
}

/**
 * Minimal glob matcher for the two shapes knip.jsonc's `entry` patterns
 * actually use: a single `*` (no `/`) and `**` (any depth, including `/`).
 * Not a general-purpose glob library — narrow on purpose, mirroring the
 * existing local `globToRegExp` helper in clients/file-utils.ts.
 */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
		} else if (c === "*") {
			re += "[^/]*";
		} else if (".+^${}()|[]\\".includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

function readKnipEntries(): string[] {
	const raw = readFileSync(resolve(repoRoot, "knip.jsonc"), "utf8");
	const config = parseJson5(raw) as { entry?: string[] };
	return config.entry ?? [];
}

/**
 * Reproduce the Windows workflow's dynamic population so a new platform test
 * cannot become invisible to knip when it joins that lane (#2837).
 */
function windowsVitestFiles(): string[] {
	return getWin32LaneFiles(repoRoot);
}

const LANE_ALREADY_REACHED: Readonly<Record<string, string>> = {
	"tests/mcp/turn-end-route.smoke.test.ts":
		"already reached through the Vitest config's default project graph; " +
		"Knip reports an explicit entry as redundant",
	"tests/packaging-pack-manifest.test.ts":
		"already reached through the Vitest config's default project graph; " +
		"Knip reports an explicit entry as redundant",
	"tests/support/fault-injection.test.ts":
		"already reached through the Vitest config's default project graph; " +
		"Knip reports an explicit entry as redundant",
	"tests/support/git-config-guard.test.ts":
		"already reached through the Vitest config's default project graph; " +
		"Knip reports an explicit entry as redundant",
	"tests/support/git-fixture-env.test.ts":
		"already reached through the Vitest config's default project graph; " +
		"Knip reports an explicit entry as redundant",
	// #3082: verified, not assumed — `npm run knip` with
	// "tests/support/tests-tree-write-guard.test.ts" added to knip.jsonc's
	// entry list reported "Remove redundant entry pattern" for exactly that
	// line, and without it knip reports no unused file.
	// #3179: verified the same way as its sibling below — `npm run knip` with
	// "tests/support/tests-tree-write-guard-race.test.ts" added to
	// knip.jsonc's entry list reported "Remove redundant entry pattern" for
	// exactly that line.
	"tests/support/tests-tree-write-guard-race.test.ts":
		"already reached through the Vitest config's default project graph; " +
		"Knip reports an explicit entry as redundant",
	"tests/support/tests-tree-write-guard.test.ts":
		"already reached through the Vitest config's default project graph; " +
		"Knip reports an explicit entry as redundant",
	// #3703: verified the same way — `npm run knip` with this file added to
	// knip.jsonc's entry list reported "Remove redundant entry pattern" for it.
	"tests/support/vitest-setup-registry-teardown.test.ts":
		"already reached through the Vitest config's default project graph; " +
		"Knip reports an explicit entry as redundant",
	// #2912: verified the same way — `npm run knip` with this file added to
	// knip.jsonc's entry list reported "Remove redundant entry pattern" for it.
	"tests/support/tmp-root-teardown.test.ts":
		"already reached through the Vitest config's default project graph; " +
		"Knip reports an explicit entry as redundant",
};

describe("knip entry coverage (#2698)", () => {
	it("covers every script a workflow run: step or .claude hook invokes with node", () => {
		const fromWorkflows = scriptPathsFromWorkflows();
		const fromHooks = scriptPathsFromClaudeHooks();
		expect(fromWorkflows.size).toBeGreaterThan(0); // sanity: the scan itself must find something real
		expect(fromHooks.size).toBeGreaterThan(0);

		const invoked = new Set([...fromWorkflows, ...fromHooks].map(normalize));
		const entries = readKnipEntries();
		const patterns = entries.map((pattern) => globToRegExp(pattern));
		const covered = [...invoked].filter((scriptPath) =>
			patterns.some((re) => re.test(scriptPath)),
		);

		const audit = auditRegistry({
			sweepName: "knip entry coverage",
			flagged: invoked,
			registered: covered,
			scannedCount: invoked.size,
			minScanned: 1,
			remediation: "add an entry pattern to knip.jsonc",
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});

	it("covers every test file admitted by the Vitest and Windows lanes (#2837)", () => {
		const expected = new Set([
			...realHarnessInclude,
			...wallClockBudgetInclude,
			...windowsVitestFiles(),
		]);
		const entries = readKnipEntries();
		const patterns = entries.map((pattern) => globToRegExp(pattern));
		const covered = [...expected].filter((file) =>
			patterns.some((pattern) => pattern.test(file)),
		);
		const audit = auditRegistry({
			sweepName: "knip Vitest lane entry coverage",
			flagged: expected,
			registered: covered,
			exemptions: LANE_ALREADY_REACHED,
			scannedCount: expected.size,
			minScanned: 1,
			remediation:
				"add the lane member to knip.jsonc's entry list, or document why " +
				"Knip already reaches it through the Vitest config graph",
		});
		const missing = [...expected].filter(
			(file) =>
				!patterns.some((pattern) => pattern.test(file)) &&
				!LANE_ALREADY_REACHED[file],
		);
		expect(
			audit.problems.concat(missing),
			"every real-harness, Windows, and wall-clock Vitest member must be a knip entry",
		).toEqual([]);
		// #3104 review F4: this case walks the whole tests/ tree through
		// `windowsVitestFiles()` and measured 8.0 s under Stryker's dry run,
		// which times out at vitest's 5 s default and reds the mutation lane.
		// The work is a directory walk, not a wait, so the budget is explicit.
	}, 60_000);
});
