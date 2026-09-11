import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__testing,
	clearWidgetState,
	getFileDiagnostics,
	recordDiagnostics,
	renderWidget,
	wireWidgetDispositionSubscriber,
} from "../../clients/widget-state.js";
import {
	markDisposition,
	_resetStateCacheForTests,
} from "../../clients/diagnostic-dispositions.js";
import {
	_resetDispositionPublishForTests,
	wireDispositionBusEmitter,
	type PilensDispositionPayload,
} from "../../clients/disposition-publish.js";

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

beforeEach(() => {
	tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1616-"));
	process.env.PI_LENS_HOME = tempHome;
	filePath = path.join(os.tmpdir(), `pi-lens-1616-${process.pid}.ts`);
	fs.writeFileSync(filePath, content);
	process.env.PI_LENS_BUS_PUBLISH = "1";
	clearWidgetState();
	_resetStateCacheForTests();
	_resetDispositionPublishForTests();
});

afterEach(() => {
	clearWidgetState();
	_resetStateCacheForTests();
	_resetDispositionPublishForTests();
	delete process.env.PI_LENS_HOME;
	delete process.env.PI_LENS_BUS_PUBLISH;
	try {
		fs.unlinkSync(filePath);
	} catch {}
});

function recordFinding(): void {
	recordDiagnostics(filePath, [
		{
			...targetBase,
			severity: "error",
		},
	]);
}

describe("widget disposition reconciliation (#1616)", () => {
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
});
