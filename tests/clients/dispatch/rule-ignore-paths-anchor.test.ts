/**
 * `rules.<id>.ignorePaths` is anchored at the directory of the file that
 * declares it, wherever the session starts (#5738).
 *
 * Recurrence this guards: `anchoredIgnorePaths` returned no prefix for a config
 * file above the session root and fell back to the session root as the base, so
 * the same `/gen/**` line in `repo/.pi-lens.json` carved out `repo/gen` for a
 * session at `repo` and `repo/pkg/gen` for a session at `repo/pkg`, while the
 * `ignore` field read the same line as `repo/gen` both times. Docs/settings.md
 * and #5029 anchor an entry at the declaring file's directory.
 *
 * Every row writes ONE line list to a real `repo/.pi-lens.json` as both the
 * `ignore` field and `rules.no-eval.ignorePaths`, starts the policy at each
 * session root, and asks the production matcher of each field about the same
 * files. The expected set is written from git's rules, not read back from
 * either field.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProjectIgnoreMatcher } from "../../../clients/file-utils.js";
import { loadProjectRulePolicy } from "../../../clients/dispatch/finding-policy.js";
import { applyRulePolicy } from "../../../clients/dispatch/rule-policy.js";
import type { Diagnostic } from "../../../clients/dispatch/types.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { useConfigPath } from "../../support/global-config.js";
import { removeTempDirSync } from "../test-utils.js";

const setConfigPath = useConfigPath();

let tmpDir: string;
let repo: string;
let pkg: string;

/** Files probed, relative to the repo: the repo's `gen/` and the package's. */
const PROBED = ["gen/b.ts", "pkg/gen/a.ts", "pkg/src/c.ts"] as const;

function finding(filePath: string): Diagnostic {
	return {
		id: `no-eval:`,
		message: "no-eval",
		filePath,
		severity: "warning",
		semantic: "warning",
		tool: "ast-grep",
		rule: "no-eval",
		line: 1,
	};
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

/** Of {@link PROBED}, the files `ignorePaths` hides for a session at `session`. */
function hiddenByIgnorePaths(session: string): string[] {
	const absolute = PROBED.map((rel) => path.join(repo, rel));
	const kept = new Set(
		applyRulePolicy(absolute.map(finding), loadProjectRulePolicy(session), {
			root: session,
			filePath: session,
		}).map((d) => d.filePath),
	);
	return PROBED.filter((_rel, i) => !kept.has(absolute[i] as string));
}

/** Of {@link PROBED}, the files the `ignore` field hides (matcher at the repo). */
function hiddenByIgnoreField(): string[] {
	const matcher = getProjectIgnoreMatcher(repo);
	return PROBED.filter((rel) => matcher.isIgnored(path.join(repo, rel), false));
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ignore-anchor-"));
	repo = path.join(tmpDir, "repo");
	pkg = path.join(repo, "pkg");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.mkdirSync(pkg, { recursive: true });
	setConfigPath(path.join(tmpDir, "global", "config.json"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	resetProjectLensConfigCache();
	removeTempDirSync(tmpDir);
});

describe("rules.<id>.ignorePaths anchor does not move with the session root (#5738)", () => {
	it.each([
		["rooted entry", ["/gen/**"]],
		["entry with a slash", ["gen/**"]],
	])(
		"%s from the repo root's file carves out repo/gen for a session at the repo and at pkg",
		(_name, patterns) => {
			writeJson(path.join(repo, ".pi-lens.json"), {
				ignore: patterns,
				rules: { "no-eval": { ignorePaths: patterns } },
			});

			// git's rule: the line is anchored at the directory of its file.
			const expected = ["gen/b.ts"];
			expect(hiddenByIgnoreField()).toEqual(expected);
			expect(hiddenByIgnorePaths(repo)).toEqual(expected);
			expect(hiddenByIgnorePaths(pkg)).toEqual(expected);
		},
	);

	it("a slashless entry from the repo's file still matches at any depth from a session at pkg", () => {
		writeJson(path.join(repo, ".pi-lens.json"), {
			rules: { "no-eval": { ignorePaths: ["gen/"] } },
		});

		const expected = ["gen/b.ts", "pkg/gen/a.ts"];
		expect(hiddenByIgnorePaths(repo)).toEqual(expected);
		expect(hiddenByIgnorePaths(pkg)).toEqual(expected);
	});

	it("keeps a global entry relative to the session root", () => {
		writeJson(path.join(tmpDir, "global", "config.json"), {
			rules: { "no-eval": { ignorePaths: ["/gen/**"] } },
		});

		expect(hiddenByIgnorePaths(repo)).toEqual(["gen/b.ts"]);
		expect(hiddenByIgnorePaths(pkg)).toEqual(["pkg/gen/a.ts"]);
	});

	it("keeps a nested pkg file's entry relative to pkg for a session at pkg", () => {
		writeJson(path.join(pkg, ".pi-lens.json"), {
			rules: { "no-eval": { ignorePaths: ["/gen/**"] } },
		});

		expect(hiddenByIgnorePaths(repo)).toEqual(["pkg/gen/a.ts"]);
		expect(hiddenByIgnorePaths(pkg)).toEqual(["pkg/gen/a.ts"]);
	});

	it.skipIf(process.platform === "win32")(
		"keeps the root as the base when a link at the root misplaces the climb",
		() => {
			writeJson(path.join(repo, ".pi-lens.json"), {
				rules: { "no-eval": { ignorePaths: ["/gen/**"] } },
			});
			// The session root IS a link to `repo/pkg`: a lexical climb from it lands
			// beside the link, not at `repo`, so the entry keeps its pre-#5738 base.
			const session = path.join(tmpDir, "pkg-link");
			fs.symlinkSync(pkg, session, "dir");
			const files = [
				path.join(session, "gen", "a.ts"),
				path.join(session, "src", "c.ts"),
			];
			const kept = applyRulePolicy(
				files.map(finding),
				loadProjectRulePolicy(session),
				{ root: session, filePath: session },
			).map((d) => d.filePath);

			expect(kept).toEqual([path.join(session, "src", "c.ts")]);
		},
	);

	it.skipIf(process.platform === "win32")(
		"anchors the entry at the declaring directory when the session root is spelled through a symlink above it",
		() => {
			writeJson(path.join(repo, ".pi-lens.json"), {
				rules: { "no-eval": { ignorePaths: ["/gen/**"] } },
			});
			// The link sits in the prefix of the session root, as `/var` -> `/private/var`
			// does on macOS: discovery records the repo's file under its real path.
			const link = path.join(tmpDir, "link");
			fs.symlinkSync(repo, link, "dir");
			const session = path.join(link, "pkg");
			const files = [
				path.join(link, "gen", "b.ts"),
				path.join(link, "pkg", "gen", "a.ts"),
			];
			const kept = applyRulePolicy(
				files.map(finding),
				loadProjectRulePolicy(session),
				{ root: session, filePath: session },
			).map((d) => d.filePath);

			expect(kept).toEqual([path.join(link, "pkg", "gen", "a.ts")]);
		},
	);
});
