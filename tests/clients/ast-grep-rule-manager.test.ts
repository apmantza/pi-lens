import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2626 review round 2, F4 pattern: wrap node:fs via vi.mock (a bare
// vi.spyOn cannot redefine a node: built-in's ESM export), default to the
// REAL implementation, and override for a single call in the EACCES cases.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		readdirSync: vi.fn(actual.readdirSync),
	};
});

import * as fs from "node:fs";
import {
	AstGrepRuleManager,
	checkAstGrepRulesHealth,
} from "../../clients/ast-grep-rule-manager.js";
import {
	_resetRuleCorpusCycleFingerprintsForTests,
	getUserRuleRoot,
} from "../../clients/custom-rule-locations.js";
import { getAstGrepRuleFingerprint } from "../../clients/sgconfig.js";
import {
	beginTurnContext,
	runWithTurnContext,
} from "../../clients/turn-context.js";
import { removeTempDirSync } from "./test-utils.js";

/**
 * #2636 (the #2626 class sweep's ast-grep leg): `checkAstGrepRulesHealth`
 * must mirror `loadRuleDescriptions`'s OWN resolution exactly (first
 * existing candidate among `ast-grep-rules/rules`, `rules`, `ruleDir` wins),
 * so a status this reports never disagrees with what the real manager does.
 */

let tmpDirs: string[] = [];

/**
 * Run `fn` inside a FRESH dispatch cycle, entered the way the pi host enters
 * one (`beginTurnContext` from `RuntimeCoordinator.beginTurn`, wrapped by
 * `session-event-guard`'s `runWithTurnContext`). The ast-grep rule fingerprint
 * is memoized per cycle through the same seam the tree-sitter loader uses
 * (#4212 round 4), so a case that must observe a rule edit has to cross that
 * boundary — production crosses it at every turn.
 */
let cycleSessions = 0;
function inNextCycle<T>(fn: () => T): T {
	cycleSessions += 1;
	const session = `ast-grep-cycle-${cycleSessions}`;
	beginTurnContext(session);
	return runWithTurnContext(session, fn);
}

beforeEach(() => {
	tmpDirs = [];
	vi.mocked(fs.readdirSync).mockClear();
	vi.mocked(fs.existsSync).mockClear();
	_resetRuleCorpusCycleFingerprintsForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

function freshRuleDir(): string {
	const dir = fsSync.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-pilens-ast-grep-rules-health-"),
	);
	tmpDirs.push(dir);
	return dir;
}

function writeYaml(dir: string, relPath: string, id = "fake"): void {
	const filePath = path.join(dir, relPath);
	fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
	fsSync.writeFileSync(filePath, `id: ${id}\nmessage: ${id}\n`);
}

describe("checkAstGrepRulesHealth", () => {
	it("refreshes descriptions at the next dispatch cycle after an edit or a removal", () => {
		const machine = freshRuleDir();
		const previous = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = machine;
		try {
			const rel = path.join(
				"rules",
				"ast-grep-rules",
				"rules",
				"live-description.yml",
			);
			writeYaml(machine, rel, "live-description");
			const file = path.join(machine, rel);
			fsSync.writeFileSync(file, "id: live-description\nmessage: OLD\n");
			const manager = new AstGrepRuleManager(
				[process.cwd(), getUserRuleRoot()],
				() => {},
				() => getAstGrepRuleFingerprint(process.cwd()),
			);
			expect(
				manager.loadRuleDescriptions().get("live-description")?.message,
			).toBe("OLD");

			fsSync.writeFileSync(file, "id: live-description\nmessage: NEW\n");
			// Same cycle: the fingerprint is memoized, so the description is
			// still the cycle's. Declared state-table row 17 — the ast-grep
			// twin of the loader's row 8.
			expect(
				manager.loadRuleDescriptions().get("live-description")?.message,
			).toBe("OLD");
			// Next cycle: the shared fingerprint is recomputed and the manager
			// re-reads. A same-size rewrite is caught here too, because the
			// ast-grep fingerprint has always hashed content, not stat.
			expect(
				inNextCycle(
					() => manager.loadRuleDescriptions().get("live-description")?.message,
				),
			).toBe("NEW");

			fsSync.rmSync(file);
			expect(
				inNextCycle(() =>
					manager.loadRuleDescriptions().has("live-description"),
				),
			).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previous;
		}
	});

	it("reports absent when ruleDir itself does not exist", () => {
		const ruleDir = path.join(freshRuleDir(), "does-not-exist");
		expect(checkAstGrepRulesHealth(ruleDir)).toEqual({ status: "absent" });
	});

	it("reports empty when ruleDir exists but none of the three candidates hold a .yml file", () => {
		const ruleDir = freshRuleDir();
		expect(checkAstGrepRulesHealth(ruleDir)).toEqual({ status: "empty" });
	});

	it("reports healthy via the nested ast-grep-rules/rules candidate, matching loadRuleDescriptions", () => {
		const ruleDir = freshRuleDir();
		writeYaml(ruleDir, path.join("ast-grep-rules", "rules", "one.yml"), "one");
		writeYaml(ruleDir, path.join("ast-grep-rules", "rules", "two.yml"), "two");

		expect(checkAstGrepRulesHealth(ruleDir)).toEqual({
			status: "healthy",
			entryCount: 2,
		});

		// Cross-check: the REAL manager resolves the identical count from the
		// SAME candidate — the health check must never disagree with it.
		const manager = new AstGrepRuleManager(ruleDir, () => {});
		expect(manager.loadRuleDescriptions().size).toBe(2);
	});

	it("reports healthy via the flat rules/ candidate when ast-grep-rules/rules is absent", () => {
		const ruleDir = freshRuleDir();
		writeYaml(ruleDir, path.join("rules", "only.yml"));

		expect(checkAstGrepRulesHealth(ruleDir)).toEqual({
			status: "healthy",
			entryCount: 1,
		});
	});

	it("reports empty (not absent) when the first EXISTING candidate holds no .yml, even though a later candidate would", () => {
		// Mirrors loadRuleDescriptions's own "first existing wins" resolution:
		// an empty ast-grep-rules/rules/ shadows a populated rules/ sibling.
		const ruleDir = freshRuleDir();
		fsSync.mkdirSync(path.join(ruleDir, "ast-grep-rules", "rules"), {
			recursive: true,
		});
		writeYaml(ruleDir, path.join("rules", "shadowed.yml"));

		expect(checkAstGrepRulesHealth(ruleDir)).toEqual({ status: "empty" });

		const manager = new AstGrepRuleManager(ruleDir, () => {});
		expect(manager.loadRuleDescriptions().size).toBe(0);
	});

	it("distinguishes an unreadable RESOLVED candidate (EACCES) from absent (ENOENT)", () => {
		// ruleDir itself exists (the last, catch-all candidate), so the loop
		// finds it and this exercises the readdirSync(rulesPath) branch.
		const ruleDir = freshRuleDir();
		const error = Object.assign(new Error("permission denied"), {
			code: "EACCES",
		});
		vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
			throw error;
		});
		expect(checkAstGrepRulesHealth(ruleDir)).toEqual({
			status: "unreadable",
			fsErrorCode: "EACCES",
		});
	});

	it("distinguishes an unreadable ruleDir ITSELF (EACCES) from absent (ENOENT), when no candidate is even visible", () => {
		// A ruleDir that cannot be STATTED at all (EACCES on the directory)
		// makes every fs.existsSync(candidate) check fail closed to `false`
		// (Node's own contract), so the loop never finds a rulesPath — the
		// `!rulesPath` branch must still tell this apart from a genuinely
		// ABSENT ruleDir via a direct readdirSync(ruleDir) probe.
		const ruleDir = freshRuleDir();
		vi.mocked(fs.existsSync).mockReturnValue(false);
		const error = Object.assign(new Error("permission denied"), {
			code: "EACCES",
		});
		vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
			throw error;
		});
		expect(checkAstGrepRulesHealth(ruleDir)).toEqual({
			status: "unreadable",
			fsErrorCode: "EACCES",
		});
	});
});
