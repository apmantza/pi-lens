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
