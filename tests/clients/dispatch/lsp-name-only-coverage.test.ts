/**
 * A file of an LSP-capable kind that no language server's file matcher selects
 * is not applicable to the LSP lane (#5235 review F1), not "analysis
 * unavailable": nothing is missing, nothing failed, and no install can cure
 * it. A file a server DOES select, but whose server is not installed, still
 * carries the warning.
 *
 * Drives the production path: the real `dispatchLint` over the session's
 * default runner registry and the real server table, on real files in a
 * project dir. No runner is replaced.
 *
 * Recurrence this guards (PR #5238 review r1 F1): the groovy kind named
 * `Jenkinsfile`, `build.gradle` and `settings.gradle`, but `GroovyServer` lists
 * extensions only, so every write to them printed "Pi-lens groovy analysis
 * unavailable ... (not a clean result)" for a lane that could never run.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearCoverageNoticeState,
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { dispatchLint } from "../../../clients/dispatch/integration.js";
import {
	getServersForFileWithConfig,
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import type { RunnerResult } from "../../../clients/dispatch/types.js";
import { removeTempDirSync } from "../test-utils.js";

const UNAVAILABLE = "analysis unavailable";

let tmpDir: string;
let previousHome: string | undefined;
let previousPath: string | undefined;

async function writeAndDispatch(name: string, body: string): Promise<string> {
	const file = path.join(tmpDir, name);
	fs.writeFileSync(file, body);
	clearCoverageNoticeState();
	return dispatchLint(
		file,
		tmpDir,
		{ getFlag: () => false } as never,
		undefined,
		tmpDir,
	);
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-name-only-")),
	);
	// Empty home and an empty PATH: no managed or ambient language server can
	// exist, so the "server not installed" arm is the same on every machine.
	previousHome = process.env.PI_LENS_HOME;
	previousPath = process.env.PATH;
	process.env.PI_LENS_HOME = path.join(tmpDir, ".pi-lens");
	const emptyBin = path.join(tmpDir, "empty-bin");
	fs.mkdirSync(emptyBin);
	process.env.PATH = emptyBin;
});

afterEach(() => {
	process.env.PATH = previousPath;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	resetLSPConfigStateForTests();
	resetProjectLensConfigCache();
	resetProjectTrust();
	removeTempDirSync(tmpDir);
});

describe("a name no language server selects is not 'analysis unavailable'", () => {
	it("keeps the groovy build and pipeline names off the warning", async () => {
		for (const name of ["Jenkinsfile", "build.gradle", "settings.gradle"]) {
			// Premise: the kind reaches the LSP lane, and no server selects the name.
			expect(getServersForFileWithConfig(path.join(tmpDir, name))).toEqual([]);
			const output = await writeAndDispatch(name, "plugins { id 'java' }\n");
			expect(output, name).not.toContain(UNAVAILABLE);
			expect(output, name).not.toContain("not a clean result");
		}
	});

	it("still names an operator's lsp.disabledServers denial, not 'nothing to check'", async () => {
		// Recurrence this guards: the not-applicable skip rides the branch that
		// also reports a disabled primary (#4403). A skipReason set beside the
		// disabled cause would silence the denial's own notice.
		setProjectTrustState("trusted");
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ lsp: { disabledServers: ["groovy"] } }),
		);
		resetProjectLensConfigCache();
		await initLSPConfig(tmpDir);
		const output = await writeAndDispatch("A.groovy", "class A {}\n");
		expect(output).toContain("Primary LSP (groovy) is disabled in config");
	});

	it("still warns for a .groovy file whose server is not installed", async () => {
		// Negative control: a server DOES select the extension, so the lane is
		// applicable and its absence is a real coverage gap the notice must name.
		expect(
			getServersForFileWithConfig(path.join(tmpDir, "A.groovy")).map(
				(s) => s.id,
			),
		).toEqual(["groovy"]);
		const output = await writeAndDispatch("A.groovy", "class A {}\n");
		expect(output).toContain("Pi-lens groovy analysis unavailable");
	});
});

// The quiet answer belongs to the language server's own "no server selects
// this file", not to any runner that says `no-files-matched`. Recurrence this
// guards: oxlint states the same reason when a config IGNORES the file, which
// is an unchecked file and must keep its notice. A primary group is
// `["lsp", "dotnet-build"]` for csharp; the second runner stands for any
// non-lsp runner of a primary group.
describe("only the lsp runner's no-files-matched silences the notice", () => {
	const NOT_APPLICABLE: RunnerResult = {
		status: "skipped",
		diagnostics: [],
		semantic: "none",
		skipReason: "no-files-matched",
	};
	const BARE_SKIP: RunnerResult = {
		status: "skipped",
		diagnostics: [],
		semantic: "none",
	};

	async function dispatchCsharp(
		rows: ReadonlyArray<readonly [string, RunnerResult]>,
	) {
		const registry = new RunnerRegistry();
		for (const [id, result] of rows) {
			registry.register({
				id,
				appliesTo: ["csharp"],
				priority: 10,
				async run() {
					return result;
				},
			});
		}
		const file = path.join(tmpDir, "Program.cs");
		fs.writeFileSync(file, "class P {}\n");
		const ctx = createDispatchContext(
			file,
			tmpDir,
			{ getFlag: () => false },
			new FactStore(),
			false,
		);
		clearCoverageNoticeState();
		return dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: rows.map(([id]) => id) }],
			registry,
			undefined,
			{ dedupeCoverageNotice: false },
		);
	}

	it("stays quiet when the lsp row is the only primary row that ran", async () => {
		const result = await dispatchCsharp([["lsp", NOT_APPLICABLE]]);
		expect(result.output).not.toContain(UNAVAILABLE);
		expect(result.unconfirmedStatus).toBeUndefined();
	});

	it("keeps the notice when a non-lsp primary runner also states no-files-matched", async () => {
		const result = await dispatchCsharp([
			["lsp", NOT_APPLICABLE],
			["dotnet-build", NOT_APPLICABLE],
		]);
		expect(result.output).toContain(UNAVAILABLE);
	});

	it("keeps the notice when a sibling primary runner skipped without a reason", async () => {
		const result = await dispatchCsharp([
			["lsp", NOT_APPLICABLE],
			["dotnet-build", BARE_SKIP],
		]);
		expect(result.output).toContain(UNAVAILABLE);
	});
});
