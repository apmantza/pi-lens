import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createProjectIgnoreMatcher,
	getProjectIgnoreMatcher,
} from "../../clients/file-utils.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { collectSourceFiles } from "../../clients/source-filter.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-ignore-"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	resetProjectLensConfigCache();
});

describe("createProjectIgnoreMatcher with project config", () => {
	it("createProjectIgnoreMatcher honors extraPatterns as before", () => {
		// Sanity: the existing extension point still works. The new code path
		// just wires `.pi-lens.json` content into it via getProjectIgnoreMatcher.
		const matcher = createProjectIgnoreMatcher(tmpDir, ["vendor/**"]);
		expect(matcher.isIgnored(path.join(tmpDir, "vendor/foo.ts"), false)).toBe(
			true,
		);
		expect(matcher.isIgnored(path.join(tmpDir, "src/foo.ts"), false)).toBe(
			false,
		);
	});

	it("getProjectIgnoreMatcher picks up ignore patterns from .pi-lens.json", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["**/skip-this/**", "noise.ts"] }),
		);
		fs.mkdirSync(path.join(tmpDir, "skip-this"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "keep-this"), { recursive: true });

		const matcher = getProjectIgnoreMatcher(tmpDir);
		expect(matcher.isIgnored(path.join(tmpDir, "skip-this/x.ts"), false)).toBe(
			true,
		);
		expect(matcher.isIgnored(path.join(tmpDir, "noise.ts"), false)).toBe(true);
		expect(matcher.isIgnored(path.join(tmpDir, "keep-this/y.ts"), false)).toBe(
			false,
		);
	});

	it("getProjectIgnoreMatcher still honors .gitignore alongside .pi-lens.json", () => {
		fs.writeFileSync(path.join(tmpDir, ".gitignore"), "gitignored/\n");
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["project-ignored/**"] }),
		);
		fs.mkdirSync(path.join(tmpDir, "gitignored"));
		fs.mkdirSync(path.join(tmpDir, "project-ignored"));

		const matcher = getProjectIgnoreMatcher(tmpDir);
		expect(matcher.isIgnored(path.join(tmpDir, "gitignored/x.ts"), false)).toBe(
			true,
		);
		expect(
			matcher.isIgnored(path.join(tmpDir, "project-ignored/x.ts"), false),
		).toBe(true);
	});

	it("getProjectIgnoreMatcher returns a clean matcher when no project config exists", () => {
		// No .pi-lens.json and no .gitignore — should not throw, just return
		// a matcher that ignores nothing.
		const matcher = getProjectIgnoreMatcher(tmpDir);
		expect(matcher.isIgnored(path.join(tmpDir, "anything.ts"), false)).toBe(
			false,
		);
	});

	it("getProjectIgnoreMatcher cache invalidates when .pi-lens.json changes", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["first/**"] }),
		);
		fs.mkdirSync(path.join(tmpDir, "first"));
		fs.mkdirSync(path.join(tmpDir, "second"));

		const before = getProjectIgnoreMatcher(tmpDir);
		expect(before.isIgnored(path.join(tmpDir, "first/x.ts"), false)).toBe(true);
		expect(before.isIgnored(path.join(tmpDir, "second/x.ts"), false)).toBe(
			false,
		);

		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["second/**"] }),
		);

		const after = getProjectIgnoreMatcher(tmpDir);
		expect(after.isIgnored(path.join(tmpDir, "first/x.ts"), false)).toBe(false);
		expect(after.isIgnored(path.join(tmpDir, "second/x.ts"), false)).toBe(true);
	});

	it("invalidates when inherited parent .pi-lens.json changes above the git root", async () => {
		const childRoot = path.join(tmpDir, "nested-repo");
		fs.mkdirSync(path.join(childRoot, ".git"), { recursive: true });
		fs.mkdirSync(path.join(childRoot, "first"));
		fs.mkdirSync(path.join(childRoot, "second"));
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["first/**"] }),
		);

		const before = getProjectIgnoreMatcher(childRoot);
		expect(before.isIgnored(path.join(childRoot, "first/x.ts"), false)).toBe(
			true,
		);
		expect(before.isIgnored(path.join(childRoot, "second/x.ts"), false)).toBe(
			false,
		);

		await new Promise((r) => setTimeout(r, 20));
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["second/**"] }),
		);

		const after = getProjectIgnoreMatcher(childRoot);
		expect(after.isIgnored(path.join(childRoot, "first/x.ts"), false)).toBe(
			false,
		);
		expect(after.isIgnored(path.join(childRoot, "second/x.ts"), false)).toBe(
			true,
		);
	});

	it("project ignore patterns feed through collectSourceFiles", () => {
		// End-to-end: a path that the project config ignores must not appear in
		// the source file listing that drives every per-edit scan.
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["fixtures/**"] }),
		);
		const fixturesDir = path.join(tmpDir, "fixtures");
		fs.mkdirSync(fixturesDir);
		fs.writeFileSync(
			path.join(fixturesDir, "noise.ts"),
			"export const x = 1;\n",
		);
		const srcDir = path.join(tmpDir, "src");
		fs.mkdirSync(srcDir);
		fs.writeFileSync(path.join(srcDir, "real.ts"), "export const y = 2;\n");

		const files = collectSourceFiles(tmpDir);
		const rel = files.map((f) => path.relative(tmpDir, f).replace(/\\/g, "/"));
		expect(rel).toContain("src/real.ts");
		expect(rel).not.toContain("fixtures/noise.ts");
	});
});
