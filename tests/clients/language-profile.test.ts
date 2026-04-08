import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLanguageRootForFile } from "../../clients/language-profile.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("language-profile roots", () => {
	it("resolves python file root to nearest pyproject in monorepo", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const pkg = path.join(workspace, "apps", "talos");
		const file = path.join(pkg, "core", "orchestrator.py");

		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(pkg, "pyproject.toml"), "[tool.ruff]\n");
		fs.writeFileSync(file, "print('ok')\n");

		const root = resolveLanguageRootForFile(file, workspace);
		expect(root).toBe(pkg);
	});

	it("falls back to workspace root for files outside workspace", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const external = path.join(tmp, "external", "main.go");

		fs.mkdirSync(path.dirname(external), { recursive: true });
		fs.writeFileSync(external, "package main\n");

		const root = resolveLanguageRootForFile(external, workspace);
		expect(root).toBe(workspace);
	});
});
