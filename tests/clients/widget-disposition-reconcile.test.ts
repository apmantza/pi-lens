import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__testing,
	admitWidgetDiagnosticsWrite,
	clearWidgetState,
	getFileDiagnostics,
	reconcileWidgetDisposition,
	recordDiagnostics,
	renderWidget,
	wireWidgetDispositionSubscriber,
} from "../../clients/widget-state.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	markDisposition,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import {
	_resetDispositionPublishForTests,
	wireDispositionBusEmitter,
	type PilensDispositionPayload,
} from "../../clients/disposition-publish.js";
import { setupTestEnvironment } from "./test-utils.js";

const content = "const bad = true;\n";
const targetBase = {
	tool: "eslint",
	rule: "no-constant-condition",
	message: "Unexpected constant condition",
	line: 1,
};
const theme = { fg: (_color: string, value: string) => value };

let tempHome: string;
let filePath: string;
let testEnvironment: ReturnType<typeof setupTestEnvironment>;

beforeEach(() => {
	testEnvironment = setupTestEnvironment("pi-lens-1616-");
	tempHome = testEnvironment.tmpDir;
	process.env.PI_LENS_HOME = tempHome;
	filePath = path.join(tempHome, "fixture.ts");
	fs.writeFileSync(filePath, content);
	process.env.PI_LENS_BUS_PUBLISH = "1";
	clearWidgetState();
	_resetStateCacheForTests();
	_resetDispositionPublishForTests();
	resetDegradationLedger();
});

afterEach(() => {
	clearWidgetState();
	_resetStateCacheForTests();
	_resetDispositionPublishForTests();
	resetDegradationLedger();
	delete process.env.PI_LENS_HOME;
	delete process.env.PI_LENS_BUS_PUBLISH;
	try {
		fs.unlinkSync(filePath);
	} catch {}
	testEnvironment.cleanup();
});

function recordFinding(): void {
	recordDiagnostics(filePath, [
		{
			...targetBase,
			severity: "error",
		},
	]);
}

function recordBlockingFinding(): void {
	recordDiagnostics(filePath, [
		{
			...targetBase,
			severity: "error",
			semantic: "blocking",
		},
	]);
}

describe("widget disposition reconciliation (#1616)", () => {
	it("keeps a blocking error counted when only a weak suppress mark exists", () => {
		// Prevents #1616's weak suppress anchor from hiding a blocking finding.
		recordBlockingFinding();
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"suppress",
		);

		expect(__testing.getWidgetStateSnapshot().files[0]).toMatchObject({
			blocking: 1,
			errors: 1,
		});
		expect(getFileDiagnostics(filePath)).toEqual([
			expect.not.objectContaining({ disposition: "suppress" }),
		]);
	});

	it("marks false-positive findings suppressed immediately, with a visible bucket", () => {
		recordFinding();
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);

		const snapshot = __testing.getWidgetStateSnapshot();
		const diagnostic = getFileDiagnostics(filePath);
		expect(snapshot.files[0]).toMatchObject({ blocking: 0, errors: 0 });
		expect(diagnostic).toEqual([
			expect.objectContaining({ disposition: "false-positive" }),
		]);
		expect(renderWidget(100, theme).join("\n")).toContain("suppressed: 1");
	});

	it("keeps counts and annotates flagged findings", () => {
		recordFinding();
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"flagged",
		);

		expect(__testing.getWidgetStateSnapshot().files[0]).toMatchObject({
			blocking: 1,
			errors: 1,
		});
		expect(getFileDiagnostics(filePath)).toEqual([
			expect.objectContaining({ flagged: true }),
		]);
	});

	it("restores counts when changed content removes the strict mark", () => {
		recordFinding();
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);
		fs.writeFileSync(filePath, "const bad = false;\n");
		recordFinding();

		expect(__testing.getWidgetStateSnapshot().files[0]).toMatchObject({
			blocking: 1,
			errors: 1,
		});
	});

	it("host consumes the published disposition event", () => {
		recordFinding();
		let published: PilensDispositionPayload | undefined;
		wireDispositionBusEmitter((_channel, data) => {
			published = data as PilensDispositionPayload;
		});
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);
		clearWidgetState();
		recordFinding();
		let subscribe!: (data: unknown) => void;
		wireWidgetDispositionSubscriber({
			events: { on: (_channel, handler) => ((subscribe = handler), () => {}) },
		});
		subscribe(published);

		expect(__testing.getWidgetStateSnapshot().files[0]).toMatchObject({
			blocking: 0,
			errors: 0,
		});
	});

	it("records an absent widget record once per file", () => {
		reconcileWidgetDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);
		reconcileWidgetDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);

		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "widget-disposition-reconcile-fallback",
				count: 1,
				latestReasons: [
					expect.objectContaining({
						subject: filePath,
						reason: "the marked finding's widget record is absent",
					}),
				],
			}),
		]);
	});

	it("marks during an in-flight dispatch and rejects the stale completion", async () => {
		// Prevents #1616's older dispatch completion from restoring stale counts.
		recordFinding();
		admitWidgetDiagnosticsWrite(filePath, 1);

		const staleCompletion = Promise.resolve().then(() =>
			recordDiagnostics(filePath, [{ ...targetBase, severity: "error" }], 1),
		);
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);
		await staleCompletion;

		expect(__testing.getWidgetStateSnapshot().files[0]).toMatchObject({
			blocking: 0,
			errors: 0,
		});
		expect(getFileDiagnostics(filePath)).toEqual([
			expect.objectContaining({ disposition: "false-positive" }),
		]);
	});

	it("coalesces two marks in one tick without regressing the latest mark", () => {
		recordFinding();
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);

		expect(__testing.getWidgetStateSnapshot().files[0]).toMatchObject({
			blocking: 0,
			errors: 0,
		});
		expect(getFileDiagnostics(filePath)).toEqual([
			expect.objectContaining({ disposition: "false-positive" }),
		]);
	});

	it("allows an unrelated later producer to publish its own snapshot", () => {
		recordFinding();
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);
		recordDiagnostics(filePath, [], 2);

		expect(__testing.getWidgetStateSnapshot().files[0]).toMatchObject({
			blocking: 0,
			errors: 0,
		});
		expect(getFileDiagnostics(filePath)).toEqual([]);
	});

	it("rejects a host disposition event with a non-string message", () => {
		// Prevents host payload drift from turning an invalid message into a mark.
		recordFinding();
		markDisposition(
			process.cwd(),
			{ ...targetBase, cwd: process.cwd(), filePath, content },
			"false-positive",
		);
		clearWidgetState();
		recordFinding();
		let subscribe!: (data: unknown) => void;
		wireWidgetDispositionSubscriber({
			events: { on: (_channel, handler) => ((subscribe = handler), () => {}) },
		});
		subscribe({
			source: "pi-lens",
			cwd: process.cwd(),
			filePath,
			disposition: "false-positive",
			message: 42,
			tool: targetBase.tool,
			rule: targetBase.rule,
			line: targetBase.line,
		});

		expect(getFileDiagnostics(filePath)).toEqual([
			expect.not.objectContaining({ disposition: "false-positive" }),
		]);
	});
});
