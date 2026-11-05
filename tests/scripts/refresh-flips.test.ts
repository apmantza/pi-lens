/**
 * #4512 acceptance 5 -- a refresh with no capability flips lands without a
 * manual step; a refresh with flips says so and is never armed.
 *
 * ## The recurrence this guards
 *
 * PR #4338 carried a measurement loss (five `direct` cells turned `unknown`) and
 * sat open for days because every refresh PR waited for a maintainer's close and
 * reopen, flip or not. Landing the flip-free ones automatically is only safe if
 * "flip-free" fails CLOSED: the gate admits a short list of bookkeeping surfaces
 * (the `src`, `version`, `install` and `stale` columns, the refresh-state JSON,
 * the generation date) and refuses every other difference. A gate that listed
 * the known-bad changes instead would let a new column, a new section or a
 * changed footnote ride through armed auto-merge.
 *
 * The cases drive the real `listRefreshFlips` over the recorded matrix (the doc
 * at origin/master 23aebcc2c) and the committed servercapabilities and
 * idle-eviction docs, and `landRefresh` with an in-memory git.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { landRefresh } from "../../scripts/lsp-refresh-landing.mjs";
import {
	GENERATED_LSP_DOCS,
	ensureMatrixColumns,
	parseRefreshState,
	refreshCapabilityMatrix,
	setIdleEvictionState,
} from "../../scripts/lib/md-matrix.mjs";
import {
	buildRefreshPrBody,
	listRefreshFlips,
	maskGeneratedDoc,
} from "../../scripts/lib/refresh-flips.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const MATRIX = "docs/lsp-capability-matrix.md";
const CAPS = "docs/servercapabilities.md";
const IDLE = "docs/lsp-idle-eviction.md";

const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const recorded = JSON.parse(
	read("tests/fixtures/lsp-nightly/4338-missed-probes.json"),
) as {
	nights: { day: string; observations: never[] }[];
};
const RECORDED = read("tests/fixtures/lsp-nightly/matrix-before-4338.md");
// HEAD as it stands once this change has merged: the recorded doc in the
// current column set with the current state-section prose. (A generator change
// itself IS a flip once: see "admits the refresh-state counters" below.)
const HEAD_MATRIX = setIdleEvictionState(
	ensureMatrixColumns(RECORDED),
	parseRefreshState(RECORDED)["idle-eviction"] ?? {},
);
const HEAD = {
	[MATRIX]: HEAD_MATRIX,
	[CAPS]: read(CAPS),
	[IDLE]: read(IDLE),
};

/** The recorded matrix after `n` nights of the #4338 replay (misses five servers). */
function replayed(n: number): string {
	let text = HEAD_MATRIX;
	for (const night of recorded.nights.slice(0, n))
		text = refreshCapabilityMatrix(text, night.observations, {
			src: "ci",
			now: night.day,
		}).text;
	return text;
}

const withDocs = (matrix: string, extra: Record<string, string> = {}) => ({
	...HEAD,
	[MATRIX]: matrix,
	...extra,
});

describe("#4512 a refresh with only bookkeeping differences is flip-free", () => {
	it("admits the stale mark, the new columns and the refresh state of a seven-night replay", () => {
		const next = replayed(7);
		expect(next).not.toBe(HEAD_MATRIX);
		expect(next).toContain("since 2026-10-10");
		expect(listRefreshFlips(HEAD, withDocs(next))).toEqual([]);
	});

	it("admits a version and install change and a generation date change", () => {
		const migrated = HEAD_MATRIX.replace(
			"| typescript | typescript-language-server | push-only | silent | direct | 3 | dev+ci | — | — | — |",
			"| typescript | typescript-language-server | push-only | silent | direct | 3 | dev+ci | 5.1.3 | pi-lens-auto | — |",
		);
		expect(migrated).toContain("5.1.3");
		const caps = HEAD[CAPS].replace(
			/^_Last generated: .*_$/m,
			"_Last generated: 2099-01-01 on linux; 1 servers captured, 0 unavailable._",
		);
		expect(
			listRefreshFlips(HEAD, withDocs(migrated, { [CAPS]: caps })),
		).toEqual([]);
	});

	it("ignores row order: a reordering with identical content is not a flip", () => {
		const lines = HEAD_MATRIX.split("\n");
		const first = lines.findIndex((l) => l.startsWith("| json |"));
		[lines[first], lines[first + 1]] = [lines[first + 1], lines[first]];
		expect(listRefreshFlips(HEAD, withDocs(lines.join("\n")))).toEqual([]);
	});

	it("admits the refresh-state counters but not the section's prose", () => {
		const bumped = HEAD_MATRIX.replace(
			/\{"idle-eviction":.*\}/,
			'{"idle-eviction":{"powershell":{"nights":[{"day":"2026-10-28","rssMb":160,"coldMs":2600}]}}}',
		);
		expect(bumped).not.toBe(HEAD_MATRIX);
		expect(listRefreshFlips(HEAD, withDocs(bumped))).toEqual([]);
		const prose = HEAD_MATRIX.replace(
			"Regenerated every run; never a measurement.",
			"Regenerated every run; a measurement.",
		);
		expect(listRefreshFlips(HEAD, withDocs(prose))).toHaveLength(2);
	});
});

describe("#4512 every other difference is a flip (fail closed)", () => {
	it("flags a clean-behavior change in the matrix, naming the doc and both lines", () => {
		const flipped = HEAD_MATRIX.replace(
			"| typescript | typescript-language-server | push-only | silent |",
			"| typescript | typescript-language-server | push-only | publishes-versioned |",
		);
		const flips = listRefreshFlips(HEAD, withDocs(flipped));
		expect(flips).toHaveLength(2);
		expect(flips[0]).toBe(
			`${MATRIX}: - | typescript | typescript-language-server | push-only | silent | direct | 3 |`,
		);
		expect(flips[1]).toBe(
			`${MATRIX}: + | typescript | typescript-language-server | push-only | publishes-versioned | direct | 3 |`,
		);
	});

	it("flags a first-publish change and a mode change", () => {
		const a = HEAD_MATRIX.replace(
			"| python | pyright | push-only | publishes-versioned | direct |",
			"| python | pyright | push-only | publishes-versioned | unknown |",
		);
		const b = HEAD_MATRIX.replace(
			"| rust | rust-analyzer | pull |",
			"| rust | rust-analyzer | push-only |",
		);
		expect(listRefreshFlips(HEAD, withDocs(a))).not.toEqual([]);
		expect(listRefreshFlips(HEAD, withDocs(b))).not.toEqual([]);
	});

	it("flags an added and a removed matrix row", () => {
		const added = `${HEAD_MATRIX.replace(
			"| cue | CUE",
			"| newlang | newserver | pull | — | n/a (pull) | 1 | ci |\n| cue | CUE",
		)}`;
		expect(listRefreshFlips(HEAD, withDocs(added))).toHaveLength(1);
		const removed = HEAD_MATRIX.split("\n")
			.filter((l) => !l.startsWith("| cue | CUE"))
			.join("\n");
		expect(listRefreshFlips(HEAD, withDocs(removed))).toHaveLength(1);
	});

	it("flags a capability change in servercapabilities and any change in the idle-eviction doc", () => {
		const caps = HEAD[CAPS].replace("| ✓ |", "| · |");
		expect(caps).not.toBe(HEAD[CAPS]);
		expect(
			listRefreshFlips(HEAD, withDocs(HEAD_MATRIX, { [CAPS]: caps })).every(
				(f) => f.startsWith(`${CAPS}: `),
			),
		).toBe(true);
		const idle = `${HEAD[IDLE].trimEnd()}\n- a new finding\n`;
		expect(
			listRefreshFlips(HEAD, withDocs(HEAD_MATRIX, { [IDLE]: idle })),
		).toEqual([`${IDLE}: + - a new finding`]);
	});

	it("flags a changed silentOnClean drift footnote", () => {
		const drift = HEAD_MATRIX.replace(
			/- \*\*\[silent-not-marked\]\*\*.*\n/,
			"- **[marked-not-silent]** observed publishing on clean transitions\n",
		);
		expect(drift).not.toBe(HEAD_MATRIX);
		expect(listRefreshFlips(HEAD, withDocs(drift))).toHaveLength(2);
	});

	it("flags a doc HEAD lacks and a doc the regeneration lacks", () => {
		expect(listRefreshFlips({ ...HEAD, [IDLE]: null }, HEAD)).toEqual([
			`${IDLE}: not at HEAD`,
		]);
		expect(listRefreshFlips(HEAD, { ...HEAD, [IDLE]: null })).toEqual([
			`${IDLE}: missing from the regeneration`,
		]);
	});

	// The three spellings the author did not design for (fixer contract, detector
	// PRs). Each must stay red; a green plant means the gate admitted a form it
	// was never told about.
	it("plant 1 (alias): a column named like a benign one but not on the list is a flip", () => {
		for (const alias of ["Stale", "stale-since", "versions", "installs"]) {
			const aliased = ensureMatrixColumns(HEAD_MATRIX)
				.replace(
					"| version | install | stale |",
					`| version | install | ${alias} |`,
				)
				.replace(/\| — \| — \| — \|$/m, "| — | — | x |");
			expect(
				listRefreshFlips(HEAD, withDocs(aliased)).length,
				alias,
			).toBeGreaterThan(0);
		}
	});

	it("plant 2 (indirect): a new column hides a changed value no list names", () => {
		const header =
			"| lang | server | mode | clean-behavior | first-publish | tier | src |";
		const widened = HEAD_MATRIX.replace(
			header,
			`${header.slice(0, -1)} | verdict |`,
		)
			.replace(
				/^\|---\|---\|---\|---\|---\|---\|---\|$/m,
				"|---|---|---|---|---|---|---|---|",
			)
			.replace(/^(\| json \|.*\|) $/m, "$1")
			.split("\n")
			.map((line) =>
				/^\| [a-z0-9-]+ \| .* \| (dev|ci|dev\+ci) \|$/.test(line)
					? `${line} applied |`
					: line,
			)
			.join("\n");
		expect(listRefreshFlips(HEAD, withDocs(widened)).length).toBeGreaterThan(0);
	});

	it("plant 3 (another binding): a benign column's name used in a different table does not mask it", () => {
		// `stale` and `src` are benign only in the matrix table of the matrix doc.
		// The same names in servercapabilities (or a second table in the matrix
		// doc) carry real cells and must be compared.
		const caps = HEAD[CAPS].replace(
			"| server | mode |",
			"| server | src | mode |",
		);
		expect(maskGeneratedDoc(CAPS, caps)).toContain("| server | src | mode |");
		expect(
			listRefreshFlips(HEAD, withDocs(HEAD_MATRIX, { [CAPS]: caps })).length,
		).toBeGreaterThan(0);
	});
});

describe("#4512 landRefresh: the PR body and the verdict the workflow reads", () => {
	// Every scratch root is removed when this block ends. Recurrence: #4980 round
	// 2 verify F4, where each run left one `landing-*` root in the tmp root
	// (6 per run on this file at e38b34bc8) and no `afterAll` owned them.
	const scratchRoots: string[] = [];
	afterAll(() => {
		for (const root of scratchRoots)
			fs.rmSync(root, { recursive: true, force: true });
	});

	function scratch(
		newDocs: Record<string, string | null>,
		headDocs: Record<string, string | null>,
	) {
		const root = fs.mkdtempSync(
			path.join(process.env.TMPDIR ?? os.tmpdir(), "landing-"),
		);
		scratchRoots.push(root);
		for (const [doc, text] of Object.entries(newDocs)) {
			if (text === null) continue;
			fs.mkdirSync(path.dirname(path.join(root, doc)), { recursive: true });
			fs.writeFileSync(path.join(root, doc), text);
		}
		// The two argv shapes the landing script uses, with real git's contract:
		// `ls-tree` exits 0 and prints only the paths HEAD has (a missing path is
		// an empty answer, not an error); any other argv is a git failure.
		const git = (args: string[]) => {
			if (args[0] === "ls-tree")
				return args
					.slice(args.indexOf("--") + 1)
					.filter((doc) => typeof headDocs[doc] === "string")
					.join("\n");
			const doc = args[1]?.replace(/^HEAD:/, "") ?? "";
			const text = headDocs[doc];
			if (args[0] !== "show" || typeof text !== "string")
				throw new Error("fatal: path not in HEAD");
			return text;
		};
		return { root, git };
	}

	it("reports flip-free with no flips listed for the replayed bookkeeping", () => {
		const { root, git } = scratch(withDocs(replayed(7)), HEAD);
		const result = landRefresh({ root, git, landing: "automerge" });
		expect(result.flipFree).toBe(true);
		expect(result.body).toContain("No flips: auto-merge is armed.");
		expect(result.body).toContain(
			"None. Only `src`, `version`, `install`, `stale`",
		);
	});

	it("lists the flips, links the open drift issues and does not claim to arm auto-merge", () => {
		const flipped = replayed(2).replace(
			"| typescript | typescript-language-server | push-only | silent |",
			"| typescript | typescript-language-server | push-only | publishes-versioned |",
		);
		const { root, git } = scratch(withDocs(flipped), HEAD);
		const result = landRefresh({
			root,
			git,
			landing: "automerge",
			issuesUrl: "https://example.test/issues?q=label%3Anightly-drift",
		});
		expect(result.flipFree).toBe(false);
		expect(result.flips).toHaveLength(2);
		expect(result.body).toContain("```diff");
		expect(result.body).toContain(
			"https://example.test/issues?q=label%3Anightly-drift",
		);
		expect(result.body).not.toContain("auto-merge is armed");
	});

	it("a doc HEAD does not have is a flip by name, not a failed check", () => {
		const { root, git } = scratch(withDocs(replayed(2)), {
			...HEAD,
			[CAPS]: null,
		});
		const result = landRefresh({ root, git, landing: "automerge" });
		expect(result.flipFree).toBe(false);
		expect(result.checkFailed).toBe(false);
		expect(result.flips).toEqual([`${CAPS}: not at HEAD`]);
	});

	// Recurrence (#4980 F2): a git failure was caught per doc and reported as
	// "<doc>: not at HEAD", so the refresh PR said "N changed lines" when the
	// check never ran. `git ls-tree` answers a missing path with exit 0 and
	// empty output, so a nonzero exit (here 128, not a repository) is a failure
	// and never a flip.
	it("is not flip-free when git fails: the check could not run, not a doc missing from HEAD", () => {
		const { root } = scratch(withDocs(replayed(2)), HEAD);
		const result = landRefresh({
			root,
			landing: "automerge",
			git: () => {
				throw Object.assign(new Error("fatal: not a git repository"), {
					status: 128,
				});
			},
		});
		expect(result.flipFree).toBe(false);
		expect(result.checkFailed).toBe(true);
		expect(result.flips).toEqual([]);
		expect(result.body).toContain(
			"The flip check could not run, so this refresh is treated as having flips",
		);
		expect(result.body).not.toContain("not at HEAD");
		expect(result.body).not.toContain("auto-merge is armed");
	});

	it("is not flip-free when reading a doc HEAD has fails", () => {
		const { root, git } = scratch(withDocs(replayed(2)), HEAD);
		const result = landRefresh({
			root,
			landing: "automerge",
			git: (args) => {
				if (args[0] === "show") throw new Error("fatal: bad object HEAD");
				return git(args);
			},
		});
		expect(result.flipFree).toBe(false);
		expect(result.checkFailed).toBe(true);
	});

	it("is not flip-free when the check itself cannot run (an unreadable regenerated doc)", () => {
		const { root, git } = scratch({}, HEAD);
		// A directory where the doc should be: existsSync passes, the read throws.
		fs.mkdirSync(path.join(root, MATRIX), { recursive: true });
		const result = landRefresh({ root, git, landing: "automerge" });
		expect(result.flipFree).toBe(false);
		expect(result.checkFailed).toBe(true);
		expect(result.body).toContain(
			"The flip check could not run, so this refresh is treated as having flips",
		);
		expect(result.body).not.toContain("auto-merge is armed");
	});

	it("says which landing the repository is configured for", () => {
		const flips: string[] = [];
		// Recurrence: the manual body still asked for a close and reopen after
		// #5062 made the nightly dispatch the required checks (#5304, audit D6).
		const manual = buildRefreshPrBody({ flips, landing: "manual" });
		expect(manual).toContain("dispatches the required checks on its head");
		expect(manual).not.toContain("must close and reopen");
		expect(buildRefreshPrBody({ flips, landing: "ci-only" })).toContain(
			"A maintainer merges it.",
		);
		expect(
			buildRefreshPrBody({ flips, landing: "automerge", checkFailed: true }),
		).toContain("could not run");
		expect(GENERATED_LSP_DOCS).toEqual([MATRIX, CAPS, IDLE]);
	});
});
