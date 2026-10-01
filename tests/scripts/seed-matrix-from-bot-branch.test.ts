/**
 * #3401 round 2 -- where the nightly reads its prior matrix state from.
 *
 * ## The recurrence this guards
 *
 * The expiry/hysteresis bookkeeping lives in docs/lsp-capability-matrix.md, each
 * nightly checks out master, and `peter-evans/create-pull-request` force-rebuilds
 * `bot/lsp-docs-refresh` from master. So an UNMERGED bot PR lost its bookkeeping
 * every night: a stable observation for five nights with the PR open sat at
 * `pending 1 committed 0` on all five (review F1, probe p5), and the clock was
 * "merged refreshes", not nights. The seed step starts the night from the bot
 * branch's doc when that is safe, and falls back to master's doc otherwise.
 *
 * The git boundary is an in-memory ref store that answers the few commands the
 * script issues and fails the way real git does (a missing ref makes
 * `rev-parse --verify --quiet` exit 1; a fetch of an absent branch is fatal).
 * The seam under test is the script's decision, driven with the real
 * `refreshCapabilityMatrix` so the clock is observed end to end.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	parseRefreshState,
	parseTable,
	refreshCapabilityMatrix,
	FIRST_PUBLISH_EXPIRY_DAYS,
} from "../../scripts/lib/md-matrix.mjs";
import {
	BOT_BRANCH,
	MATRIX_DOC,
	decideMatrixSeed,
	seedMatrixFromBotBranch,
} from "../../scripts/seed-matrix-from-bot-branch.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const BOT_REF = `refs/remotes/origin/${BOT_BRANCH}`;

interface Remote {
	/** Doc text by blob id; the blob id is just the text's label here. */
	master?: string | null;
	bot?: string | null;
	botBase?: string | null;
	fetchFails?: string;
	showFails?: boolean;
}

/** A tiny git: blobs are addressed by `blob:<text>` so equal text == equal id. */
function fakeGit(remote: Remote) {
	const calls: string[][] = [];
	const id = (text: string | null | undefined) =>
		text == null ? null : `blob:${text}`;
	const git = (args: string[]): string => {
		calls.push(args);
		if (args[0] === "fetch") {
			if (remote.fetchFails)
				throw Object.assign(new Error("fetch failed"), {
					stderr: remote.fetchFails,
				});
			return "";
		}
		if (args[0] === "rev-parse") {
			const spec = args.at(-1) as string;
			const table: Record<string, string | null | undefined> = {
				[`HEAD:${MATRIX_DOC}`]: remote.master,
				[`${BOT_REF}:${MATRIX_DOC}`]: remote.bot,
				[`${BOT_REF}^:${MATRIX_DOC}`]: remote.botBase,
			};
			const found = id(table[spec]);
			if (found === null)
				throw Object.assign(new Error("exit 1"), { status: 1 });
			return `${found}\n`;
		}
		if (args[0] === "show") {
			if (remote.showFails) throw new Error("show failed");
			return remote.bot ?? "";
		}
		throw new Error(`unexpected git ${args.join(" ")}`);
	};
	return { git, calls };
}

function seed(remote: Remote) {
	const { git, calls } = fakeGit(remote);
	const writes: Array<{ file: string; text: string }> = [];
	const logs: string[] = [];
	const decision = seedMatrixFromBotBranch({
		cwd: "/work",
		git,
		writeFile: (file, text) => writes.push({ file, text }),
		log: (line) => logs.push(line),
	});
	return { decision, writes, logs, calls };
}

describe("#3401 decideMatrixSeed", () => {
	it.each([
		[
			"fresh and ahead",
			{ masterBlob: "m", botBlob: "b", botBaseBlob: "m" },
			"bot",
		],
		[
			"no doc on the bot branch",
			{ masterBlob: "m", botBlob: null, botBaseBlob: "m" },
			"master",
		],
		[
			"identical to master (not ahead)",
			{ masterBlob: "m", botBlob: "m", botBaseBlob: "m" },
			"master",
		],
		[
			"stale: master moved the doc since the fork",
			{ masterBlob: "m2", botBlob: "b", botBaseBlob: "m" },
			"master",
		],
		[
			"base doc unreadable (history boundary)",
			{ masterBlob: "m", botBlob: "b", botBaseBlob: null },
			"master",
		],
	] as const)("%s", (_name, facts, source) => {
		expect(decideMatrixSeed(facts).source).toBe(source);
	});
});

describe("#3401 seedMatrixFromBotBranch", () => {
	it("writes the bot branch's doc when it is ahead of master and built on master's doc", () => {
		const { decision, writes, calls } = seed({
			master: "MASTER DOC",
			bot: "BOT DOC",
			botBase: "MASTER DOC",
		});
		expect(decision.source).toBe("bot");
		expect(writes).toEqual([{ file: `/work/${MATRIX_DOC}`, text: "BOT DOC" }]);
		// The fetch is bounded (depth 2) and targets exactly the bot branch.
		expect(calls[0]).toEqual([
			"fetch",
			"--no-tags",
			"--depth=2",
			"origin",
			`+refs/heads/${BOT_BRANCH}:${BOT_REF}`,
		]);
	});

	it("falls back to master when the bot branch does not exist (fetch fails)", () => {
		const { decision, writes, logs } = seed({
			master: "MASTER DOC",
			fetchFails:
				"fatal: couldn't find remote ref refs/heads/bot/lsp-docs-refresh",
		});
		expect(decision.source).toBe("master");
		expect(writes).toEqual([]);
		expect(logs[0]).toMatch(/absent or unreachable/);
		expect(logs[0]).toMatch(/couldn't find remote ref/);
	});

	it("falls back to master when the branch was squash-merged (master carries a newer doc)", () => {
		// After a squash merge the branch keeps its old commit: it differs from
		// master's doc and is "ahead" by commit count, but its base doc is the
		// pre-merge master. Seeding from it would revert master's merged refresh.
		const { decision, writes } = seed({
			master: "MASTER DOC AFTER SQUASH",
			bot: "BOT DOC",
			botBase: "MASTER DOC BEFORE",
		});
		expect(decision.source).toBe("master");
		expect(decision.reason).toMatch(/stale/);
		expect(writes).toEqual([]);
	});

	it("falls back to master when the bot doc equals master's", () => {
		const { decision, writes } = seed({
			master: "SAME",
			bot: "SAME",
			botBase: "OLDER",
		});
		expect(decision.source).toBe("master");
		expect(writes).toEqual([]);
	});

	it("falls back to master when the bot branch carries no matrix doc", () => {
		const { decision, writes } = seed({
			master: "MASTER DOC",
			botBase: "MASTER DOC",
		});
		expect(decision.source).toBe("master");
		expect(writes).toEqual([]);
	});

	it("falls back to master, never throws, when reading the bot doc fails after the decision", () => {
		const { decision, writes } = seed({
			master: "MASTER DOC",
			bot: "BOT DOC",
			botBase: "MASTER DOC",
			showFails: true,
		});
		expect(decision.source).toBe("master");
		expect(decision.reason).toMatch(/unreadable/);
		expect(writes).toEqual([]);
	});
});

describe("#3401 the nightly clock with an unmerged bot PR", () => {
	const DOC = [
		"# LSP capability matrix",
		"",
		"| lang | server | mode | clean-behavior | first-publish | tier | src |",
		"|---|---|---|---|---|---|---|",
		"| vue | @vue/language-server | push-only | unknown | direct | 2/3? | dev+ci |",
		"",
		"## Key findings",
		"",
	].join("\n");

	const day = (n: number) =>
		new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10);
	const vueFirstPublish = (text: string) => {
		const table = parseTable(text, "| lang | server |")!;
		return table.rows.find((c) => c[0] === "vue")![
			table.header.indexOf("first-publish")
		];
	};

	/** Nights 0..n with the bot PR NEVER merged; master's doc stays `DOC`. */
	function run(nights: number, seedFromBot: boolean) {
		let botDoc: string | null = null; // the unmerged bot PR's doc
		let working = DOC;
		for (let n = 0; n <= nights; n++) {
			working = DOC; // a fresh checkout of master
			if (seedFromBot && botDoc !== null) {
				const { git } = fakeGit({ master: DOC, bot: botDoc, botBase: DOC });
				seedMatrixFromBotBranch({
					cwd: "/work",
					git,
					writeFile: (_f, text) => {
						working = text;
					},
					log: () => {},
				});
			}
			working = refreshCapabilityMatrix(working, [], {
				src: "ci",
				now: day(n),
			}).text;
			botDoc = working; // peter-evans force-pushes tonight's doc
		}
		return working;
	}

	it("expires the cell after N elapsed days although no bot PR ever merged", () => {
		const after = run(FIRST_PUBLISH_EXPIRY_DAYS, true);
		expect(vueFirstPublish(after)).toBe("unknown");
	});

	it("never expires it when every night starts from master's doc (the r1 defect)", () => {
		const after = run(FIRST_PUBLISH_EXPIRY_DAYS + 10, false);
		expect(vueFirstPublish(after)).toBe("direct");
		// Each night restarted the clock at its own date.
		expect(parseRefreshState(after)["first-publish"]?.vue).toEqual({
			firstMissed: day(FIRST_PUBLISH_EXPIRY_DAYS + 10),
		});
	});
});

describe("#3401 the workflow wiring", () => {
	type Step = {
		name?: string;
		run?: string;
		if?: string;
		"continue-on-error"?: boolean;
		"timeout-minutes"?: number;
	};
	const workflow = yaml.load(
		readFileSync(
			resolve(REPO_ROOT, ".github/workflows/tool-smoke.yml"),
			"utf8",
		),
	) as { jobs: Record<string, { steps: Step[] }> };
	const steps = workflow.jobs["tool-smoke"].steps;
	const indexOfRun = (needle: string) =>
		steps.findIndex((s) => typeof s.run === "string" && s.run.includes(needle));

	it("seeds the matrix before the first step that writes it, scoped like the PR step, fail-open", () => {
		const seedIdx = indexOfRun("seed-matrix-from-bot-branch.mjs");
		expect(seedIdx, "the seed step exists").toBeGreaterThan(-1);
		// characterize-lsp.mjs is the first matrix-doc writer of the job.
		expect(seedIdx).toBeLessThan(indexOfRun("characterize-lsp.mjs"));
		expect(seedIdx).toBeLessThan(indexOfRun("probe-clean-signal.mjs"));
		const step = steps[seedIdx];
		expect(step.if).toBe(
			"github.event_name == 'schedule' || github.ref == 'refs/heads/master'",
		);
		expect(step["continue-on-error"]).toBe(true);
		// `continue-on-error` does not bound a hung fetch; only a step timeout does.
		expect(step["timeout-minutes"]).toBe(2);
	});
});
