/**
 * #1980 AC3, as a recurrence guard rather than a one-off census.
 *
 * A synchronous child-process call parks the event loop for exactly as long
 * as the child takes. With no `timeout`, that park is unbounded — and #1980's
 * whole finding is that such a park used to read as ordinary compute in
 * `loop_block`, because `windowCpuMs` was recorded beside every block and
 * never read.
 *
 * The one-off sweep found three real call sites with no bound. Two are fixed
 * (`findBinaryOnPath` in clients/lsp/launch.ts, on the LSP spawn path;
 * `ensureUtf8ConsoleCodePageOnce` in clients/safe-spawn.ts, on the first spawn
 * of the process); the third is exempted below with its reason. This walks the
 * family so the next one cannot land silently: a hand-written list of "the
 * sync spawn sites" goes stale the first time someone adds one, which is the
 * single-source-of-truth rule this repo already applies to language and runner
 * registries.
 *
 * Built on tests/support/sweep-kit.ts — `listSourceFiles` for the walk,
 * `stripSource` for comment/string masking, `auditRegistry` for
 * exempted-with-a-reason plus stale-exemption and dead-scan floors. Those
 * floors are the point: this repo's catalog shape 10 is a sweep that matches
 * nothing and reads as clean.
 *
 * Scope: the shipped source tree (clients/, index.ts, tools/, mcp/). Tests and
 * scripts are out — neither runs on pi's event loop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	callSites,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The family: every synchronous child-process launcher Node offers. */
/**
 * Sites that legitimately carry no literal `timeout:` in their own options,
 * each with the reason `auditRegistry` requires. Keyed `file:snippet`, where
 * the snippet must appear within the call's own ARGUMENT LIST (never a
 * preceding-source preamble — see `exemptionKey` below), so a moved call is
 * still recognised but a genuinely new one is not.
 *
 * `safeSpawn` has TWO internal `spawnSync` fallback calls that both spread
 * `...(options as SpawnOptions)` — a substring match against that spread
 * alone would collide across both, which is exactly what happened here
 * (#2487 review round 3 F1): a prior version keyed both on that shared
 * spread and disambiguated the collision by SCAN POSITION (`key`, `key#2`).
 * Position is not identity — inserting a new unbounded call between the two
 * exempted ones shifts every ordinal after it, so a reviewed reason rides
 * the WRONG call site while the new, unreviewed one either reds with no
 * file:line to act on, or rides an existing ordinal and ships silently
 * (round 3 probes 1 and 2, both proved against this file pre-fix). The fix
 * is a snippet unique to each call's own arguments — no ordinal, no
 * position-dependence: the Windows-resolved-path branch destructures into
 * `spawnCmd, spawnArgs`, the plain-command branch carries a comment no other
 * call shares. Each snippet occurs in exactly one call's argument list, so a
 * THIRD colliding call (a new site that also happens to match one of these
 * snippets) still cannot ride an existing entry — see `exemptionKey`.
 *
 * Keep this SHORT and reasoned. "It is probably fast" is not a reason — both
 * bugs this guard exists for were probably fast.
 */
const EXEMPT_SITES: Readonly<Record<string, string>> = {
	'clients/safe-spawn.ts:"/F", "/T", "/PID"':
		"killPidTreeSync runs from process exit and signal handlers. The process is already tearing down, so there is no event loop left to protect, and a timeout would only orphan the kill it was asked to perform.",
	"clients/safe-spawn.ts:spawnCmd, spawnArgs,":
		"safeSpawn's Windows-resolved-path spawnSync fallback (the PATH+PATHEXT resolved-path branch) spreads the CALLER's options, which is where the timeout comes from. Its three in-repo callers: isCommandAvailable and findCommand in safe-spawn.ts (timeout: 5000 each), and test-runner-client.ts's detectRunner (timeout: 2000).",
	"clients/safe-spawn.ts:// Explicit override, not just the spread above":
		"safeSpawn's plain-command spawnSync fallback (the non-Windows-resolved branch) spreads the CALLER's options for the identical reason as the Windows-resolved-path sibling above: the timeout comes from the caller. Same three in-repo callers — isCommandAvailable and findCommand in safe-spawn.ts (timeout: 5000 each), and test-runner-client.ts's detectRunner (timeout: 2000).",
};

interface CallSite {
	/** `file:line fn` — the id the audit reports. */
	id: string;
	file: string;
	/**
	 * The call's own argument list — raw, unstripped (so an in-argument
	 * comment like the plain-command safe-spawn fallback's is visible to
	 * exemption matching), and NOTHING outside the parens. #2487 review round
	 * 3 F1: an earlier version matched against a 600-char PREAMBLE plus the
	 * arguments, which is how two textually distinct `spawnSync` calls with
	 * merely a shared spread (`...(options as SpawnOptions)`) collided on one
	 * exemption key — the preamble was never the discriminator, the arguments
	 * always were. Scoping the match to the call's own arguments makes THAT
	 * collision structurally impossible — `callSites` takes the argument span
	 * from the TypeScript AST, so strings, comments, and nested expressions
	 * cannot pull unrelated later source into this call.
	 */
	args: string;
	bounded: boolean;
}

function shippedSourceFiles(): string[] {
	const files = ["clients", "tools", "mcp"].flatMap((dir) => {
		const abs = path.join(REPO_ROOT, dir);
		return fs.existsSync(abs)
			? listSourceFiles(abs, { extensions: [".ts"], skipTests: true })
			: [];
	});
	const indexTs = path.join(REPO_ROOT, "index.ts");
	if (fs.existsSync(indexTs)) files.push(indexTs);
	return files;
}

/**
 * Every synchronous child-process call site in one file's RAW source,
 * `rel`-labeled. Pulled out of {@link findCallSites} so the probe tests below
 * can run the real production scanner against a synthetic fixture instead of
 * the shipped tree — the same shape as `bounded-eviction-idiom-sweep.test.ts`'s
 * `ATTACK_TWIN_OCCURRENCE_COLLISION` fixture, which runs the real detector on
 * a hand-built source string rather than re-deriving its logic.
 */
function analyzeFile(rel: string, raw: string): CallSite[] {
	return callSites(raw, /^(?:spawnSync|execSync|execFileSync)$/).map(
		(site) => ({
			id: `${rel}:${site.line} ${site.callee}`,
			file: rel,
			args: site.argsText,
			bounded: /\btimeout\s*:/.test(site.optionsLiteral ?? ""),
		}),
	);
}

function findCallSites(): { sites: CallSite[]; scanned: number } {
	const files = shippedSourceFiles();
	const sites: CallSite[] = [];
	for (const abs of files) {
		const raw = fs.readFileSync(abs, "utf8");
		const rel = relativePosix(REPO_ROOT, abs);
		sites.push(...analyzeFile(rel, raw));
	}
	return { sites, scanned: files.length };
}

/**
 * The exemption key a site matches, if any. Matches the discriminating
 * snippet against the call's own ARGUMENTS ONLY (`site.args`) — never a
 * preceding-source preamble (#2487 review round 3 F1: a preamble match is
 * how two textually distinct calls collided on one key, since the preamble
 * carries the module's shared boilerplate rather than each call's own
 * identity).
 */
function exemptionKey(site: CallSite): string | undefined {
	return Object.keys(EXEMPT_SITES).find((key) => {
		const [file, ...rest] = key.split(":");
		return file === site.file && site.args.includes(rest.join(":"));
	});
}

describe("#1980 every synchronous child-process call bounds the event-loop park", () => {
	const { sites, scanned } = findCallSites();
	const unbounded = sites.filter((site) => !site.bounded);

	// Flagged = the unbounded sites, reported under their exemption key when
	// they have one, so a stale exemption is detectable by the kit itself.
	// `exemptionKey` matches each call's own ARGUMENTS against a
	// discriminating snippet (never a preceding-source preamble — #2487
	// review round 3 F1), so two genuinely distinct call sites derive
	// genuinely distinct keys with no ordinal disambiguation needed. If a
	// future site's arguments happen to collide with an existing snippet
	// anyway, `auditRegistry`'s `requireUniqueFlagged` (on by default) fails
	// loud, naming both colliding sites by their own `detail` (`site.id`,
	// a real file:line) — never a silent ordinal shift.
	const flagged = unbounded.map((site) => ({
		key: exemptionKey(site) ?? site.id,
		detail: site.id,
	}));

	const audit = auditRegistry({
		sweepName: "sync child-process timeout sweep",
		flagged,
		registered: [],
		exemptions: EXEMPT_SITES,
		scannedCount: scanned,
		// Floors, not decoration (catalog shape 10): a walk that finds no
		// source files, or a detector that flags nothing, must fail rather than
		// read as clean. 200 is well under the ~450 shipped .ts files; 1 is the
		// single exempt site that will always be flagged.
		minScanned: 200,
		minFlagged: 1,
		remediation:
			"Pass an explicit `timeout` (5000 matches every other sync child-process site), or add an entry to EXEMPT_SITES with a real reason.",
	});

	it("actually finds the family (a dead scan must not read as clean)", () => {
		// Vacuity guard on the DETECTOR, separate from the audit's floors: if
		// the call-site regex breaks, every assertion below passes for free.
		// There were 7 sites across 3 files when this landed.
		expect(sites.length).toBeGreaterThanOrEqual(5);
		expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(3);
	});

	it("bounds every site, or exempts it with a reason", () => {
		// Pre-fix, `audit.unaccounted` reads:
		//   clients/lsp/launch.ts:310 execFileSync
		//   clients/safe-spawn.ts:1062 spawnSync
		expect(audit.problems).toEqual([]);
	});

	it("keeps the exemption list live and reasoned", () => {
		// An exemption whose site no longer exists must be deleted, not left to
		// silently cover some future call it was never reasoned about.
		expect(audit.staleExemptions).toEqual([]);
		expect(audit.reasonlessExemptions).toEqual([]);
	});
});

describe("#2487 review round 4 F1: a paren inside a string/comment argument cannot unbalance the depth scan", () => {
	// Reviewer's probe against bb752de8's shipped `callArguments`, which
	// depth-scanned RAW source: a literal `(` inside a string argument (a
	// shell command line quoting a paren, which is ordinary shell syntax) is
	// invisible to a naive depth count, so the scan never finds depth 0
	// before EOF and the "argument list" runs off the end of the real call,
	// through the rest of the file, and can swallow a later, unrelated
	// call's `timeout:` — silently reclassifying a genuinely unbounded call
	// as bounded. A real production fixture (not a hand-fed input): a
	// `spawnSync` invoking a shell with a quoted parenthesis in its command
	// string, exactly the shape `clients/safe-spawn.ts` callers pass through
	// (e.g. a grep pattern), followed by an unrelated bounded call.
	const FIXTURE_FILE = "clients/safe-spawn.ts";
	const FIXTURE_SOURCE = [
		"function runShellProbe() {",
		'	const result = spawnSync(shellPath, ["-c", "grep \'(\' /etc/hosts"], {',
		"		shell: false,",
		"	});",
		"}",
		"",
		"function runBoundedProbe() {",
		"	spawnSync(otherCmd, otherArgs, { timeout: 5000 });",
		"}",
		"",
	].join("\n");

	it("ATTACK_STRING_PAREN_COLLAPSE: the unbounded call stays unbounded, named by its own file:line", () => {
		const sites = analyzeFile(FIXTURE_FILE, FIXTURE_SOURCE);
		expect(sites.map((s) => s.id)).toEqual([
			"clients/safe-spawn.ts:2 spawnSync", // the shell-probe call — genuinely unbounded
			"clients/safe-spawn.ts:8 spawnSync", // the bounded call — must stay bounded, not be consumed
		]);
		// Pre-fix (bb752de8), the shell-probe call's depth scan is unbalanced
		// by the `(` inside `"grep '(' /etc/hosts"`, runs off the end of its
		// own call, and absorbs `runBoundedProbe`'s `{ timeout: 5000 }` into
		// its own "arguments" — so `bounded` reads true for a call that has
		// no `timeout:` anywhere in its own parens.
		const shellProbe = sites.find(
			(s) => s.id === "clients/safe-spawn.ts:2 spawnSync",
		);
		expect(shellProbe?.bounded).toBe(false);
		expect(shellProbe?.args).not.toContain("timeout");

		const unbounded = sites.filter((s) => !s.bounded);
		const flagged = unbounded.map((site) => ({
			key: exemptionKey(site) ?? site.id,
			detail: site.id,
		}));
		const audit = auditRegistry({
			sweepName: "sync child-process timeout sweep",
			flagged,
			registered: [],
			exemptions: EXEMPT_SITES,
		});
		// RED (pre-fix this passes with unaccounted: [] because the call
		// misreads as bounded) — the unbounded shell-probe call must be
		// caught, named by its own file:line.
		expect(audit.unaccounted).toEqual(["clients/safe-spawn.ts:2 spawnSync"]);
	});
});

describe("#2502 P1c: a nested template literal inside a call argument cannot unbalance the depth scan", () => {
	// Named output from #2487 round-4 review (2026-09-02): `stripSource` had
	// no `${` nesting state, so a backtick opening a NESTED template inside
	// an interpolation was read as the CLOSING backtick of the outer
	// template. The nested template's own stray `(` (from its unmasked text)
	// then falls through into `masked` as an ordinary, unblanked character —
	// `callArguments`'s depth scan over `masked` counts it as a real open
	// paren with no matching close inside the call, runs past the call's
	// true closing `)`, and does not return to depth 0 until it happens to
	// consume the NEXT call's `{ timeout: 5000 }` too. That inflates the
	// first call's own `args` to include `timeout:`, silently reclassifying
	// a genuinely unbounded call as bounded.
	const FIXTURE_FILE = "clients/safe-spawn.ts";
	const FIXTURE_SOURCE = [
		"function runTemplateProbe(cond) {",
		"\tspawnSync(cmd, [`x ${cond ? `y(` : `z`} w`]);",
		"}",
		"",
		"function runBoundedProbe() {",
		"\tspawnSync(otherCmd, otherArgs, { timeout: 5000 });",
		"}",
		"",
	].join("\n");

	it("ATTACK_NESTED_TEMPLATE_LAUNDERING: the unbounded call stays unbounded, named by its own file:line", () => {
		const sites = analyzeFile(FIXTURE_FILE, FIXTURE_SOURCE);
		expect(sites.map((s) => s.id)).toEqual([
			"clients/safe-spawn.ts:2 spawnSync", // the template-probe call — genuinely unbounded
			"clients/safe-spawn.ts:6 spawnSync", // the bounded call — must stay bounded, not absorbed
		]);
		// Pre-fix, the nested template's leaked `(` inflates the depth count
		// for THIS call, and the scan never returns to 0 before running past
		// its own closing paren into `runBoundedProbe`'s `{ timeout: 5000 }` —
		// so `bounded` reads true for a call with no `timeout:` in its own args.
		const templateProbe = sites.find(
			(s) => s.id === "clients/safe-spawn.ts:2 spawnSync",
		);
		expect(templateProbe?.bounded).toBe(false);
		expect(templateProbe?.args).not.toContain("timeout");

		const unbounded = sites.filter((s) => !s.bounded);
		const flagged = unbounded.map((site) => ({
			key: exemptionKey(site) ?? site.id,
			detail: site.id,
		}));
		const audit = auditRegistry({
			sweepName: "sync child-process timeout sweep",
			flagged,
			registered: [],
			exemptions: EXEMPT_SITES,
		});
		// RED pre-fix: `audit.unaccounted` reads `[]` — the unbounded call
		// silently reads as bounded, so nothing is ever flagged.
		expect(audit.unaccounted).toEqual(["clients/safe-spawn.ts:2 spawnSync"]);
	});
});

describe("#2487 review round 3 F1: a NEW colliding call cannot ride an existing exemption", () => {
	// The reviewer's two probes against 73a5db8a's shipped mechanism (the
	// haystack-matched `exemptionKey` plus `disambiguateFlaggedKeys`'
	// scan-position ordinals), reproduced here as a fixture through the REAL,
	// FIXED production scanner (`analyzeFile`, `exemptionKey`, the real
	// `EXEMPT_SITES`) — same shape as `bounded-eviction-idiom-sweep.test.ts`'s
	// `ATTACK_TWIN_OCCURRENCE_COLLISION`, a hand-built source string run
	// through the actual detector rather than a re-derivation of its logic.
	//
	// The fixture mirrors `clients/safe-spawn.ts`: call A is the real
	// Windows-resolved-path fallback (matches the `spawnCmd, spawnArgs,`
	// exemption), call C is the real plain-command fallback (matches the
	// `// Explicit override...` exemption), and call B is a brand-new,
	// never-reviewed `spawnSync` inserted BETWEEN them that shares only the
	// generic `...(options as SpawnOptions)` spread neither real exemption is
	// keyed to.
	//
	// Pre-fix (73a5db8a), a standalone reproduction of the shipped haystack
	// matching + `disambiguateFlaggedKeys` against this exact fixture (quoted
	// in the PR body) showed:
	//   - Probe 1 (all three unbounded): the sweep reds, but on the bare
	//     ordinal key `...(options as SpawnOptions)#3` — no file:line, and the
	//     ordinal actually belongs to C (an already-reviewed original site),
	//     not B (the new one) — `problems: [".. are neither registered nor
	//     exempted:\n  clients/safe-spawn.ts:...(options as SpawnOptions)#3"]`.
	//   - Probe 2 (same insertion, plus `timeout: 5000` added to A so the
	//     unbounded count stays at 2): `problems: []` — fully silent. B rides
	//     A's "occurrence 1 of 2" exemption by scan position alone.
	//
	// After this fix, B cannot match either real exemption (its arguments
	// contain neither discriminating snippet), so it is unaccounted under ITS
	// OWn key, which — since `exemptionKey` falls back to `site.id` (a real
	// file:line) when nothing matches — the problem message names directly.
	const FIXTURE_FILE = "clients/safe-spawn.ts";
	const FIXTURE_SOURCE = [
		"function resolveAndSpawn() {",
		"	const result = spawnSync(spawnCmd, spawnArgs, {",
		"		...(options as SpawnOptions),",
		"		cwd: spawnCwd,",
		"	});",
		"",
		"	const probeResult = spawnSync(otherCmd, otherArgs, {",
		"		...(options as SpawnOptions),",
		"		foo: 1,",
		"	});",
		"",
		"	const result3 = spawnSync(command, args, {",
		"		...(options as SpawnOptions),",
		"		// Explicit override, not just the spread above",
		"		env: spawnEnv,",
		"	});",
		"}",
		"",
	].join("\n");

	it("ATTACK_ARGUMENT_COLLISION: the new call is caught under its OWN file:line, never a stale ordinal", () => {
		const sites = analyzeFile(FIXTURE_FILE, FIXTURE_SOURCE);
		expect(sites.map((s) => s.id)).toEqual([
			"clients/safe-spawn.ts:2 spawnSync", // A — real Windows-branch fallback
			"clients/safe-spawn.ts:7 spawnSync", // B — the new, never-reviewed call
			"clients/safe-spawn.ts:12 spawnSync", // C — real plain-branch fallback
		]);
		const unbounded = sites.filter((s) => !s.bounded);
		expect(unbounded).toHaveLength(3); // none carry a `timeout:` in this fixture

		const flagged = unbounded.map((site) => ({
			key: exemptionKey(site) ?? site.id,
			detail: site.id,
		}));
		// A and C key to their REAL exemption entries; B keys to nothing and
		// falls back to its own id — no ordinal, no collision.
		expect(flagged.map((f) => f.key)).toEqual([
			"clients/safe-spawn.ts:spawnCmd, spawnArgs,", // A — real exemption
			"clients/safe-spawn.ts:7 spawnSync", // B — no match, own id
			"clients/safe-spawn.ts:// Explicit override, not just the spread above", // C — real exemption
		]);

		const audit = auditRegistry({
			sweepName: "sync child-process timeout sweep",
			flagged,
			registered: [],
			exemptions: EXEMPT_SITES,
		});
		// RED — the new call is still caught, exactly as it must be — but
		// NAMED by its own site, unlike pre-fix probe 1's bare `#3` ordinal.
		expect(audit.unaccounted).toEqual(["clients/safe-spawn.ts:7 spawnSync"]);
		expect(audit.problems.join("\n")).toContain(
			"clients/safe-spawn.ts:7 spawnSync",
		);
	});

	it("ATTACK_ARGUMENT_COLLISION probe 2: bounding the FIRST occurrence cannot launder the new call either", () => {
		// The same fixture, with `timeout: 5000` added to A — pre-fix, this is
		// exactly what made the sweep go fully silent (the unbounded COUNT
		// stayed at 2, matching the exemption list's cardinality by accident).
		const boundedFixture = FIXTURE_SOURCE.replace(
			"\t\tcwd: spawnCwd,",
			"\t\ttimeout: 5000,",
		);
		const sites = analyzeFile(FIXTURE_FILE, boundedFixture);
		const unbounded = sites.filter((s) => !s.bounded);
		expect(unbounded).toHaveLength(2); // A is now bounded; B and C remain

		const flagged = unbounded.map((site) => ({
			key: exemptionKey(site) ?? site.id,
			detail: site.id,
		}));
		const audit = auditRegistry({
			sweepName: "sync child-process timeout sweep",
			flagged,
			registered: [],
			exemptions: EXEMPT_SITES,
		});
		// Still RED, and still names B by its own file:line — args-derived
		// keys have no notion of "occurrence 1 of 2", so bounding A cannot
		// shift B into A's exemption the way scan-position ordinals could.
		expect(audit.unaccounted).toEqual(["clients/safe-spawn.ts:7 spawnSync"]);
	});
});
