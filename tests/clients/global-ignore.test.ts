/**
 * Global ignore patterns in ~/.pi-lens/config.json (#252).
 *
 * Follow-up to #243: excludes configurable once, applied across all projects.
 * Precedence (lowest → highest): global config → project .gitignore → project
 * .pi-lens.json. A project `!negation` must be able to re-include a path the
 * global config excluded.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectIgnoreMatcher } from "../../clients/file-utils.js";
import {
	getGlobalIgnorePatterns,
	loadPiLensGlobalConfig,
} from "../../clients/lens-config.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";

let tmpDir: string;
let projectRoot: string;
let globalConfigPath: string;
let previousConfigPath: string | undefined;

function writeGlobalConfig(obj: unknown): void {
	fs.writeFileSync(globalConfigPath, JSON.stringify(obj));
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-global-ignore-"));
	projectRoot = path.join(tmpDir, "project");
	fs.mkdirSync(projectRoot, { recursive: true });
	globalConfigPath = path.join(tmpDir, "global-config.json");
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	process.env.PI_LENS_CONFIG_PATH = globalConfigPath;
	resetProjectLensConfigCache();
});

afterEach(() => {
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	fs.rmSync(tmpDir, { recursive: true, force: true });
	resetProjectLensConfigCache();
});

const p = (rel: string) => path.join(projectRoot, rel);

describe("global ignore config parsing (#252)", () => {
	it("reads a string[] ignore from the global config", () => {
		writeGlobalConfig({ ignore: ["*.snap", "scratch/**"] });
		expect(getGlobalIgnorePatterns()).toEqual(["*.snap", "scratch/**"]);
		expect(loadPiLensGlobalConfig()?.ignore).toEqual(["*.snap", "scratch/**"]);
	});

	it("ignores non-string entries and a non-array ignore", () => {
		writeGlobalConfig({ ignore: ["ok.ts", 42, null, "fine/**"] });
		expect(getGlobalIgnorePatterns()).toEqual(["ok.ts", "fine/**"]);

		writeGlobalConfig({ ignore: "not-an-array" });
		expect(getGlobalIgnorePatterns()).toEqual([]);
	});

	it("returns [] when the global config is absent", () => {
		expect(getGlobalIgnorePatterns()).toEqual([]);
	});
});

describe("global ignore applied via getProjectIgnoreMatcher (#252)", () => {
	it("suppresses files matching global patterns", () => {
		writeGlobalConfig({ ignore: ["*.snap", "scratch/**"] });
		const m = getProjectIgnoreMatcher(projectRoot);
		expect(m.isIgnored(p("a.snap"), false)).toBe(true);
		expect(m.isIgnored(p("scratch/x.ts"), false)).toBe(true);
		expect(m.isIgnored(p("src/a.ts"), false)).toBe(false);
	});

	it("lets a project .pi-lens.json negation re-include a globally-ignored path", () => {
		writeGlobalConfig({ ignore: ["fixtures/**"] });
		fs.writeFileSync(
			p(".pi-lens.json"),
			JSON.stringify({ ignore: ["!fixtures/keep.ts"] }),
		);
		const m = getProjectIgnoreMatcher(projectRoot);
		expect(m.isIgnored(p("fixtures/noise.ts"), false)).toBe(true);
		expect(m.isIgnored(p("fixtures/keep.ts"), false)).toBe(false);
	});

	it("honors global + .gitignore + .pi-lens.json together", () => {
		writeGlobalConfig({ ignore: ["from-global/**"] });
		fs.writeFileSync(p(".gitignore"), "from-git/\n");
		fs.writeFileSync(
			p(".pi-lens.json"),
			JSON.stringify({ ignore: ["from-project/**"] }),
		);
		const m = getProjectIgnoreMatcher(projectRoot);
		expect(m.isIgnored(p("from-global/x.ts"), false)).toBe(true);
		expect(m.isIgnored(p("from-git/x.ts"), false)).toBe(true);
		expect(m.isIgnored(p("from-project/x.ts"), false)).toBe(true);
		expect(m.isIgnored(p("src/x.ts"), false)).toBe(false);
	});

	it("invalidates the matcher cache when the global config changes", async () => {
		writeGlobalConfig({ ignore: ["first/**"] });
		const before = getProjectIgnoreMatcher(projectRoot);
		expect(before.isIgnored(p("first/x.ts"), false)).toBe(true);
		expect(before.isIgnored(p("second/x.ts"), false)).toBe(false);

		await new Promise((r) => setTimeout(r, 20));
		writeGlobalConfig({ ignore: ["second/**"] });

		const after = getProjectIgnoreMatcher(projectRoot);
		expect(after.isIgnored(p("first/x.ts"), false)).toBe(false);
		expect(after.isIgnored(p("second/x.ts"), false)).toBe(true);
	});

	it("a project that ignores nothing still inherits global patterns", () => {
		writeGlobalConfig({ ignore: ["globally-hidden/**"] });
		const m = getProjectIgnoreMatcher(projectRoot);
		expect(m.isIgnored(p("globally-hidden/x.ts"), false)).toBe(true);
	});
});
