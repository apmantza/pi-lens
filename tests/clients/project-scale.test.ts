import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PROJECT_SCALE_BASE,
	PROJECT_SCALE_RATIOS,
	REVIEW_GRAPH_HARD_CEILING,
	REVIEW_GRAPH_LINEAR_CEILING_BASE,
	REVIEW_GRAPH_TAPER_SCALE,
	_resetProjectScaleBaseForTests,
	deriveBudget,
	getJscpdMaxEntriesDerived,
	getProjectDiagnosticsScannerMaxFiles,
	getProjectScaleBase,
	getReviewGraphMaxFilesDerived,
	getStartupScanMaxSourceFilesDerived,
	getWordIndexMaxFilesDerived,
	taperedReviewGraphMaxFiles,
} from "../../clients/project-scale.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { removeTempDirSync } from "./test-utils.js";

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
	removeTempDirSync(tmpDir);
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
		expect(deriveBudget(PROJECT_SCALE_RATIOS.projectDiagnosticsScanner)).toBe(
			500,
		);
		expect(getProjectDiagnosticsScannerMaxFiles()).toBe(500);
	});

	it("review graph: 0.5x2000 = 1000", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.reviewGraph)).toBe(1000);
		expect(getReviewGraphMaxFilesDerived()).toBe(1000);
	});

	it("startup scan: 1.25x2000 = 2500", () => {
		expect(deriveBudget(PROJECT_SCALE_RATIOS.startupScan)).toBe(2500);
		expect(getStartupScanMaxSourceFilesDerived()).toBe(2500);
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
		expect(getStartupScanMaxSourceFilesDerived(tmpDir)).toBe(5000);
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

describe("taperedReviewGraphMaxFiles (#775 R1)", () => {
	it("matches the flat 0.5x ratio below the linear boundary", () => {
		expect(taperedReviewGraphMaxFiles(2_000)).toBe(1_000);
		expect(taperedReviewGraphMaxFiles(1)).toBe(1); // floors at 1, never 0
	});

	it("matches the flat 0.5x ratio exactly AT the linear boundary", () => {
		expect(taperedReviewGraphMaxFiles(REVIEW_GRAPH_LINEAR_CEILING_BASE)).toBe(
			REVIEW_GRAPH_LINEAR_CEILING_BASE * PROJECT_SCALE_RATIOS.reviewGraph,
		);
	});

	it("tapers (grows sublinearly, not a cliff) just above the linear boundary", () => {
		const boundaryValue =
			REVIEW_GRAPH_LINEAR_CEILING_BASE * PROJECT_SCALE_RATIOS.reviewGraph;
		const justAboveBase = REVIEW_GRAPH_LINEAR_CEILING_BASE + 100;
		const justAbove = taperedReviewGraphMaxFiles(justAboveBase);
		const flatRatioValue = justAboveBase * PROJECT_SCALE_RATIOS.reviewGraph;
		// Not a cliff: still >= the boundary value, growth continues.
		expect(justAbove).toBeGreaterThanOrEqual(boundaryValue);
		// Not linear either: far below what the flat 0.5x ratio would give.
		expect(justAbove).toBeLessThan(flatRatioValue);
	});

	it("closes exactly half the remaining gap to the ceiling at base = boundary + taper scale", () => {
		const boundaryValue =
			REVIEW_GRAPH_LINEAR_CEILING_BASE * PROJECT_SCALE_RATIOS.reviewGraph;
		const halfwayBase =
			REVIEW_GRAPH_LINEAR_CEILING_BASE + REVIEW_GRAPH_TAPER_SCALE;
		const expectedHalfway =
			boundaryValue + (REVIEW_GRAPH_HARD_CEILING - boundaryValue) / 2;
		expect(taperedReviewGraphMaxFiles(halfwayBase)).toBe(
			Math.round(expectedHalfway),
		);
	});

	it("approaches but never reaches or exceeds the hard ceiling", () => {
		const veryLarge = taperedReviewGraphMaxFiles(10_000_000);
		expect(veryLarge).toBeLessThan(REVIEW_GRAPH_HARD_CEILING);
		expect(veryLarge).toBeGreaterThan(REVIEW_GRAPH_HARD_CEILING - 5);
	});

	it("is monotonically non-decreasing as the base grows", () => {
		const bases = [
			1, 500, 2_000, 4_000, 4_001, 6_000, 12_000, 50_000, 1_000_000,
		];
		let previous = 0;
		for (const base of bases) {
			const value = taperedReviewGraphMaxFiles(base);
			expect(value).toBeGreaterThanOrEqual(previous);
			previous = value;
		}
	});
});

describe("getReviewGraphMaxFilesDerived config override (#775 R2)", () => {
	it("a .pi-lens.json reviewGraph.maxFiles override beats the taper", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ reviewGraph: { maxFiles: 15_000 } }),
		);
		expect(getReviewGraphMaxFilesDerived(tmpDir)).toBe(15_000);
	});

	it("does not affect callers that pass no cwd", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ reviewGraph: { maxFiles: 15_000 } }),
		);
		expect(getReviewGraphMaxFilesDerived()).toBe(1_000);
	});

	it("falls back to the taper when reviewGraph is absent", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ maxProjectFiles: 4_000 }),
		);
		expect(getReviewGraphMaxFilesDerived(tmpDir)).toBe(2_000);
	});
});
