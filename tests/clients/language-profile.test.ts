import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDispatchContext } from "../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	detectProjectLanguageProfile,
	getDefaultStartupTools,
	resolveLanguageRootForFile,
} from "../../clients/language-profile.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		removeTempDirSync(dir);
	}
});

describe("language-profile roots", () => {
	it("does not treat a plain git repository as configured C/C++", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
		fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
		fs.writeFileSync(
			path.join(workspace, "index.ts"),
			"export const ok = true;\n",
		);

		const profile = detectProjectLanguageProfile(workspace);
		expect(profile.present.cxx).toBe(false);
		expect(profile.configured.cxx).toBeUndefined();
	});

	it("preinstalls Ruby tooling only for configured Ruby projects", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const fixturesOnly = path.join(tmp, "fixtures-only");
		fs.mkdirSync(fixturesOnly, { recursive: true });
		fs.writeFileSync(path.join(fixturesOnly, "sample.rb"), "puts :ok\n");

		const configured = path.join(tmp, "configured-ruby");
		fs.mkdirSync(configured, { recursive: true });
		fs.writeFileSync(
			path.join(configured, "Gemfile"),
			"source 'https://rubygems.org'\n",
		);
		fs.writeFileSync(path.join(configured, "app.rb"), "puts :ok\n");

		expect(
			getDefaultStartupTools(detectProjectLanguageProfile(fixturesOnly)),
		).not.toContain("rubocop");
		expect(
			getDefaultStartupTools(detectProjectLanguageProfile(configured)),
		).toContain("rubocop");
	});
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

	it("resolves a java file to a nested Kotlin-DSL Gradle module (#2870)", () => {
		// Both java marker tables listed only the Groovy `build.gradle`, so a
		// `.java` file in a `build.gradle.kts` module resolved to the workspace
		// root — where a polyglot repo's `go.mod` then claimed it as a go test
		// target. `kotlin` already listed both spellings.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const module = path.join(workspace, "app", "gw");
		const file = path.join(module, "src", "test", "java", "com", "FooTest.java");

		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(workspace, "go.mod"), "module example.com/x\n");
		fs.writeFileSync(path.join(module, "build.gradle.kts"), "\n");
		fs.writeFileSync(file, "class FooTest {}\n");

		expect(resolveLanguageRootForFile(file, workspace)).toBe(module);
		// The same spelling gap in the PROJECT marker table left a Kotlin-DSL
		// Gradle build reporting no configured java at all.
		expect(detectProjectLanguageProfile(module).configured.java).toBe(true);
	});

	it("resolves C/C++ file root to nearest C/C++ marker", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const projectRoot = path.join(workspace, "qwenfire");
		const file = path.join(projectRoot, "src", "main.c");

		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "compile_commands.json"), "[]\n");
		fs.writeFileSync(file, "int main(void) { return 0; }\n");

		const root = resolveLanguageRootForFile(file, workspace);
		expect(root).toBe(projectRoot);
	});

	it.each([
		["csharp", "App.csproj", "Program.cs"],
		["csharp", "App.sln", "Program.cs"],
		["fsharp", "App.fsproj", "Program.fs"],
		["fsharp", "App.sln", "Program.fs"],
	])(
		"resolves %s file root to nearest .NET marker",
		(_kind, marker, source) => {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
			dirs.push(tmp);

			const workspace = path.join(tmp, "repo");
			const projectRoot = path.join(workspace, "services", "dotnet");
			const file = path.join(projectRoot, "src", source);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(path.join(projectRoot, marker), "\n");
			fs.writeFileSync(file, "// test\n");

			expect(resolveLanguageRootForFile(file, workspace)).toBe(projectRoot);
		},
	);

	it("resolves a nested C# file to the nearest .csproj, not the solution root (#895)", () => {
		// The actual #895 monorepo shape: solution file at the workspace root,
		// project file in a nested service. A file under the service must resolve
		// to the service (nearest marker), NOT the solution root above it.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const project = path.join(workspace, "services", "api");
		const file = path.join(project, "src", "Handler.cs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(workspace, "App.sln"), "\n");
		fs.writeFileSync(path.join(project, "Api.csproj"), "<Project />\n");
		fs.writeFileSync(file, "// test\n");

		expect(resolveLanguageRootForFile(file, workspace)).toBe(project);
	});

	it("detects an XML solution file (*.slnx) as a csharp root marker (#895)", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const solutionRoot = path.join(workspace, "solution");
		const file = path.join(solutionRoot, "src", "Program.cs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(solutionRoot, "App.slnx"), "<Solution />\n");
		fs.writeFileSync(file, "// test\n");

		expect(resolveLanguageRootForFile(file, workspace)).toBe(solutionRoot);
	});

	it("marks .NET languages configured via glob project markers (#895)", () => {
		// Exercises detectProjectLanguageProfile's hasProjectMarker glob path:
		// `*.csproj` / `*.fsproj` are patterns, not literal basenames, so the
		// readdir+minimatch branch must find the real project filenames.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const csharpProject = path.join(tmp, "csharp-project");
		fs.mkdirSync(csharpProject, { recursive: true });
		fs.writeFileSync(path.join(csharpProject, "App.csproj"), "<Project />\n");
		fs.writeFileSync(path.join(csharpProject, "Program.cs"), "// test\n");

		const csharpProfile = detectProjectLanguageProfile(csharpProject);
		expect(csharpProfile.present.csharp).toBe(true);
		expect(csharpProfile.configured.csharp).toBe(true);

		const fsharpProject = path.join(tmp, "fsharp-project");
		fs.mkdirSync(fsharpProject, { recursive: true });
		fs.writeFileSync(path.join(fsharpProject, "App.fsproj"), "<Project />\n");

		const fsharpProfile = detectProjectLanguageProfile(fsharpProject);
		expect(fsharpProfile.configured.fsharp).toBe(true);
		// No glob marker present → the glob branch must also say "no", not
		// false-positive on unrelated files.
		expect(fsharpProfile.configured.csharp).toBeUndefined();
	});

	it("falls back to workspace root for nested C# and F# files without a marker", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);
		const workspace = path.join(tmp, "repo");
		const csharpFile = path.join(workspace, "src", "Program.cs");
		const fsharpFile = path.join(workspace, "src", "Program.fs");
		fs.mkdirSync(path.dirname(csharpFile), { recursive: true });
		fs.writeFileSync(csharpFile, "// test\n");
		fs.writeFileSync(fsharpFile, "// test\n");

		expect(resolveLanguageRootForFile(csharpFile, workspace)).toBe(workspace);
		expect(resolveLanguageRootForFile(fsharpFile, workspace)).toBe(workspace);
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

	it("keeps dispatch file paths absolute when a language root is nested under the workspace", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const projectRoot = path.join(workspace, "cases", "kotlin");
		const file = path.join(projectRoot, "src", "main", "kotlin", "main.kt");

		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			path.join(projectRoot, "build.gradle.kts"),
			"plugins {}\n",
		);
		fs.writeFileSync(file, "fun main() = greet(123)\n");

		const ctx = createDispatchContext(
			path.relative(workspace, file),
			workspace,
			{ getFlag: () => false },
			new FactStore(),
		);

		expect(normalizeMapKey(ctx.cwd)).toBe(normalizeMapKey(projectRoot));
		expect(normalizeMapKey(ctx.filePath)).toBe(normalizeMapKey(file));
		expect(ctx.filePath.includes("cases/kotlin/cases/kotlin")).toBe(false);
	});

	it("resolves workspace-relative files correctly even when dispatch cwd is already nested", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lang-root-"));
		dirs.push(tmp);

		const workspace = path.join(tmp, "repo");
		const projectRoot = path.join(workspace, "ts-service");
		const file = path.join(projectRoot, "src", "index.ts");

		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(projectRoot, "package.json"), "{}\n");
		fs.writeFileSync(file, "export const ok = true;\n");

		const ctx = createDispatchContext(
			"ts-service/src/index.ts",
			projectRoot,
			{ getFlag: () => false },
			new FactStore(),
		);

		expect(normalizeMapKey(ctx.cwd)).toBe(normalizeMapKey(projectRoot));
		expect(normalizeMapKey(ctx.filePath)).toBe(normalizeMapKey(file));
		expect(ctx.filePath.includes("ts-service/ts-service")).toBe(false);
	});
});
