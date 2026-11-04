/**
 * #4689 item 9, read back through the REAL latency sink (#4957 review F7).
 *
 * `tests/clients/runtime-tool-result.test.ts` mocks `latency-logger.js` for the
 * whole file, so its item 9 case proves the call, not the row. This file does
 * not mock the logger: it flushes the sink and reads `latency.log` through
 * `readNdjsonRows`.
 *
 * Recurrence it prevents: `deferred_format_queued` was written for an adopted
 * project's edit, which `deferMutation` refuses and queues nothing for; the
 * latency log then read as a queue entry that never existed. Nothing is
 * mocked: the files are `.txt`, which no runner claims, so the real pipeline
 * runs without a child process. `PI_LENS_TEST_MODE=0` makes the phase rows
 * real for the one call, as the index witnesses do.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, expect, it } from "vitest";

import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

beforeEach(async () => {
	await installLspServiceDouble({});
});

async function editRows(runtime: RuntimeCoordinator, filePath: string) {
	const previous = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	try {
		await handleToolResult({
			event: { toolName: "edit", input: { path: filePath }, content: [] },
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: { addModifiedRange: () => {}, readTurnState: () => ({}) },
			biomeClient: {},
			ruffClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as never);
	} finally {
		if (previous === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previous;
	}
	await flushLatencyLog();
	const read = readNdjsonRows<{ phase?: string; filePath?: string }>(
		getLatencyLogPath(),
	);
	expect(read.skipped).toBe(0);
	// The log is shared by earlier cases: keep this file's own rows, by the
	// unique name of the directory it was written under.
	const own = path.basename(path.dirname(filePath));
	return read.rows.filter(
		(row) =>
			row.phase === "deferred_format_queued" &&
			(row.filePath ?? "").includes(own),
	);
}

it("writes deferred_format_queued to latency.log for a session file and not for an adopted one", async () => {
	const env = setupTestEnvironment("pi-lens-4689-queued-sink-");
	// A direct child of the temp root with no `pi-lens-` prefix, so the foreign
	// project reads `adopted` and not the pi-owned `none` (#4560).
	const adopted = path.join(
		path.dirname(env.tmpDir),
		`capture-4689-sink-adopted-${process.pid}`,
	);
	try {
		fs.mkdirSync(adopted, { recursive: true });
		fs.writeFileSync(path.join(adopted, "package.json"), "{}\n");
		const sessionFile = createTempFile(env.tmpDir, "in.txt", "let a = 1;\n");
		const adoptedFile = createTempFile(adopted, "out.txt", "let b = 1;\n");
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = env.tmpDir;

		const sessionRows = await editRows(runtime, sessionFile);
		expect(sessionRows).toHaveLength(1);
		expect(sessionRows[0].filePath).toContain("in.txt");

		expect(await editRows(runtime, adoptedFile)).toEqual([]);
	} finally {
		fs.rmSync(adopted, { recursive: true, force: true });
		env.cleanup();
	}
});
