/**
 * #253 — startup-scan must reject a project marker resolved at $HOME OR at an
 * ancestor of it. The old exact `=== homeDir` check only caught $HOME itself,
 * so a marker found ABOVE home (e.g. a stray .git in /home or C:\Users) would
 * root the warmup walk above the user's workspace — the #250 runaway.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	resolveStartupScanContext,
	resolveStartupScanContextAsync,
} from "../../clients/startup-scan.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-home-ceiling-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveStartupScanContext home ceiling (#253)", () => {
	it("refuses to warm when the nearest marker is ABOVE the home dir", () => {
		// ancestor/.git  (marker)  >  ancestor/home  (fake HOME)  >  …/proj (cwd)
		const ancestor = path.join(tmpDir, "ancestor");
		const home = path.join(ancestor, "home");
		const cwd = path.join(home, "proj");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(path.join(ancestor, ".git"), { recursive: true });

		const ctx = resolveStartupScanContext(cwd, { homeDir: home });
		expect(ctx.canWarmCaches).toBe(false);
		expect(ctx.reason).toBe("home-dir");
		// And it must NOT have walked the above-home tree to count files.
		expect(ctx.projectRoot).toBe(path.resolve(ancestor));
	});

	it("refuses to warm when the marker is AT the home dir", () => {
		const home = path.join(tmpDir, "home");
		const cwd = path.join(home, "proj");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(path.join(home, ".git"), { recursive: true });

		const ctx = resolveStartupScanContext(cwd, { homeDir: home });
		expect(ctx.canWarmCaches).toBe(false);
		expect(ctx.reason).toBe("home-dir");
	});

	it("still warms a normal project UNDER home", () => {
		const home = path.join(tmpDir, "home");
		const proj = path.join(home, "code", "app");
		fs.mkdirSync(proj, { recursive: true });
		fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
		fs.writeFileSync(path.join(proj, "index.ts"), "export const x = 1;\n");

		const ctx = resolveStartupScanContext(proj, { homeDir: home });
		expect(ctx.canWarmCaches).toBe(true);
		expect(ctx.projectRoot).toBe(path.resolve(proj));
	});
});

describe("resolveStartupScanContextAsync home ceiling (#296)", () => {
	it("refuses to warm when the nearest marker is ABOVE the home dir", async () => {
		const ancestor = path.join(tmpDir, "async-ancestor");
		const home = path.join(ancestor, "home");
		const cwd = path.join(home, "empty-folder");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(path.join(ancestor, ".git"), { recursive: true });

		const ctx = await resolveStartupScanContextAsync(cwd, { homeDir: home });
		expect(ctx.canWarmCaches).toBe(false);
		expect(ctx.reason).toBe("home-dir");
		expect(ctx.projectRoot).toBe(path.resolve(ancestor));
	});

	it("refuses to warm when the marker is AT the home dir", async () => {
		const home = path.join(tmpDir, "async-marker-home");
		const cwd = path.join(home, "empty-folder");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(path.join(home, ".git"), { recursive: true });

		const ctx = await resolveStartupScanContextAsync(cwd, { homeDir: home });
		expect(ctx.canWarmCaches).toBe(false);
		expect(ctx.reason).toBe("home-dir");
		expect(ctx.projectRoot).toBe(path.resolve(home));
	});

	it("refuses to warm when the cwd itself is ABOVE the home dir", async () => {
		const ancestor = path.join(tmpDir, "async-cwd-ancestor");
		const home = path.join(ancestor, "home");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(path.join(ancestor, ".git"), { recursive: true });

		const ctx = await resolveStartupScanContextAsync(ancestor, {
			homeDir: home,
		});
		expect(ctx.canWarmCaches).toBe(false);
		expect(ctx.reason).toBe("home-dir");
		expect(ctx.projectRoot).toBe(path.resolve(ancestor));
		expect(ctx.sourceFileCount).toBeUndefined();
	});

	it("returns home-dir for an above-home cwd even with no project marker", async () => {
		const ancestor = path.join(tmpDir, "async-no-marker-ancestor");
		const home = path.join(ancestor, "home");
		fs.mkdirSync(home, { recursive: true });

		const ctx = await resolveStartupScanContextAsync(ancestor, {
			homeDir: home,
		});
		expect(ctx.canWarmCaches).toBe(false);
		expect(ctx.reason).toBe("home-dir");
		expect(ctx.sourceFileCount).toBeUndefined();
	});

	it("returns too-many-source-files for a normal project over the limit", async () => {
		const home = path.join(tmpDir, "async-large-home");
		const proj = path.join(home, "code", "large-app");
		fs.mkdirSync(proj, { recursive: true });
		fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
		fs.writeFileSync(path.join(proj, "a.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(proj, "b.ts"), "export const b = 1;\n");

		const ctx = await resolveStartupScanContextAsync(proj, {
			homeDir: home,
			maxSourceFiles: 1,
		});
		expect(ctx.canWarmCaches).toBe(false);
		expect(ctx.reason).toBe("too-many-source-files");
		expect(ctx.projectRoot).toBe(path.resolve(proj));
		expect(ctx.sourceFileCount).toBe(2);
	});

	it("still warms a normal project UNDER home", async () => {
		const home = path.join(tmpDir, "async-home");
		const proj = path.join(home, "code", "app");
		fs.mkdirSync(proj, { recursive: true });
		fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
		fs.writeFileSync(path.join(proj, "index.ts"), "export const x = 1;\n");

		const ctx = await resolveStartupScanContextAsync(proj, { homeDir: home });
		expect(ctx.canWarmCaches).toBe(true);
		expect(ctx.projectRoot).toBe(path.resolve(proj));
		expect(ctx.sourceFileCount).toBe(1);
	});
});
