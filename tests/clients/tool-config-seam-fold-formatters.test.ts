/**
 * #5408 slice 3: the formatter family, prettier, rubocop, standardrb, oxfmt and
 * oxlint now ask `clients/tool-config-presence.ts`. Each cell drives a
 * PRODUCTION caller (`establishToolAgreement`, the formatter `detect`, the
 * JS/TS lint policy), never a hand-shaped input.
 *
 * Recurrences these cells name:
 * - `findNearestContaining` and the oxfmt/oxlint/prettier walks climbed to the
 *   filesystem root, so a `.clang-format` or `.oxlintrc.json` ABOVE `$HOME`
 *   counted as project config (the #5408 divergence 3 shape, tflint). The seam
 *   stops at `$HOME`.
 * - `hasRubocopConfig` / `hasStandardrbConfig` matched a substring anywhere in
 *   a Gemfile (a comment, `standardize`): the #5408 divergence 2 shape.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { oxfmtFormatter, prettierFormatter } from "../../clients/formatters.js";
import { establishToolAgreement } from "../../clients/tool-agreement.js";
import { getJstsLintPolicyForCwd } from "../../clients/tool-policy.js";
import { pinFixtureHome } from "./test-utils.js";

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
afterEach(() => {
	for (const file of planted.splice(0)) fs.rmSync(file, { force: true });
});

// [tool name `establishToolAgreement` knows, the config file the tool reads]
const FORMATTER_MARKERS: ReadonlyArray<readonly [string, string]> = [
	["clang-format", ".clang-format"],
	["php-cs-fixer", ".php-cs-fixer.php"],
	["stylua", "stylua.toml"],
	["ocamlformat", ".ocamlformat"],
	["google-java-format", ".google-java-format"],
	["cljfmt", ".cljfmt.edn"],
	["cmake-format", ".cmake-format.yaml"],
	["csharpier", ".csharpierrc.json"],
	["ormolu", ".ormolu"],
	["taplo", "taplo.toml"],
	["terraform", ".terraform.lock.hcl"],
	["swiftformat", ".swiftformat"],
	["fantomas", ".fantomasignore"],
	["mix", ".formatter.exs"],
	["rubocop", ".rubocop.yml"],
	["psscriptanalyzer-format", "PSScriptAnalyzerSettings.psd1"],
];

describe("a formatter-family marker above $HOME is not project config (#5408 divergence 3 shape)", () => {
	it.each(FORMATTER_MARKERS)(
		"%s: %s over $HOME leaves the project without evidence",
		(tool, file) => {
			const { proj, above } = layout(`5408-s3-${tool}`);
			plant(path.join(above, file));
			expect(establishToolAgreement(tool, proj).decision).toBe("decline");
		},
	);

	// Control: the same marker inside the project is evidence on master and now.
	it.each(FORMATTER_MARKERS)(
		"%s: %s in the project is evidence",
		(tool, file) => {
			const { proj } = layout(`5408-s3-in-${tool}`);
			write(path.join(proj, file));
			expect(establishToolAgreement(tool, proj).decision).toBe("established");
		},
	);

	it("a marker at $HOME itself still counts (the tool reads it)", () => {
		const { home, proj } = layout("5408-s3-at-home");
		write(path.join(home, ".clang-format"));
		expect(establishToolAgreement("clang-format", proj).decision).toBe(
			"established",
		);
	});

	// Recurrence: psscriptanalyzer-format's agreement walked to the VCS root, so
	// a settings file at $HOME never counted for a repo under it, while the
	// formatter's own detect (the seam) selected the tool. Both now read one answer.
	it("a PSScriptAnalyzer settings file at $HOME counts for a repo under it", () => {
		const { home, proj } = layout("5408-s3-psa-home-repo");
		fs.mkdirSync(path.join(proj, ".git"));
		plant(path.join(home, "PSScriptAnalyzerSettings.psd1"), "@{}\n");
		expect(
			establishToolAgreement("psscriptanalyzer-format", proj).decision,
		).toBe("established");
	});
});

describe("oxlint, oxfmt and prettier stop at $HOME (#5408 divergence 3 shape)", () => {
	it("an .oxlintrc.json over $HOME is not oxlint config", () => {
		const { proj, above } = layout("5408-s3-oxlint");
		plant(path.join(above, ".oxlintrc.json"), "{}\n");
		expect(getJstsLintPolicyForCwd(proj).hasOxlintConfig).toBe(false);
	});

	it("an .oxlintrc.json in the project is (control)", () => {
		const { proj } = layout("5408-s3-oxlint-in");
		write(path.join(proj, ".oxlintrc.json"), "{}\n");
		expect(getJstsLintPolicyForCwd(proj).hasOxlintConfig).toBe(true);
	});

	it("an .oxfmtrc.json over $HOME does not select oxfmt", async () => {
		const { proj, above } = layout("5408-s3-oxfmt");
		plant(path.join(above, ".oxfmtrc.json"), "{}\n");
		expect(await oxfmtFormatter.detect?.(proj)).toBe(false);
	});

	it.each([
		["an .oxfmtrc.json", ".oxfmtrc.json", "{}\n"],
		[
			"an oxfmt devDependency",
			"package.json",
			'{"devDependencies":{"oxfmt":"1"}}',
		],
		["a vite-plus.json", "vite-plus.json", "{}\n"],
	])("%s in the project selects oxfmt (control)", async (_n, file, text) => {
		const { proj } = layout("5408-s3-oxfmt-in");
		write(path.join(proj, file), text);
		expect(await oxfmtFormatter.detect?.(proj)).toBe(true);
	});

	it("a .prettierrc over $HOME does not select prettier", async () => {
		const { proj, above } = layout("5408-s3-prettier");
		plant(path.join(above, ".prettierrc"), "{}\n");
		expect(await prettierFormatter.detect?.(proj)).toBe(false);
	});

	it.each([
		["a .prettierrc", ".prettierrc", "{}\n"],
		[
			"package.json#prettier set to false",
			"package.json",
			'{"prettier":false}',
		],
		[
			"a prettier devDependency",
			"package.json",
			'{"devDependencies":{"prettier":"3"}}',
		],
	])("%s in the project selects prettier (control)", async (_n, file, text) => {
		const { proj } = layout("5408-s3-prettier-in");
		write(path.join(proj, file), text);
		expect(await prettierFormatter.detect?.(proj)).toBe(true);
	});
});

describe("a Gemfile names its gems; a mention is not a gem (#5408 divergence 2 shape)", () => {
	it.each([
		["rubocop", "# gem 'rubocop'\nsource 'https://rubygems.org'\n"],
		["rubocop", "gem 'rubocop-rails-omakase' # not rubocop itself\n"],
		["standardrb", "gem 'standardize'\n"],
		["standardrb", "# gem 'standard'\n"],
	])("%s: %j is no evidence", (tool, gemfile) => {
		const { proj } = layout(`5408-s3-gemfile-${tool}`);
		write(path.join(proj, "Gemfile"), gemfile);
		expect(establishToolAgreement(tool, proj).decision).toBe("decline");
	});

	it.each([
		["rubocop", "gem 'rubocop'\n"],
		["rubocop", 'gem "rubocop", require: false\n'],
		["rubocop", "  gem('rubocop', '~> 1.0')\n"],
		["standardrb", "gem 'standard', group: :development\n"],
	])("%s: %j is evidence (control)", (tool, gemfile) => {
		const { proj } = layout(`5408-s3-gemfile-in-${tool}`);
		write(path.join(proj, "Gemfile"), gemfile);
		expect(establishToolAgreement(tool, proj).decision).toBe("established");
	});
});
