/**
 * #3968 class sweep — "a lane claims a dialect or capability it cannot serve,
 * with no ownership channel".
 *
 * Population census over the dispatch runners (`clients/dispatch/runners/**`,
 * `.ts` sources only, never the compiled twins), two detector families:
 *
 *   A. **literal-id self-skip predicates** — a CLI runner calling
 *      `lspPrimaryCoversFile(ctx, "<id>")` with an id that is not the
 *      runner's OWN id. The seam's arg is the RUNNER CAPABILITY being
 *      subsumed; asking for another lane's server id was #3968's defect
 *      (the shellcheck runner could never be deferred by a covering shell
 *      LSP that wasn't literally named `bash`).
 *
 *   B. **hardcoded dialect/tool-flag argv** — a runner that emits a dialect
 *      selector flag (`--shell`) without routing the value through the
 *      pinned resolver (`resolveShellFileDialect` in shell-dialect.ts). The
 *      pre-fix runner hardcoded `--shell bash` on every file — the SC1071 /
 *      bash-semantics defect itself — so the census holds the flag to the
 *      resolver; a new runner gaining a dialect selector reds until it
 *      resolves dialects too.
 *
 *   C. **builtin covers-fact consultation by id collision** (F2) — the
 *      runner-coverage seam must resolve a claim's provenance from the ROW
 *      (`primary.custom`), never consult `BUILTIN_SERVER_RUNNER_COVERS` for
 *      a custom primary: a `lsp.servers.<id>` overlay collides with the
 *      builtin id, and an id-keyed fact lookup inherits a claim the declared
 *      server never made (the lane the user registered silently suppresses
 *      the CLI runner). The census pins ONE consultation site in the tree,
 *      guarded on row provenance; a second consult site reds the floor.
 *
 * Sources are comment-and-string-blanked (`stripSource`) so prose or a
 * string literal can never satisfy a requirement, and the floors are real
 * populations (an empty census fails loud, defect shape 10).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

const RUNNERS_DIR = path.resolve(
	import.meta.dirname,
	"../../clients/dispatch/runners",
);

interface RunnerScan {
	file: string;
	/** The runner id the file declares (`id: "<id>"` in the RunnerDefinition). */
	ownId: string | null;
	/** Every literal first string arg passed to lspPrimaryCoversFile calls. */
	coverArgs: string[];
	/** True when the (blanked) source references the pinned dialect resolver. */
	referencesDialectResolver: boolean;
	/** True when the (blanked) source emits a `--shell` flag. */
	emitsShellFlag: boolean;
}

function ownRunnerId(source: string): string | null {
	// A runner definition is registered as `const X: RunnerDefinition = { id: "..." }`
	// (or object literal `id: "..."` followed by appliesTo) — take the first
	// `id:` assignment that is followed by an appliesTo clause, so a comment
	// or an unrelated `id:` cannot satisfy it (strings are blanked first).
	const id = /id:\s*"([^"]+)"/.exec(source)?.[1];
	return id ?? null;
}

function scanRunner(file: string): RunnerScan {
	// Both needles live inside string literals (a runner id arg, an argv
	// flag), so this census keeps strings and strips comments — the
	// "per-needle policy" case: prose quoting a needle cannot satisfy it and
	// the literal evidence survives.
	const blanked = stripSource(fs.readFileSync(file, "utf8"), {
		strings: "keep",
	});
	const coverArgs = [
		...blanked.matchAll(/lspPrimaryCoversFile\(\s*ctx\s*,\s*"([^"]+)"/g),
	].map((m) => m[1] ?? "");
	return {
		file: relativePosix(RUNNERS_DIR, file),
		ownId: ownRunnerId(blanked),
		coverArgs,
		referencesDialectResolver: /resolveShellFileDialect/.test(blanked),
		emitsShellFlag: /--shell/.test(blanked),
	};
}

describe("#3968 class sweep — dialect/capability ownership over the runners", () => {
	const files = listSourceFiles(RUNNERS_DIR, {
		extensions: [".ts"],
		skipTests: true,
	});
	const scans = files.map(scanRunner).filter((scan) => scan.ownId !== null);

	it(
		"finds the real runner population (floor)",
		() => {
			expect(files.length).toBeGreaterThanOrEqual(40);
			expect(scans.length).toBeGreaterThanOrEqual(40);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every self-skip predicate asks for the runner's OWN capability, never a literal server id",
		() => {
			const violations = scans
				.filter((scan) => scan.coverArgs.length > 0)
				.flatMap((scan) =>
					scan.coverArgs
						.filter((arg) => arg !== scan.ownId)
						.map(
							(arg) =>
								`${scan.file}: lspPrimaryCoversFile(ctx, "${arg}") — the arg is the RUNNER capability being subsumed (#3968); a server id here can never be deferred away from (the #3968 defect was the literal "bash")`,
						),
				);
			// Real floor: the two runners with a covering LSP lane. A third runner
			// gaining the pattern keeps this green iff it names its own id.
			const sites = scans
				.filter((scan) => scan.coverArgs.length > 0)
				.map((scan) => scan.file);
			assertNonEmptyScan("#3968 covers-call sites", sites.length, 2);
			expect(sites.sort()).toEqual(["shellcheck.ts", "taplo.ts"]);
			expect(violations).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every --shell emit routes its dialect through the pinned resolver",
		() => {
			const emitters = scans.filter((scan) => scan.emitsShellFlag);
			// Real floor: exactly the shell runner emits the flag today.
			expect(emitters.map((scan) => scan.file)).toEqual(["shellcheck.ts"]);
			for (const emitter of emitters) {
				expect(
					emitter.referencesDialectResolver,
					`${emitter.file}: --shell value must come from resolveShellFileDialect (#3968) — a hardcoded dialect literal is the reported defect`,
				).toBe(true);
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"the covers seam consults the builtin facts table only for non-custom primaries (F2)",
		() => {
			// Family C. Census one: over the whole client tree, the builtin
			// covers-fact table is consulted at RUNTIME in exactly one file — the
			// seam. A second consultation site (a runner or LSP module keying
			// cover facts by server id) re-creates the F2 id-collision defect
			// outside the one place the provenance rule is enforced.
			const clientFiles = listSourceFiles(path.join(ROOT, "clients"), {
				extensions: [".ts"],
				skipTests: true,
			});
			const consultSites = clientFiles
				.filter((file) =>
					stripSource(fs.readFileSync(file, "utf8")).includes(
						"BUILTIN_SERVER_RUNNER_COVERS.get(",
					),
				)
				.map((file) => relativePosix(ROOT, file));
			assertNonEmptyScan(
				"builtin covers-fact consultation sites",
				consultSites.length,
				1,
			);
			expect(consultSites).toEqual([
				"clients/dispatch/runners/utils/runner-helpers.ts",
			]);
			// Census two: structural, on the blanked seam — the ONE lookup is the
			// false-arm of the row-provenance conditional, so a custom primary
			// never reaches the builtin table. Comment-blanked: quoting the guard
			// in prose cannot satisfy it.
			const blanked = stripSource(
				fs.readFileSync(
					path.join(ROOT, "clients/dispatch/runners/utils/runner-helpers.ts"),
					"utf8",
				),
				{ strings: "keep" },
			);
			expect(blanked).toMatch(
				/primary\.custom\s*\?\s*undefined\s*:\s*BUILTIN_SERVER_RUNNER_COVERS\.get\(primary\.id\)/,
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("pins the shell runner's supported-dialect set to the upstream fact", async () => {
		// Upstream-pinned per defect shape 16:
		// bash-lsp/bash-language-server@server-5.8.1 server/src/shellcheck/config.ts.
		// A set that silently gains zsh (or loses a member) changes what the
		// categorical gate skips — exactly the reported defect in reverse.
		const mod = (await import("../../clients/shell-dialect.js")) as unknown as {
			SHELLCHECK_SUPPORTED_DIALECTS: readonly string[];
			resolveShellFileDialect: (f: string) => {
				dialect: string;
				shebang: string | null;
				directive: string | null;
			};
		};
		expect(mod.SHELLCHECK_SUPPORTED_DIALECTS).toEqual([
			"sh",
			"bash",
			"dash",
			"ksh",
			"busybox",
		]);
		expect(mod.SHELLCHECK_SUPPORTED_DIALECTS).not.toContain("zsh");
		expect(typeof mod.resolveShellFileDialect).toBe("function");
	});
});
