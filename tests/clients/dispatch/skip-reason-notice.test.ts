/**
 * #5258: a file whose only applicable checks all skipped reads "not checked:
 * <cause>", never clean and never one sentence for every cause.
 *
 * Recurrence prevented: 119 runner returns were a bare `skipped`, so the
 * coverage notice worded a runner that needed a config the project lacks, a
 * runner whose tool was missing, and a runner the install kill switch had kept
 * away with the same "a language tool is missing, timed out, or failed to run".
 * The rows below drive the REAL `createDispatchContext` and `dispatchForFile`
 * with stand-in runners (the property under test is the verdict built from
 * what each runner states), for the markdown primary group (`spellcheck`,
 * `vale`) under `--no-lsp`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_getDegradationLedgerStateForTests,
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	skipped,
	type RunnerDefinition,
	type RunnerGroup,
	type RunnerResult,
} from "../../../clients/dispatch/types.js";
import { removeTempDirSync } from "../test-utils.js";
import { uncheckedReason } from "../../support/dispatch-verdict.js";

const GROUP: RunnerGroup[] = [
	{
		mode: "all",
		runnerIds: ["spellcheck", "vale"],
		filterKinds: ["markdown"],
	},
];

const BARE: RunnerResult = {
	status: "skipped",
	diagnostics: [],
	semantic: "none",
};
const CLEAN: RunnerResult = {
	status: "succeeded",
	diagnostics: [],
	semantic: "none",
};
const TIMED_OUT: RunnerResult = {
	status: "failed",
	diagnostics: [],
	semantic: "none",
	failureKind: "timeout",
};

const GENERIC = "a language tool is missing, timed out, or failed to run";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-skip-reason-"));
	resetDegradationLedger();
	clearCoverageNoticeState();
});

afterEach(() => {
	removeTempDirSync(tmpDir);
});

async function dispatchMarkdown(
	spellcheck: RunnerResult,
	vale: RunnerResult,
	name = "a.md",
) {
	const registry = new RunnerRegistry();
	for (const [id, result] of [
		["spellcheck", spellcheck],
		["vale", vale],
	] as const) {
		const runner: RunnerDefinition = {
			id,
			appliesTo: ["markdown"],
			priority: 10,
			async run() {
				return result;
			},
		};
		registry.register(runner);
	}
	const file = path.join(tmpDir, name);
	fs.writeFileSync(file, "# title\n");
	const ctx = createDispatchContext(
		file,
		tmpDir,
		{ getFlag: (flag: string) => flag === "no-lsp" },
		new FactStore(),
		false,
	);
	return dispatchForFile(ctx, GROUP, registry);
}

describe("a file every applicable check skipped is named not checked (#5258)", () => {
	it("states each runner's cause when every primary row states one", async () => {
		const result = await dispatchMarkdown(
			skipped("not-installed"),
			skipped("not-configured"),
		);

		expect(uncheckedReason(result)).toBe(
			"not checked (spellcheck: not installed; vale: not configured)",
		);
		expect(result.output).toContain(
			"spellcheck: not installed; vale: not configured, so this file was not checked (not a clean result)",
		);
		expect(result.output).not.toContain(GENERIC);
	});

	it("names the install kill switch for install-disabled", async () => {
		const result = await dispatchMarkdown(
			skipped("install-disabled"),
			skipped("not-preferred"),
		);

		expect(uncheckedReason(result)).toBe(
			"not checked (spellcheck: not installed, and the managed install is off (PI_LENS_DISABLE_TOOL_INSTALL=1); vale: the project's lint policy prefers another tool)",
		);
	});

	it("keeps the generic sentence for a bare skip, and adds the stated cause beside it", async () => {
		const bare = await dispatchMarkdown(BARE, BARE);
		expect(uncheckedReason(bare)).toBe(`not fully checked (${GENERIC})`);

		clearCoverageNoticeState();
		const mixed = await dispatchMarkdown(
			skipped("not-installed"),
			BARE,
			"b.md",
		);
		expect(uncheckedReason(mixed)).toBe(
			`not fully checked (${GENERIC}; spellcheck: not installed)`,
		);
		expect(mixed.output).toContain(GENERIC);
		expect(mixed.output).toContain("Stated: spellcheck: not installed.");
	});

	it("keeps the generic sentence when the other primary timed out", async () => {
		const result = await dispatchMarkdown(skipped("not-installed"), TIMED_OUT);

		expect(uncheckedReason(result)).toBe(
			`not fully checked (${GENERIC}; spellcheck: not installed)`,
		);
	});

	it("is checked when one primary completed beside a skipped one", async () => {
		const result = await dispatchMarkdown(CLEAN, skipped("not-configured"));

		expect(result.verdict).toEqual({
			checked: true,
			tier: "primary",
			runnerIds: ["spellcheck"],
		});
	});
});

describe("a missing tool is recorded once per (runner, reason) per session (#5258)", () => {
	it("writes one runner-skip-cause row across many edits, and none for a missing config", async () => {
		for (const name of ["a.md", "b.md", "c.md"]) {
			clearCoverageNoticeState();
			await dispatchMarkdown(
				skipped("not-installed"),
				skipped("not-configured"),
				name,
			);
		}

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "runner-skip-cause",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons).toEqual([
			{
				subject: "spellcheck:not-installed",
				reason: "spellcheck did not run: not installed",
			},
		]);
		expect(_getDegradationLedgerStateForTests().onceKeys).toBe(1);
	});

	it("keeps install-disabled a distinct subject from not-installed", async () => {
		await dispatchMarkdown(skipped("not-installed"), skipped("not-configured"));
		clearCoverageNoticeState();
		await dispatchMarkdown(
			skipped("install-disabled"),
			skipped("not-configured"),
			"b.md",
		);

		const group = getDegradationSummary().find(
			(entry) => entry.kind === "runner-skip-cause",
		);
		expect(group?.latestReasons.map((entry) => entry.subject)).toEqual([
			"spellcheck:not-installed",
			"spellcheck:install-disabled",
		]);
	});
});
