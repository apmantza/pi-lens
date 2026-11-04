/**
 * #5273: the source walk admitted a file by extension only, so a file whose
 * kind comes from its NAME (`Jenkinsfile`, `build.gradle`, `Dockerfile`,
 * `Makefile`, ...) never reached the word index and `symbol_search` could not
 * return it. `includeNamedFiles` admits the names `SPECIAL_FILENAMES`
 * (clients/file-kinds.ts) classifies; the index opts in, every other walk
 * consumer keeps the extension gate.
 *
 * Every case drives the real walk over a real directory tree.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectIgnoreMatcher } from "../../clients/file-utils.js";
import { SPECIAL_FILENAMES } from "../../clients/file-kinds.js";
import { collectSourceFilesForWarmup } from "../../clients/language-profile.js";
import {
	getSourceFiles,
	getSourceFilesAsync,
} from "../../clients/scan-utils.js";
import {
	collectSourceFiles,
	collectSourceFilesAsync,
	collectSourceFilesWithBudget,
	collectSourceFilesWithBudgetAsync,
} from "../../clients/source-filter.js";
import { TodoScanner } from "../../clients/todo-scanner.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-named-files-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	removeTempDirSync(tmpDir);
});

function write(rel: string, content = "x\n"): string {
	const full = path.join(tmpDir, ...rel.split("/"));
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

function rel(files: string[]): string[] {
	return files
		.map((f) => path.relative(tmpDir, f).split(path.sep).join("/"))
		.sort();
}

/** Every name SPECIAL_FILENAMES classifies, one concrete spelling each. */
const NAMED = [
	"Jenkinsfile",
	"build.gradle",
	"settings.gradle",
	"Dockerfile",
	"Dockerfile.dev",
	"Makefile",
	"CMakeLists.txt",
	"terragrunt.hcl",
	"root.hcl",
];

function seedTree(): void {
	write("a.groovy", "def a() {}\n");
	write("ci/x.ts", "export const x = 1;\n");
	for (const name of NAMED) write(`pipeline/${name}`);
	// Near misses: not a name SPECIAL_FILENAMES claims.
	write("pipeline/Jenkinsfile.bak");
	write("pipeline/build.gradle.orig");
	write("pipeline/settings.gradle.bak");
	write("pipeline/Makefile.old");
	write("pipeline/README");
	write("pipeline/notes.txt");
}

const WITH_NAMES = [
	"a.groovy",
	"ci/x.ts",
	...NAMED.map((n) => `pipeline/${n}`),
].sort();
const EXT_ONLY = ["a.groovy", "ci/x.ts"];

describe("includeNamedFiles admission across the four collectors (#5273)", () => {
	it("the fixture names are exactly the SPECIAL_FILENAMES population", () => {
		// Recurrence: a name added to SPECIAL_FILENAMES that this table (and the
		// walk tests below) never exercised.
		for (const name of NAMED) {
			expect(
				SPECIAL_FILENAMES.some(({ pattern }) => pattern.test(name)),
				name,
			).toBe(true);
		}
		const covered = SPECIAL_FILENAMES.filter(
			({ pattern }) => !NAMED.some((name) => pattern.test(name)),
		);
		expect(covered).toEqual([]);
	});

	it("collectSourceFiles admits every named file", () => {
		seedTree();
		expect(
			rel(collectSourceFiles(tmpDir, { includeNamedFiles: true })),
		).toEqual(WITH_NAMES);
	});

	it("collectSourceFilesWithBudget admits every named file", () => {
		seedTree();
		const result = collectSourceFilesWithBudget(tmpDir, {
			includeNamedFiles: true,
		});
		expect(rel(result.files)).toEqual(WITH_NAMES);
		expect(result.entryBudgetExceeded).toBe(false);
	});

	it("collectSourceFilesAsync admits every named file", async () => {
		seedTree();
		expect(
			rel(await collectSourceFilesAsync(tmpDir, { includeNamedFiles: true })),
		).toEqual(WITH_NAMES);
	});

	it("collectSourceFilesWithBudgetAsync admits every named file", async () => {
		seedTree();
		const result = await collectSourceFilesWithBudgetAsync(tmpDir, {
			includeNamedFiles: true,
		});
		expect(rel(result.files)).toEqual(WITH_NAMES);
	});

	it("the option is opt-in: without it every collector stays extension-only", async () => {
		// Recurrence: a default-on admission silently widening the review graph,
		// project diagnostics, the language profile and the TODO baseline.
		seedTree();
		expect(rel(collectSourceFiles(tmpDir))).toEqual(EXT_ONLY);
		expect(rel(collectSourceFilesWithBudget(tmpDir).files)).toEqual(EXT_ONLY);
		expect(rel(await collectSourceFilesAsync(tmpDir))).toEqual(EXT_ONLY);
		expect(
			rel((await collectSourceFilesWithBudgetAsync(tmpDir)).files),
		).toEqual(EXT_ONLY);
	});

	it("an explicit extensions list is still honoured next to the named files", () => {
		seedTree();
		expect(
			rel(
				collectSourceFiles(tmpDir, {
					includeNamedFiles: true,
					extensions: [".groovy"],
				}),
			),
		).toEqual(["a.groovy", ...NAMED.map((n) => `pipeline/${n}`)].sort());
	});

	it("a gitignored named file stays out: isIgnored still runs for admitted names", () => {
		// Recurrence: admitting by name ahead of the ignore matcher would index
		// build output such as an ignored out/Dockerfile.
		fs.mkdirSync(path.join(tmpDir, ".git"));
		write(".gitignore", "generated-ci/Jenkinsfile\n");
		write("generated-ci/Jenkinsfile");
		write("ci/Jenkinsfile");
		expect(
			rel(collectSourceFiles(tmpDir, { includeNamedFiles: true })),
		).toEqual(["ci/Jenkinsfile"]);
	});

	it("neither gate pays isIgnored for a file that passes neither (#1974 cost property)", () => {
		// Recurrence: a name check placed after isIgnored (or an always-true
		// admission) makes every unclaimed file pay the per-ancestor minimatch
		// compile that #1974 moved behind the extension gate.
		write("junk/data.bin");
		write("junk/LICENSE");
		write("junk/Jenkinsfile.bak");
		write("junk/Jenkinsfile");
		const spy = vi.spyOn(getProjectIgnoreMatcher(tmpDir), "isIgnored");
		collectSourceFiles(tmpDir, { includeNamedFiles: true });
		const probed = spy.mock.calls.map(([file]) => path.basename(String(file)));
		expect(probed.filter((name) => name !== "junk")).toEqual(["Jenkinsfile"]);
	});
});

describe("consumers that keep the extension gate (#5273 decision per consumer)", () => {
	// Reasons are in the PR body. Recurrence for the whole block: the admission
	// leaking to a consumer whose analyzers key on the extension and have no
	// parser, fact provider or comment syntax for a named file.
	it("scan-utils getSourceFiles / getSourceFilesAsync (language profile, TODO baseline)", async () => {
		seedTree();
		expect(rel(getSourceFiles(tmpDir))).toEqual(EXT_ONLY);
		expect(rel(await getSourceFilesAsync(tmpDir))).toEqual(EXT_ONLY);
	});

	it("collectSourceFilesForWarmup (own walk, language presence)", async () => {
		seedTree();
		expect(rel(await collectSourceFilesForWarmup(tmpDir))).toEqual(EXT_ONLY);
	});

	it("the TODO scanner does not read a named file", () => {
		write("Jenkinsfile", "// TODO: pin the agent label\n");
		write("a.groovy", "// TODO: real item\n");
		const result = new TodoScanner().scanDirectory(tmpDir);
		expect(result.items.map((item) => path.basename(item.file))).toEqual([
			"a.groovy",
		]);
	});
});
