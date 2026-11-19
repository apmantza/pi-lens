/**
 * The STOP block names the file a cross-file blocker cites.
 *
 * mypy follows imports and attributes each error to the module it names
 * (`parseMypyOutput`), so one dispatch of `edited.py` can carry a blocker on
 * `other.py`. `formatDiagnostics` rendered every row as `L<n>: <message>`
 * under the edited file, so the agent read `L737` as a line of a 211-line
 * file and marked it against the wrong file, where no mark could reach it.
 * The dispatcher's `blockerOutput` is also the record summary the turn end
 * re-serves, so this asserts it at that seam: `dispatchForFile` with the real
 * mypy parser's output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { parseMypyOutput } from "../../../clients/dispatch/runners/mypy.js";
import { parseRuffJson } from "../../../clients/dispatch/runners/ruff.js";
import type {
	Diagnostic,
	RunnerGroup,
} from "../../../clients/dispatch/types.js";
import { applyInlineBlockerPolicy } from "../../../clients/inline-blocker-dispositions.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { createMockRunner } from "../../mocks/runner-factory.js";
import { setupTestEnvironment } from "../test-utils.js";

let projectRoot: string;
let cleanup: () => void;
let previousDataDir: string | undefined;

const EDITED = "import other\nx: int = other.f()\n";
const MYPY_OUTPUT = [
	"edited.py:2: error: Incompatible types in assignment  [assignment]",
	"other.py:737: error: Type statement is only supported in Python 3.12 and greater  [syntax]",
	"Found 2 errors in 2 files (checked 1 source file)",
].join("\n");

beforeEach(() => {
	({ tmpDir: projectRoot, cleanup } = setupTestEnvironment(
		"pi-lens-stop-xfile-",
	));
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(projectRoot, ".data");
	clearCoverageNoticeState();
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	cleanup();
});

async function dispatchEdited(): Promise<{
	blockerOutput: string;
	blockers: Diagnostic[];
	fileAbs: string;
	otherPath: string;
}> {
	const fileAbs = path.join(projectRoot, "edited.py");
	fs.writeFileSync(fileAbs, EDITED);
	const diagnostics = parseMypyOutput(MYPY_OUTPUT, fileAbs, projectRoot);
	const registry = new RunnerRegistry();
	registry.register(
		createMockRunner({
			id: "mypy",
			appliesTo: ["python"],
			runResult: { status: "failed", diagnostics, semantic: "blocking" },
		}),
	);
	const facts = new FactStore();
	const ctx = createDispatchContext(
		fileAbs,
		projectRoot,
		{ getFlag: () => false },
		facts,
	);
	facts.setFileFact(ctx.filePath, "file.content", EDITED);
	const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["mypy"] }];
	const result = await dispatchForFile(ctx, groups, registry);
	return {
		blockerOutput: result.blockerOutput,
		blockers: result.blockers,
		fileAbs,
		otherPath: path.join(projectRoot, "other.py"),
	};
}

describe("the STOP block names a cross-file blocker's file", () => {
	it("labels the other file's row with that file", async () => {
		const { blockerOutput, otherPath } = await dispatchEdited();
		expect(blockerOutput).toContain(`  ${otherPath} L737: [syntax]`);
	});

	it("leaves the edited file's own row unlabelled", async () => {
		const { blockerOutput } = await dispatchEdited();
		expect(blockerOutput).toContain("  L2: [assignment]");
		expect(blockerOutput).not.toContain("edited.py L2");
	});

	it("re-serves the record at turn end with the same labelled body", async () => {
		// `applyInlineBlockerPolicy` re-renders an unmarked record from its
		// diagnostics; the re-render must equal the stored summary, label
		// included, or the turn end serves the bare `L737` again.
		const { blockerOutput, blockers, fileAbs, otherPath } =
			await dispatchEdited();
		const summary = blockerOutput.trim();
		const { body } = applyInlineBlockerPolicy(
			{ filePath: fileAbs, summary, diagnostics: blockers },
			projectRoot,
		);
		expect(body).toBe(summary);
		expect(body).toContain(`${otherPath} L737:`);
	});
});

describe("the coordinator's stored blocker summary names a cross-file blocker's file", () => {
	function mypyBlockers(): {
		fileAbs: string;
		otherPath: string;
		blockers: Diagnostic[];
	} {
		const fileAbs = path.join(projectRoot, "edited.py");
		fs.writeFileSync(fileAbs, EDITED);
		const blockers = parseMypyOutput(MYPY_OUTPUT, fileAbs, projectRoot).map(
			(d) => ({ ...d, runnerId: "mypy" }),
		);
		return { fileAbs, otherPath: path.join(projectRoot, "other.py"), blockers };
	}

	it("a deferred record's summary labels the other file's row", () => {
		const { fileAbs, otherPath, blockers } = mypyBlockers();
		const runtime = new RuntimeCoordinator();
		runtime.recordDeferredInlineBlockers(fileAbs, blockers, {
			recordedAtMs: 1,
		});
		const [record] = runtime.getInlineBlockersSnapshot();
		expect(record?.summary).toContain(`  ${otherPath} L737: [syntax]`);
		expect(record?.summary).toContain("  L2: [assignment]");
	});

	it("a narrowed record's summary keeps the label", () => {
		const { fileAbs, otherPath, blockers } = mypyBlockers();
		const runtime = new RuntimeCoordinator();
		runtime.recordDeferredInlineBlockers(fileAbs, blockers, {
			recordedAtMs: 1,
			contentBaseline: { size: EDITED.length, sha256: "bytes" },
		});
		const crossFile = blockers.filter((d) => d.filePath === otherPath);
		// The settled run still observes only the cross-file blocker, so the
		// own-file one retires and the record is rebuilt (`narrowedRecord`).
		const retired = runtime.retireUnobservedRunnerBlockers(fileAbs, {
			runnerId: "mypy",
			observed: crossFile,
			markedAtMs: 2,
			sha256: "bytes",
		});
		expect(retired).toBe(1);
		const [record] = runtime.getInlineBlockersSnapshot();
		expect(record?.summary).toContain(`  ${otherPath} L737: [syntax]`);
		expect(record?.summary).not.toContain("L2:");
	});
});

// Review r1 on #5714 (CodeRabbit and the maintainer's probe): ruff, pyright and
// spotbugs report the edited file by a project-relative path (`edited.py`),
// and the policy judges a row after resolving it against the project root. A
// label check on the raw spelling gave every such own-file row a label once
// the process cwd differed from the project root.
describe("a project-relative cited path is judged against the project root", () => {
	function ruffBlockers(filename: string): Diagnostic[] {
		return parseRuffJson(
			JSON.stringify([
				{
					code: "F821",
					message: "Undefined name `undefined_name`",
					filename,
					location: { row: 2, column: 1 },
					severity: "error",
				},
			]),
			path.join(projectRoot, "edited.py"),
		);
	}

	async function dispatchRuff(filename: string) {
		const fileAbs = path.join(projectRoot, "edited.py");
		fs.writeFileSync(fileAbs, EDITED);
		const registry = new RunnerRegistry();
		registry.register(
			createMockRunner({
				id: "ruff-lint",
				appliesTo: ["python"],
				runResult: {
					status: "failed",
					diagnostics: ruffBlockers(filename),
					semantic: "blocking",
				},
			}),
		);
		const facts = new FactStore();
		const ctx = createDispatchContext(
			fileAbs,
			projectRoot,
			{ getFlag: () => false },
			facts,
		);
		facts.setFileFact(ctx.filePath, "file.content", EDITED);
		const result = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: ["ruff-lint"] }],
			registry,
		);
		return { fileAbs, result };
	}

	it("premise: the real ruff parser keeps the relative spelling, and the process cwd is not the project root", () => {
		expect(ruffBlockers("edited.py")[0]?.filePath).toBe("edited.py");
		expect(path.resolve("edited.py")).not.toBe(
			path.join(projectRoot, "edited.py"),
		);
	});

	it("renders a project-relative own-file row with no label", async () => {
		const { result } = await dispatchRuff("edited.py");
		expect(result.blockerOutput).toContain("  L2: Undefined name");
		expect(result.blockerOutput).not.toContain("edited.py L2");
	});

	it("re-serves that record at turn end byte for byte, still unlabelled", async () => {
		const { fileAbs, result } = await dispatchRuff("edited.py");
		const summary = result.blockerOutput.trim();
		const { body } = applyInlineBlockerPolicy(
			{ filePath: fileAbs, summary, diagnostics: result.blockers },
			projectRoot,
		);
		expect(body).toBe(summary);
		expect(body).not.toContain("edited.py L2");
	});

	// The live block resolves cited paths before it renders (the cases above);
	// a late runner's record (`recordDeferredInlineBlockers`) keeps the raw
	// spelling, and the turn end re-renders those same objects.
	it("writes the coordinator's deferred record summary with no label", () => {
		const fileAbs = path.join(projectRoot, "edited.py");
		fs.writeFileSync(fileAbs, EDITED);
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = projectRoot;
		runtime.recordDeferredInlineBlockers(fileAbs, ruffBlockers("edited.py"), {
			recordedAtMs: 1,
		});
		const [record] = runtime.getInlineBlockersSnapshot();
		expect(record?.summary).toContain("  L2: Undefined name");
		expect(record?.summary).not.toContain("edited.py L2");
	});

	it("re-serves a deferred record with a relative own-file row byte for byte, unlabelled", () => {
		const fileAbs = path.join(projectRoot, "edited.py");
		fs.writeFileSync(fileAbs, EDITED);
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = projectRoot;
		runtime.recordDeferredInlineBlockers(fileAbs, ruffBlockers("edited.py"), {
			recordedAtMs: 1,
		});
		const [record] = runtime.getInlineBlockersSnapshot();
		const { body } = applyInlineBlockerPolicy(
			{
				filePath: fileAbs,
				summary: record?.summary ?? "",
				diagnostics: record?.diagnostics ?? [],
			},
			projectRoot,
		);
		expect(body).toBe(record?.summary);
		expect(body).toContain("  L2: Undefined name");
	});

	it("keeps the label on a relative row that names another file", () => {
		const fileAbs = path.join(projectRoot, "edited.py");
		fs.writeFileSync(fileAbs, EDITED);
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = projectRoot;
		runtime.recordDeferredInlineBlockers(fileAbs, ruffBlockers("other.py"), {
			recordedAtMs: 1,
		});
		const [record] = runtime.getInlineBlockersSnapshot();
		expect(record?.summary).toContain("  other.py L2: Undefined name");
	});
});
