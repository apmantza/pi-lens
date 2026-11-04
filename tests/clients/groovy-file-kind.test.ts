/**
 * #5235 slice 1: Groovy is a file kind. Before it, GroovyServer (#5123) was the
 * only thing in pi-lens that knew the language: `.groovy` had no kind, so
 * `lang:groovy`, kind-keyed dispatch and the language registry skipped it.
 *
 * Every case goes through the production seam that fans the kind out (the
 * detector, the registry, the LSP language-id resolver, the word-index query,
 * symbol_search's `lang`, the dispatch plan, the server selector); none
 * restates the kind table.
 */

import { describe, expect, it } from "vitest";
import lspRunner from "../../clients/dispatch/runners/lsp.js";
import { getToolPlan } from "../../clients/dispatch/plan.js";
import {
	detectFileKind,
	getFileKindLabel,
	getLanguageId as getKindLanguageId,
	isCodeKindFile,
} from "../../clients/file-kinds.js";
import { getLspCapableKinds } from "../../clients/language-policy.js";
import { resolveLanguage } from "../../clients/language-registry.js";
import { symbolSearchFileMatchesLang } from "../../clients/lens-engine.js";
import { getLanguageId } from "../../clients/lsp/language.js";
import { getServersForFile } from "../../clients/lsp/server.js";
import {
	buildWordIndex,
	buildWordIndexQueryFilter,
	searchWordIndex,
} from "../../clients/word-index.js";

const GROOVY_EXTENSIONS = [".groovy", ".gvy", ".gy", ".gsh"];
// The three build/pipeline files the issue names. Exact basenames: `Jenkinsfile`
// is conventionally extensionless, and the Gradle build scripts are Groovy only
// under these names (`build.gradle.kts` is Kotlin, `foo.gradle` is not claimed).
const GROOVY_FILENAMES = ["Jenkinsfile", "build.gradle", "settings.gradle"];

describe("groovy file kind (#5235 slice 1)", () => {
	it("classifies every Groovy extension", () => {
		for (const extension of GROOVY_EXTENSIONS) {
			expect(detectFileKind(`/repo/src/Main${extension}`), extension).toBe(
				"groovy",
			);
			expect(
				detectFileKind(`/repo/src/Main${extension.toUpperCase()}`),
				extension,
			).toBe("groovy");
		}
	});

	it("classifies every Groovy build and pipeline name", () => {
		for (const name of GROOVY_FILENAMES) {
			expect(detectFileKind(`/repo/${name}`), name).toBe("groovy");
			expect(detectFileKind(`/repo/app/${name}`), name).toBe("groovy");
		}
	});

	it("leaves the neighbours of the Groovy names where they were", () => {
		// build.gradle.kts is a Kotlin script; a build file with another stem or an
		// unlisted .gradle name is not claimed by this slice.
		expect(detectFileKind("/repo/build.gradle.kts")).toBe("kotlin");
		expect(detectFileKind("/repo/settings.gradle.kts")).toBe("kotlin");
		expect(detectFileKind("/repo/Jenkinsfile.bak")).toBeUndefined();
		expect(detectFileKind("/repo/MyJenkinsfile")).toBeUndefined();
		expect(detectFileKind("/repo/dependencies.gradle")).toBeUndefined();
	});

	it("labels the kind and is a code kind", () => {
		expect(getFileKindLabel("groovy")).toBe("Groovy");
		expect(getKindLanguageId("groovy")).toBe("groovy");
		expect(isCodeKindFile("/repo/Main.groovy")).toBe(true);
		expect(isCodeKindFile("/repo/Jenkinsfile")).toBe(true);
	});

	it("registers the language so the LSP announces groovy, not plaintext", () => {
		for (const extension of GROOVY_EXTENSIONS) {
			expect(getLanguageId(`/repo/Main${extension}`), extension).toBe("groovy");
			expect(resolveLanguage(`/repo/Main${extension}`)?.id, extension).toBe(
				"groovy",
			);
		}
		for (const name of GROOVY_FILENAMES) {
			expect(getLanguageId(`/repo/${name}`), name).toBe("groovy");
			expect(resolveLanguage(`/repo/${name}`)?.id, name).toBe("groovy");
		}
	});

	it("routes the kind to the lsp runner and the existing GroovyServer", () => {
		expect(getLspCapableKinds()).toContain("groovy");
		expect(lspRunner.appliesTo).toContain("groovy");
		const plan = getToolPlan("groovy");
		expect(plan?.groups.flatMap((group) => group.runnerIds)).toContain("lsp");
		expect(
			getServersForFile("/repo/src/Main.groovy").map((server) => server.id),
		).toContain("groovy");
	});

	describe("lang:groovy filters", () => {
		const files = [
			{ path: "src/Build.groovy", content: "def deployService() { }" },
			{ path: "ci/Jenkinsfile", content: "def deployService() { }" },
			{ path: "app/build.gradle", content: "def deployService() { }" },
			{ path: "src/Build.kts", content: "fun deployService() { }" },
			{ path: "src/Build.py", content: "def deploy_service(): pass" },
		];

		it("the word-index query selects .groovy files and the named build files", () => {
			const index = buildWordIndex(files);
			const hits = searchWordIndex(index, "lang:groovy deployService").map(
				(hit) => hit.file,
			);
			expect(hits.sort()).toEqual(
				["app/build.gradle", "ci/Jenkinsfile", "src/Build.groovy"].sort(),
			);
		});

		it("the word-index filter keeps selecting by extension for other kinds", () => {
			const python = buildWordIndexQueryFilter([
				{ key: "lang", value: "python", negated: false },
			]);
			expect(python?.("ci/Jenkinsfile")).toBe(false);
			expect(python?.("src/Build.py")).toBe(true);
		});

		it("symbol_search's lang token selects them too", () => {
			expect(symbolSearchFileMatchesLang("src/Build.groovy", "groovy")).toBe(
				true,
			);
			expect(symbolSearchFileMatchesLang("ci/Jenkinsfile", "groovy")).toBe(
				true,
			);
			expect(symbolSearchFileMatchesLang("app/settings.gradle", "groovy")).toBe(
				true,
			);
			expect(symbolSearchFileMatchesLang("src/Build.kts", "groovy")).toBe(
				false,
			);
			expect(symbolSearchFileMatchesLang("ci/Jenkinsfile", "python")).toBe(
				false,
			);
		});

		// Recurrence this guards (PR #5238 review r3, coderabbit): the changelog
		// says the `lang:` filters match named files of every kind, but the
		// structured filter compared the token with the registry id only, so
		// `lang:docker` (the kind; the registry id is "dockerfile") found
		// Dockerfile inline and missed it in symbol_search, and the registry's
		// exact-name tier never saw `Dockerfile.dev` at all.
		it("symbol_search matches a named file by its kind, as the inline filter does", () => {
			const named: ReadonlyArray<readonly [string, string]> = [
				["Dockerfile", "docker"],
				["ci/Dockerfile.dev", "docker"],
				["Makefile", "shell"],
				["CMakeLists.txt", "cmake"],
			];
			for (const [file, kind] of named) {
				const inline = buildWordIndexQueryFilter([
					{ key: "lang", value: kind, negated: false },
				]);
				expect(inline?.(file), `inline ${kind} ${file}`).toBe(true);
				expect(
					symbolSearchFileMatchesLang(file, kind),
					`structured ${kind} ${file}`,
				).toBe(true);
			}
			expect(symbolSearchFileMatchesLang("Dockerfile", "shell")).toBe(false);
			expect(symbolSearchFileMatchesLang("Dockerfile.dev", "python")).toBe(
				false,
			);
		});
	});
});
