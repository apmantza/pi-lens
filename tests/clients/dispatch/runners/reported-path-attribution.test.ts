// lane: windows-vitest — the case-variant cells below assert the HOST
// filesystem's own case-folding answer, and only a real Windows (or APFS) host
// answers it `true`; that arm is also the per-member mutation signature for the
// eight members whose reported spelling is byte-identical to our argv on POSIX.
// Every boundary mocked here is a process boundary (`safe-spawn`, the
// availability probes, `rust-client`), so the lane needs no Go, Java, Kotlin,
// .NET, Dart, Zig, Rust or CUE toolchain.
/**
 * #3278 — ONE seam answers "is this reported diagnostic about the file I
 * dispatched for?" for every runner:
 * `pathsEqual(path.resolve(<the cwd the tool RAN in>, reported), absTarget)`.
 *
 * Every cell enters through the REAL `createDispatchContext` + `dispatchForFile`
 * + `RunnerRegistry`: the defect is about the relationship between the
 * DISPATCHER's spelling of the file and the TOOL's, and a parser called
 * directly with a hand-made target cannot show it. The project root is always
 * NESTED two levels inside the temp dir and is never `process.cwd()`, so a
 * spelling that is relative to the runner cwd resolves to a DIFFERENT file
 * under the no-base `path.resolve` this change deletes.
 *
 * Recurrence prevented, per direction:
 *
 * - DROPPED (#209 / #3277): the tool's spelling of the edited file differs from
 *   the dispatcher's, the local compare drops every line for that file, and a
 *   run with a real finding is reported clean (or degrades to #1816's
 *   unparseable-output path). Reproduced from upstream source for
 *   `golangci-lint`, whose `PathPrettifier` OVERWRITES `Pos.Filename` with
 *   `filepath.Rel(basePath, …)` before the JSON printer sees it (v1.64.8
 *   `pkg/result/processors/path_prettifier.go:31` + `path_relativity.go:43`).
 * - OVER-MERGED: a DIFFERENT file's finding is attributed to the edited one.
 *   Reproduced from upstream source for `cue-vet`, whose locations are printed
 *   relative to the vet cwd with a `./` prefix (v0.11.0
 *   `cue/errors/errors.go:586-596`), so an imported package's file that merely
 *   SHARES the touched file's basename matched the old
 *   `path.posix.basename(...) === fileName` compare.
 * - CASE: a case-variant spelling must be ONE file exactly where the
 *   filesystem says it is, and two files where it does not — measured, never
 *   assumed from `process.platform`.
 *
 * The other eight members are handed the absolute target as argv and echo it
 * back (MEASURED for gcc 15.2.0 on this host; read from upstream for the rest —
 * see the PR's premise table), so for them the fold is behaviour-preserving
 * TODAY and these cells say so rather than feeding a spelling the tool never
 * emits (#2432: a double that mirrors the assumption proves nothing). Their
 * per-member proof is `tests/config/reported-path-attribution-sweep.test.ts`
 * plus the two mutation directions of the shared predicate.
 *
 * `gleam-check` is the ELEVENTH member and the one this file could not cover
 * when it was written (#3285): its reported spelling arrives inside
 * codespan_reporting's `┌─` locus gutter, an `endsWith` was tolerating that
 * gutter, and #3284 had no captured gleam output to establish the gutter's shape
 * from. Its cells feed a REAL upstream-rendered vector
 * (`tests/fixtures/gleam-codespan/`), so the fold is proven against gleam's own
 * renderer rather than against a guess at it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pinNoCli2OnPath } from "../../../support/no-cli2-on-path.js";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { pathsEqual } from "../../../../clients/path-utils.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync, unavailableCommands, CARGO_PATH } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	/** Commands the availability double reports as absent (cpp-check's MSVC arm). */
	unavailableCommands: { current: new Set<string>() },
	/** rust-clippy resolves cargo through its own client, not the shared probe. */
	CARGO_PATH: "/usr/bin/cargo",
}));

pinNoCli2OnPath();

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => !unavailableCommands.current.has(command),
			isAvailableAsync: async () => !unavailableCommands.current.has(command),
			getCommand: () =>
				unavailableCommands.current.has(command) ? null : command,
		}),
		resolveAvailableOrInstall: async (_c: unknown, toolId: string) =>
			unavailableCommands.current.has(toolId) ? null : toolId,
		resolveToolCommandWithInstallFallback: async (
			_cwd: string,
			toolId: string,
		) => (unavailableCommands.current.has(toolId) ? null : toolId),
		createCwdCachedProbe: () =>
			Object.assign(async () => true, {
				getVerdict: () => ({ outcome: "ok" as const }),
			}),
	}),
);

vi.mock("../../../../clients/rust-client.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/rust-client.js")
	>()),
	rustClient: {
		async findCargoPathAsync() {
			return CARGO_PATH;
		},
	},
}));

/** Text every fixture output carries, so no cell can pass on a diagnostic the
 * runner manufactured for some other reason (an #1816 parse-error row). */
const MARKER = "lens3278";

interface Member {
	/** How the PR body's premise table names this member. */
	name: string;
	/** Runner id, as the registry knows it. */
	runnerId: string;
	modulePath: string;
	/** The dispatched file, POSIX-relative to the project root. */
	file: string;
	/** A DIFFERENT file under the same root, POSIX-relative. */
	sibling: string;
	fileContent: string;
	/** Config files this runner's own gates require before it will spawn. */
	prepare?(root: string): void;
	/** Commands the availability double must report absent. */
	unavailable?: string[];
	/** The tool's real output shape, naming `reported` at line 4 column 5. */
	output(reported: string): {
		status: number;
		stdout?: string;
		stderr?: string;
	};
	/** Dispatch status/semantic when the finding DOES attach. */
	attached: { status: string; semantic: string };
}

/** What a spelling function may read to build the tool's reported path. */
interface Spelling {
	/** The cwd the runner really spawns the tool in. */
	runnerCwd: string;
	/** The absolute path the runner hands the tool as argv. */
	argvPath: string;
	/** A sibling file under the same root, absolute. */
	siblingPath: string;
}

interface Observed {
	status: string | undefined;
	semantic: string | undefined;
	diagnostics: Array<{
		id?: string;
		line?: number;
		column?: number;
		filePath?: string;
		message?: string;
		severity?: string;
		semantic?: string;
	}>;
	dispatchedPath: string;
	reported: string;
}

/**
 * Does THIS filesystem fold case? Measured once against a real temp directory,
 * never asserted from `process.platform` (#3159 round 2: a platform-shaped case
 * claim redded EEXIST on the first real macOS run). APFS and NTFS answer true,
 * ext4 answers false, and every case-variant cell asserts the filesystem's own
 * answer, so ONE cell is live on the ubuntu, macOS and windows lanes with
 * opposite expectations instead of being skipped off Windows.
 */
function hostFoldsPathCase(): boolean {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3278-case-"));
	try {
		fs.writeFileSync(path.join(probe, "probe.txt"), "");
		return fs.existsSync(path.join(probe, "PROBE.txt"));
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
}

const HOST_FOLDS_PATH_CASE = hostFoldsPathCase();

/**
 * Drive ONE runner outcome through the real dispatcher, with the tool reporting
 * whatever `spell` builds from the runner's own resolved cwd and argv path.
 * Throws when the tool was never spawned: a gate-skip that read as "nothing
 * attached" would make every cell here vacuous (#448).
 */
async function dispatch(
	member: Member,
	spell: (spelling: Spelling) => string,
): Promise<Observed> {
	vi.resetModules();
	safeSpawnAsync.mockReset();
	unavailableCommands.current = new Set(member.unavailable ?? []);
	const env = setupTestEnvironment(`pi-lens-3278-${member.runnerId}-`);
	try {
		// NESTED: the runner cwd is never `process.cwd()`, which is what makes a
		// no-base `path.resolve` of the reported spelling observably wrong.
		const root = path.join(env.tmpDir, "workspace", "pkg");
		const absFile = path.join(root, ...member.file.split("/"));
		const absSibling = path.join(root, ...member.sibling.split("/"));
		fs.mkdirSync(path.dirname(absFile), { recursive: true });
		fs.mkdirSync(path.dirname(absSibling), { recursive: true });
		fs.writeFileSync(absFile, member.fileContent);
		fs.writeFileSync(absSibling, member.fileContent);
		member.prepare?.(root);

		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const { resolveRunnerCwd } =
			await import("../../../../clients/tool-cwd.js");
		const runner = (await import(member.modulePath)).default;
		const registry = new RunnerRegistry();
		registry.register(runner);
		const ctx = createDispatchContext(
			absFile,
			root,
			{ getFlag: () => false } as never,
			new FactStore(),
		);
		const runnerCwd = resolveRunnerCwd(ctx, member.runnerId);
		const reported = spell({
			runnerCwd,
			argvPath: path.resolve(runnerCwd, ctx.filePath),
			siblingPath: absSibling,
		});
		const outcome = member.output(reported);
		safeSpawnAsync.mockResolvedValue({
			status: outcome.status,
			stdout: outcome.stdout ?? "",
			stderr: outcome.stderr ?? "",
			error: null,
		} as never);

		let status: string | undefined;
		let semantic: string | undefined;
		let diagnostics: Observed["diagnostics"] = [];
		await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: [member.runnerId] }],
			registry,
			(_runnerId, result) => {
				status = result.status;
				semantic = result.semantic;
				diagnostics = result.diagnostics;
			},
		);
		if (safeSpawnAsync.mock.calls.length === 0) {
			throw new Error(
				`${member.name}: the tool was never spawned — a gate skipped the run, ` +
					"so this cell would assert nothing about path attribution",
			);
		}
		return {
			status,
			semantic,
			diagnostics,
			dispatchedPath: ctx.filePath,
			reported,
		};
	} finally {
		env.cleanup();
	}
}

/** The spelling a tool emits when it names the file relative to its own cwd. */
const cwdRelative =
	(member: Member) =>
	({ runnerCwd, argvPath }: Spelling) =>
		relativePath(runnerCwd, argvPath).split(/[\\/]/).join("/") || member.file;

/** The spelling a tool emits when it echoes the absolute argv path back. */
const echoesArgv = ({ argvPath }: Spelling) => argvPath;

/** The absolute argv spelling with its basename upper-cased. */
const caseVariantOfArgv = ({ argvPath }: Spelling) =>
	path.join(path.dirname(argvPath), path.basename(argvPath).toUpperCase());

/** The absolute spelling of a DIFFERENT file under the same root. */
const echoesSibling = ({ siblingPath }: Spelling) => siblingPath;

/** The tool's finding reached the agent, attributed to the dispatched file. */
function expectAttached(observed: Observed, member: Member): void {
	const attributed = observed.diagnostics.filter((diagnostic) =>
		diagnostic.message?.includes(MARKER),
	);
	expect(attributed).toHaveLength(1);
	expect(attributed[0]?.line).toBe(4);
	expect(
		pathsEqual(attributed[0]?.filePath ?? "", observed.dispatchedPath),
	).toBe(true);
	expect(observed.status).toBe(member.attached.status);
	expect(observed.semantic).toBe(member.attached.semantic);
}

/**
 * The tool's finding did NOT reach the agent as this file's problem. Asserted on
 * the MARKER rather than on `diagnostics.length`, because a nonzero exit whose
 * output parsed to nothing legitimately yields ONE #1816 parse-error row — that
 * row is not the tool's finding and must not make an over-merge look filtered.
 */
function expectDetached(observed: Observed): void {
	expect(
		observed.diagnostics.filter((diagnostic) =>
			diagnostic.message?.includes(MARKER),
		),
	).toEqual([]);
}

/** Exactly what THIS filesystem says about a case-variant spelling. */
function expectFilesystemAnswer(observed: Observed, member: Member): void {
	if (HOST_FOLDS_PATH_CASE) expectAttached(observed, member);
	else expectDetached(observed);
}

function relativePath(from: string, target: string): string {
	const pathApi = /^[A-Za-z]:|^\\/.test(from) ? path.win32 : path.posix;
	const canonicalFrom = fs.realpathSync.native(from);
	const canonicalTarget = fs.realpathSync.native(target);
	return pathApi.relative(canonicalFrom, canonicalTarget);
}
/**
 * gleam's own rendering of a located error, byte-identical to the upstream
 * snapshot it was taken from:
 *
 *   curl -s https://raw.githubusercontent.com/gleam-lang/gleam/v1.18.1/compiler-core/src/type_/tests/snapshots/gleam_core__type___tests__assert__mismatched_types.snap \
 *     | diff - tests/fixtures/gleam-codespan/gleam-v1.18.1-assert-mismatched-types.snap.txt
 *
 * The vector is generated by UPSTREAM code, not by a transcription of it: that
 * snapshot's `----- ERROR` section is `Error::pretty_string()`
 * (`compiler-core/src/error.rs:978-989` at v1.18.1), which writes through the
 * same `Diagnostic::write` → `codespan_reporting::term::emit` the CLI's own
 * error printer uses (`compiler-cli/src/lib.rs:927-940`), into a
 * `Buffer::no_color()` — exactly what `gleam check` writes to stderr when its
 * stderr is a pipe (`compiler-cli/src/cli.rs:189-207`). #2432 is the recurrence:
 * a test double shaped from an issue's DESCRIPTION of a tool's output proves
 * nothing about the tool.
 */
const GLEAM_VECTOR = path.resolve(
	import.meta.dirname,
	"../../../fixtures/gleam-codespan/gleam-v1.18.1-assert-mismatched-types.snap.txt",
);
const GLEAM_WARNING_VECTOR = path.resolve(
	import.meta.dirname,
	"../../../fixtures/gleam-codespan/gleam-v1.18.1-warning-unused-value.snap.txt",
);
const GLEAM_LOCATIONLESS_VECTOR = path.resolve(
	import.meta.dirname,
	"../../../fixtures/gleam-codespan/gleam-v1.18.1-locationless-project-error.snap.txt",
);

/** codespan's locus line inside that vector: `  ┌─ /src/one/two.gleam:1:8`. */
const GLEAM_VECTOR_LOCUS = /^(\s*┌─ )(\S.*):(\d+):(\d+)$/m;

/** The line and column the upstream vector's own locus line names. */
const GLEAM_VECTOR_LINE = 1;
const GLEAM_VECTOR_COLUMN = 8;

/**
 * The upstream vector's error block with ONLY the locus line's file name
 * swapped for `reported` — its gutter, its `:line:column`, its border lines and
 * its snippet stay upstream's bytes. Throws rather than silently degrading if a
 * fixture refresh ever removes the gutter, which is the whole point of the
 * vector.
 */
/**
 * The same rendering as gleam emits when `FORCE_COLOR` is non-empty. codespan
 * styles TWO things on the lines this parser reads, and both sit where a
 * regex anchor would trip over them:
 *
 * - the title line — `render_header` sets the severity style, writes `error`,
 *   switches to the header-message style for `: <message>` and resets at the
 *   end of the line (codespan-reporting 0.13.1 `src/term/renderer.rs:141-171`),
 *   so an escape sequence precedes the very first character of the line;
 * - the locus gutter — `chars().snippet_start` is wrapped in the source-border
 *   style and reset after it (`src/term/renderer.rs:386-388`), cyan by default
 *   (`src/term/config.rs:246`).
 *
 * The exact SGR parameters are codespan's choice; what this pins is the
 * STRUCTURE — an escape sequence before the title's `error`, and one between
 * the line start and the gutter.
 */
function colourRichOutput(rendered: string): string {
	return rendered
		.replace(/^(error|warning): (.*)$/m, "\u001b[1;31m$1\u001b[1m: $2\u001b[0m")
		.replace("┌─", "\u001b[36m┌─\u001b[0m");
}

function gleamCheckStderr(reported: string): string {
	const marker = "----- ERROR\n";
	const upstream = fs.readFileSync(GLEAM_VECTOR, "utf8");
	const rendered = upstream.slice(upstream.indexOf(marker) + marker.length);
	const locus = GLEAM_VECTOR_LOCUS.exec(rendered);
	if (!locus)
		throw new Error(
			`the upstream gleam vector no longer carries a codespan locus line: ${GLEAM_VECTOR}`,
		);
	return rendered.replace(
		locus[0],
		`${locus[1]}${reported}:${locus[3]}:${locus[4]}`,
	);
}

function gleamFixtureStderr(fixture: string, reported?: string): string {
	const rendered = fs.readFileSync(fixture, "utf8");
	const marker = rendered.indexOf("----- ");
	const output = rendered.slice(rendered.indexOf("\n", marker) + 1);
	if (!reported) return output;
	const locus = GLEAM_VECTOR_LOCUS.exec(output);
	if (!locus) throw new Error(`fixture has no codespan locus: ${fixture}`);
	return output.replace(
		locus[0],
		`${locus[1]}${reported}:${locus[3]}:${locus[4]}`,
	);
}

const MEMBERS: Member[] = [
	{
		name: "golangci-lint",
		attached: { status: "succeeded", semantic: "warning" },
		runnerId: "golangci-lint",
		modulePath: "../../../../clients/dispatch/runners/golangci-lint.js",
		file: "sub/b.go",
		sibling: "sub/a.go",
		fileContent: "package sub\n",
		prepare(root) {
			fs.writeFileSync(path.join(root, "go.mod"), "module demo\n");
			fs.writeFileSync(
				path.join(root, ".golangci.yml"),
				"linters:\n  enable:\n    - govet\n",
			);
		},
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify({
				Issues: [
					{
						FromLinter: "govet",
						Text: `printf format %d has arg of wrong type (${MARKER})`,
						Severity: "",
						Pos: { Filename: reported, Offset: 0, Line: 4, Column: 5 },
					},
				],
			}),
		}),
	},
	{
		name: "rust-clippy",
		attached: { status: "succeeded", semantic: "warning" },
		runnerId: "rust-clippy",
		modulePath: "../../../../clients/dispatch/runners/rust-clippy.js",
		file: "src/main.rs",
		sibling: "src/other.rs",
		fileContent: "fn main() {}\n",
		prepare(root) {
			fs.writeFileSync(
				path.join(root, "Cargo.toml"),
				'[package]\nname = "demo"\nversion = "0.1.0"\n',
			);
		},
		output: (reported) => ({
			status: 0,
			stdout: `${JSON.stringify({
				reason: "compiler-message",
				message: {
					code: { code: "unused_variables" },
					message: `unused variable: \`x\` (${MARKER})`,
					level: "warning",
					spans: [{ file_name: reported, line_start: 4, column_start: 5 }],
				},
			})}\n`,
		}),
	},
	{
		name: "javac",
		attached: { status: "failed", semantic: "warning" },
		runnerId: "javac",
		modulePath: "../../../../clients/dispatch/runners/javac.js",
		file: "src/App.java",
		sibling: "src/Other.java",
		fileContent: "class App {}\n",
		output: (reported) => ({
			status: 1,
			stderr: `${reported}:4: error: cannot find symbol (${MARKER})\n`,
		}),
	},
	{
		name: "zig-check",
		attached: { status: "failed", semantic: "warning" },
		runnerId: "zig-check",
		modulePath: "../../../../clients/dispatch/runners/zig-check.js",
		file: "src/main.zig",
		sibling: "src/other.zig",
		fileContent: "pub fn main() void {}\n",
		output: (reported) => ({
			status: 1,
			stderr: `${reported}:4:5: error: expected type 'u8' (${MARKER})\n`,
		}),
	},
	{
		name: "detekt",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "detekt",
		modulePath: "../../../../clients/dispatch/runners/detekt.js",
		file: "src/Main.kt",
		sibling: "src/Other.kt",
		fileContent: "fun main() {}\n",
		prepare(root) {
			fs.writeFileSync(
				path.join(root, "detekt.yml"),
				"build:\n  maxIssues: 0\n",
			);
		},
		output: (reported) => ({
			// #4522: detekt's measured findings exit is 2 (captured real.captured.json).
			status: 2,
			stdout: `${reported}:4:5: error: This expression contains a magic number (${MARKER}) [MagicNumber]\n`,
		}),
	},
	{
		name: "cpp-check (gcc)",
		attached: { status: "failed", semantic: "warning" },
		runnerId: "cpp-check",
		modulePath: "../../../../clients/dispatch/runners/cpp-check.js",
		file: "src/a.c",
		sibling: "src/b.c",
		fileContent: "int main(void){return 0;}\n",
		output: (reported) => ({
			status: 1,
			stderr: `${reported}:4:5: error: 'q' undeclared (${MARKER})\n`,
		}),
	},
	{
		name: "cpp-check (msvc)",
		attached: { status: "failed", semantic: "warning" },
		runnerId: "cpp-check",
		modulePath: "../../../../clients/dispatch/runners/cpp-check.js",
		file: "src/a.c",
		sibling: "src/b.c",
		fileContent: "int main(void){return 0;}\n",
		unavailable: ["clang", "gcc", "cc", "clang++", "g++", "c++"],
		output: (reported) => ({
			status: 1,
			stdout: `${reported}(4,5): error C2065: 'q': undeclared identifier (${MARKER})\n`,
		}),
	},
	{
		name: "dotnet-build",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "dotnet-build",
		modulePath: "../../../../clients/dispatch/runners/dotnet-build.js",
		file: "Program.cs",
		sibling: "Other.cs",
		fileContent: "class Program {}\n",
		prepare(root) {
			fs.writeFileSync(
				path.join(root, "Demo.csproj"),
				'<Project Sdk="Microsoft.NET.Sdk" />\n',
			);
		},
		output: (reported) => ({
			status: 1,
			stdout: `${reported}(4,5): error CS0103: The name 'q' does not exist (${MARKER})\n`,
		}),
	},
	{
		name: "dart-analyze",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "dart-analyze",
		modulePath: "../../../../clients/dispatch/runners/dart-analyze.js",
		file: "lib/main.dart",
		sibling: "lib/other.dart",
		fileContent: "void main() {}\n",
		output: (reported) => ({
			status: 1,
			stderr: `ERROR|COMPILE_TIME_ERROR|UNDEFINED_IDENTIFIER|${reported}|4|5|3|Undefined name 'q' (${MARKER})\n`,
		}),
	},
	{
		name: "cue-vet",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "cue-vet",
		modulePath: "../../../../clients/dispatch/runners/cue-vet.js",
		file: "config.cue",
		sibling: "sub/config.cue",
		fileContent: "package demo\n\na: int\n",
		output: (reported) => ({
			status: 1,
			stderr: `a: conflicting values int and "hello" (${MARKER}):\n    ${reported}:4:5\n`,
		}),
	},
	{
		name: "taplo",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "taplo",
		modulePath: "../../../../clients/dispatch/runners/taplo.js",
		file: "src/app.toml",
		sibling: "src/other.toml",
		fileContent: "[package\n",
		output: (reported) => ({
			status: 1,
			stderr: `error: invalid TOML ${MARKER}\n  ┌─ ${reported}:4:5\n  │\n4 │ [package\n`,
		}),
	},
	{
		name: "yamllint",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "yamllint",
		modulePath: "../../../../clients/dispatch/runners/yamllint.js",
		file: "src/app.yaml",
		sibling: "src/other.yaml",
		fileContent: "name: a\nname: b\n",
		output: (reported) => ({
			status: 1,
			stdout: `${reported}:4:5: [error] ${MARKER} (key-duplicates)\n`,
		}),
	},
	{
		name: "htmlhint",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "htmlhint",
		modulePath: "../../../../clients/dispatch/runners/htmlhint.js",
		file: "src/app.html",
		sibling: "src/other.html",
		fileContent: "<div>\n",
		output: (reported) => ({
			status: 1,
			stdout: `${reported}:4:5: ${MARKER} [error/tag-pair]\n`,
		}),
	},
	{
		name: "oxlint",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "oxlint",
		modulePath: "../../../../clients/dispatch/runners/oxlint.js",
		file: "src/app.js",
		sibling: "src/other.js",
		fileContent: "debugger;\n",
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify({
				diagnostics: [
					{
						message: MARKER,
						code: "eslint(no-debugger)",
						severity: "error",
						filename: reported,
						labels: [{ span: { line: 4, column: 5 } }],
					},
				],
				number_of_files: 1,
				number_of_rules: 1,
				threads_count: 1,
				start_time: 0,
			}),
		}),
	},
	{
		name: "gleam-check",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "gleam-check",
		modulePath: "../../../../clients/dispatch/runners/gleam-check.js",
		file: "src/app.gleam",
		sibling: "src/other.gleam",
		fileContent: "pub fn main() {\n  assert 10\n}\n",
		prepare(root) {
			// gleam's own root rule and ours are the same marker: the CLI walks up
			// for `gleam.toml` (`compiler-cli/src/fs.rs:46-62`) and
			// `clients/language-profile.ts:63` anchors the runner cwd on it.
			fs.writeFileSync(path.join(root, "gleam.toml"), 'name = "demo"\n');
		},
		// gleam check takes no file argument; it compiles the project and prints
		// through codespan, to STDERR (`compiler-cli/src/lib.rs:927-940`).
		output: (reported) => ({ status: 1, stderr: gleamCheckStderr(reported) }),
	},
	{
		name: "gleam-check (colour-forced)",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "gleam-check",
		modulePath: "../../../../clients/dispatch/runners/gleam-check.js",
		file: "src/app.gleam",
		sibling: "src/other.gleam",
		fileContent: "pub fn main() {\n  assert 10\n}\n",
		prepare(root) {
			fs.writeFileSync(path.join(root, "gleam.toml"), 'name = "demo"\n');
		},
		output: (reported) => ({
			status: 1,
			stderr: colourRichOutput(gleamCheckStderr(reported)),
		}),
	},
	{
		name: "gleam-check (located warning)",
		attached: { status: "failed", semantic: "warning" },
		runnerId: "gleam-check",
		modulePath: "../../../../clients/dispatch/runners/gleam-check.js",
		file: "src/app.gleam",
		sibling: "src/other.gleam",
		fileContent: "pub fn main() {\n  let unused = 1\n}\n",
		prepare(root) {
			fs.writeFileSync(path.join(root, "gleam.toml"), 'name = "demo"\n');
		},
		output: (reported) => ({
			status: 1,
			stderr: gleamFixtureStderr(GLEAM_WARNING_VECTOR, reported),
		}),
	},
	{
		name: "gleam-check (locationless diagnostic)",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "gleam-check",
		modulePath: "../../../../clients/dispatch/runners/gleam-check.js",
		file: "src/app.gleam",
		sibling: "src/other.gleam",
		fileContent: "pub fn main() {\n  let unused = 1\n}\n",
		prepare(root) {
			fs.writeFileSync(path.join(root, "gleam.toml"), 'name = "demo"\n');
		},
		output: () => ({
			status: 1,
			stderr: gleamFixtureStderr(GLEAM_LOCATIONLESS_VECTOR),
		}),
	},
	{
		name: "gleam-check (adjacent diagnostics)",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "gleam-check",
		modulePath: "../../../../clients/dispatch/runners/gleam-check.js",
		file: "src/app.gleam",
		sibling: "src/other.gleam",
		fileContent: "pub fn main() {\n  assert 10\n}\n",
		prepare(root) {
			fs.writeFileSync(path.join(root, "gleam.toml"), 'name = "demo"\n');
		},
		output: (reported) => ({
			status: 1,
			stderr: `${gleamCheckStderr(reported)}\n${gleamFixtureStderr(
				GLEAM_WARNING_VECTOR,
				reported,
			)}`,
		}),
	},
	{
		name: "gleam-check (orphan locus)",
		attached: { status: "failed", semantic: "blocking" },
		runnerId: "gleam-check",
		modulePath: "../../../../clients/dispatch/runners/gleam-check.js",
		file: "src/app.gleam",
		sibling: "src/other.gleam",
		fileContent: "pub fn main() {\n  assert 10\n}\n",
		prepare(root) {
			fs.writeFileSync(path.join(root, "gleam.toml"), 'name = "demo"\n');
		},
		output: (reported) => ({
			status: 1,
			stderr: `  ┌─ ${reported}:1:8\n  │\n1 │ assert 10\n  │        ^^\n`,
		}),
	},
];

const [
	golangciLint,
	rustClippy,
	javac,
	zigCheck,
	detekt,
	cppCheckGcc,
	cppCheckMsvc,
	dotnetBuild,
	dartAnalyze,
	cueVet,
	taplo,
	yamllint,
	htmlhint,
	oxlint,
	gleamCheck,
	gleamCheckColoured,
	gleamCheckWarning,
	gleamCheckLocationless,
	gleamCheckAdjacent,
	gleamCheckOrphan,
] = MEMBERS;

describe("runner reported-path attribution (#3295)", () => {
	it.each([
		["taplo", taplo],
		["yamllint", yamllint],
		["htmlhint", htmlhint],
		["oxlint", oxlint],
	] as const)("%s keeps its own reported location", async (_name, member) => {
		expectAttached(await dispatch(member, cwdRelative(member)), member);
	});

	it.each([
		["taplo", taplo],
		["yamllint", yamllint],
		["htmlhint", htmlhint],
		["oxlint", oxlint],
	] as const)(
		"%s rejects a sibling reported location",
		async (_name, member) => {
			expectDetached(await dispatch(member, echoesSibling));
		},
	);
});

/** `cue` prefixes a cwd-relative position with `./` (v0.11.0 errors.go:590-596). */
const cueRelative =
	(target: (spelling: Spelling) => string) => (spelling: Spelling) =>
		`./${relativePath(spelling.runnerCwd, target(spelling))
			.split(/[\\/]/)
			.join("/")}`;

// ── golangci-lint — reproduced defect (relative Pos.Filename) ────────────────

describe("golangci-lint reported-path attribution (#3278)", () => {
	it("attributes a cwd-relative golangci-lint Pos.Filename to the dispatched file (#3278)", async () => {
		const observed = await dispatch(golangciLint, cwdRelative(golangciLint));
		expect(observed.reported).toBe("sub/b.go");
		expectAttached(observed, golangciLint);
	});

	it("does not attribute a sibling Go file's golangci-lint finding to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(golangciLint, echoesSibling));
	});

	it("treats a case-variant golangci-lint path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(golangciLint, caseVariantOfArgv),
			golangciLint,
		);
	});
});

// ── cue-vet — reproduced defect (basename over-merge) ────────────────────────

describe("cue-vet reported-path attribution (#3278)", () => {
	it("does not attribute a sibling-directory cue location that shares the touched file's basename (#3278)", async () => {
		const observed = await dispatch(cueVet, cueRelative(echoesSibling));
		expect(observed.reported).toBe("./sub/config.cue");
		expectDetached(observed);
	});

	it("attributes a './'-prefixed cue location for the touched file itself (#3278)", async () => {
		const observed = await dispatch(cueVet, cueRelative(echoesArgv));
		expect(observed.reported).toBe("./config.cue");
		expectAttached(observed, cueVet);
	});

	it("treats a case-variant cue location exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(await dispatch(cueVet, caseVariantOfArgv), cueVet);
	});
});

// ── the eight argv-echo members — two-directional contract pins ──────────────

describe("rust-clippy reported-path attribution (#3278)", () => {
	it("attributes a package-relative clippy span to the dispatched file (#3278)", async () => {
		expectAttached(
			await dispatch(rustClippy, cwdRelative(rustClippy)),
			rustClippy,
		);
	});

	it("does not attribute a crate-mate's clippy span to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(rustClippy, echoesSibling));
	});

	it("treats a case-variant clippy span exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(rustClippy, caseVariantOfArgv),
			rustClippy,
		);
	});
});

describe("javac reported-path attribution (#3278)", () => {
	it("attributes the absolute path javac echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(javac, echoesArgv), javac);
	});

	it("does not attribute a sibling Java file's javac error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(javac, echoesSibling));
	});

	it("treats a case-variant javac path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(await dispatch(javac, caseVariantOfArgv), javac);
	});
});

describe("zig-check reported-path attribution (#3278)", () => {
	it("attributes the absolute path zig echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(zigCheck, echoesArgv), zigCheck);
	});

	it("does not attribute a sibling Zig file's error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(zigCheck, echoesSibling));
	});

	it("treats a case-variant zig path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(zigCheck, caseVariantOfArgv),
			zigCheck,
		);
	});
});

describe("detekt reported-path attribution (#3278)", () => {
	it("attributes the absolute path detekt echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(detekt, echoesArgv), detekt);
	});

	it("does not attribute a sibling Kotlin file's detekt finding to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(detekt, echoesSibling));
	});

	it("treats a case-variant detekt path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(await dispatch(detekt, caseVariantOfArgv), detekt);
	});
});

describe("cpp-check gcc-flavour reported-path attribution (#3278)", () => {
	it("attributes the absolute path gcc echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(cppCheckGcc, echoesArgv), cppCheckGcc);
	});

	it("does not attribute an included header's gcc error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(cppCheckGcc, echoesSibling));
	});

	it("treats a case-variant gcc path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(cppCheckGcc, caseVariantOfArgv),
			cppCheckGcc,
		);
	});
});

describe("cpp-check msvc-flavour reported-path attribution (#3278)", () => {
	it("attributes the absolute path cl echoes back to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(cppCheckMsvc, echoesArgv), cppCheckMsvc);
	});

	it("does not attribute another translation unit's cl error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(cppCheckMsvc, echoesSibling));
	});

	it("treats a case-variant cl path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(cppCheckMsvc, caseVariantOfArgv),
			cppCheckMsvc,
		);
	});
});

describe("dotnet-build reported-path attribution (#3278)", () => {
	it("attributes the full path MSBuild reports to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(dotnetBuild, echoesArgv), dotnetBuild);
	});

	it("does not attribute a sibling C# file's compiler error to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(dotnetBuild, echoesSibling));
	});

	it("treats a case-variant MSBuild path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(dotnetBuild, caseVariantOfArgv),
			dotnetBuild,
		);
	});
});

describe("dart-analyze reported-path attribution (#3278)", () => {
	it("attributes the absolute path dart analyze reports to the dispatched file (#3278)", async () => {
		expectAttached(await dispatch(dartAnalyze, echoesArgv), dartAnalyze);
	});

	// The `endsWith` arm this fold deleted accepted ANY reported path whose TAIL
	// spelled the dispatched file, with no separator or case rule of its own.
	it("does not attribute a sibling Dart file's diagnostic to the dispatched file (#3278)", async () => {
		expectDetached(await dispatch(dartAnalyze, echoesSibling));
	});

	it("treats a case-variant dart path exactly as this filesystem does (#3278)", async () => {
		expectFilesystemAnswer(
			await dispatch(dartAnalyze, caseVariantOfArgv),
			dartAnalyze,
		);
	});
});

// ── gleam-check — the codespan gutter member (#3285) ─────────────────────────

/**
 * gleam's finding is recognized by the LINE:COLUMN the upstream vector's locus
 * names, not by a marker in the message. The message comes from the title
 * before that locus plus an optional `^^` label, never the empty border `│`.
 */
function gleamFindings(observed: Observed) {
	return observed.diagnostics.filter(
		(diagnostic) =>
			diagnostic.line === GLEAM_VECTOR_LINE &&
			diagnostic.column === GLEAM_VECTOR_COLUMN,
	);
}

function expectGleamAttached(observed: Observed, member: Member): void {
	const attributed = gleamFindings(observed);
	expect(attributed).toHaveLength(1);
	expect(attributed[0]?.filePath).toBe(observed.dispatchedPath);
	expect(attributed[0]?.message).toBe("error: Type mismatch");
	expect(observed.status).toBe(member.attached.status);
	expect(observed.semantic).toBe(member.attached.semantic);
}

function expectGleamDetached(observed: Observed): void {
	expect(gleamFindings(observed)).toEqual([]);
}

describe("gleam-check reported-path attribution (#3285)", () => {
	it("pins the upstream gleam vector's codespan locus gutter (#3285)", () => {
		// The vector is the premise. If a refresh ever drops the gutter or the
		// `:line:column` suffix, the cells below would silently stop covering the
		// shape that made #3284 revert its fold.
		const upstream = fs.readFileSync(GLEAM_VECTOR, "utf8");
		expect(upstream).toContain("----- ERROR\nerror: Type mismatch\n");
		expect(upstream).toContain(
			`  ┌─ /src/one/two.gleam:${GLEAM_VECTOR_LINE}:${GLEAM_VECTOR_COLUMN}`,
		);
		expect(gleamCheckStderr("/abs/proj/src/app.gleam")).toContain(
			`  ┌─ /abs/proj/src/app.gleam:${GLEAM_VECTOR_LINE}:${GLEAM_VECTOR_COLUMN}`,
		);
	});

	it("attributes a codespan-guttered gleam locus line to the dispatched file (#3285)", async () => {
		const observed = await dispatch(gleamCheck, echoesArgv);
		// gleam's `location.path` is absolute by construction: the CLI walks up
		// from the absolute cwd to `gleam.toml` and joins `src`
		// (`compiler-cli/src/fs.rs:32-62`, `compiler-core/src/paths.rs:42-48`).
		// `reported` is built with host `path.resolve` (backslashes on Windows)
		// while `ctx.filePath` carries the dispatcher's forward-slash spelling;
		// compare the same file in one spelling, still byte-exact (#4019).
		expect(observed.reported).toBe(path.resolve(observed.dispatchedPath));
		expectGleamAttached(observed, gleamCheck);
	});

	// gleam colours whenever FORCE_COLOR is non-empty, whatever stderr is
	// (`compiler-cli/src/cli.rs:194-207`). The pre-#3285 suffix compare never saw
	// the locus line's prefix; an anchored capture without `stripAnsi` refuses
	// the whole line and drops every diagnostic in that environment. Recurrence
	// prevented (#3293): the TITLE line is styled too, so the same anchored
	// capture would refuse the message this PR reads and fall back to the
	// project record — `expectGleamAttached` pins the decoded title here.
	it("still attributes a colour-forced gleam locus line (#3285)", async () => {
		const observed = await dispatch(gleamCheckColoured, echoesArgv);
		expectGleamAttached(observed, gleamCheckColoured);
	});

	it("keeps a located warning title and label, without the border glyph (#3293)", async () => {
		const observed = await dispatch(gleamCheckWarning, echoesArgv);
		const finding = gleamFindings(observed)[0];
		expect(finding?.message).toBe(
			"warning: Unused value — this value is never used",
		);
		expect(finding?.message).not.toContain("│");
		expect(finding?.severity).toBe("warning");
		expect(observed.status).toBe("failed");
		expect(observed.semantic).toBe("blocking");
	});

	it("keeps a locationless project diagnostic unattributed (#3293)", async () => {
		const observed = await dispatch(gleamCheckLocationless, echoesArgv);
		// Recurrence prevented (#3293): `gleam check` analyzes the whole project,
		// so a diagnostic without a reported locus must not be charged to the file
		// that happened to trigger this project-scoped runner. It reaches the
		// existing nonzero-without-diagnostics project fallback instead.
		expect(observed.diagnostics).toHaveLength(1);
		expect(observed.diagnostics[0]).toMatchObject({
			id: "gleam-check-nonzero-no-diagnostics",
			message: "error: Could not find a package required by this project",
			severity: "warning",
			semantic: "warning",
			runnerFault: true,
		});
		expect(observed.diagnostics[0]?.line).toBeUndefined();
		expect(observed.diagnostics[0]?.column).toBeUndefined();
	});

	it("does not use the next diagnostic title as the prior label (#3293)", async () => {
		const observed = await dispatch(gleamCheckAdjacent, echoesArgv);
		expect(observed.diagnostics.map((finding) => finding.message)).toEqual([
			"error: Type mismatch",
			"warning: Unused value — this value is never used",
		]);
	});

	it("uses the bounded fallback for a locus with no title (#3293)", async () => {
		const observed = await dispatch(gleamCheckOrphan, echoesArgv);
		expect(observed.diagnostics).toHaveLength(1);
		expect(observed.diagnostics[0]).toMatchObject({
			id: "gleam-check-nonzero-no-diagnostics",
		});
		expect(observed.diagnostics[0]?.line).toBeUndefined();
		expect(observed.diagnostics[0]?.column).toBeUndefined();
	});

	// The over-merge direction: one gleam diagnostic renders one locus line PER
	// FILE GROUP — an extra label in another module adds a second `files.add`
	// and a second `┌─` line (`compiler-core/src/diagnostic.rs:100-113`) — so a
	// sibling module's locus must not be charged to the edited file.
	it("does not attribute a sibling gleam module's guttered locus line (#3285)", async () => {
		expectGleamDetached(await dispatch(gleamCheck, echoesSibling));
	});

	// Recurrence prevented (#209 / #3277): on Windows gleam joins OUR cwd
	// spelling with the on-disk filename case from its own directory walk, so a
	// case-variant spelling is reachable there, and the pre-#3285 `endsWith`
	// dropped every diagnostic for the edited file. The opposite direction
	// matters just as much: on a case-SENSITIVE host these are two files and a
	// sibling's error must not attach.
	it("treats a case-variant gleam locus path exactly as this filesystem does (#3285)", async () => {
		const observed = await dispatch(gleamCheck, caseVariantOfArgv);
		if (HOST_FOLDS_PATH_CASE) expectGleamAttached(observed, gleamCheck);
		else expectGleamDetached(observed);
	});
});

// Round-2 JSON members stay in their own tail block so the concurrent gleam
// extraction work in this file has a stable merge boundary. These cells enter
// through dispatchForFile and prevent the JSON parser from stamping a sibling's
// finding onto the dispatched file (#3304 M3304-F7).
describe("JSON runner reported-path attribution (#3304)", () => {
	const shellcheckMember: Member = {
		name: "shellcheck",
		runnerId: "shellcheck",
		modulePath: "../../../../clients/dispatch/runners/shellcheck.js",
		file: "src/app.sh",
		sibling: "src/other.sh",
		fileContent: "echo ok\n",
		attached: { status: "succeeded", semantic: "warning" },
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify([
				{
					file: reported,
					line: 4,
					column: 5,
					level: "warning",
					code: 2154,
					message: MARKER,
				},
			]),
		}),
	};

	const trivyMember: Member = {
		name: "trivy-config",
		runnerId: "trivy-config",
		modulePath: "../../../../clients/dispatch/runners/trivy-config.js",
		file: "src/main.tf",
		sibling: "src/other.tf",
		fileContent: 'resource "x" "y" {}\n',
		attached: { status: "succeeded", semantic: "warning" },
		prepare(root) {
			fs.writeFileSync(
				path.join(root, ".pi-lens.json"),
				JSON.stringify({ trivy: { enabled: true } }),
			);
		},
		output: (reported) => ({
			status: 0,
			stdout: JSON.stringify({
				Results: [
					{
						Target: reported,
						Misconfigurations: [
							{
								ID: "TEST001",
								Title: MARKER,
								Severity: "HIGH",
								CauseMetadata: { StartLine: 4 },
							},
						],
					},
				],
			}),
		}),
	};

	it.each([
		["shellcheck", shellcheckMember],
		["trivy-config", trivyMember],
	] as const)("%s keeps its own JSON path", async (_name, member) => {
		expectAttached(await dispatch(member, cwdRelative(member)), member);
	});

	it.each([
		["shellcheck", shellcheckMember],
		["trivy-config", trivyMember],
	] as const)("%s rejects a sibling JSON path", async (_name, member) => {
		expectDetached(await dispatch(member, echoesSibling));
	});
});

/**
 * #3295 round 3 — the members the two earlier no-predicate censuses could not
 * see, because each enumerated path SHAPES (round 1: `:(\d+):(\d+)` captures;
 * round 2: two JSON field NAMES) instead of asking the inverted question the
 * census now asks: does this file build a diagnostic, from parsed tool output,
 * stamped with the DISPATCHED path, holding no identity predicate?
 *
 * Recurrence prevented: the over-merge direction of #209 / #3277 / #3278 — a
 * SECOND file's finding delivered as the edited file's problem. The r2 reviewer
 * proved it live for `stylelint` (a finding whose `source` was `src/other.css`
 * arrived on `src/app.css`); every runner below is the same shape through the
 * same seam, so each gets its own two cells rather than riding stylelint's.
 *
 * Every cell enters through the REAL `createDispatchContext` +
 * `dispatchForFile` + `RunnerRegistry`, with only the process boundary mocked.
 */
describe("no-predicate runner reported-path attribution (#3295 r3)", () => {
	const stylelintMember: Member = {
		name: "stylelint",
		runnerId: "stylelint",
		modulePath: "../../../../clients/dispatch/runners/stylelint.js",
		file: "src/app.css",
		sibling: "src/other.css",
		fileContent: "a { color: red }\n",
		attached: { status: "succeeded", semantic: "warning" },
		prepare(root) {
			fs.writeFileSync(path.join(root, ".stylelintrc.json"), "{}");
		},
		output: (reported) => ({
			status: 2,
			stdout: JSON.stringify([
				{
					source: reported,
					warnings: [
						{
							line: 4,
							column: 5,
							rule: "color-named",
							severity: "warning",
							text: MARKER,
						},
					],
				},
			]),
		}),
	};

	const rubocopMember: Member = {
		name: "rubocop",
		runnerId: "rubocop",
		modulePath: "../../../../clients/dispatch/runners/rubocop.js",
		file: "src/app.rb",
		sibling: "src/other.rb",
		fileContent: "puts 1\n",
		attached: { status: "succeeded", semantic: "warning" },
		output: (reported) => ({
			status: 0,
			stdout: JSON.stringify({
				files: [
					{
						path: reported,
						offenses: [
							{
								severity: "convention",
								message: MARKER,
								cop_name: "Style/Test",
								correctable: false,
								location: { line: 4, column: 5 },
							},
						],
					},
				],
			}),
		}),
	};

	const eslintMember: Member = {
		name: "eslint",
		runnerId: "eslint",
		modulePath: "../../../../clients/dispatch/runners/eslint.js",
		file: "src/app.ts",
		sibling: "src/other.ts",
		fileContent: "export const a = 1;\n",
		attached: { status: "succeeded", semantic: "warning" },
		prepare(root) {
			fs.writeFileSync(
				path.join(root, "eslint.config.js"),
				"export default [];\n",
			);
		},
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify([
				{
					filePath: reported,
					messages: [
						{
							ruleId: "no-test",
							severity: 1,
							message: MARKER,
							line: 4,
							column: 5,
						},
					],
				},
			]),
		}),
	};

	const biomeMember: Member = {
		name: "biome-check",
		runnerId: "biome-check-json",
		modulePath: "../../../../clients/dispatch/runners/biome-check.js",
		file: "src/app.ts",
		sibling: "src/other.ts",
		fileContent: "export const a = 1;\n",
		attached: { status: "succeeded", semantic: "warning" },
		prepare(root) {
			fs.writeFileSync(path.join(root, "biome.json"), "{}");
		},
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify({
				diagnostics: [
					{
						severity: "warning",
						category: "lint/test",
						message: MARKER,
						location: {
							path: reported,
							start: { line: 4, column: 5 },
							end: { line: 4, column: 6 },
						},
					},
				],
			}),
		}),
	};

	const tflintMember: Member = {
		name: "tflint",
		runnerId: "tflint",
		modulePath: "../../../../clients/dispatch/runners/tflint.js",
		file: "src/main.tf",
		sibling: "src/other.tf",
		fileContent: 'resource "x" "y" {}\n',
		attached: { status: "succeeded", semantic: "warning" },
		output: (reported) => ({
			status: 2,
			stdout: JSON.stringify({
				issues: [
					{
						rule: { name: "test_rule", severity: "warning" },
						message: MARKER,
						range: { filename: reported, start: { line: 4, column: 5 } },
					},
				],
				errors: [],
			}),
		}),
	};

	const swiftlintMember: Member = {
		name: "swiftlint",
		runnerId: "swiftlint",
		modulePath: "../../../../clients/dispatch/runners/swiftlint.js",
		file: "src/app.swift",
		sibling: "src/other.swift",
		fileContent: "let a = 1\n",
		attached: { status: "succeeded", semantic: "warning" },
		output: (reported) => ({
			status: 0,
			stdout: JSON.stringify([
				{
					file: reported,
					line: 4,
					character: 5,
					severity: "Warning",
					reason: MARKER,
					rule_id: "test_rule",
				},
			]),
		}),
	};

	const ktlintMember: Member = {
		name: "ktlint",
		runnerId: "ktlint",
		modulePath: "../../../../clients/dispatch/runners/ktlint.js",
		file: "src/App.kt",
		sibling: "src/Other.kt",
		fileContent: "val a = 1\n",
		attached: { status: "succeeded", semantic: "warning" },
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify([
				{
					file: reported,
					errors: [
						{ line: 4, column: 5, message: MARKER, rule: "standard:test" },
					],
				},
			]),
		}),
	};

	const hadolintMember: Member = {
		name: "hadolint",
		runnerId: "hadolint",
		modulePath: "../../../../clients/dispatch/runners/hadolint.js",
		file: "src/Dockerfile",
		sibling: "src/Dockerfile.other",
		fileContent: "FROM alpine\n",
		attached: { status: "failed", semantic: "warning" },
		output: (reported) => ({
			status: 0,
			stdout: JSON.stringify([
				{
					file: reported,
					line: 4,
					column: 5,
					level: "warning",
					code: "DL3000",
					message: MARKER,
				},
			]),
		}),
	};

	const actionlintMember: Member = {
		name: "actionlint",
		runnerId: "actionlint",
		modulePath: "../../../../clients/dispatch/runners/actionlint.js",
		file: ".github/workflows/ci.yml",
		sibling: ".github/workflows/other.yml",
		fileContent: "on: push\njobs: {}\n",
		attached: { status: "failed", semantic: "blocking" },
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify([
				{
					message: MARKER,
					filepath: reported,
					line: 4,
					column: 5,
					kind: "syntax-check",
				},
			]),
		}),
	};

	const spellcheckMember: Member = {
		name: "spellcheck",
		runnerId: "spellcheck",
		modulePath: "../../../../clients/dispatch/runners/spellcheck.js",
		file: "docs/app.md",
		sibling: "docs/other.md",
		fileContent: "# hello\n",
		attached: { status: "failed", semantic: "warning" },
		output: (reported) => ({
			status: 2,
			stdout: JSON.stringify({
				path: reported,
				line_num: 4,
				byte_offset: 5,
				typo: MARKER,
				corrections: ["marker"],
			}),
		}),
	};

	const sqlfluffMember: Member = {
		name: "sqlfluff",
		runnerId: "sqlfluff",
		modulePath: "../../../../clients/dispatch/runners/sqlfluff.js",
		file: "src/app.sql",
		sibling: "src/other.sql",
		fileContent: "select 1\n",
		attached: { status: "failed", semantic: "warning" },
		prepare(root) {
			fs.writeFileSync(
				path.join(root, ".sqlfluff"),
				"[sqlfluff]\ndialect = ansi\n",
			);
		},
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify([
				{
					filepath: reported,
					violations: [
						{ code: "LT01", description: MARKER, line_no: 4, line_pos: 5 },
					],
				},
			]),
		}),
	};

	const valeMember: Member = {
		name: "vale",
		runnerId: "vale",
		modulePath: "../../../../clients/dispatch/runners/vale.js",
		file: "docs/app.md",
		sibling: "docs/other.md",
		fileContent: "# hello\n",
		attached: { status: "succeeded", semantic: "warning" },
		prepare(root) {
			fs.writeFileSync(path.join(root, ".vale.ini"), "StylesPath = styles\n");
		},
		output: (reported) => ({
			status: 1,
			stdout: JSON.stringify({
				[reported]: [
					{
						Check: "Test.Rule",
						Message: MARKER,
						Line: 4,
						Span: [5, 6],
						Severity: "warning",
					},
				],
			}),
		}),
	};

	const markdownlintMember: Member = {
		name: "markdownlint",
		runnerId: "markdownlint",
		modulePath: "../../../../clients/dispatch/runners/markdownlint.js",
		file: "docs/app.md",
		sibling: "docs/other.md",
		fileContent: "# hello\n",
		attached: { status: "succeeded", semantic: "warning" },
		output: (reported) => ({
			status: 1,
			stderr: `${reported}:4:5 MD013/line-length ${MARKER}\n`,
		}),
	};

	const phpLintMember: Member = {
		name: "php-lint",
		runnerId: "php-lint",
		modulePath: "../../../../clients/dispatch/runners/php-lint.js",
		file: "src/app.php",
		sibling: "src/other.php",
		fileContent: "<?php\n",
		attached: { status: "failed", semantic: "blocking" },
		output: (reported) => ({
			status: 255,
			stdout: `PHP Parse error:  ${MARKER} in ${reported} on line 4\n`,
		}),
	};

	/**
	 * The SHARED diagnostic factory (`utils/diagnostic-parsers.ts`), reached
	 * through its live consumer: ruff's TEXT fallback, which runs whenever the
	 * JSON parser yields nothing. `createLineParser`'s own docstring says group 1
	 * is the FILE; it dropped that group and stamped the dispatched path.
	 */
	const ruffTextMember: Member = {
		name: "diagnostic-parsers (ruff text fallback)",
		runnerId: "ruff-lint",
		modulePath: "../../../../clients/dispatch/runners/ruff.js",
		file: "src/app.py",
		sibling: "src/other.py",
		fileContent: "x = 1\n",
		attached: { status: "succeeded", semantic: "warning" },
		output: (reported) => ({
			status: 1,
			stdout: `${reported}:4:5: F401 ${MARKER}\n`,
		}),
	};

	/**
	 * `[name, member, ownSpelling?]`. `ownSpelling` exists for the one member
	 * whose tool does NOT run in the runner cwd: `tflint` spawns with
	 * `cwd: fileDir` and names `range.filename` relative to THAT, which is
	 * exactly the "the cwd the tool RAN in" clause of ADR 0009. A shared
	 * `cwdRelative` here would feed tflint a spelling it never emits (#2432).
	 */
	interface Round3Cell {
		readonly name: string;
		readonly member: Member;
		/**
		 * The one member whose tool does NOT run in the runner cwd: `tflint`
		 * spawns with `cwd: fileDir` and names `range.filename` relative to THAT,
		 * which is exactly the "the cwd the tool RAN in" clause of ADR 0009. A
		 * shared `cwdRelative` here would feed tflint a spelling it never emits
		 * (#2432).
		 */
		readonly ownSpelling?: (spelling: Spelling) => string;
	}

	const ROUND3: readonly Round3Cell[] = [
		{ name: "stylelint", member: stylelintMember },
		{ name: "rubocop", member: rubocopMember },
		{ name: "eslint", member: eslintMember },
		{ name: "biome-check", member: biomeMember },
		{
			name: "tflint",
			member: tflintMember,
			ownSpelling: ({ argvPath }) => path.basename(argvPath),
		},
		{ name: "swiftlint", member: swiftlintMember },
		{ name: "ktlint", member: ktlintMember },
		{ name: "hadolint", member: hadolintMember },
		{ name: "actionlint", member: actionlintMember },
		{ name: "spellcheck", member: spellcheckMember },
		{ name: "sqlfluff", member: sqlfluffMember },
		{ name: "vale", member: valeMember },
		{ name: "markdownlint", member: markdownlintMember },
		{ name: "php-lint", member: phpLintMember },
		{ name: "diagnostic-parsers", member: ruffTextMember },
	];

	it.each(ROUND3)(
		"$name keeps a finding it reported for the dispatched file",
		async ({ member, ownSpelling }) => {
			expectAttached(
				await dispatch(member, ownSpelling ?? cwdRelative(member)),
				member,
			);
		},
	);

	it.each(ROUND3)(
		"$name rejects a finding it reported for a sibling file",
		async ({ member }) => {
			expectDetached(await dispatch(member, echoesSibling));
		},
	);

	it.each(ROUND3)(
		"$name treats a case-variant reported path exactly as this filesystem does",
		async ({ member }) => {
			expectFilesystemAnswer(await dispatch(member, caseVariantOfArgv), member);
		},
	);
});
