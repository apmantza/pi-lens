import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PROJECT_SCALE_BASE,
	PROJECT_SCALE_RATIOS,
	_resetProjectScaleBaseForTests,
	deriveBudget,
	getJscpdMaxEntriesDerived,
	getProjectDiagnosticsScannerMaxFiles,
	getProjectScaleBase,
	getReviewGraphMaxFilesDerived,
	getStartupScanMaxSourceFilesDerived,
	getWordIndexMaxFilesDerived,
} from "../../clients/project-scale.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

const ENV_NAME = "PI_LENS_MAX_PROJECT_FILES";

let tmpDir: string;
let previousEnv: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-scale-"));
	previousEnv = process.env[ENV_NAME];
	delete process.env[ENV_NAME];
	_resetProjectScaleBaseForTests();
	resetProjectLensConfigCache();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	if (previousEnv === undefined) delete process.env[ENV_NAME];
	else process.env[ENV_NAME] = previousEnv;
	_resetProjectScaleBaseForTests();
	resetProjectLensConfigCache();
});

describe("getProjectScaleBase", () => {
	it("defaults to DEFAULT_PROJECT_SCALE_BASE when nothing is configured", () => {
		expect(getProjectScaleBase()).toBe(DEFAULT_PROJECT_SCALE_BASE);
		expect(getProjectScaleBase(tmpDir)).toBe(DEFAULT_PROJECT_SCALE_BASE);
	});

	it("honours PI_LENS_MAX_PROJECT_FILES when no cwd/config is given", () => {
		process.env[ENV_NAME] = "9000";
		expect(getProjectScaleBase()).toBe(9000);
	});

	it("honours PI_LENS_MAX_PROJECT_FILES when a cwd has no .pi-lens.json", () => {
		process.env[ENV_NAME] = "9000";
		expect(getProjectScaleBase(tmpDir)).toBe(9000);
	});

	it("a .pi-lens.json maxProjectFiles override beats PI_LENS_MAX_PROJECT_FILES", () => {
		process.env[ENV_NAME] = "9000";
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ maxProjectFiles: 5000 }),
		);
		expect(getProjectScaleBase(tmpDir)).toBe(5000);
	});

	it("falls back to the env/default chain when maxProjectFiles is invalid", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ maxProjectFiles: -5 }),
		);
		expect(getProjectScaleBase(tmpDir)).toBe(DEFAULT_PROJECT_SCALE_BASE);
	});
});

describe("deriveBudget / ratio table reproduces today's five defaults", () => {
	it("project-diagnostics scanner: 0.25x2000 = 500", () => {
		expect(
			deriveBudget(PROJECT_SCALE_RATIOS.projectDiagnosticsScanner),
		).toBe(500);
		expect(getProjectDiagnosticsScannerMaxFiles()).toBe(500);
	});

	it("review graph: 0.5x2000 = 1000", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.reviewGraph)).toBe(1000);
		expect(getReviewGraphMaxFilesDerived()).toBe(1000);
	});

	it("startup scan: 1x2000 = 2000", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.startupScan)).toBe(2000);
		expect(getStartupScanMaxSourceFilesDerived()).toBe(2000);
	});

	it("jscpd: 3x2000 = 6000", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.jscpd)).toBe(6000);
		expect(getJscpdMaxEntriesDerived()).toBe(6000);
	});

	it("word index: 3x2000 = 6000", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.wordIndex)).toBe(6000);
		expect(getWordIndexMaxFilesDerived()).toBe(6000);
	});
});

describe("a .pi-lens.json maxProjectFiles override scales all five derived budgets", () => {
	beforeEach(() => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ maxProjectFiles: 4000 }),
		);
	});

	it("scales every subsystem's derived budget proportionally", () => {
		expect(getProjectDiagnosticsScannerMaxFiles(tmpDir)).toBe(1000);
		expect(getReviewGraphMaxFilesDerived(tmpDir)).toBe(2000);
		expect(getStartupScanMaxSourceFilesDerived(tmpDir)).toBe(4000);
		expect(getJscpdMaxEntriesDerived(tmpDir)).toBe(12000);
		expect(getWordIndexMaxFilesDerived(tmpDir)).toBe(12000);
	});

	it("does not affect callers that pass no cwd", () => {
		expect(getProjectDiagnosticsScannerMaxFiles()).toBe(500);
	});
});

describe("deriveBudget floors", () => {
	it("never returns less than 1, even at a tiny base", () => {
		process.env[ENV_NAME] = "1";
		expect(deriveBudget(PROJECT_SCALE_RATIOS.projectDiagnosticsScanner)).toBe(
			1,
		);
	});
});
