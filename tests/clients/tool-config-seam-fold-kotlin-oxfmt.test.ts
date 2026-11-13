/**
 * #5408 slice 4: the ktfmt, ktlint and oxfmt-svelte readers climb the config
 * seam's stop rule (`toolConfigDirs`), not a private `walkUpDirs`. Each cell
 * drives a PRODUCTION caller (`getFormattersForFile`, `establishToolAgreement`),
 * never a hand-shaped input.
 *
 * Recurrences these cells name:
 * - `getSpotlessKotlinFormatter`, `hasKtfmtConfig`, `hasGradleKtlintPlugin` and
 *   `hasOxfmtSvelteConfig` climbed to the filesystem root, so a `.ktfmt`, a
 *   Spotless block, a Gradle build file or an `oxfmt.toml` ABOVE `$HOME`
 *   counted as project config (the #5408 divergence 3 shape, tflint). The seam
 *   stops at `$HOME`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearFormatterRuntimeState,
	getFormattersForFile,
} from "../../clients/formatters.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { toolConfigDirs } from "../../clients/tool-config-presence.js";
import { establishToolAgreement } from "../../clients/tool-agreement.js";
import { pinFixtureHome, setupTestEnvironment } from "./test-utils.js";

const isWin = process.platform === "win32";

function write(file: string, content = ""): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/** `$HOME` pinned; the project lives under it; `above` is the directory over `$HOME`. */
function layout(slug: string) {
	const { home } = pinFixtureHome(slug);
	const proj = path.join(home, "proj");
	fs.mkdirSync(proj, { recursive: true });
	return { home, proj, above: path.dirname(home) };
}

const planted: string[] = [];
function plant(file: string, content = ""): string {
	planted.push(file);
	return write(file, content);
}

const SPOTLESS = (formatter: "ktlint" | "ktfmt") =>
	`spotless {\n  kotlin {\n    ${formatter}()\n  }\n}\n`;

let shimEnv: ReturnType<typeof setupTestEnvironment>;
beforeEach(() => {
	setProjectTrustState("trusted");
	// The formatters probe their binary, so a fake one on PATH is what lets a
	// pre-fix over-selection show up as a selected formatter.
	shimEnv = setupTestEnvironment("pi-lens-5408s4-shim-");
	for (const tool of ["ktfmt", "ktlint", "oxfmt"]) {
		const exe = path.join(shimEnv.tmpDir, isWin ? `${tool}.cmd` : tool);
		fs.writeFileSync(exe, isWin ? "@echo off\r\n" : "#!/bin/sh\necho fake\n");
		if (!isWin) fs.chmodSync(exe, 0o755);
	}
	vi.stubEnv("PATH", `${shimEnv.tmpDir}${path.delimiter}${process.env.PATH}`);
});
afterEach(() => {
	for (const file of planted.splice(0)) fs.rmSync(file, { force: true });
	clearFormatterRuntimeState();
	vi.unstubAllEnvs();
	shimEnv.cleanup();
});

async function kotlinFormatters(proj: string): Promise<string[]> {
	const file = write(path.join(proj, "src", "App.kt"), "fun main() {}\n");
	return (await getFormattersForFile(file, proj)).map((f) => f.name);
}

describe("a Kotlin formatter election above $HOME is not project config (#5408 divergence 3 shape)", () => {
	it.each([
		["a .ktfmt marker", ".ktfmt", ""],
		["a Spotless ktfmt block", "build.gradle.kts", SPOTLESS("ktfmt")],
		["a Spotless ktlint block", "settings.gradle.kts", SPOTLESS("ktlint")],
		[
			"a ktfmt Gradle plugin",
			"build.gradle",
			"plugins { id 'com.ncorti.ktfmt.gradle' version '0.20.1' }\n",
		],
	])(
		"%s over $HOME selects no Kotlin formatter",
		async (_label, file, body) => {
			const { proj, above } = layout("5408-s4-above");
			plant(path.join(above, file), body);
			expect(await kotlinFormatters(proj)).toEqual([]);
		},
	);

	// Control: the same evidence inside the project, and at $HOME (which the
	// tools read), selects the formatter on master and now.
	it.each([
		["a .ktfmt marker", ".ktfmt", "", "ktfmt"],
		["a Spotless ktfmt block", "build.gradle.kts", SPOTLESS("ktfmt"), "ktfmt"],
		[
			"a Spotless ktlint block",
			"settings.gradle.kts",
			SPOTLESS("ktlint"),
			"ktlint",
		],
		[
			"a ktfmt Gradle plugin",
			"build.gradle",
			"plugins { id 'com.ncorti.ktfmt.gradle' version '0.20.1' }\n",
			"ktfmt",
		],
	])("%s in the project selects it", async (_label, file, body, expected) => {
		const { proj } = layout("5408-s4-in");
		write(path.join(proj, file), body);
		expect(await kotlinFormatters(proj)).toEqual([expected]);
	});

	it("a .ktfmt marker at $HOME itself still counts (the tool reads it)", async () => {
		const { home, proj } = layout("5408-s4-at-home");
		write(path.join(home, ".ktfmt"));
		expect(await kotlinFormatters(proj)).toEqual(["ktfmt"]);
	});
});

// Recurrence: hasKtfmtConfig read `/ktfmt/i` over the raw build file, so a
// comment that merely names ktfmt elected it (the #5408 divergence 2 shape,
// a substring read, applied to Gradle).
describe("a ktfmt mention in a Gradle comment is not an election (#5408 divergence 2 shape)", () => {
	it.each([
		["a line comment", "// we could switch to ktfmt one day\n"],
		["a block comment", "/* ktfmt()\n */\n"],
	])("%s selects no Kotlin formatter", async (_label, body) => {
		const { proj } = layout("5408-s4-gradle-comment");
		write(path.join(proj, "build.gradle.kts"), body);
		expect(await kotlinFormatters(proj)).toEqual([]);
	});

	// Control: code and strings still elect it, on master and now.
	it.each([
		["a version-catalog alias", "plugins { alias(libs.plugins.ktfmt) }\n"],
		[
			"a plugin id",
			'plugins { id("com.ncorti.ktfmt.gradle") version "0.20.1" }\n',
		],
		[
			"a quoted artifact",
			"dependencies { classpath 'com.facebook:ktfmt:0.47' }\n",
		],
	])("%s elects ktfmt", async (_label, body) => {
		const { proj } = layout("5408-s4-gradle-code");
		write(path.join(proj, "build.gradle.kts"), body);
		expect(await kotlinFormatters(proj)).toEqual(["ktfmt"]);
	});
});

describe("Gradle ktlint ownership above $HOME is not this project's (#5408 divergence 3 shape)", () => {
	const PLUGIN = 'plugins { id("org.jlleitschuh.gradle.ktlint") }\n';

	it("a plugin in a build file over $HOME leaves agreement established", () => {
		const { proj, above } = layout("5408-s4-gradle-above");
		plant(path.join(above, "build.gradle.kts"), PLUGIN);
		expect(establishToolAgreement("ktlint", proj).decision).toBe("established");
	});

	// Control: the same plugin inside the project declines (Gradle owns ktlint).
	it("a plugin in the project's build file declines", () => {
		const { proj } = layout("5408-s4-gradle-in");
		write(path.join(proj, "build.gradle.kts"), PLUGIN);
		expect(establishToolAgreement("ktlint", proj)).toMatchObject({
			decision: "decline",
			subject: "kotlin:gradle-ktlint",
		});
	});
});

describe("the oxfmt svelte flag above $HOME is not project config (#5408 divergence 3 shape)", () => {
	async function svelteFormatters(proj: string): Promise<string[]> {
		write(
			path.join(proj, "package.json"),
			JSON.stringify({ devDependencies: { oxfmt: "^0.54.0", svelte: "^5" } }),
		);
		const file = write(path.join(proj, "Component.svelte"), "<p>hi</p>\n");
		return (await getFormattersForFile(file, proj)).map((f) => f.name);
	}

	it.each([
		["oxfmt.toml", "svelte = true\n"],
		[".oxfmtrc.json", JSON.stringify({ svelte: true })],
	])("a %s over $HOME does not offer oxfmt for .svelte", async (file, body) => {
		const { proj, above } = layout("5408-s4-oxfmt-above");
		plant(path.join(above, file), body);
		expect(await svelteFormatters(proj)).not.toContain("oxfmt");
	});

	// Recurrence: the flag was a line match anywhere in the file (#1134 P3 tail
	// 1), so `svelte = true` under a `[table]` offered oxfmt.
	it("a svelte key nested under a [table] is not the top-level flag", async () => {
		const { proj } = layout("5408-s4-oxfmt-nested");
		write(path.join(proj, "oxfmt.toml"), "[overrides]\nsvelte = true\n");
		expect(await svelteFormatters(proj)).not.toContain("oxfmt");
	});

	// Control: a top-level flag with a trailing comment, and below a comment
	// line, still offers oxfmt.
	it("a top-level svelte flag with a trailing comment offers oxfmt", async () => {
		const { proj } = layout("5408-s4-oxfmt-comment");
		write(
			path.join(proj, "oxfmt.toml"),
			"# oxfmt\nsvelte = true # enable\n\n[overrides]\nx = 1\n",
		);
		expect(await svelteFormatters(proj)).toContain("oxfmt");
	});

	// Control: the flag inside the project, and at $HOME, offers oxfmt.
	it.each([
		["in the project", false],
		["at $HOME", true],
	])("the svelte flag %s offers oxfmt", async (_label, atHome) => {
		const { home, proj } = layout("5408-s4-oxfmt-in");
		write(
			path.join(atHome ? home : proj, ".oxfmtrc.json"),
			JSON.stringify({ svelte: true }),
		);
		expect(await svelteFormatters(proj)).toContain("oxfmt");
	});
});

describe("toolConfigDirs is the one stop rule (#5408)", () => {
	it("climbs through the home directory and no further", () => {
		const { home, proj } = layout("5408-s4-dirs");
		const deep = path.join(proj, "a", "b");
		fs.mkdirSync(deep, { recursive: true });
		const dirs = [...toolConfigDirs(deep, { homeDir: home })].map((dir) =>
			fs.realpathSync(dir),
		);
		expect(dirs).toEqual(
			[deep, path.join(proj, "a"), proj, home].map((dir) =>
				fs.realpathSync(dir),
			),
		);
	});

	it("stops at the caller's ceiling when that is nearer", () => {
		const { home, proj } = layout("5408-s4-ceiling");
		const deep = path.join(proj, "a");
		fs.mkdirSync(deep, { recursive: true });
		const dirs = [
			...toolConfigDirs(deep, { homeDir: home, ceiling: proj }),
		].map((dir) => fs.realpathSync(dir));
		expect(dirs).toEqual([deep, proj].map((dir) => fs.realpathSync(dir)));
	});
});
