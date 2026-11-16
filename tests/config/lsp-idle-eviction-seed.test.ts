/**
 * #5667: the nightly's seed step restores the idle-eviction doc with the matrix.
 *
 * ## The recurrence this guards
 *
 * The idle-eviction doc holds a changed row for two agreeing nights; the pending
 * night is kept in the matrix's refresh-state block and the published row it is
 * held against is `docs/lsp-idle-eviction.md`. Each nightly checks out master,
 * and the seed step restored only the matrix, so while the refresh PR stayed
 * unmerged the restored pending night sat over master's older row and the held
 * row flipped on every other night (PR #5681 review F2). This test fails when
 * the seed step stops restoring the doc, stops running before the measurement,
 * or the refresh PR stops committing the doc the seed restores.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	BOT_BRANCH,
	IDLE_DOC,
	MATRIX_DOC,
	seedMatrixFromBotBranch,
} from "../../scripts/seed-matrix-from-bot-branch.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const workflow: any = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/tool-smoke.yml"), "utf8"),
);
const steps: any[] = workflow.jobs["tool-smoke"].steps;
const indexOfStep = (id: string) => steps.findIndex((s) => s.id === id);

describe("the seed step restores the idle-eviction doc with the matrix (#5667)", () => {
	it("runs the seed script before the idle-eviction measurement writes the doc", () => {
		const seed = indexOfStep("seed_matrix");
		const measure = indexOfStep("idle_measurement");
		expect(seed).toBeGreaterThan(-1);
		expect(measure).toBeGreaterThan(seed);
		expect(steps[seed].run).toBe(
			"node scripts/seed-matrix-from-bot-branch.mjs",
		);
	});

	it("restores both docs when the bot branch is ahead and built on master", () => {
		const botRef = `refs/remotes/origin/${BOT_BRANCH}`;
		const blobs: Record<string, string> = {};
		for (const doc of [MATRIX_DOC, IDLE_DOC]) {
			blobs[`HEAD:${doc}`] = `master:${doc}`;
			blobs[`${botRef}:${doc}`] = `bot:${doc}`;
			blobs[`${botRef}^:${doc}`] = `master:${doc}`;
		}
		const writes: Record<string, string> = {};
		const decision = seedMatrixFromBotBranch({
			cwd: "/work",
			git: (args) => {
				if (args[0] === "fetch") return "";
				if (args[0] === "rev-parse") {
					const blob = blobs[args.at(-1) as string];
					if (blob === undefined)
						throw Object.assign(new Error("exit 1"), { status: 1 });
					return `${blob}\n`;
				}
				return blobs[args.at(-1) as string];
			},
			writeFile: (file, text) => {
				writes[file] = text;
			},
			log: () => {},
		});
		expect(decision.source).toBe("bot");
		expect(writes[`/work/${MATRIX_DOC}`]).toBe(`bot:${MATRIX_DOC}`);
		expect(writes[`/work/${IDLE_DOC}`]).toBe(`bot:${IDLE_DOC}`);
	});

	it("keeps the restored doc among the files the refresh PR commits", () => {
		const prJob = Object.values<any>(workflow.jobs).flatMap(
			(job) => job.steps ?? [],
		);
		const refresh = prJob.find(
			(s) =>
				typeof s.with?.["add-paths"] === "string" &&
				s.with["add-paths"].includes(MATRIX_DOC),
		);
		expect(refresh?.with["add-paths"]).toContain(IDLE_DOC);
	});
});
