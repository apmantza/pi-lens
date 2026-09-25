import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectInstallDiagnostics,
	formatInstallDiagnostics,
	grammarsInstalled,
	installDiagnosticNotes,
} from "../../clients/install-diagnostics.js";
import { setupTestEnvironment } from "./test-utils.js";

describe("install-diagnostics", () => {
	it("collects an environment fingerprint without throwing", () => {
		const d = collectInstallDiagnostics();
		expect(d.piLensVersion).toBeTruthy();
		expect(d.runtime).toMatch(/node|bun/);
		expect(d.platform).toContain("-");
		expect(d.deps.map((x) => x.name)).toContain("typescript");
		// In this repo's flat node_modules everything resolves.
		expect(d.deps.find((x) => x.name === "typescript")?.resolved).toBe(true);
	});

	it("formats a paste-able block with the cause and a report URL", () => {
		const out = formatInstallDiagnostics(
			collectInstallDiagnostics(),
			new Error("ResolveMessage: Cannot find package 'typescript'"),
		);
		expect(out).toContain("pi-lens install diagnostics");
		expect(out).toContain("LOAD ERROR: ResolveMessage");
		expect(out).toContain("runtime:");
		expect(out).toContain("install:");
		expect(out).toMatch(/github\.com\/apmantza\/pi-lens\/issues/);
	});

	it("flags a missing dep as FAIL in the rendered block", () => {
		const diag = collectInstallDiagnostics();
		diag.deps = [
			{
				name: "typescript",
				resolved: false,
				error: "ERR_MODULE_NOT_FOUND ...",
			},
		];
		diag.notes = ["unresolved deps note"];
		const out = formatInstallDiagnostics(diag);
		expect(out).toContain("FAIL typescript");
		expect(out).toContain("note: unresolved deps note");
	});
});

// #3424: the grammar probe through its injected ladder inputs. The Unit tests
// lane's own node_modules/web-tree-sitter/grammars is empty, so the live probe
// has no stable answer there; these fixtures give every case one.
describe("grammarsInstalled (#3424)", () => {
	const compiledHost = (specifier: string): string => {
		throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
			code: "MODULE_NOT_FOUND",
		});
	};

	function webTreeSitterPackage(root: string, withGrammar: boolean): string {
		const dir = path.join(root, "node_modules", "web-tree-sitter");
		fs.mkdirSync(path.join(dir, "grammars"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "web-tree-sitter" }),
		);
		fs.writeFileSync(path.join(dir, "tree-sitter.wasm"), "");
		if (withGrammar)
			fs.writeFileSync(
				path.join(dir, "grammars", "tree-sitter-typescript.wasm"),
				"",
			);
		return dir;
	}

	it("finds populated grammars under the package root on a compiled host", () => {
		const env = setupTestEnvironment("pi-lens-grammar-probe-");
		try {
			webTreeSitterPackage(env.tmpDir, true);
			expect(
				grammarsInstalled({
					resolve: compiledHost,
					packageRoot: () => env.tmpDir,
					cwd: () => path.join(env.tmpDir, "elsewhere"),
				}),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("reports an empty grammars directory as missing", () => {
		const env = setupTestEnvironment("pi-lens-grammar-probe-");
		try {
			webTreeSitterPackage(env.tmpDir, false);
			expect(
				grammarsInstalled({
					resolve: compiledHost,
					packageRoot: () => env.tmpDir,
					cwd: () => env.tmpDir,
				}),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("follows the resolver when it answers, wherever the package lives", () => {
		const env = setupTestEnvironment("pi-lens-grammar-probe-");
		try {
			const dir = webTreeSitterPackage(path.join(env.tmpDir, "store"), true);
			expect(
				grammarsInstalled({
					resolve: () => path.join(dir, "tree-sitter.wasm"),
					packageRoot: () => path.join(env.tmpDir, "no-package-here"),
					cwd: () => path.join(env.tmpDir, "no-package-here"),
				}),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("reports missing when no rung finds the package", () => {
		const env = setupTestEnvironment("pi-lens-grammar-probe-");
		try {
			expect(
				grammarsInstalled({
					resolve: compiledHost,
					packageRoot: () => env.tmpDir,
					cwd: () => env.tmpDir,
				}),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});

describe("installDiagnosticNotes (#3424)", () => {
	it("names the compiled-host cause when a runtime dependency did not resolve", () => {
		const [note] = installDiagnosticNotes({
			depsUnresolved: true,
			astGrepCli: true,
			grammars: true,
		});
		expect(note).toContain("pnpm symlink store");
		expect(note).toContain("bun build --compile");
	});

	it("adds no dependency note when every dependency resolved", () => {
		expect(
			installDiagnosticNotes({
				depsUnresolved: false,
				astGrepCli: true,
				grammars: true,
			}),
		).toEqual([]);
	});
});
