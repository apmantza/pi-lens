/**
 * Edit-scope census (#4481): every dispatch lane that can STOP the agent on a
 * per-edit pass is classified as span-gated or unscoped by design.
 *
 * Recurrence this prevents: #4481. tree-sitter gated its blocking tier on the
 * edited lines; ast-grep-napi was added beside it without that gate, so the
 * first write to a file stopped the agent on old ast-grep findings the edit
 * never touched. Nothing tied a new blocking lane to a decision about edit
 * scope. Here a lane with no classification fails, naming the lane, and a
 * span-gated lane whose runner source no longer calls
 * `spanOverlapsModifiedRanges` fails too.
 *
 * Scope (the maintainer's 2026-10-15 decision, mirrored on #4480): only the
 * ast-grep lanes and tree-sitter are span-gated. Language-server diagnostics,
 * type checkers, compilers, linters and the other scanners stay unscoped by
 * design: an edit can cause their findings at a line it never touched. A
 * runner source outside the span-gated set that references the predicate or
 * `modifiedRanges` fails, so a gate, shared or private (tree-sitter's was a
 * private function before #4481 r2), cannot drift onto an unscoped runner
 * through the runner module itself.
 *
 * Derivation (AGENTS.md shape 69): lanes come from the live registry
 * (`registerDefaultRunners`) plus one lane per auxiliary LSP profile, never a
 * hand list. Every registered runner is classified, not only today's blocking
 * emitters: whether a runner can block is decided by shared helpers (severity
 * maps, `blockOnErrorWhenAllowed`) a file-local scan cannot see, so the census
 * fails closed on the whole registry. A runner's source file is found by
 * module identity (the runner module whose default export IS the registered
 * object); a registered runner with no such module fails. A gated runner
 * needs a direct call found in the AST (`callSites`); an unscoped runner must
 * hold no code reference to the predicate or to `modifiedRanges`
 * (`codeMatches`, comments and strings blanked). Either way a comment or
 * string quoting the call never counts.
 *
 * Blind spots, each named so nobody reads this census as wider than it is:
 * - The classification itself is judgment: a runner filed under the wrong
 *   unscoped kind passes.
 * - Only each runner's own default-export module is scanned. A gate inside a
 *   `runners/utils/` helper (or any other imported module) is not seen.
 * - The `lsp` runner is one module for the `lsp` (semantic) lane and the
 *   `lsp/ast-grep` (gated) lane. A gate inside `lsp.ts` widened to every tool
 *   passes the census; only the behaviour guard `keeps a language-server
 *   blocker on an unchanged line` (runner-status-semantics.test.ts) catches it.
 * - A gated call in code that never runs on the per-edit pass passes; the
 *   behaviour tests for the three gates catch that.
 */

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { AUXILIARY_LSP_PROFILES } from "../../../clients/dispatch/auxiliary-lsp.js";
import { RunnerRegistry } from "../../../clients/dispatch/dispatcher.js";
import {
	PRE_EDIT_SEED_RUNNER_IDS,
	PRE_EDIT_SEED_SPANLESS_RUNNER_IDS,
} from "../../../clients/dispatch/pre-edit-seed.js";
import { registerDefaultRunners } from "../../../clients/dispatch/runners/index.js";
import type { RunnerDefinition } from "../../../clients/dispatch/types.js";
import {
	assertNonEmptyScan,
	assertSortedRegistry,
	callSites,
	codeMatches,
} from "../../support/sweep-kit.js";

const RUNNERS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../clients/dispatch/runners",
);

const PREDICATE = /^spanOverlapsModifiedRanges$/;

type Classification =
	| { scope: "span-gated" }
	| { scope: "unscoped"; kind: "linter" | "semantic" | "scanner" };

const GATED: Classification = { scope: "span-gated" };
const LINTER: Classification = { scope: "unscoped", kind: "linter" };
const SEMANTIC: Classification = { scope: "unscoped", kind: "semantic" };
const SCANNER: Classification = { scope: "unscoped", kind: "scanner" };

/**
 * Lane id → classification. A registry runner's lane is its id; an auxiliary
 * LSP profile's lane is `lsp/<tool>` (its findings come from the `lsp` runner,
 * whose own lane is the language-server diagnostics). Sorted.
 */
const CLASSIFICATION: Readonly<Record<string, Classification>> = {
	actionlint: LINTER,
	"ast-grep-napi": GATED,
	"biome-check-json": LINTER,
	"cpp-check": SEMANTIC,
	credo: LINTER,
	"cue-vet": SEMANTIC,
	"dart-analyze": SEMANTIC,
	detekt: LINTER,
	"dotnet-build": SEMANTIC,
	"elixir-check": SEMANTIC,
	eslint: LINTER,
	"fact-rules": SCANNER,
	"fish-indent": SEMANTIC,
	"gleam-check": SEMANTIC,
	"go-vet": SEMANTIC,
	"golangci-lint": LINTER,
	hadolint: LINTER,
	"helm-lint": SEMANTIC,
	"helm-render": SEMANTIC,
	htmlhint: LINTER,
	javac: SEMANTIC,
	ktlint: LINTER,
	lsp: SEMANTIC,
	"lsp/ast-grep": GATED,
	"lsp/fallow": SCANNER,
	"lsp/opengrep": SCANNER,
	"lsp/typos": SCANNER,
	"lsp/zizmor": SCANNER,
	markdownlint: LINTER,
	mypy: SEMANTIC,
	oxlint: LINTER,
	"php-lint": SEMANTIC,
	phpstan: SEMANTIC,
	"prisma-validate": SEMANTIC,
	psscriptanalyzer: LINTER,
	pyright: SEMANTIC,
	rubocop: LINTER,
	"ruff-lint": LINTER,
	"rust-clippy": LINTER,
	shellcheck: LINTER,
	shfmt: SEMANTIC,
	spellcheck: LINTER,
	spotbugs: SCANNER,
	sqlfluff: LINTER,
	stylelint: LINTER,
	swiftlint: LINTER,
	taplo: SEMANTIC,
	terragrunt: SEMANTIC,
	tflint: LINTER,
	"tree-sitter": GATED,
	"trivy-config": SCANNER,
	vale: LINTER,
	yamllint: LINTER,
	"zig-check": SEMANTIC,
};

interface Lane {
	id: string;
	/** The registry runner whose source emits this lane's findings. */
	runnerId: string;
}

function registeredRunners(): RunnerDefinition[] {
	const registry = new RunnerRegistry();
	registerDefaultRunners(registry);
	return registry.list();
}

function derivedLanes(runners: readonly RunnerDefinition[]): Lane[] {
	const lanes: Lane[] = runners.map((r) => ({ id: r.id, runnerId: r.id }));
	for (const profile of AUXILIARY_LSP_PROFILES) {
		lanes.push({ id: `lsp/${profile.tool}`, runnerId: "lsp" });
	}
	return lanes;
}

/** Runner id → source path, by default-export identity with the registry. */
async function runnerSources(
	runners: readonly RunnerDefinition[],
): Promise<Map<string, string>> {
	const byObject = new Map<unknown, string>(runners.map((r) => [r, r.id]));
	const sources = new Map<string, string>();
	const files = readdirSync(RUNNERS_DIR).filter(
		(f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
	);
	assertNonEmptyScan("runner sources", files.length, 40);
	for (const file of files) {
		const compiled = path.join(RUNNERS_DIR, file.replace(/\.ts$/, ".js"));
		const mod = (await import(pathToFileURL(compiled).href)) as {
			default?: unknown;
		};
		const id = byObject.get(mod.default);
		if (id !== undefined) sources.set(id, path.join(RUNNERS_DIR, file));
	}
	return sources;
}

/** Gated direction: a direct AST call; an alias reds loudly (fail closed). */
function callsPredicate(sourcePath: string): boolean {
	return callSites(readFileSync(sourcePath, "utf8"), PREDICATE).length > 0;
}

/**
 * Drift direction: any code reference (import, alias, namespace member) to the
 * predicate, or to `modifiedRanges` itself, so an unscoped runner can gate
 * neither through an alias the call scan would miss nor through its own
 * inline range check.
 */
function referencesEditScope(sourcePath: string): boolean {
	const source = readFileSync(sourcePath, "utf8");
	return (
		codeMatches(source, /\b(?:spanOverlapsModifiedRanges|modifiedRanges)\b/)
			.length > 0
	);
}

describe("edit-scope census (#4481)", () => {
	it("classifies every registered runner and auxiliary LSP lane", () => {
		const lanes = derivedLanes(registeredRunners());
		assertNonEmptyScan("dispatch lanes", lanes.length, 40);
		const live = new Set(lanes.map((l) => l.id));
		const unclassified = [...live].filter((id) => !(id in CLASSIFICATION));
		const stale = Object.keys(CLASSIFICATION).filter((id) => !live.has(id));
		expect(
			unclassified,
			"classify each new dispatch lane in CLASSIFICATION: span-gated only " +
				"under the maintainer's ast-grep/tree-sitter scope, otherwise unscoped",
		).toEqual([]);
		expect(
			stale,
			"remove classifications for lanes that no longer exist",
		).toEqual([]);
		assertSortedRegistry(
			"edit-scope classification",
			Object.keys(CLASSIFICATION),
		);
	});

	it("seeds the pre-edit baseline from exactly the linter lanes (#4483)", () => {
		// Recurrence: a linter registered (or reclassified) here without joining
		// PRE_EDIT_SEED_RUNNER_IDS would stop the agent on its old errors at a
		// file's first write again (#4483); a language server or scanner added
		// to that set would hide its old errors there, against the maintainer's
		// linters-only scope (2026-10-15).
		const linters = Object.entries(CLASSIFICATION)
			.filter(([, c]) => c.scope === "unscoped" && c.kind === "linter")
			.map(([id]) => id);
		assertNonEmptyScan("linter lanes", linters.length, 20);
		expect(
			[...PRE_EDIT_SEED_RUNNER_IDS].sort(),
			"PRE_EDIT_SEED_RUNNER_IDS (clients/dispatch/pre-edit-seed.ts) must equal the lanes classified LINTER here",
		).toEqual(linters.sort());
	});

	it("seeds a spanless writer's baseline from the linter lanes plus the registry's span-gated lanes (#5553)", () => {
		// Recurrence: `ast_grep_replace`, `sed -i`, an unclassified tool and an LSP
		// rename give the dispatch no edit span, so the two span-gated registry
		// lanes read the whole file and stopped the agent on a `debugger;` HEAD
		// already held (#5553). A span-gated lane registered later without
		// joining the set would repeat it; a language server or scanner added
		// would hide its old errors, against the maintainer's scope (2026-10-15).
		// `lsp/ast-grep` is an auxiliary profile of the `lsp` runner, not a
		// registry runner, so it cannot be seeded by runner id.
		const expected = Object.entries(CLASSIFICATION)
			.filter(
				([id, c]) =>
					(c.scope === "unscoped" && c.kind === "linter") ||
					(c.scope === "span-gated" && !id.includes("/")),
			)
			.map(([id]) => id)
			.sort();
		assertNonEmptyScan("spanless seed lanes", expected.length, 20);
		expect(
			[...PRE_EDIT_SEED_SPANLESS_RUNNER_IDS].sort(),
			"PRE_EDIT_SEED_SPANLESS_RUNNER_IDS (clients/dispatch/pre-edit-seed.ts) must equal the LINTER lanes plus the span-gated registry lanes",
		).toEqual(expected);
	});

	it("finds a runner source for every registered runner", async () => {
		const runners = registeredRunners();
		const sources = await runnerSources(runners);
		const missing = runners.map((r) => r.id).filter((id) => !sources.has(id));
		expect(
			missing,
			"a registered runner must be the default export of a module in clients/dispatch/runners/",
		).toEqual([]);
	});

	it("span-gated lanes call spanOverlapsModifiedRanges and only they do", async () => {
		const runners = registeredRunners();
		const sources = await runnerSources(runners);
		const lanes = derivedLanes(runners);
		const gatedRunnerIds = new Set(
			lanes
				.filter((l) => CLASSIFICATION[l.id]?.scope === "span-gated")
				.map((l) => l.runnerId),
		);
		assertNonEmptyScan("span-gated runners", gatedRunnerIds.size, 3);

		const ungated = [...gatedRunnerIds].filter((id) => {
			const source = sources.get(id);
			return source === undefined || !callsPredicate(source);
		});
		expect(
			ungated,
			"a span-gated lane's runner must call spanOverlapsModifiedRanges on the per-edit pass",
		).toEqual([]);

		const driftedGates = runners
			.map((r) => r.id)
			.filter((id) => !gatedRunnerIds.has(id))
			.filter((id) => {
				const source = sources.get(id);
				return source !== undefined && referencesEditScope(source);
			});
		expect(
			driftedGates,
			"only the ast-grep lanes and tree-sitter are edit-scoped; an unscoped runner must not gate on the edited lines",
		).toEqual([]);
	});
});
