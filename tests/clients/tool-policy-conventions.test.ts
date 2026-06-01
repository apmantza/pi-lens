import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getCachedProjectConventions,
	getLinterPolicyForCwd,
} from "../../clients/tool-policy.js";
import {
	buildProjectSnapshotFromRuntime,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

let env: { tmpDir: string; cleanup: () => void } | undefined;
let previousDataDir: string | undefined;

beforeEach(() => {
	env = setupTestEnvironment("pi-lens-tool-policy-conventions-");
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
});

afterEach(() => {
	if (previousDataDir === undefined) {
		delete process.env.PILENS_DATA_DIR;
	} else {
		process.env.PILENS_DATA_DIR = previousDataDir;
	}
	env?.cleanup();
	env = undefined;
});

function projectCwd(): string {
	if (!env) throw new Error("test env not initialised");
	const cwd = path.join(env.tmpDir, "project");
	fs.mkdirSync(cwd, { recursive: true });
	return cwd;
}

function saveSnapshotWithConventions(
	cwd: string,
	frameworks: Array<{ id: string; confidence: "high" | "medium" | "low" }>,
): void {
	const runtime = new RuntimeCoordinator();
	runtime.seedProjectSequence(1);
	const snapshot = buildProjectSnapshotFromRuntime({
		cwd,
		runtime,
		conventions: {
			frameworks: frameworks.map((f) => ({
				id: f.id,
				confidence: f.confidence,
				signals: [`fixture:${f.id}`],
			})),
			testRunners: [],
			buildTools: [],
			agentDocs: [],
		},
	});
	saveProjectSnapshot(cwd, snapshot);
}

describe("tool-policy × project-conventions wiring (Phase 3 of #118)", () => {
	it("getCachedProjectConventions returns undefined when no snapshot exists", () => {
		const cwd = projectCwd();
		expect(getCachedProjectConventions(cwd)).toBeUndefined();
	});

	it("getCachedProjectConventions reads frameworks from the saved snapshot", () => {
		const cwd = projectCwd();
		saveSnapshotWithConventions(cwd, [
			{ id: "react", confidence: "high" },
			{ id: "vite", confidence: "high" },
		]);
		const conv = getCachedProjectConventions(cwd);
		expect(conv?.frameworks.map((f) => f.id).sort()).toEqual(["react", "vite"]);
	});

	it("getLinterPolicyForCwd populates frameworkHints from the cached conventions for a JS/TS file", () => {
		const cwd = projectCwd();
		// Make the linter policy path resolve: drop a package.json so the
		// JS/TS branch returns a real policy rather than undefined.
		createTempFile(
			cwd,
			"package.json",
			JSON.stringify({ name: "fixture" }),
		);
		saveSnapshotWithConventions(cwd, [
			{ id: "react", confidence: "high" },
			{ id: "next", confidence: "high" },
		]);

		const policy = getLinterPolicyForCwd(path.join(cwd, "src", "main.tsx"), cwd);
		expect(policy).toBeDefined();
		expect(policy?.frameworkHints?.sort()).toEqual(["next", "react"]);
	});

	it("leaves frameworkHints undefined when no snapshot exists, even when the policy resolves", () => {
		const cwd = projectCwd();
		createTempFile(
			cwd,
			"package.json",
			JSON.stringify({ name: "fixture" }),
		);
		const policy = getLinterPolicyForCwd(path.join(cwd, "src", "main.tsx"), cwd);
		expect(policy).toBeDefined();
		expect(policy?.frameworkHints).toBeUndefined();
	});

	it("leaves frameworkHints undefined when the snapshot has no detected frameworks", () => {
		const cwd = projectCwd();
		createTempFile(
			cwd,
			"package.json",
			JSON.stringify({ name: "fixture" }),
		);
		saveSnapshotWithConventions(cwd, []);
		const policy = getLinterPolicyForCwd(path.join(cwd, "src", "main.tsx"), cwd);
		expect(policy).toBeDefined();
		expect(policy?.frameworkHints).toBeUndefined();
	});
});
