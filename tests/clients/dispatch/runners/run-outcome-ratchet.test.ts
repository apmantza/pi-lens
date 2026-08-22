import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNNERS_DIR = fileURLToPath(
	new URL("../../../../clients/dispatch/runners", import.meta.url),
);
const CLIENTS_DIR = fileURLToPath(
	new URL("../../../../clients", import.meta.url),
);

/** Files in the runners directory that are not runner definitions. */
const NOT_A_RUNNER = new Set(["index.ts", "utils.ts"]);

/**
 * Every runner that does NOT yet route its spawn through `classifyRunOutcome`
 * carries a reason here (#1816). This is the population sweep, kept honest by
 * the test below: a new runner file that neither uses the primitive nor
 * appears here fails, and an entry that no longer matches a real file fails
 * too. Migrating the rest is #1737's strangler work, deliberately not this PR.
 */
const NOT_YET_ON_PRIMITIVE: Record<string, string> = {
	// No child process at all — there is no spawn outcome to classify.
	"ast-grep-napi.ts": "in-process NAPI analysis, no child process",
	"fact-rules.ts": "in-process FactRule pipeline, no child process",
	"lsp.ts": "language-server requests, no child process of its own",
	"tree-sitter.ts": "in-process tree-sitter parse, no child process",
	"yaml-rule-parser.ts": "in-process YAML rule evaluation, no child process",

	// Spawning runners that already consult the spawn outcome with their own
	// per-tool check. Correct today, not yet unified. #1737.
	"actionlint.ts": "reads its own exit status; #1737 strangler",
	"cpp-check.ts": "reads its own exit status; #1737 strangler",
	"credo.ts": "reads its own exit status; #1737 strangler",
	"dart-analyze.ts": "reads its own exit status; #1737 strangler",
	"dotnet-build.ts": "reads its own exit status; #1737 strangler",
	"elixir-check.ts": "reads its own exit status; #1737 strangler",
	"eslint.ts": "reads its own exit status; #1737 strangler",
	"fish-indent.ts": "reads its own exit status; #1737 strangler",
	"gleam-check.ts": "reads its own exit status; #1737 strangler",
	"golangci-lint.ts": "reads its own exit status; #1737 strangler",
	"helm-lint.ts": "reads its own exit status; #1737 strangler",
	"helm-render.ts": "reads its own exit status; #1737 strangler",
	"javac.ts": "reads its own exit status; #1737 strangler",
	"ktlint.ts": "reads its own exit status; #1737 strangler",
	"php-lint.ts": "reads its own exit status; #1737 strangler",
	"prisma-validate.ts": "reads its own exit status; #1737 strangler",
	"psscriptanalyzer.ts": "reads its own exit status; #1737 strangler",
	"rubocop.ts": "reads its own exit status; #1737 strangler",
	"ruff.ts": "reads its own exit status; #1737 strangler",
	"rust-clippy.ts": "reads its own exit status; #1737 strangler",
	"shfmt.ts": "reads its own exit status; #1737 strangler",
	"spotbugs.ts": "reads its own exit status; #1737 strangler",
	"zig-check.ts": "reads its own exit status; #1737 strangler",
};

function runnerFiles(): string[] {
	return fs
		.readdirSync(RUNNERS_DIR)
		.filter((name) => name.endsWith(".ts") && !NOT_A_RUNNER.has(name))
		.sort();
}

function readRunner(name: string): string {
	return fs.readFileSync(path.join(RUNNERS_DIR, name), "utf8");
}

const USES_PRIMITIVE = /utils\/(spawn-outcome|tool-failure)\.js/;
const SPAWNS = /safeSpawn/;

describe("run-outcome primitive ratchet", () => {
	it("every runner either uses the primitive or carries a reason", () => {
		const unlisted = runnerFiles().filter(
			(name) =>
				!USES_PRIMITIVE.test(readRunner(name)) && !NOT_YET_ON_PRIMITIVE[name],
		);
		expect(
			unlisted,
			"add these to NOT_YET_ON_PRIMITIVE with a reason, or route them through classifyRunOutcome",
		).toEqual([]);
	});

	it("carries no stale exemptions", () => {
		const present = new Set(runnerFiles());
		const stale = Object.keys(NOT_YET_ON_PRIMITIVE).filter(
			(name) => !present.has(name),
		);
		expect(stale, "these files no longer exist").toEqual([]);
	});

	it("does not exempt a runner that already migrated", () => {
		const migrated = Object.keys(NOT_YET_ON_PRIMITIVE).filter(
			(name) => present(name) && USES_PRIMITIVE.test(readRunner(name)),
		);
		expect(migrated, "drop these exemptions").toEqual([]);
	});

	function present(name: string): boolean {
		return fs.existsSync(path.join(RUNNERS_DIR, name));
	}

	// The nine #1816 migrated, plus phpstan, which #1948 pulled onto the
	// primitive while closing the parsed-nothing hole. Pinning them by name
	// means a revert cannot pass by quietly adding an exemption instead.
	it("pins the runners already on the primitive", () => {
		for (const name of [
			"biome-check.ts",
			"go-vet.ts",
			"oxlint.ts",
			"phpstan.ts",
			"pyright.ts",
			"shellcheck.ts",
			"markdownlint.ts",
			"mypy.ts",
			"spellcheck.ts",
			"sqlfluff.ts",
			"stylelint.ts",
			"swiftlint.ts",
			"vale.ts",
			"yamllint.ts",
		]) {
			expect(USES_PRIMITIVE.test(readRunner(name)), `${name}`).toBe(true);
			expect(NOT_YET_ON_PRIMITIVE[name]).toBeUndefined();
		}
	});

	it("every exempted spawning runner still reads its spawn outcome", () => {
		const blind = Object.keys(NOT_YET_ON_PRIMITIVE).filter((name) => {
			const source = readRunner(name);
			if (!SPAWNS.test(source)) return false;
			return !/\.(status|error)\b/.test(
				source.replace(/status:\s*"[a-z]+"/g, ""),
			);
		});
		expect(blind, "these runners are exit-blind and must be migrated").toEqual(
			[],
		);
	});
});

describe("shared cascade TTL", () => {
	// #1816: two modules each declared their own 240_000. A split pair reads as
	// two independent policies and drifts.
	it("is declared exactly once", () => {
		const declarations: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
				} else if (entry.name.endsWith(".ts")) {
					const source = fs.readFileSync(full, "utf8");
					if (/CASCADE_[A-Z_]*TTL_MS\s*=\s*240_000/.test(source)) {
						declarations.push(path.relative(CLIENTS_DIR, full));
					}
				}
			}
		};
		walk(CLIENTS_DIR);
		expect(declarations).toEqual(["cascade-types.ts"]);
	});
});
