import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	callSites,
	codeMatches,
	escapeRegExp,
	readWalkedFiles,
	stripSource,
} from "../support/sweep-kit.js";
import {
	KNOWN_FIXTURE_EMAILS,
	KNOWN_FIXTURE_NAMES,
} from "../support/git-config-guard.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const directGitSpawn =
	/\b(execSync|execFileSync|spawnSync|spawn|execFile|safeSpawnAsync)\s*\(\s*["'`]git\b/g;
const helperImport =
	/import\s*{([^}]+)}\s*from\s*["'`][^"'`]*git-fixture-env/gs;

const OWN_IMPLEMENTATION_FILES = [
	"tests/config/git-fixture-governance.test.ts",
	"tests/support/git-fixture-env.ts",
	"scripts/lib/git-fixture-env.mjs",
] as const;
// Scripts that drive the developer's REAL repository rather than a throwaway
// fixture repo. git-fixture-env exists to scrub GIT_* and pin
// GIT_CONFIG_GLOBAL at `<cwd>/gitconfig` so a fixture never reads the
// developer's config — exactly the wrong environment for a script whose whole
// job is to operate on this checkout (#2435: safe.directory, credential and
// alias config all have to apply).
const NOT_A_FIXTURE = [
	"scripts/pre-push-targeted-tests.mjs",
	// #3215 lane 3: the pre-push selector's history pass, which reads past
	// heads' paths and the data-branch summary out of THIS clone
	// (`git cat-file`/`git log`/`git show`) -- the same "drives the real repo"
	// shape as the hook that calls it; its tests run it against a throwaway
	// repo through gitFixtureEnv.
	"scripts/lib/test-history-selection.mjs",
	"scripts/prune-agent-worktrees.mjs",
	// #2698: reads THIS checkout's own `git ls-files` state (untracked+
	// ignored .js siblings, tracked .ts sources) before `knip` runs — same
	// "drives the real repo" shape as the two scripts above, not a fixture.
	"scripts/lib/knip-sibling-purge.mjs",
	// #2758: runs `git diff` on the real CI checkout to find changed files
	// for Stryker mutation testing — drives the real checkout, not a fixture.
	"scripts/stryker-diff.mjs",
	// #3674: asks the real clone for its main worktree and writes the real
	// clone's core.hooksPath -- the fixture env pins GIT_CONFIG_GLOBAL at
	// `<cwd>/gitconfig` and would hide the config this script must honour.
	"scripts/setup-git-hooks.mjs",
	// #3723: opens and closes worktrees of THIS clone (`git worktree add/list/
	// remove`, `git config branch.*`) -- the fixture env would pin
	// GIT_CONFIG_GLOBAL at `<cwd>/gitconfig` and hide the safe.directory and
	// alias config a real checkout needs. Its tests drive it against a
	// throwaway repo through gitFixtureEnv, so the fixture side is covered.
	"scripts/pr-worktree.mjs",
	// #5111: removes a linked worktree of THIS clone (`git worktree list/
	// remove`), the same real-clone shape as `pr-worktree.mjs` above. Its
	// tests inject `gitExec` backed by the fixture-env wrapper, so the fixture
	// side is covered.
	"scripts/worktree-remove.mjs",
] as const;

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Every callee that can put a `git` process on the end of an argument list:
 * the raw child_process entry points {@link directGitSpawn} already knows,
 * plus the three git-fixture-env wrappers a compliant test uses. Anchored so
 * `spawn` cannot claim `spawnSync`'s call sites (sweep-kit requires the whole
 * simple name to match).
 */
const GIT_SPAWN_CALLEE =
	/^(?:gitExecFileSync|gitExecSync|gitFixtureSpawnAsync|execFileSync|execSync|spawnSync|safeSpawnAsync|execFile|spawn)$/;

/**
 * A LITERAL Git object name: 7-40 lowercase hex characters that are not part
 * of a longer word -- standing alone (`["checkout", "ca26395", "--"]`) or
 * carrying a `:path`/`^`/`~` suffix (`["show", "20896a56b:tests/x.test.ts"]`).
 * The word boundaries keep `"myabcdef1var"` and `"v1-abcdef1"` out; both have
 * a row below, because round 2 T2 found the lookarounds mutation-inert.
 */
const LITERAL_COMMIT_ISH = /(?<![\w.$-])[0-9a-f]{7,40}(?![\w.$-])/g;

/**
 * A module-scope `const NAME = "<sha>"` binding. Round 2 S1: hoisting the sha
 * out of the argument list and spawning `["show", `${PRE_FIX_SHA}:path`]`
 * left the guard green on the REAL `ca26395` file (19/19) while the
 * module-scope spawn still collapses the file on a depth-1 checkout. The
 * binding is code, so it is read from the comment-blanked source.
 */
const SHA_BINDING =
	/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*["'`]([0-9a-f]{7,40})["'`]/g;

/**
 * Git subcommands that resolve an argument against the repository's HISTORY.
 * They are the only ones a depth-1 checkout can fail, so they are the only
 * ones whose arguments are scanned. Round 2 S3: scanning every git spawn's
 * whole argument text flagged `GIT_AUTHOR_DATE: "1700000000 +0000"`,
 * `-m "fix deadbeef regression"`, `-m "defaced effaced"` and
 * `["add", "tests/fixtures/abcdef1/x.ts"]` -- five false positives, none of
 * which can name a commit.
 */
const HISTORY_SUBCOMMANDS = new Set([
	"show",
	"cat-file",
	"diff",
	"log",
	"checkout",
	"rev-parse",
	"archive",
]);

/**
 * Global git options that consume a SEPARATE following token, so the
 * subcommand search steps over their value -- the same seven
 * `scripts/hooks/guard-bash.mjs`'s `classifyGit` walks past.
 */
const GIT_TWO_TOKEN_FLAGS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
]);

const QUOTED_ITEM = /^(["'`])((?:\\.|(?!\1)[\s\S])*)\1$/;

/**
 * A stand-in for an array element that is not a string or template literal
 * (`dir`, `path.join(a, b)`). It keeps the token list POSITIONAL, which is
 * what lets the global-option walk below stay aligned with what git sees:
 * dropping unquoted elements made `["-C", dir, "show", rev]` resolve its
 * subcommand to the rev. It can match neither a subcommand name nor
 * {@link LITERAL_COMMIT_ISH}.
 */
const OPAQUE_ELEMENT = "\u0000";

function quotedItems(region: string): string[] {
	return splitTopLevel(region).map((element) => {
		const match = QUOTED_ITEM.exec(element.trim());
		return match ? (match[2] ?? "") : OPAQUE_ELEMENT;
	});
}

/**
 * Split an array-literal body on its own top-level commas. Quote-, bracket-
 * and brace-aware, so a comma inside a string, a nested array or an object
 * does not start a new element.
 */
function splitTopLevel(region: string): string[] {
	const elements: string[] = [];
	let quote: string | undefined;
	let depth = 0;
	let start = 0;
	for (let index = 0; index < region.length; index += 1) {
		const character = region[index];
		if (quote !== undefined) {
			if (character === "\\") index += 1;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "[" || character === "{" || character === "(") depth += 1;
		else if (character === "]" || character === "}" || character === ")")
			depth -= 1;
		else if (character === "," && depth === 0) {
			elements.push(region.slice(start, index));
			start = index + 1;
		}
	}
	elements.push(region.slice(start));
	return elements.filter((element) => element.trim() !== "");
}

/**
 * The body of the first top-level array literal in `code`, or undefined when
 * there is none. Quote-aware, so a `[` inside a string or a template is not a
 * bracket. Named limit: a template literal whose EXPRESSION contains a quote
 * character (`` `${a["k"]}` ``) desynchronises the quote state; that spelling
 * does not occur in a git argument vector and is not handled.
 */
function firstArrayLiteral(code: string): string | undefined {
	let quote: string | undefined;
	let depth = 0;
	let start = -1;
	for (let index = 0; index < code.length; index += 1) {
		const character = code[index];
		if (quote !== undefined) {
			if (character === "\\") index += 1;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
			continue;
		}
		if (character === "[") {
			if (depth === 0) start = index;
			depth += 1;
			continue;
		}
		if (character === "]") {
			depth -= 1;
			if (depth === 0 && start !== -1) return code.slice(start + 1, index);
		}
	}
	return undefined;
}

/**
 * The tokens git itself would receive, from either spawn spelling: the
 * argument ARRAY (`execFileSync("git", ["show", rev])`) or the single command
 * string (`execSync("git show rev")`). Everything after the vector -- the
 * options object with its `cwd` and `env` -- is outside the array and is
 * never scanned, which is half of the round 2 S3 fix.
 */
function gitArgumentTokens(argsText: string): string[] {
	// Comments are blanked HERE as well as at the admission gate. Round 2 S2:
	// a sha in a comment INSIDE the argument list is reported as an argument
	// as soon as any OTHER hex literal in the file passes admission, so the
	// two stripping points have separate signatures and neither is redundant.
	const code = stripSource(argsText, { strings: "keep" });
	const array = firstArrayLiteral(code);
	if (array !== undefined) return quotedItems(array);
	const commandString = QUOTED_ITEM.exec(splitTopLevel(code)[0]?.trim() ?? "");
	if (!commandString) return [];
	const words = (commandString[2] ?? "").trim().split(/\s+/);
	const command = words[0]?.split(/[\\/]/).pop();
	return command === "git" ? words.slice(1) : [];
}

/**
 * The argument tokens of a HISTORY subcommand, or an empty list when this
 * spawn is not one. Global options are stepped over the way git steps over
 * them, so `["-C", dir, "show", rev]` resolves to `show` and not to `-C`.
 *
 * #3093: the walk resolves a subcommand by POSITION, and a position can be
 * {@link OPAQUE_ELEMENT} instead of a flag or a subcommand name -- a spread
 * (`[...base, "show", sha]`) or a bare variable ahead of the subcommand.
 * `execFileSync("git", [...base, "show", sha])` used to resolve `subcommand`
 * to the placeholder, fail `HISTORY_SUBCOMMANDS.has()`, and return `[]`:
 * silent, not a red flag, even though the real argv git receives could well
 * start with `show`. The walk cannot know what an opaque prefix hides -- it
 * could be more flags, or the subcommand itself -- so the moment the walk
 * would classify an opaque element as a flag or as the subcommand, it stops
 * resolving and scans EVERY token instead of none: an unknown subcommand
 * position is flagged, not cleared. That is the safe direction (a stray
 * fixture path or flag value re-scanned as an argument is a false positive
 * that reds loudly; a silently skipped file is not).
 *
 * `--git-dir=<path>` and `--work-tree=<path>` need no entry in
 * {@link GIT_TWO_TOKEN_FLAGS}: each is one self-contained token, already
 * stepped over by the generic `token.startsWith("-")` branch below.
 */
function historyArgumentTokens(tokens: readonly string[]): string[] {
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === OPAQUE_ELEMENT) return [...tokens];
		if (GIT_TWO_TOKEN_FLAGS.has(token)) {
			index += 2;
			continue;
		}
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	const subcommand = tokens[index];
	if (subcommand === undefined || !HISTORY_SUBCOMMANDS.has(subcommand))
		return [];
	return [...tokens.slice(index + 1)];
}

/**
 * Does this call site actually run `git`? Either the callee is one of the
 * git-fixture-env wrappers (which spawn nothing else), or the first argument
 * is a `git` command word -- `execFileSync("git", [...])`,
 * `execSync("git show ...")`, `execFileSync("/usr/bin/git", [...])`.
 */
function isGitSpawnSite(callee: string, argsText: string): boolean {
	if (callee.startsWith("git")) return true;
	return /^\s*["'`](?:[^"'`\s]*[\\/])?git(?:["'`]|\s)/.test(argsText);
}

/**
 * #3050 / #3066 round 1 (`ca26395`): a `git show <sha>:<path>` at MODULE
 * SCOPE in `tests/clients/pi-lens-home-hermeticity.test.ts`.
 * `.github/workflows/ci.yml`'s `test` job checks out with no `fetch-depth`
 * override, which is depth 1, so the object is unreachable on CI: the call
 * throws during collection and the whole file yields ZERO tests -- silently
 * taking three #525 cases that already lived there with it. The remedy round
 * 2 shipped is to commit the content as a fixture under `tests/fixtures/`
 * and read it.
 *
 * What counts as naming history: a literal hex object name in a history
 * subcommand's arguments, or `${NAME}` where NAME is a module-scope binding
 * to such a literal. A fixture repo's own commit is read back at RUNTIME
 * (`rev-parse HEAD` into a variable) and reaches the spawn as `${sha}` with
 * no hex literal anywhere, so it is untouched -- that is the discriminator.
 *
 * Detector policy, per needle (docs/engineering-principles.md "Detectors match code, not prose"):
 * comments BLANKED, string contents KEPT, at BOTH scanning points (the file
 * admission gate and the argument vector). The evidence is itself a string
 * literal -- a commit-ish reaches a spawn only as a quoted argument -- so the
 * `"blank"` policy would erase the only thing there is to see, the same
 * reason the sibling `directGitSpawn` row in this file scans with
 * `strings: "keep"`. A sha quoted in a comment is blanked at both points and
 * cannot flag; a comment never satisfies this guard, which is the dangerous
 * direction. The residual false positive -- a delimited 7-40 hex run in a
 * history subcommand's own argument -- reds loudly and is the safe direction.
 *
 * Named blind spots, all of them one indirection further than the binding
 * above: a sha IMPORTED from another module, one held in an object property
 * or array element, one assigned to a `let` after declaration, and one built
 * by concatenation. Each is invisible to a text needle; none has occurred.
 * An UPPERCASE hex object name is also not matched -- enumerating spellings
 * is its own defect shape, and git writes lowercase.
 */
export function findHistoricalCommitIshOffenders(
	files: ReadonlyArray<{ file: string; source: string }>,
): string[] {
	const offenders: string[] = [];
	for (const { file, source } of files) {
		const relativeFile = repoRelative(file);
		// Cheap admission: parsing every file under tests/ with ast-grep would
		// cost hundreds of parses (and the peak RSS the #3062 budget gate
		// measures) for a needle almost no file carries. No file is exempt
		// from THIS row -- `tests/support/git-fixture-env.ts` is the wrapper
		// the sibling spawn row has to exempt, and it is the helper whose
		// collapse would take the most files down with it (round 2 T2).
		const code = stripSource(source, { strings: "keep" });
		LITERAL_COMMIT_ISH.lastIndex = 0;
		if (!LITERAL_COMMIT_ISH.test(code)) continue;
		SHA_BINDING.lastIndex = 0;
		const boundShaNames = [...code.matchAll(SHA_BINDING)].map(
			(match) => match[1] ?? "",
		);
		for (const site of callSites(source, GIT_SPAWN_CALLEE)) {
			if (!isGitSpawnSite(site.callee, site.argsText)) continue;
			for (const token of historyArgumentTokens(
				gitArgumentTokens(site.argsText),
			)) {
				LITERAL_COMMIT_ISH.lastIndex = 0;
				for (const match of token.matchAll(LITERAL_COMMIT_ISH))
					offenders.push(`${relativeFile}:${site.line} ${match[0]}`);
				for (const name of boundShaNames)
					if (new RegExp(`\\$\\{\\s*${escapeRegExp(name)}\\s*\\}`).test(token))
						offenders.push(`${relativeFile}:${site.line} \${${name}}`);
			}
		}
	}
	return offenders;
}

function repoRelative(file: string): string {
	if (!path.isAbsolute(file)) return file.replaceAll("\\", "/");
	return path.relative(REPO_ROOT, file).replaceAll("\\", "/");
}

export function isExpectedScriptExemption(file: string): boolean {
	return NOT_A_FIXTURE.includes(
		repoRelative(file) as (typeof NOT_A_FIXTURE)[number],
	);
}

export function findGitSpawnOffenders(
	files: ReadonlyArray<{ file: string; source: string }>,
): string[] {
	return files
		.filter(({ file, source }) => {
			directGitSpawn.lastIndex = 0;
			const relativeFile = repoRelative(file);
			if (
				OWN_IMPLEMENTATION_FILES.includes(
					relativeFile as (typeof OWN_IMPLEMENTATION_FILES)[number],
				)
			)
				return false;
			const sourceKeep = stripSource(source, { strings: "keep" });
			const imported = new Set<string>();
			for (const match of codeMatches(source, helperImport)) {
				for (const item of match[1].split(",")) {
					imported.add(item.trim().split(/\s+as\s+/)[0] ?? "");
				}
			}
			for (const match of sourceKeep.matchAll(directGitSpawn)) {
				if (!imported.has(match[1])) return true;
			}
			return false;
		})
		.map(({ file }) => file);
}

function fixtureIdentityWrites(
	files: ReadonlyArray<{ file: string; source: string }>,
): Array<{ file: string; kind: "name" | "email"; value: string }> {
	const writes: Array<{
		file: string;
		kind: "name" | "email";
		value: string;
	}> = [];
	const literal =
		/\buser\.(name|email)(?:["']\s*,\s*["']([^"']+)["']|\s+["']([^"']+)["']|\s+([^\s"'`,}\]]+))/g;
	for (const { file, source } of files) {
		for (const line of source.split(/\r?\n/)) {
			if (!/\bconfig\b/.test(line)) continue;
			literal.lastIndex = 0;
			for (const match of line.matchAll(literal)) {
				const value = match[2] ?? match[3] ?? match[4];
				if (value)
					writes.push({ file, kind: match[1] as "name" | "email", value });
			}
		}
	}
	return writes;
}

function walkFiles(
	root: string,
	matches: (name: string) => boolean,
): Array<{ file: string; source: string }> {
	const walked: string[] = [];
	function walk(dir: string): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (matches(entry.name)) walked.push(file);
		}
	}
	walk(root);
	// readWalkedFiles: a path that vanished between the walk and the read is
	// out of the population, not a finding (#3082).
	return readWalkedFiles(walked);
}

function testFiles(root: string): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".test.ts"));
}

/**
 * Every TypeScript file under tests/, not only the collected `*.test.ts`
 * ones: a module-scope spawn in a `tests/support/` helper collapses every
 * file that imports it, which is the same zero-collected-tests outcome
 * {@link findHistoricalCommitIshOffenders} exists to prevent.
 */
function testTypeScriptFiles(
	root: string,
): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".ts"));
}

/**
 * scripts/**\/*.mjs is a second population that can spawn a bare `git`
 * process (#2163 F7): standalone smoke/compat scripts, not vitest tests.
 * Walked separately because it lives outside tests/ and uses the .mjs
 * fixture helper (scripts/lib/git-fixture-env.mjs) rather than the .ts one.
 */
function scriptFiles(root: string): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".mjs"));
}

describe("real Git fixture governance", () => {
	it(
		"routes every direct Git spawn through git-fixture-env",
		() => {
			const offenders = findGitSpawnOffenders(
				testFiles(path.resolve(__dirname, "..")),
			);
			expect(
				offenders,
				`Bare Git spawns found:\n${offenders.join("\n")}`,
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"routes every direct Git spawn in scripts/**/*.mjs through git-fixture-env",
		() => {
			const offenders = findGitSpawnOffenders(
				scriptFiles(path.resolve(__dirname, "../../scripts")),
			);
			const REMAINING_OFFENDERS: string[] = [];
			const unexpected = offenders.filter(
				(file) =>
					!REMAINING_OFFENDERS.includes(repoRelative(file)) &&
					!isExpectedScriptExemption(file),
			);
			expect(
				unexpected,
				`Unexpected bare Git spawns found:\n${unexpected.join("\n")}`,
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("anchors script exemptions to the repository-relative path", () => {
		expect(
			isExpectedScriptExemption("scripts/pre-push-targeted-tests.mjs"),
		).toBe(true);
		expect(
			isExpectedScriptExemption("scripts/zzdir/pre-push-targeted-tests.mjs"),
		).toBe(false);
	});

	it(
		"keeps every literal fixture Git identity in the guard sets",
		() => {
			const files = [
				...walkFiles(
					path.resolve(__dirname, ".."),
					(name) => name.endsWith(".ts") || name.endsWith(".mts"),
				),
				...walkFiles(path.resolve(__dirname, "../../scripts"), (name) =>
					name.endsWith(".mjs"),
				),
			];
			const unknown = fixtureIdentityWrites(files).filter(
				({ kind, value }) =>
					(kind === "name" ? KNOWN_FIXTURE_NAMES : KNOWN_FIXTURE_EMAILS).has(
						value,
					) === false,
			);
			expect(unknown).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("detects a synthetic bare Git offender", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source: 'execFileSync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("rejects a helper mention that does not import or call the helper", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source: '// git-fixture-env\nexecFileSync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("does not let a string literal import excuse a bare Git spawn", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						"const prose = \"import { execFileSync } from './git-fixture-env.js'\";\n" +
						"execFile" +
						'Sync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("does not let a commented-out import excuse a bare Git spawn", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						'// import { execFileSync } from "./git-fixture-env.js";\n' +
						"execFile" +
						'Sync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("finds a real import after a commented-out import", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						'// import { execFileSync } from "./git-fixture-env.js";\n' +
						'import { execFileSync } from "./git-fixture-env.js";\n' +
						"execFile" +
						'Sync("git", ["status"])',
				},
			]),
		).toEqual([]);
	});

	it("rejects a direct call when a different helper symbol is imported", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						'import { gitExecSync } from "./git-fixture-env.js";\nexecFileSync("git", [])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it(
		"pins no historical commit-ish in any tests/ Git spawn",
		() => {
			const offenders = findHistoricalCommitIshOffenders(
				testTypeScriptFiles(path.resolve(__dirname, "..")),
			);
			expect(
				offenders,
				"A tests/ Git spawn names a commit from this repository's history.\n" +
					"CI checks out at depth 1 (.github/workflows/ci.yml's test job sets no\n" +
					"fetch-depth), so the object is unreachable there: at module scope the\n" +
					"call throws during collection and the file yields ZERO tests (#3066\n" +
					"round 1, ca26395). Commit the content as a fixture under tests/fixtures/\n" +
					"and read it back instead:\n" +
					offenders.join("\n"),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("detects the #3066 round 1 shape: git show <sha>:<path> through the fixture wrapper", () => {
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'const PRE = gitExecFileSync("git", [\n' +
						'  "show",\n' +
						'  "20896a56b:tests/index-vanished-instance-wiring.test.ts",\n' +
						'], { cwd: REPO_ROOT, encoding: "utf8" });',
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:1 20896a56b"]);
	});

	it("detects a bare commit-ish argument, not only the <sha>:<path> form", () => {
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'execFileSync("git", ["checkout", "ca2639524", "--", "clients/x.ts"]);',
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:1 ca2639524"]);
	});

	it("detects a sha hoisted out of the argument list into a const", () => {
		// Round 2 S1: the same real ca26395 file with the sha hoisted to
		// `const PRE_FIX_SHA` and interpolated was GREEN (19/19) while the
		// module-scope spawn still collapses the file on a depth-1 checkout.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'const PRE_FIX_SHA = "20896a56b";\n' +
						'const PRE = gitExecFileSync("git", [\n' +
						'  "show",\n' +
						"  `${PRE_FIX_SHA}:tests/index-vanished-instance-wiring.test.ts`,\n" +
						'], { cwd: REPO_ROOT, encoding: "utf8" });',
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:2 ${PRE_FIX_SHA}"]);
	});

	it("does not let a comment INSIDE the argument list trip the guard", () => {
		// The shape the #3066 round 2 remedy leaves behind: the spawn is gone,
		// but a comment in the surviving call still quotes the sha the fixture
		// was taken at. A comment is prose, never an argument.
		//
		// Round 2 S2: the fixture carries a SECOND hex literal (`COLOR`) on
		// purpose. Without it the file never passes the admission gate, the
		// argument vector is never read, and the row passes for the wrong
		// reason — which is exactly how round 1 mis-measured the argument-side
		// comment blanking as inert and deleted it.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'const COLOR = "abcdef1";\n' +
						'gitExecFileSync("git", [\n' +
						'  "show",\n' +
						'  // was "20896a56b:tests/index-vanished-instance-wiring.test.ts"\n' +
						"  `${fixtureSha}:src/a.ts`,\n" +
						"], { cwd: COLOR });",
				},
			]),
		).toEqual([]);
	});

	it("still sees a literal sha on the line after a comment inside the argument list", () => {
		// Round 2 S2, corrected. The reviewer's finding is real but its
		// signature is the FALSE-NEGATIVE direction, not the false-positive
		// one: without the argument-side comment blanking, the comment fuses
		// with the element that follows it, the element stops being a bare
		// quoted literal, and the real sha on the next line is swallowed as an
		// opaque expression. That is a guard going silent, so it gets the row.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'gitExecFileSync("git", [\n' +
						'  "show",\n' +
						"  // the pre-#3048 pin\n" +
						'  "20896a56b:tests/index-vanished-instance-wiring.test.ts",\n' +
						"]);",
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:1 20896a56b"]);
	});

	it("does not let a COMMENTED-OUT binding make a live variable a sha", () => {
		// The remedy's own residue: a note saying what the pin used to be,
		// beside a same-named variable that now holds a runtime revision. Read
		// from raw source the comment would bind `SHA` to a sha and flag a
		// spawn that names nothing historical. `COLOR` is there so the file
		// reaches the argument scan at all.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'// const SHA = "20896a56b"; // the old pin, before the fixture\n' +
						'const SHA = process.env.FIXTURE_SHA ?? "HEAD";\n' +
						'const COLOR = "abcdef1";\n' +
						'gitExecFileSync("git", ["show", `${SHA}:src/a.ts`], { cwd: COLOR });',
				},
			]),
		).toEqual([]);
	});

	it("does not scan the arguments of a subcommand that cannot name a commit", () => {
		// Round 2 S3, all four verbatim: a commit message, an author date in
		// the options object, and a fixture path that happens to be hex.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'gitExecFileSync("git", ["commit", "-m", "x"], { cwd: "/f", env: { GIT_AUTHOR_DATE: "1700000000 +0000" } });\n' +
						'gitExecFileSync("git", ["commit", "-m", "fix deadbeef regression"], { cwd: "/f" });\n' +
						'gitExecFileSync("git", ["commit", "-m", "defaced effaced"], { cwd: "/f" });\n' +
						'gitExecFileSync("git", ["add", "tests/fixtures/abcdef1/x.ts"], { cwd: "/f" });',
				},
			]),
		).toEqual([]);
	});

	it("leaves every cleared revision spelling green", () => {
		// Round 2 S3's keep-green list: symbolic revisions, a tag, a
		// too-short abbreviation, an uppercase name, and the two word-boundary
		// cases round 2 T2 found unpinned.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source: [
						'gitExecFileSync("git", ["show", "HEAD:src/a.ts"], { cwd: "/f" });',
						'gitExecFileSync("git", ["show", "origin/master:src/a.ts"], { cwd: "/f" });',
						'gitExecFileSync("git", ["show", "HEAD~1"], { cwd: "/f" });',
						'gitExecFileSync("git", ["show", "v4.1.6:package.json"], { cwd: "/f" });',
						'gitExecFileSync("git", ["show", "abcde1:x"], { cwd: "/f" });',
						'gitExecFileSync("git", ["show", "ABCDEF1:x"], { cwd: "/f" });',
						'gitExecFileSync("git", ["show", "myabcdef1var"], { cwd: "/f" });',
						'gitExecFileSync("git", ["show", "v1-abcdef1"], { cwd: "/f" });',
					].join("\n"),
				},
			]),
		).toEqual([]);
	});

	it("reads the single-command-string spawn spelling too", () => {
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'gitExecSync("git show ca2639524:clients/x.ts", { cwd: REPO_ROOT });',
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:1 ca2639524"]);
	});

	it("steps over every separate-value git global to find the subcommand", () => {
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source: [
						'execFileSync("git", ["-C", dir, "show", "ca2639524:clients/x.ts"]);',
						'execFileSync("git", ["-c", config, "show", "20896a56b:clients/y.ts"]);',
						'execFileSync("git", ["--git-dir", dir, "show", "deadbeef1:clients/z.ts"]);',
						'execFileSync("git", ["--work-tree", dir, "show", "abcdef12:clients/a.ts"]);',
						'execFileSync("git", ["--namespace", namespace, "show", "1234567:clients/b.ts"]);',
						'execFileSync("git", ["--config-env", key, "show", "fedcba98:clients/c.ts"]);',
						'execFileSync("git", ["--attr-source", source, "show", "7654321:clients/d.ts"]);',
					].join("\\n"),
				},
			]),
		).toEqual([
			"tests/clients/synthetic.test.ts:1 ca2639524",
			"tests/clients/synthetic.test.ts:1 20896a56b",
			"tests/clients/synthetic.test.ts:1 deadbeef1",
			"tests/clients/synthetic.test.ts:1 abcdef12",
			"tests/clients/synthetic.test.ts:1 1234567",
			"tests/clients/synthetic.test.ts:1 fedcba98",
			"tests/clients/synthetic.test.ts:1 7654321",
		]);
	});

	it("steps over --git-dir=<path> and --work-tree=<path> to find the subcommand", () => {
		// Already correct before #3093: each is one self-contained token, so
		// the generic `token.startsWith("-")` branch steps over it. Pinned here
		// so the #3093 opaque-prefix fix cannot regress the already-working
		// forms named in its acceptance criteria alongside `-C`/`-c`.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'execFileSync("git", ["--git-dir=/f/.git", "show", "ca2639524:clients/x.ts"]);\n' +
						'execFileSync("git", ["--work-tree=/f", "show", "20896a56b:clients/y.ts"]);',
				},
			]),
		).toEqual([
			"tests/clients/synthetic.test.ts:1 ca2639524",
			"tests/clients/synthetic.test.ts:2 20896a56b",
		]);
	});

	it("flags a spread ahead of the subcommand instead of silently clearing the site (#3093)", () => {
		// The bug this issue exists to fix. `base` occupies the position the
		// walk resolves as a flag-or-subcommand; before the fix it collapsed to
		// OPAQUE_ELEMENT, failed HISTORY_SUBCOMMANDS.has(), and the whole site
		// returned [] -- a real `git show <sha>` spawn went unscanned.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'execFileSync("git", [...base, "show", "ca2639524:clients/x.ts"]);',
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:1 ca2639524"]);
	});

	it("flags a bare variable ahead of the subcommand the same way as a spread (#3093)", () => {
		// A non-spread opaque element (a variable standing in for a flag list,
		// not a literal) in the same position must be treated identically --
		// the walk has no way to tell the two apart once the array element
		// fails {@link QUOTED_ITEM} and collapses to the same placeholder.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'execFileSync("git", [globalArgs, "show", "ca2639524:x.ts"]);',
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:1 ca2639524"]);
	});

	it("still resolves the subcommand when a spread trails behind it, not ahead (#3093)", () => {
		// Round-1 shape already worked and must stay working: the opaque
		// element after "show" is not on the walk's flag/subcommand path.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source: 'execFileSync("git", ["show", ...extra, "ca2639524:a.ts"]);',
				},
			]),
		).toEqual(["tests/clients/synthetic.test.ts:1 ca2639524"]);
	});

	it("leaves a fixture repo's own runtime sha alone", () => {
		// The legitimate population this guard must not touch: a sha the test
		// itself created and read back at runtime is reachable everywhere,
		// depth-1 CI checkout included.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source:
						'const sha = gitExecSync("git rev-parse HEAD", { cwd: fixture }).trim();\n' +
						'gitExecFileSync("git", ["show", `${sha}:src/a.ts`], { cwd: fixture });',
				},
			]),
		).toEqual([]);
	});

	it("does not flag a hex argument to a spawn that is not git", () => {
		// The argument vector deliberately LOOKS like `git diff <sha>` --
		// `docker diff <container-id>` takes a hex id in exactly that shape.
		// Only the git gate can tell these apart, and round 2's subcommand
		// narrowing made the previous `node -e` fixture unable to show that:
		// its own argument vector never reached a history subcommand, so the
		// row went green under the always-a-git-spawn mutation.
		expect(
			findHistoricalCommitIshOffenders([
				{
					file: "tests/clients/synthetic.test.ts",
					source: 'execFileSync("docker", ["diff", "3f2a1b8c9d"]);',
				},
			]),
		).toEqual([]);
	});

	it(
		"scans a non-empty tests/**/*.ts population, helpers included",
		() => {
			const files = testTypeScriptFiles(path.resolve(__dirname, "..")).map(
				({ file }) => repoRelative(file),
			);
			// Calibration: 400 is the same documented floor the *.test.ts walk
			// below uses; this population is a superset of it (#3050).
			assertNonEmptyScan("historical commit-ish sweep", files.length, 400);
			// The superset is the point, not an accident: a module-scope spawn in
			// a tests/support helper takes every file that imports it down with
			// it, so the walk must reach past the collected *.test.ts files.
			expect(files).toContain("tests/support/git-fixture-env.ts");
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"scans a non-empty source population",
		() => {
			const files = testFiles(path.resolve(__dirname, ".."));
			// Calibration: 807 *.test.ts files under tests/ on 2026-08-26 (fix round
			// 2). Half is 403.5; 400 is the documented floor so the walk still fails
			// loud if the tests/ tree collapses, without pinning to the exact count.
			assertNonEmptyScan("git fixture governance sweep", files.length, 400);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"scans a non-empty scripts/**/*.mjs population",
		() => {
			const files = scriptFiles(path.resolve(__dirname, "../../scripts"));
			// Calibration: 60+ *.mjs files under scripts/ on 2026-08-26 (fix round
			// 2); 30 is a floor well below that, well above zero.
			assertNonEmptyScan(
				"git fixture governance scripts sweep",
				files.length,
				30,
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});
