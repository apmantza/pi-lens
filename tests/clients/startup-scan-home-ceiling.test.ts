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
import { resolveStartupScanContext } from "../../clients/startup-scan.js";

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
