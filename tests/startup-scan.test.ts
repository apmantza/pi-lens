import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_STARTUP_SOURCE_FILES,
	resolveStartupScanContext,
} from "../clients/startup-scan.js";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

describe("startup scan gating", () => {
	it("skips heavy warmup when cwd is not inside a detected project", () => {
		const homeDir = makeTempDir("pi-lens-home-");
		const cwd = path.join(homeDir, "scratch");
		fs.mkdirSync(cwd, { recursive: true });

		const context = resolveStartupScanContext(cwd, { homeDir });

		expect(context.canWarmCaches).toBe(false);
		expect(context.projectRoot).toBeNull();
		expect(context.reason).toBe("no-project-root");
	});

	it("uses the nearest detected project root for startup scans", () => {
		const homeDir = makeTempDir("pi-lens-project-home-");
		const projectRoot = path.join(homeDir, "workspace", "demo");
		const nestedCwd = path.join(projectRoot, "src", "feature");
		fs.mkdirSync(nestedCwd, { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "package.json"), '{"name":"demo"}');

		const context = resolveStartupScanContext(nestedCwd, { homeDir });

		expect(context.canWarmCaches).toBe(true);
		expect(context.projectRoot).toBe(projectRoot);
		expect(context.scanRoot).toBe(projectRoot);
		expect(context.reason).toBeUndefined();
	});

	it("skips heavy warmup when the detected project exceeds the startup source budget", () => {
		const homeDir = makeTempDir("pi-lens-large-home-");
		const projectRoot = path.join(homeDir, "workspace", "huge-project");
		fs.mkdirSync(projectRoot, { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "package.json"), '{"name":"huge-project"}');

		for (let i = 0; i <= MAX_STARTUP_SOURCE_FILES; i++) {
			fs.writeFileSync(
				path.join(projectRoot, `file-${i}.ts`),
				`export const value${i} = ${i};\n`,
			);
		}

		const context = resolveStartupScanContext(projectRoot, { homeDir });

		expect(context.canWarmCaches).toBe(false);
		expect(context.projectRoot).toBe(projectRoot);
		expect(context.reason).toBe("too-many-source-files");
		expect(context.sourceFileCount).toBeGreaterThan(MAX_STARTUP_SOURCE_FILES);
	});
});
