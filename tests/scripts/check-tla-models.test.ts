import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	TLA_TOOLS,
	classifyTlcOutput,
	listModelConfigs,
	parseModelHeader,
	resolveJarPath,
	verdictMatches,
} from "../../scripts/check-tla-models.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// Trimmed from real TLC 2.19 runs of formal/file-locks.
const TLC_PASS = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Computing initial states...
Model checking completed. No error has been found.
178 states generated, 74 distinct states found, 0 states left on queue.`;
const TLC_VIOLATED = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Error: Invariant MutualExclusion is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>`;
const TLC_PARSE_ERROR = `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)
Error: TLC threw an unexpected exception.
This was probably caused by an error in the spec or model.`;

describe("parseModelHeader (#3447)", () => {
	it("reads a pass expectation and its module", () => {
		expect(
			parseModelHeader("\\* expect: pass\n\\* module: FileLock\nCONSTANTS\n"),
		).toEqual({ module: "FileLock", expect: { status: "pass" } });
	});

	it("reads the invariant a violation expects", () => {
		expect(
			parseModelHeader(
				"\\* expect: violated NoOrphanLock\n\\* module: FileLock\n",
			),
		).toEqual({
			module: "FileLock",
			expect: { status: "violated", invariant: "NoOrphanLock" },
		});
	});

	it.each([
		[
			"no expectation",
			"\\* module: FileLock\n",
			"missing `\\* expect:` header",
		],
		["no module", "\\* expect: pass\n", "missing `\\* module:` header"],
		[
			"a violation with no invariant",
			"\\* expect: violated\n\\* module: FileLock\n",
			'unrecognised expectation "violated"',
		],
		[
			"an unknown verdict",
			"\\* expect: fails\n\\* module: FileLock\n",
			'unrecognised expectation "fails"',
		],
	])("names the header problem: %s", (_label, text, error) => {
		expect(parseModelHeader(text)).toEqual({ error });
	});
});

describe("classifyTlcOutput (#3447)", () => {
	it("reads a completed check as pass", () => {
		expect(classifyTlcOutput(TLC_PASS)).toEqual({ status: "pass" });
	});

	it("reads which invariant was violated", () => {
		expect(classifyTlcOutput(TLC_VIOLATED)).toEqual({
			status: "violated",
			invariant: "MutualExclusion",
		});
	});

	it("reports a spec or tool error rather than a verdict", () => {
		expect(classifyTlcOutput(TLC_PARSE_ERROR)).toEqual({
			status: "error",
			detail: "Error: TLC threw an unexpected exception.",
		});
		expect(classifyTlcOutput("")).toEqual({
			status: "error",
			detail: "no verdict",
		});
	});
});

describe("verdictMatches (#3447)", () => {
	const violated = (invariant: string) =>
		({ status: "violated", invariant }) as const;

	it("matches equal verdicts", () => {
		expect(verdictMatches({ status: "pass" }, { status: "pass" })).toBe(true);
		expect(
			verdictMatches(violated("MutualExclusion"), violated("MutualExclusion")),
		).toBe(true);
	});

	it("reds a fix the config does not record yet, and a hidden bug", () => {
		expect(
			verdictMatches(violated("MutualExclusion"), { status: "pass" }),
		).toBe(false);
		expect(
			verdictMatches({ status: "pass" }, violated("MutualExclusion")),
		).toBe(false);
	});

	it("reds a different invariant or a tool error", () => {
		expect(
			verdictMatches(violated("MutualExclusion"), violated("NoOrphanLock")),
		).toBe(false);
		expect(
			verdictMatches({ status: "pass" }, { status: "error", detail: "x" }),
		).toBe(false);
	});
});

describe("resolveJarPath (#3447)", () => {
	it("makes a relative --jar absolute, since TLC runs from each config's directory", () => {
		const resolved = resolveJarPath(".cache/tla2tools.jar", REPO_ROOT);
		expect(path.isAbsolute(resolved)).toBe(true);
		expect(resolved).toBe(path.resolve(".cache/tla2tools.jar"));
	});

	it("defaults to the repo's .cache/ jar", () => {
		expect(resolveJarPath(undefined, REPO_ROOT)).toBe(
			path.join(REPO_ROOT, ".cache", "tla2tools.jar"),
		);
	});
});

describe("formal/ models (#3447)", () => {
	const configs = listModelConfigs(REPO_ROOT);

	it("every config names its expectation and an existing module", () => {
		assertNonEmptyScan("TLA+ model configs", configs.length, 74);
		const problems = configs.flatMap((config) => {
			const header = parseModelHeader(fs.readFileSync(config, "utf8"));
			const name = path.relative(REPO_ROOT, config);
			if ("error" in header) return [`${name}: ${header.error}`];
			const spec = path.join(path.dirname(config), `${header.module}.tla`);
			return fs.existsSync(spec) ? [] : [`${name}: no ${header.module}.tla`];
		});
		expect(problems).toEqual([]);
	});

	it("CI runs the checker against the pinned tools release", () => {
		const workflow = yaml.load(
			fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8"),
		) as { jobs: Record<string, { steps?: Array<{ run?: string }> }> };
		const runs = Object.values(workflow.jobs).flatMap((job) =>
			(job.steps ?? []).map((step) => step.run ?? ""),
		);
		expect(
			runs.some((run) =>
				/^\s*node scripts\/check-tla-models\.mjs\s*$/m.test(run),
			),
		).toBe(true);
		expect(TLA_TOOLS.url).toContain(`/download/${TLA_TOOLS.release}/`);
	});
});
