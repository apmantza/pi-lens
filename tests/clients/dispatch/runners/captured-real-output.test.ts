/**
 * Replay REAL binary output through each runner's parser (#1937).
 *
 * The vale parser in #1933 read `Data.Files`; vale emits a flat map. The unit
 * tests agreed with the parser because the same author wrote both, so the runner
 * reported "succeeded, 0 findings" while the CLI exited 1 with real errors. A
 * parser that has never met its binary's bytes is the defect; a hand-authored
 * test cannot catch it.
 *
 * Every fixture under `tests/fixtures/runner-output/` holds bytes a real tool
 * actually produced (see `scripts/capture-runner-output.mjs`, which writes the
 * provenance header). This suite copies the fixture's recorded workspace to a
 * temp dir, feeds the captured stdout/stderr/exit code to the runner through the
 * `safeSpawnAsync` seam, and asserts the runner turns them into findings.
 *
 * The availability checker is real, not mocked (#4473). The capture records the
 * answer each runner's probe gets from the real tool, in
 * `fixture.availability`, and this suite answers that exact spawn with those
 * bytes. A tool that REJECTS its probe — helm 4 rejects `--version` — therefore
 * reaches the replay layer instead of being mocked into "installed". Only the
 * process boundary is replaced, plus the measured-presence seam: each probing
 * command gets a stub on a PATH of this suite's own, because presence is a
 * filesystem fact the capture cannot carry, and `verifyOrInstallCommand`
 * short-circuits on it.
 *
 * A parser regression against a real binary now reds here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import {
	listCapturedOutputs,
	materialize,
	materializeClean,
	probeAnswer,
	probeCommandNames,
	WORKSPACE_TOKEN,
} from "../../../helpers/captured-runner-output.js";
import { setupTestEnvironment } from "../../test-utils.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);

const { safeSpawnAsync, getLinterPolicyForCwd } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	getLinterPolicyForCwd: vi.fn(),
}));

// Partial mocks throughout: these modules keep growing exports, and a full
// replacement turns every new one into an unrelated crash in this suite.
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

// Config gates are not what this suite tests — it tests parsers. Force every
// gate open so each runner reaches its parse step.
vi.mock("../../../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getLinterPolicyForCwd,
	markdownlintConfigArgs: () => [],
	hasEslintConfig: () => true,
	hasMypyConfig: () => true,
	hasPhpstanConfig: () => true,
	// Left real: sqlfluff's config presence CHANGES its argv (an unconfigured
	// project gets `--dialect ansi`), so forcing it open would make the argv
	// tie assert against an invocation the fixture never captured.
	hasSqlfluffConfig: (cwd: string) =>
		fs.existsSync(path.join(cwd, ".sqlfluff")),
	hasStylelintConfig: () => true,
	hasYamllintConfig: () => true,
	getAutofixCapability: () => ({
		toolSupportsFix: false,
		safePipelineAutofix: false,
		fixKind: "none",
	}),
}));

/**
 * How to drive one runner: its module basename and the dispatch `kind` its
 * `appliesTo` declares. Keyed by registered runner id.
 *
 * Every captured fixture must appear here — the completeness assertion below
 * fails otherwise, so a new capture cannot land unreplayed.
 */
const RUNNER_DESCRIPTORS: Record<string, { module: string; kind: string }> = {
	actionlint: { module: "actionlint", kind: "yaml" },
	"cpp-check": { module: "cpp-check", kind: "cxx" },
	"cue-vet": { module: "cue-vet", kind: "cue" },
	"dart-analyze": { module: "dart-analyze", kind: "dart" },
	detekt: { module: "detekt", kind: "kotlin" },
	"dotnet-build": { module: "dotnet-build", kind: "csharp" },
	"elixir-check": { module: "elixir-check", kind: "elixir" },
	eslint: { module: "eslint", kind: "jsts" },
	"biome-check-json": { module: "biome-check", kind: "jsts" },
	"fish-indent": { module: "fish-indent", kind: "fish" },
	"gleam-check": { module: "gleam-check", kind: "gleam" },
	"go-vet": { module: "go-vet", kind: "go" },
	"golangci-lint": { module: "golangci-lint", kind: "go" },
	hadolint: { module: "hadolint", kind: "docker" },
	"helm-lint": { module: "helm-lint", kind: "yaml" },
	htmlhint: { module: "htmlhint", kind: "html" },
	javac: { module: "javac", kind: "java" },
	ktlint: { module: "ktlint", kind: "kotlin" },
	markdownlint: { module: "markdownlint", kind: "markdown" },
	mypy: { module: "mypy", kind: "python" },
	oxlint: { module: "oxlint", kind: "jsts" },
	"php-lint": { module: "php-lint", kind: "php" },
	phpstan: { module: "phpstan", kind: "php" },
	pyright: { module: "pyright", kind: "python" },
	rubocop: { module: "rubocop", kind: "ruby" },
	"ruff-lint": { module: "ruff", kind: "python" },
	"rust-clippy": { module: "rust-clippy", kind: "rust" },
	shellcheck: { module: "shellcheck", kind: "shell" },
	shfmt: { module: "shfmt", kind: "shell" },
	spellcheck: { module: "spellcheck", kind: "markdown" },
	sqlfluff: { module: "sqlfluff", kind: "sql" },
	stylelint: { module: "stylelint", kind: "css" },
	swiftlint: { module: "swiftlint", kind: "swift" },
	taplo: { module: "taplo", kind: "toml" },
	terragrunt: { module: "terragrunt", kind: "terragrunt" },
	"trivy-config": { module: "trivy-config", kind: "yaml" },
	tflint: { module: "tflint", kind: "terraform" },
	vale: { module: "vale", kind: "markdown" },
	yamllint: { module: "yamllint", kind: "yaml" },
	"zig-check": { module: "zig-check", kind: "zig" },
};

/**
 * What a fixture's replay must produce beyond "at least one finding". Keyed
 * `<runner>/<case>`. Presence alone passed a fish-indent replay that reported a
 * merely unformatted file as a blocking parse error (#4454), and a helm-lint
 * replay whose path was built from prose (#4453): neither asserts the
 * semantic, the rule, the file or the line.
 */
interface ExpectedFinding {
	rule: string;
	semantic: string;
	/** Workspace-relative, forward slashes. */
	file: string;
	/** Absent when the tool reports the finding with no line. */
	line?: number;
}
interface ReplayExpectation {
	status: string;
	semantic: string;
	findings: ExpectedFinding[];
}
const REPLAY_EXPECTATIONS: Record<string, ReplayExpectation> = {
	// fish_indent 4.9.3 --check prints the file name on stderr and exits 1 for a
	// file that only needs formatting: a fixable warning, never a blocker.
	"fish-indent/real": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{
				rule: "fish-indent-unformatted",
				semantic: "warning",
				file: "unformatted.fish",
				line: 1,
			},
		],
	},
	"fish-indent/smoke-bad": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{
				rule: "fish-indent-unformatted",
				semantic: "warning",
				file: "bad.fish",
				line: 1,
			},
		],
	},
	// fish_indent --check never reports a syntax error, so the runner also asks
	// `fish --no-execute`; its real bytes for the three defects (and the fish-lsp
	// smoke fixture) must reach the agent as a blocking finding on the real file
	// and line (#4454). Each file is already formatted: only fish -n sees it.
	"fish-indent/syntax-missing-end": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "missing-end.fish",
				line: 1,
			},
		],
	},
	"fish-indent/syntax-unterminated-quote": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "unterminated-quote.fish",
				line: 1,
			},
		],
	},
	"fish-indent/syntax-stray-end": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "stray-end.fish",
				line: 2,
			},
		],
	},
	// fish 3.3.1 (Ubuntu 22.04) prints the header of an absolute argv path as `~`
	// plus that path; the attribution dropped every syntax error there (#4454).
	"fish-indent/syntax-stray-end-fish-3.3.1": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "stray-end.fish",
				line: 2,
			},
		],
	},
	"fish-indent/syntax-smoke-bad": {
		status: "failed",
		semantic: "blocking",
		findings: [
			{
				rule: "fish-syntax-error",
				semantic: "blocking",
				file: "bad.fish",
				line: 1,
			},
		],
	},
	"golangci-lint/real": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{ rule: "errcheck", semantic: "warning", file: "bad.go", line: 6 },
			{ rule: "unused", semantic: "warning", file: "bad.go", line: 9 },
		],
	},
	"golangci-lint/config-text-stdout": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{ rule: "errcheck", semantic: "warning", file: "bad.go", line: 6 },
			{ rule: "unused", semantic: "warning", file: "bad.go", line: 9 },
		],
	},
	// ktlint 1.8.0 prints its own `WARN` log line on stdout ahead of the JSON
	// report; reading that stream whole replayed as a parse error, not the
	// finding (#4522). The finding is op-spacing on Bad.kt line 3.
	"ktlint/real": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{
				rule: "standard:op-spacing",
				semantic: "warning",
				file: "Bad.kt",
				line: 3,
			},
		],
	},
	// detekt 1.23.8 emits TEXT reports with no severity token, so its real line
	// is `file:line:col: message [Rule]`; a parser that requires `warning:`
	// dropped every finding (#4522). The rule config the smoke workspace carries
	// activates ForbiddenComment on the TODO comment.
	"detekt/real": {
		status: "succeeded",
		semantic: "warning",
		findings: [
			{
				rule: "ForbiddenComment",
				semantic: "warning",
				file: "Bad.kt",
				line: 2,
			},
		],
	},
	// helm 4.3.0 prefixes the chart name inside the message; the real template
	// is `templates/bad.yaml` line 5, not the prose around it.
	"helm-lint/real": {
		status: "succeeded",
		semantic: "blocking",
		findings: [
			{ rule: "info", semantic: "warning", file: "Chart.yaml" },
			{
				rule: "error",
				semantic: "blocking",
				file: "templates/bad.yaml",
				line: 5,
			},
		],
	},
	// helm does not quote the name in a template parse error, so a name with a
	// space must still resolve to the real file (#4453).
	"helm-lint/space-in-name": {
		status: "succeeded",
		semantic: "blocking",
		findings: [
			{ rule: "info", semantic: "warning", file: "Chart.yaml" },
			{
				rule: "error",
				semantic: "blocking",
				file: "templates/my file.yaml",
				line: 5,
			},
		],
	},
};

/**
 * Version probes are no longer a hand-written list: each fixture records the
 * argv its own checker sends (`availability`), and the replay answers that exact
 * spawn (#4473).
 */
/**
 * True when every token of `needle` appears in `haystack` in the same relative
 * order. Membership alone is not enough: sqlfluff's #1937 argv bug reordered
 * `--dialect` into the middle of `--format json` while keeping every token.
 */
function isOrderedSubsequence(
	needle: readonly string[],
	haystack: readonly string[],
): boolean {
	let cursor = 0;
	for (const token of haystack) {
		if (cursor < needle.length && token === needle[cursor]) cursor++;
	}
	return cursor === needle.length;
}

function createCtx(kind: string, filePath: string, cwd: string) {
	return {
		filePath,
		cwd,
		kind,
		// `no-lsp` is the user kill switch: taplo and oxlint skip the CLI when the
		// language's LSP primary covers the file, and this suite exercises the CLI
		// parser. Production reads the same flag (`lspPrimaryCoversFile`), so the
		// short-circuit closes through the real seam, not a replaced rule.
		pi: { getFlag: (flag: string) => flag === "no-lsp" },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

const FIXTURES = listCapturedOutputs();

describe("captured real-binary output", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue(null);
	});

	it("has at least one captured fixture", () => {
		expect(
			FIXTURES.length,
			"tests/fixtures/runner-output is empty — the replay suite would pass vacuously",
		).toBeGreaterThan(0);
	});

	it("every captured fixture has a replay descriptor", () => {
		const missing = FIXTURES.filter(
			(f) => !RUNNER_DESCRIPTORS[f.provenance.runner],
		).map((f) => `${f.relPath} (runner "${f.provenance.runner}")`);
		expect(
			missing,
			`captured fixture(s) with no RUNNER_DESCRIPTORS entry — add one so the bytes are actually replayed: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("every replay descriptor has a captured fixture", () => {
		const captured = new Set(FIXTURES.map((f) => f.provenance.runner));
		const orphans = Object.keys(RUNNER_DESCRIPTORS).filter(
			(id) => !captured.has(id),
		);
		expect(
			orphans,
			`descriptor(s) for a runner with no captured fixture — capture bytes or drop the entry: ${orphans.join(", ")}`,
		).toEqual([]);
	});

	// #4522 review, "Windows Rust tests fail": rust-clippy resolves cargo
	// through `findCargoPathAsync`, which on Windows answers an absolute
	// `…\cargo.exe`, while the capture records the bare `cargo`. The lookup is
	// by BINARY identity — basename, case-folded, without the platform's own
	// executable suffix — so the same record answers on both lanes; the
	// arguments stay exact, which is what keeps a neighbour's probe out.
	it("matches a probe by binary identity across the platform's exe spelling", () => {
		const rust = FIXTURES.find((f) => f.provenance.runner === "rust-clippy");
		expect(rust, "rust-clippy's captured fixture is missing").toBeTruthy();
		const argv = ["clippy", "--version"];
		for (const spelling of [
			"cargo",
			"CARGO.EXE",
			"C:\\Users\\dev\\.cargo\\bin\\cargo.exe",
			"/home/dev/.cargo/bin/cargo",
		]) {
			expect(
				probeAnswer(rust as never, spelling, argv),
				`${spelling} names the binary the record was captured from`,
			).toBeTruthy();
		}
		// A different binary that merely ends in ".exe" is not this record's.
		expect(
			probeAnswer(
				rust as never,
				"C:\\Users\\dev\\.cargo\\bin\\cargo-nextest.exe",
				argv,
			),
		).toBeUndefined();
		// The arguments are still exact: identity never widens the probe. This
		// argv is nobody's recorded probe (the fixture holds `--version` and
		// `clippy --version`), so a match here would mean the tie had loosened.
		expect(
			probeAnswer(rust as never, "C:\\Users\\dev\\.cargo\\bin\\cargo.exe", [
				"--version",
				"--short",
			]),
		).toBeUndefined();
	});

	/**
	 * Commands the runners resolve by PRESENCE before they spawn anything
	 * (`verifyOrInstallCommand` → `isSpawnableCommand`, a PATH walk). The capture
	 * cannot carry a filesystem fact about the replay host, so each command the
	 * fixtures name gets a non-empty stub on a PATH of this suite's own; the stub
	 * is never executed because `safeSpawnAsync` is the mocked seam.
	 *
	 * Prepended, so the answer is the same on a host that has the tool and on one
	 * that does not: a cell models presence through its spawn answers alone, and
	 * both replay suites resolve it the same way (`probeCommandNames`, #4522 F12).
	 */
	const presenceStub = setupTestEnvironment("pi-lens-captured-bin-");
	const originalPath = process.env.PATH;

	beforeAll(() => {
		for (const name of probeCommandNames(FIXTURES)) {
			fs.writeFileSync(path.join(presenceStub.tmpDir, name), "#!/bin/sh\n", {
				mode: 0o755,
			});
		}
		process.env.PATH = `${presenceStub.tmpDir}${path.delimiter}${originalPath ?? ""}`;
	});

	afterAll(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		presenceStub.cleanup();
	});

	/** File tokens the work-spawn tie drops, in every spelling the runner sends. */
	function fileTokens(file: string): Set<string> {
		return new Set([
			file,
			path.basename(file),
			file.replace(/\\/g, "/"),
			path.relative(".", file).replace(/\\/g, "/"),
		]);
	}

	/**
	 * A spawn is the runner's WORK when it names the analysed file or carries the
	 * recorded invocation in order; everything else must be a recorded probe.
	 * Same tie the matrix uses, so the two suites cannot disagree about which
	 * spawn the captured bytes answer.
	 */
	function isWorkSpawn(
		args: readonly string[],
		tokens: Set<string>,
		recorded: readonly string[],
	): boolean {
		if (
			args.some(
				(token) =>
					tokens.has(token) ||
					tokens.has(path.basename(token)) ||
					tokens.has(path.relative(".", token).replace(/\\/g, "/")),
			)
		) {
			return true;
		}
		if (recorded.length === 0) return false;
		let cursor = 0;
		for (const token of args) {
			if (cursor < recorded.length && token === recorded[cursor]) cursor++;
		}
		return cursor === recorded.length;
	}

	/**
	 * The recorded invocation with the analysed file's tokens dropped, so the
	 * tie can ignore the replay's own temp path.
	 */
	function recordedInvocation(
		argv: readonly string[],
		tokens: Set<string>,
		workspace: string,
	): string[] {
		return argv
			.filter(
				(token) => !tokens.has(token) && !tokens.has(path.basename(token)),
			)
			.map((token) =>
				token.split(WORKSPACE_TOKEN).join(path.resolve(workspace)),
			);
	}

	interface Replay {
		/** Captured bytes to answer the work spawn with. */
		captured: { stdout: string; stderr: string; status: number | null };
		/** The argv tie for that work spawn. */
		recorded: string[];
		/** Workspace-relative path the runner is pointed at. */
		file: string;
		relPath: string;
	}

	/**
	 * Answer every spawn for one replay, and COLLECT any probe the capture did
	 * not record. The availability checker is real here, so an unrecorded probe
	 * means the runner's probe argv drifted from the manifest, and answering it
	 * from the work bytes would hide exactly the class #4473 names.
	 *
	 * The report is collected, not thrown: a runner wraps its spawns in try/catch
	 * (they must never be host-fatal), so a throw here would be swallowed and read
	 * as "tool missing". The case asserts the report is empty.
	 */
	function answerSpawns(
		fixture: {
			availability: ReadonlyArray<{ command: string; argv: string[] }>;
		},
		replay: Replay,
	): { spawned: Array<string[]>; unrecorded: string[] } {
		const tokens = fileTokens(replay.file);
		const spawned: Array<string[]> = [];
		const unrecorded: string[] = [];
		safeSpawnAsync.mockImplementation(
			async (cmd: string, args: string[] = []) => {
				spawned.push([cmd, ...args]);
				if (isWorkSpawn(args, tokens, replay.recorded)) return replay.captured;
				const record = probeAnswer(
					{ availability: fixture.availability } as never,
					cmd,
					args,
				);
				if (!record) {
					unrecorded.push(`${cmd} ${JSON.stringify(args)}`);
					return {
						error: new Error(`no recorded availability answer for ${cmd}`),
						status: null,
						stdout: "",
						stderr: "",
						failure: "spawn",
					};
				}
				return {
					error: null,
					status: record.exitCode,
					stdout: record.stdout,
					stderr: record.stderr,
				};
			},
		);
		return { spawned, unrecorded };
	}

	/**
	 * Drive one runner over one captured payload. Returns the runner's result and
	 * every spawn it made, so each case can assert its own tie and verdict.
	 */
	async function replayPayload(options: {
		runnerId: string;
		module: string;
		kind: string;
		fixture: {
			provenance: { workspace: string; argv: string[] };
			availability: ReadonlyArray<{ command: string; argv: string[] }>;
			relPath: string;
		};
		relPath: string;
		file: string;
		argv: readonly string[];
		payload: (workspace: string) => {
			stdout: string;
			stderr: string;
			status: number | null;
		};
		/** Extra bytes to write into the copied workspace before the run. */
		plant?: (cwd: string) => void;
	}) {
		vi.resetModules();
		const env = setupTestEnvironment(`pi-lens-captured-${options.runnerId}-`);
		const workerHome = process.env.PI_LENS_HOME;
		// Keep every module graph's delayed probe-cache flush inside this case: a
		// durable `probe-cache.json` left by another graph would answer the
		// availability probe the record exists to answer.
		process.env.PI_LENS_HOME = path.join(env.tmpDir, "probe-home");
		try {
			const source = path.join(repoRoot, options.fixture.provenance.workspace);
			fs.cpSync(source, env.tmpDir, { recursive: true });
			options.plant?.(env.tmpDir);
			const filePath = path.join(env.tmpDir, options.file);
			const tokens = fileTokens(options.file);
			const replay: Replay = {
				captured: options.payload(env.tmpDir),
				recorded: recordedInvocation(options.argv, tokens, env.tmpDir),
				file: options.file,
				relPath: options.relPath,
			};
			const answers = answerSpawns(options.fixture, replay);
			const runner = (
				await import(
					`../../../../clients/dispatch/runners/${options.module}.js`
				)
			).default;
			const result = await runner.run(
				createCtx(options.kind, filePath, env.tmpDir) as never,
			);
			return { result, ...answers, env, filePath };
		} finally {
			if (workerHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = workerHome;
		}
	}

	for (const fixture of FIXTURES) {
		const runnerId = fixture.provenance.runner;
		const descriptor = RUNNER_DESCRIPTORS[runnerId];
		if (!descriptor) continue;

		// `vi.resetModules()` gives every case a fresh module graph, so each one
		// re-imports the whole runner tree. On a cold cache — the first run
		// after `npm run build` rewrites the compiled .js — a late case has
		// been observed taking over six seconds, which the 5s default turns
		// into a timeout that reads like a parser failure. The budget is
		// generous because this suite spawns nothing; a real assertion failure
		// still reds immediately.
		it(
			`${runnerId} (${fixture.caseName}) parses findings out of ${fixture.provenance.tool} ${fixture.provenance.version} output`,
			{
				timeout: 30000,
			},
			async () => {
				const { result, spawned, unrecorded, env } = await replayPayload({
					runnerId,
					module: descriptor.module,
					kind: descriptor.kind,
					fixture,
					relPath: fixture.relPath,
					file: fixture.file,
					argv: fixture.provenance.argv ?? [],
					payload: (workspace) => materialize(fixture, workspace),
				});
				try {
					expect(
						unrecorded,
						`${runnerId} (${fixture.caseName}) spawned probe(s) the capture did not record: ${unrecorded.join("; ")}. The availability checker is real here, so an unrecorded probe is answered as a failure. Re-capture with the argv the runner now sends (scripts/capture-runner-fixtures.mjs PROBE_OVERRIDES).`,
					).toEqual([]);
					expect(
						fs.existsSync(path.join(env.tmpDir, fixture.file)),
						`${fixture.relPath}: ${fixture.provenance.workspace}/${fixture.file} is missing`,
					).toBe(true);

					// Argv tie. Captured bytes are evidence about THIS runner only
					// while the runner still asks the tool for them the same way.
					// Order matters, not just membership: sqlfluff's #1937 bug put
					// `--dialect` BETWEEN `--format` and its value, and every token
					// was still present. File paths are dropped, because the runner
					// resolves them to absolute and the capture did not.
					const tokens = fileTokens(fixture.file);
					const recorded = recordedInvocation(
						fixture.provenance.argv ?? [],
						tokens,
						env.tmpDir,
					);
					expect(
						spawned.length,
						`${runnerId} never spawned anything, so the captured bytes prove nothing`,
					).toBeGreaterThan(0);
					expect(
						spawned.some(([, ...argv]) => isOrderedSubsequence(recorded, argv)),
						`${runnerId} spawned none of ${JSON.stringify(spawned)} carrying its fixture's argv ${JSON.stringify(recorded)} in order. Either the runner's invocation drifted from \`${fixture.provenance.command}\`, or the fixture and the scripts/capture-runner-fixtures.mjs manifest need updating to the new argv.`,
					).toBe(true);

					expect(
						result.diagnostics.length,
						`${runnerId} parsed 0 diagnostics out of real ${fixture.provenance.tool} ${fixture.provenance.version} output (exit ${fixture.exitCode}). Re-capture with \`${fixture.provenance.command}\` and fix the parser.`,
					).toBeGreaterThan(0);
					expect(result.status).not.toBe("skipped");
					const expected =
						REPLAY_EXPECTATIONS[`${runnerId}/${fixture.caseName}`];
					if (expected) {
						expect(
							{ status: result.status, semantic: result.semantic },
							`${runnerId} verdict over real ${fixture.provenance.tool} ${fixture.provenance.version} output`,
						).toEqual({
							status: expected.status,
							semantic: expected.semantic,
						});
						expect(
							(result.diagnostics as Array<Record<string, unknown>>).map(
								(diagnostic) => ({
									rule: diagnostic.rule,
									semantic: diagnostic.semantic,
									file: path
										.relative(env.tmpDir, String(diagnostic.filePath))
										.replace(/\\/g, "/"),
									line: diagnostic.line,
								}),
							),
						).toEqual(expected.findings);
						return;
					}
					for (const diagnostic of result.diagnostics as Array<
						Record<string, unknown>
					>) {
						expect(
							diagnostic.message,
							`${runnerId} emitted a blank message`,
						).toBeTruthy();
						expect(
							typeof diagnostic.line === "number" &&
								(diagnostic.line as number) >= 1,
							`${runnerId} emitted a non-positive line number: ${String(diagnostic.line)}`,
						).toBe(true);
					}
				} finally {
					env.cleanup();
				}
			},
		);

		// The clean half (#4522): the same invocation on an input the real tool
		// reports nothing for must parse to nothing. This is the second direction
		// the matrix's clean cell needs — a parser that invents a finding out of a
		// clean report reads an unchecked clean run as dirty, the mirror of K4.
		const clean = fixture.clean;
		if (!clean) continue;
		it(
			`${runnerId} (${fixture.caseName}) parses no findings out of its real clean run`,
			{ timeout: 30000 },
			async () => {
				const { result, spawned, unrecorded, env } = await replayPayload({
					runnerId,
					module: descriptor.module,
					kind: descriptor.kind,
					fixture: {
						...fixture,
						provenance: { ...fixture.provenance, workspace: clean.workspace },
					},
					relPath: `${fixture.relPath} clean`,
					file: clean.file,
					argv: clean.argv,
					// The clean bytes' own paths must name the workspace they replay in,
					// or the runner attributes a finding to a path that does not exist,
					// drops it, and this case passes whatever the bytes say (#4522 F4).
					payload: (workspace) => materializeClean(fixture, workspace),
				});
				try {
					// The clean bytes must name the workspace they replay in. An
					// unresolved `__WORKSPACE__/bad.js` is a path no parser can
					// attribute, so a clean run that DID report something would read
					// clean (#4522 F4). Pinned on the helper, because the fixture
					// below is the only other place the token is spent.
					const spelled = materializeClean(fixture, "/clean-probe");
					expect(
						`${spelled.stdout}${spelled.stderr}`,
						`${fixture.relPath}: the clean run's bytes still carry ${WORKSPACE_TOKEN}, so its paths name no file on the replay host`,
					).not.toContain(WORKSPACE_TOKEN);
					expect(
						unrecorded,
						`${runnerId} (${fixture.caseName}) clean replay spawned probe(s) the capture did not record: ${unrecorded.join("; ")}`,
					).toEqual([]);
					// The clean input is the whole point of the run: without it the
					// captured bytes are a report about nothing, and no parser can be
					// wrong about them (#4522 F4).
					expect(
						fs.existsSync(path.join(env.tmpDir, clean.file)),
						`${fixture.relPath}: the clean workspace ${clean.workspace} holds no ${clean.file}, so the clean run analysed nothing`,
					).toBe(true);
					const tokens = fileTokens(clean.file);
					const recorded = recordedInvocation(clean.argv, tokens, env.tmpDir);
					expect(
						spawned.some(([, ...argv]) => isOrderedSubsequence(recorded, argv)),
						`${runnerId} clean: the runner (${result.status}${result.skipReason ? `/${result.skipReason}` : ""}) spawned none of ${JSON.stringify(spawned)} carrying the captured clean argv ${JSON.stringify(recorded)} in order`,
					).toBe(true);
					expect(
						(result.diagnostics as Array<Record<string, unknown>>).map(
							(diagnostic) => ({
								rule: diagnostic.rule,
								message: diagnostic.message,
								line: diagnostic.line,
							}),
						),
						`${runnerId} turned a real clean ${fixture.provenance.tool} ${clean.version} run (exit ${clean.exitCode}) into findings. The clean cell of the tool-state matrix reads this run as clean, so a parser that invents a finding here contradicts it.`,
					).toEqual([]);
					expect(result.status).not.toBe("failed");
				} finally {
					env.cleanup();
				}
			},
		);
	}
});
