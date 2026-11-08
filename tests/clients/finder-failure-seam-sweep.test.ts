/**
 * Population sweep: a production file that spawns the `where`/`which` finder
 * and keeps a verdict classifies its failure through `classifyFinderFailure`.
 *
 * ## The recurrence this guards (AGENTS.md shape 83)
 *
 * `formatters.ts` learned in #1495 that a `where`/`which` that COULD NOT SPAWN
 * (EACCES, EMFILE, an unresolvable cwd) says nothing about the tool it was
 * asked for. `package-manager.ts` and `lsp/jvm-runtime.ts` re-derived the
 * classification beside it with an unconditional `missing` override, so one
 * EACCES latched pnpm, yarn, bun, npm and java absent for the session
 * (`tests/clients/package-manager-availability-latch.test.ts` and
 * `tests/clients/lsp/jvm-runtime.test.ts` carry the behaviour cells). A copy
 * of the rule is always plausible beside its owner, so the next finder-gated
 * latch would have copied the wrong one.
 *
 * ## What is scanned, and what is admitted
 *
 * Every production file under `clients/`, `tools/`, `mcp/`, `scripts/` (`.mjs`)
 * and `index.ts`, with comments blanked and string contents KEPT (the finder
 * name is itself a string literal, and so is a bracket access to the
 * classifier). A file is a finder file when its code holds the string literal
 * `"where"` or `"which"`. Each finder file must be a row below, in one of two
 * forms, and every other file with the needle fails:
 *
 * - `seam`: the file mentions `classifyFinderFailure` and never mentions
 *   `classifyProbeFailure` (a call, an alias, a destructure, a namespace
 *   member or a bracket string all mention it).
 * - `status-only`: the file mentions neither classifier and creates no
 *   availability latch, so the finder's result is read per call and never
 *   parked as a verdict.
 *
 * A row whose file no longer holds the needle fails too, so a retired site
 * cannot leave dead scaffolding behind.
 *
 * The needle is the finder name as one literal. A finder name assembled from
 * fragments (`"wh" + "ich"`) is not read; `grep -rnE '"wh" *\+'` over the
 * scanned roots is empty today.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

type FinderForm = "seam" | "status-only";

/** Every file that spells the finder, with the form it must take. Sorted. */
const FINDER_FILES: ReadonlyArray<readonly [string, FinderForm, string]> = [
	[
		"clients/formatters.ts",
		"seam",
		"`which()` latches a per-command verdict and replays its cooldown",
	],
	[
		"clients/lsp/jvm-runtime.ts",
		"seam",
		"`runJavaProbe` latches the java verdict",
	],
	[
		"clients/package-manager.ts",
		"seam",
		"`probeAvailability` latches one verdict per package manager",
	],
	[
		"clients/safe-spawn.ts",
		"status-only",
		"`findCommand*` and `isCommandAvailableAsync` reduce each call to a path or a boolean",
	],
	[
		"clients/test-runner-client.ts",
		"status-only",
		"the pytest-on-PATH probe reads `status === 0` per call",
	],
	[
		"scripts/smoke-availability-lifecycle.mjs",
		"status-only",
		"a bare Node smoke script: it cannot import the TypeScript seam and reads the finder's status",
	],
	[
		"scripts/smoke-gitleaks-scratch-exclusion.mjs",
		"status-only",
		"a bare Node smoke script: it cannot import the TypeScript seam and reads the finder's status",
	],
	[
		"scripts/smoke-psscriptanalyzer-classification.mjs",
		"status-only",
		"a bare Node smoke script: it cannot import the TypeScript seam and reads the finder's status",
	],
];

const FINDER_NEEDLE = /(["'`])(?:where|which)\1/;
const SEAM = /\bclassifyFinderFailure\b/;
const RAW_CLASSIFIER = /\bclassifyProbeFailure\b/;
const LATCH = /\bcreateAvailabilityLatch\b/;

interface Verdict {
	isFinderFile: boolean;
	problems: string[];
}

/** Judge one file's source against the form the table names for it (or none). */
function judge(
	file: string,
	source: string,
	table: ReadonlyArray<readonly [string, FinderForm, string]>,
): Verdict {
	const code = stripSource(source, { strings: "keep" });
	if (!FINDER_NEEDLE.test(code)) return { isFinderFile: false, problems: [] };
	const row = table.find(([name]) => name === file);
	if (!row) {
		return {
			isFinderFile: true,
			problems: [
				`${file}: spells the where/which finder but has no row. Route its failure ` +
					"through classifyFinderFailure (clients/dispatch/runners/utils/availability-policy.ts) " +
					"and add a `seam` row, or add a `status-only` row if it reads the result per call.",
			],
		};
	}
	const [, form] = row;
	const problems: string[] = [];
	if (RAW_CLASSIFIER.test(code)) {
		problems.push(
			`${file}: a finder file mentions classifyProbeFailure; the finder's failure is read by classifyFinderFailure only`,
		);
	}
	if (form === "seam" && !SEAM.test(code)) {
		problems.push(
			`${file}: a \`seam\` row never mentions classifyFinderFailure`,
		);
	}
	if (form === "status-only") {
		if (SEAM.test(code)) {
			problems.push(
				`${file}: a \`status-only\` row mentions classifyFinderFailure; make it a \`seam\` row`,
			);
		}
		if (LATCH.test(code)) {
			problems.push(
				`${file}: a \`status-only\` row creates an availability latch; its verdict must go through the seam`,
			);
		}
	}
	return { isFinderFile: true, problems };
}

function scanTree(): Array<{ file: string; source: string }> {
	const roots: Array<[string, string[]]> = [
		["clients", [".ts"]],
		["tools", [".ts"]],
		["mcp", [".ts"]],
		["scripts", [".mjs"]],
	];
	const files = roots.flatMap(([root, extensions]) =>
		listSourceFiles(path.join(REPO_ROOT, root), { extensions }),
	);
	files.push(path.join(REPO_ROOT, "index.ts"));
	return readWalkedFiles(files).map(({ file, source }) => ({
		file: relativePosix(REPO_ROOT, file),
		source,
	}));
}

describe("where/which finder failures are classified once (shape 83)", () => {
	const tree = scanTree();
	const verdicts = tree.map(({ file, source }) => ({
		file,
		...judge(file, source, FINDER_FILES),
	}));

	it(
		"scans a real population, so a broken walk cannot read as clean",
		() => {
			assertNonEmptyScan("finder sweep tree", tree.length, 300);
			assertNonEmptyScan(
				"finder files",
				verdicts.filter((verdict) => verdict.isFinderFile).length,
				FINDER_FILES.length,
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("keeps the table sorted and unique", () => {
		const names = FINDER_FILES.map(([name]) => name);
		expect(names).toEqual([...new Set(names)].sort());
	});

	it(
		"every finder file takes the form its row names, and no other file spells the finder",
		() => {
			const problems = verdicts.flatMap((verdict) => verdict.problems);
			expect(problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"no row outlives its site",
		() => {
			const finderFiles = new Set(
				verdicts.filter((verdict) => verdict.isFinderFile).map((v) => v.file),
			);
			expect(
				FINDER_FILES.map(([name]) => name).filter(
					(name) => !finderFiles.has(name),
				),
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);
});

describe("finder sweep detector self-test (shape 69 plants)", () => {
	const table: ReadonlyArray<readonly [string, FinderForm, string]> = [
		["seam.ts", "seam", "planted"],
		["status.ts", "status-only", "planted"],
	];
	const finder =
		'const f = process.platform === "win32" ? "where" : "which";\n';

	it("reds a new finder file with no row, whichever binding holds the name", () => {
		// Plant 1, an alias: the finder name reaches the spawn through a binding
		// and the classifier through a second one.
		const alias = `${finder}const c = classifyProbeFailure;\nc(result);\n`;
		expect(judge("new.ts", alias, table).problems).toHaveLength(1);
		// A name held in an object member is still a literal in code.
		const member = 'const names = { win32: "where", posix: "which" };\n';
		expect(judge("new.ts", member, table).problems).toHaveLength(1);
	});

	it("reds a seam row that reaches the raw classifier by an indirect call", () => {
		// Plant 2, an indirect call: the classifier is never called by name.
		const indirect = `${finder}classifyFinderFailure(r);\n[classifyProbeFailure].map((c) => c(r));\n`;
		expect(judge("seam.ts", indirect, table).problems).toHaveLength(1);
	});

	it("reds a seam row that reaches the raw classifier through another binding", () => {
		// Plant 3, a value reached through another binding: a namespace member,
		// a destructure rename and a bracket string each mention the name.
		const bindings = [
			"policy.classifyProbeFailure(r);",
			"const { classifyProbeFailure: c } = policy;",
			'policy["classifyProbeFailure"](r);',
		];
		for (const line of bindings) {
			const source = `${finder}classifyFinderFailure(r);\n${line}\n`;
			expect(judge("seam.ts", source, table).problems).toHaveLength(1);
		}
	});

	it("reds a status-only row that parks a verdict in a latch", () => {
		const latched = `${finder}const latch = createAvailabilityLatch();\n`;
		expect(judge("status.ts", latched, table).problems).toHaveLength(1);
	});

	it("admits the two known-good forms and ignores a comment that names the needle", () => {
		const seam = `${finder}classifyFinderFailure(r);\n`;
		expect(judge("seam.ts", seam, table)).toEqual({
			isFinderFile: true,
			problems: [],
		});
		const status = `${finder}run(f);\n`;
		expect(judge("status.ts", status, table).problems).toEqual([]);
		const prose = '// runs "where" then classifyProbeFailure\nconst x = 1;\n';
		expect(judge("other.ts", prose, table)).toEqual({
			isFinderFile: false,
			problems: [],
		});
	});
});
