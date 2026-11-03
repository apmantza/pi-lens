#!/usr/bin/env node
/**
 * Capture a REAL tool's bytes into a runner-output fixture (#1937).
 *
 * A runner parser written from documentation or memory can be wrong in a way no
 * hand-authored test sees: the test asserts the shape the author imagined, the
 * parser reads that same shape, and both agree while the binary emits something
 * else. #1933 found exactly that in the vale runner — the parser read
 * `Data.Files`, vale emits a flat map, and the runner reported "0 findings"
 * against a CLI that exited 1.
 *
 * This script closes that loop. It spawns a real binary with the SAME argv the
 * runner spawns, then writes stdout, stderr, and the exit code into a fixture
 * envelope with a machine-generated provenance header. The envelope feeds
 * `tests/clients/dispatch/runners/captured-real-output.test.ts`, which replays
 * the bytes through the runner and asserts the parser finds something.
 *
 * The provenance header is generated here, never typed by hand, so a fixture
 * cannot claim a version or a command it did not run.
 *
 * Usage:
 *   node scripts/capture-runner-output.mjs \
 *     --runner actionlint --tool actionlint --bin /path/to/actionlint \
 *     --cwd /tmp/workspace --workspace tests/fixtures/tool-smoke/actionlint \
 *     --file .github/workflows/ci.yml \
 *     --probe '["--version"]' \
 *     --clean-cwd /tmp/clean-workspace \
 *     --clean-workspace tests/fixtures/runner-output-clean/actionlint \
 *     --case workflow-violations \
 *     -- -format "{{json .}}" .github/workflows/ci.yml
 *
 * Flags:
 *   --runner        registered dispatch runner id the bytes belong to (required)
 *   --tool          binary name as humans know it (default: --runner)
 *   --bin           path/name of the work executable to spawn (default: --tool)
 *   --bin-dir       directory searched for each PROBE's own binary, before
 *                   pi-lens's tool dirs and PATH (default: none)
 *   --cwd           working directory for the spawn (default: process.cwd())
 *   --workspace     repo-relative path recorded as the capture workspace
 *                   (default: --cwd relative to the repo root)
 *   --file          workspace-relative path the runner was pointed at (required)
 *   --case          fixture basename (default: "real")
 *   --version-args  argv that prints the version (default: --version)
 *   --probe         JSON array: the argv the runner's availability checker
 *                   sends. Repeatable. REQUIRED: the replay answers that exact
 *                   spawn from this record, so a fixture without one cannot be
 *                   replayed against the real checker (#4473). Each probe runs
 *                   ITS OWN command, never `--bin`.
 *   --clean-cwd     a copy of a clean workspace: the SAME argv runs there, so
 *                   the bytes are this runner asking this tool about clean input
 *   --clean-file    workspace-relative clean input (default: --file, because
 *                   the clean workspace mirrors the analysed file's own name)
 *   --clean-workspace  repo-relative path recorded for the clean run (default:
 *                   --clean-cwd relative to the repo root)
 *   --merge-into    existing fixture envelope: merge the availability and clean
 *                   records into it instead of writing a new capture. This is
 *                   the retrofit path for fixtures captured before #4473, and it
 *                   never touches the recorded work bytes. A clean run whose
 *                   invocation is NOT the fixture's own is refused (#4522).
 *   --note          free-text note stored alongside the provenance
 *   --out-dir       fixture root (default: tests/fixtures/runner-output)
 *
 * Everything after `--` is the argv passed to the binary.
 *
 * There is no flag for "this tool has no clean run": `--clean-unavailable`
 * took a prose fact and is refused, because the two facts it ever held were
 * false and any runner could silence its clean cell with a sentence (#4522
 * F8). A clean run is recorded from `--clean-cwd`, or not at all.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/is-main-module.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/** Placeholder substituted for the capture workspace inside captured bytes. */
export const WORKSPACE_TOKEN = "__WORKSPACE__";

function parseArgs(argv) {
	const opts = {};
	const rest = [];
	let afterSeparator = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (afterSeparator) {
			rest.push(arg);
			continue;
		}
		if (arg === "--") {
			afterSeparator = true;
			continue;
		}
		if (arg.startsWith("--")) {
			opts[arg.slice(2)] = argv[++i];
			continue;
		}
		rest.push(arg);
	}
	return { opts, rest };
}

/** `major.minor[.patch][-suffix]` — the version shape every banner prints. */
const VERSION_TOKEN = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/;

/**
 * First version-shaped token in a `--version` banner, e.g. "1.7.12" from
 * "actionlint 1.7.12\ninstalled by ...".
 *
 * Returns "" when the banner carries no `major.minor` token. The caller then
 * refuses to write the fixture. Falling back to "the first line" instead would
 * let a failed spawn's error text become the recorded version — a Windows
 * "not compatible with the version of Windows you're running" message did
 * exactly that during this script's own bring-up.
 *
 * When `command` is given, a line that leads with that command's own name wins:
 * `mix --version` prints the Erlang runtime's banner first and Mix's second, so
 * the first token in the whole output is erts' version, not Mix's (#4522 F10).
 * The line is preferred, not the token, because a banner can name its runtime
 * before itself and its own version after (`go version go1.27.2 linux/amd64`).
 *
 * Without such a line, only the answer's LEADING BLOCK is eligible — its first
 * lines up to the next blank line, the shape a version banner has. A probe is
 * not always a version probe: biome's availability checker also sends
 * `explain noUnusedVariables`, whose answer is a rule page and whose line
 * "Available from version: 1.0.0" is the RULE's version, not the binary's
 * (#4522 NEW-4). The block keeps that page out, and returns "" so the record
 * says what answered it and nothing about a version (#4522 F10's shape).
 */
export function extractVersion(banner, command) {
	const text = banner ?? "";
	const name = command ? basenameOf(command).toLowerCase() : "";
	if (name) {
		for (const line of text.split("\n")) {
			const lead =
				line
					.trim()
					.split(/[\s,:]+/)[0]
					?.toLowerCase() ?? "";
			if (lead !== name) continue;
			const match = line.match(VERSION_TOKEN);
			if (match) return match[0];
		}
	}
	const match = leadingBlock(text).match(VERSION_TOKEN);
	return match ? match[0] : "";
}

/**
 * An answer's banner block: its first non-blank lines, up to the next blank one.
 *
 * A tool that prints a blank line before its banner (`swiftlint --version` on
 * some shells) still has one, so leading blank lines are skipped rather than
 * treated as an empty block.
 */
function leadingBlock(text) {
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length && lines[i].trim() === "") i++;
	const block = [];
	for (; i < lines.length; i++) {
		if (lines[i].trim() === "") break;
		block.push(lines[i]);
	}
	return block.join("\n");
}

/**
 * The binary name to resolve for a probe: the command the checker spawns, as a
 * bare name. An absolute or relative path is used as given, because the checker
 * resolved it itself.
 */
export function probeBinaryName(command) {
	return /[\\/]/.test(command) ? command : basenameOf(command);
}

/** The last segment of a path spelled with either separator. */
function basenameOf(value) {
	const segments = String(value).split(/[\\/]/);
	return segments[segments.length - 1] ?? String(value);
}

/**
 * Directories searched for a tool binary, in order: the caller's `--bin-dir`,
 * pi-lens's managed tool dirs, then PATH via the bare name.
 */
function candidateDirs(binDir) {
	const home = os.homedir();
	return [
		binDir,
		path.join(home, ".pi-lens", "bin"),
		path.join(home, ".pi-lens", "tools", "node_modules", ".bin"),
	].filter(Boolean);
}

/**
 * Absolute path to `name`'s binary, or the bare name to fall back to PATH.
 *
 * Every spawn this script makes — the work run, the version run, and each
 * probe — resolves through here, so a probe is answered by the binary it names
 * and not by the work binary wearing that name (#4522 F2).
 */
export function resolveBin(name, binDir) {
	if (/[\\/]/.test(name)) return name;
	for (const dir of candidateDirs(binDir)) {
		for (const suffix of [".exe", ".bat", ".cmd", ""]) {
			const candidate = path.join(dir, `${name}${suffix}`);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return name;
}

/**
 * Replace every spelling of `workspace` in `text` with WORKSPACE_TOKEN.
 *
 * Tools print the workspace path back in their output, and that path is the
 * capturing machine's temp dir. Left raw, a fixture would be unreplayable on
 * another host and would leak a local path into the repo. Both the native and
 * the forward-slash spelling are replaced because a single tool emits both
 * (Windows argv in, POSIX-normalised paths out).
 */
export function redactWorkspace(text, workspace) {
	if (!text || !workspace) return text ?? "";
	const backslashed = workspace.replace(/\//g, "\\");
	const spellings = new Set([
		// Longest first. A tool's `--format json` output embeds the path with
		// DOUBLED backslashes; the raw spelling does not match it, and JSON
		// output is exactly what these fixtures capture. Replacing a shorter
		// spelling first would break the escaped one into unmatchable pieces.
		backslashed.replace(/\\/g, "\\\\"),
		workspace,
		workspace.replace(/\\/g, "/"),
		backslashed,
	]);
	let out = text;
	for (const spelling of spellings) {
		out = out.split(spelling).join(WORKSPACE_TOKEN);
	}
	return out;
}

/**
 * `text` with the capture host's home directory collapsed to `~`.
 *
 * A tool's probe output can name its own install path (swiftlint reports the
 * shim it loaded, and that path is under this host's home). The record keeps the
 * tool's answer but never a maintainer's absolute path.
 */
export function redactHomePath(text) {
	const home = os.homedir();
	if (!text || !home) return text ?? "";
	return text.split(home).join("~");
}

/**
 * The argv to spawn: every `WORKSPACE_TOKEN` in an argument becomes the
 * workspace, so `__WORKSPACE__/bad.fish` is that file's absolute path (#4454).
 *
 * A runner that hands its tool an ABSOLUTE path (helm lint `<chart root>`) can
 * only be captured by spawning with the workspace's absolute path, while the
 * recorded argv must stay machine-neutral. The token stands for the workspace
 * in the recorded argv, and the replay maps it back to its own temp dir.
 */
export function expandWorkspaceArgs(argv, workspace) {
	return argv.map((arg) => arg.split(WORKSPACE_TOKEN).join(workspace));
}

/**
 * Whether this spawn needs a shell.
 *
 * On Windows an npm-installed tool is a `.cmd` shim that `spawnSync` cannot
 * exec directly, so those need `shell: true`. A real `.exe` does NOT: routing it
 * through cmd.exe re-tokenises the argv and silently drops the quoting that
 * arguments like `{{json .}}` depend on, which turns a capture into a usage
 * error instead of tool output.
 */
export function needsShell(bin, platform = process.platform) {
	if (platform !== "win32") return false;
	return !/\.exe$/i.test(bin);
}

/** Characters that force an argv entry to be quoted before cmd.exe sees it. */
const NEEDS_QUOTING = /[\s"{}^&|<>()%!]/;

/**
 * Quote one argv entry for a Windows command line.
 *
 * Implements the CommandLineToArgvW rules rather than "escape the quotes"
 * (#1937 round 2): backslashes are literal EXCEPT before a double quote, where
 * 2n backslashes produce n backslashes and a delimiting quote, and 2n+1
 * produce n backslashes and a literal quote. The previous version escaped `"`
 * and left `\` alone, so an argument ending in a backslash — a Windows
 * directory path, routinely — had its closing quote escaped and swallowed the
 * next argument. CodeQL flags that shape as incomplete sanitization, correctly.
 *
 * Written as a scan rather than chained regex replaces so there is one pass
 * over the string and no ordering hazard between the two escapes.
 */
export function quoteForShell(arg) {
	const text = String(arg);
	if (text.length > 0 && !NEEDS_QUOTING.test(text)) return text;

	let quoted = '"';
	let pendingBackslashes = 0;
	for (const character of text) {
		if (character === "\\") {
			pendingBackslashes++;
			continue;
		}
		if (character === '"') {
			// Double the run, then escape the quote itself.
			quoted += `${"\\".repeat(pendingBackslashes * 2 + 1)}"`;
			pendingBackslashes = 0;
			continue;
		}
		quoted += `${"\\".repeat(pendingBackslashes)}${character}`;
		pendingBackslashes = 0;
	}
	// A trailing run abuts the closing quote, so it must be doubled too.
	quoted += `${"\\".repeat(pendingBackslashes * 2)}"`;
	return quoted;
}

/**
 * The executable path as the shell should see it.
 *
 * `shell: true` hands the path to a shell, and which shell that is depends on
 * the environment: cmd.exe normally, but `sh` when the run started from Git
 * Bash. `sh` reads each `\` in `C:\tools\phpstan.bat` as an escape and hands
 * the program `C:toolsphpstan.bat`. Windows accepts forward slashes in a path,
 * and no shell treats them specially, so normalise before quoting.
 */
export function shellBinPath(bin) {
	return quoteForShell(String(bin).replace(/\\/g, "/"));
}

/**
 * One availability record: the argv the runner's checker sends, the binary that
 * answered, and the REAL exit status with its streams.
 *
 * The exit status is the load-bearing field. helm 4 rejects `--version` and
 * exits 1; a record that dropped the status would let the replay assume a
 * rejected probe succeeded, which is the class #4473 names.
 *
 * `version` is read from THIS probe's own answer, so a record cannot carry the
 * work binary's banner under another binary's name (#4522 F2). A probe whose
 * answer is not a version banner — biome's `explain` answer is a rule page —
 * records "" rather than the rule's own version (#4522 NEW-4), and a probe
 * that never spawned records "" with an `error`.
 */
export function buildAvailability(command, argv, run) {
	const record = {
		command,
		argv: [...argv],
		version: extractVersion(
			`${run?.stdout ?? ""}${run?.stderr ?? ""}`,
			command,
		),
		exitCode: typeof run?.status === "number" ? run.status : null,
		stdout: redactHomePath(run?.stdout ?? ""),
		stderr: redactHomePath(run?.stderr ?? ""),
	};
	if (run?.error) {
		record.error = `${command} could not be spawned: ${run.error.message}`;
		record.exitCode = null;
	}
	return record;
}

/**
 * Everything wrong with a set of records about one fixture, as human-readable
 * strings. Empty means the records are evidence about THIS fixture.
 *
 * One seam, three ties, checked before a record is written and again by the
 * fixture census over every committed fixture (#4522):
 *
 *  - binary: a recorded `version` must be EXACTLY what this probe's own answer
 *    yields (`extractVersion`), so the work binary's banner cannot answer for
 *    another program, and a rule page cannot contribute the rule's version. A
 *    "" records a probe whose answer prints no version in its leading block.
 *    The tie is content, not provenance: an answer that is another binary's
 *    banner carrying the SAME version string still passes, and capture-time
 *    resolution of each probe's own binary is what actually prevents it.
 *  - invocation: the clean run must be this fixture's own argv. `--records-only`
 *    once replayed the last manifest entry's clean run into every case of its
 *    runner, so fish-indent's formatter fixture replayed a `fish --no-execute`
 *    syntax check as its clean half.
 *  - workspace: a clean run must name the workspace it ran in, and nothing else.
 */
export function recordProblems(records) {
	const problems = [];
	const where = records?.provenance?.runner ?? "fixture";
	for (const record of records?.availability ?? []) {
		const label = `${where}: availability for ${record?.command} ${JSON.stringify(record?.argv)}`;
		const answer = `${record?.stdout ?? ""}${record?.stderr ?? ""}`;
		if (record?.error) {
			if (record.version)
				problems.push(
					`${label}: records version "${record.version}" for a probe that could not be spawned`,
				);
			continue;
		}
		// Recomputed from the answer the record carries, so the field cannot
		// assert a version its own bytes do not yield — including a version that
		// merely APPEARS somewhere in a long answer (#4522 NEW-4).
		const expected = extractVersion(answer, record?.command);
		if (record?.version !== expected) {
			problems.push(
				record?.version
					? `${label}: version "${record.version}" is not the one its own answer yields ("${expected}") — another binary answered this probe`
					: `${label}: no version in its own answer, though its leading block yields "${expected}" — a record must name the binary that answered it, or record the spawn error`,
			);
		}
	}
	const clean = records?.clean;
	if (clean) {
		const own = records?.provenance?.argv ?? [];
		if (JSON.stringify(clean.argv) !== JSON.stringify(own))
			problems.push(
				`${where}: clean run argv ${JSON.stringify(clean.argv)} is not this fixture's own invocation ${JSON.stringify(own)} — a clean run is evidence only for the command it ran`,
			);
		if (!clean.workspace)
			problems.push(`${where}: clean run names no workspace`);
	}
	return problems;
}

/**
 * Merge the availability and clean records into an existing fixture envelope.
 *
 * The work bytes, provenance, file and exit code stay byte-identical: those were
 * captured from the version the fixture names, and re-recording them from a
 * newer build would silently retarget the parser evidence. Only the records the
 * old capture could not produce are added.
 *
 * Refuses to write when `recordProblems` finds the records describe a different
 * invocation or a different binary than this fixture: a retrofit that overwrites
 * a neighbour's clean run is worse than no record.
 */
export function mergeRecords(dest, patch) {
	let envelope;
	try {
		envelope = JSON.parse(fs.readFileSync(dest, "utf8"));
	} catch (err) {
		// A corrupt fixture is a named refusal, not a SyntaxError from deep in the
		// retrofit: this path rewrites a committed file, so it says which one and why.
		throw new Error(
			`refusing to merge into ${path.relative(repoRoot, dest)}: it is not readable JSON (${err?.message ?? err})`,
		);
	}
	if (patch.availability) envelope.availability = patch.availability;
	if (patch.clean) envelope.clean = patch.clean;
	if (patch.versionArgv) {
		envelope.provenance = {
			...envelope.provenance,
			versionArgv: patch.versionArgv,
		};
	}
	const problems = recordProblems(envelope);
	if (problems.length > 0) {
		throw new Error(
			`refusing to write ${path.relative(repoRoot, dest)}:\n  ${problems.join("\n  ")}`,
		);
	}
	fs.writeFileSync(dest, `${JSON.stringify(envelope, null, "\t")}\n`, "utf8");
	return envelope;
}

/**
 * Why a clean run cannot be recorded, or null when it can.
 *
 * A clean run that exited non-zero is not a clean run: recording it would put
 * the dirty verdict in the fixture's clean half, and the matrix's clean cell
 * would then assert the opposite of what it replayed. The reason names the
 * output, because the common cause is a clean workspace that is not clean.
 */
export function cleanRunRejection(run) {
	if (run?.error) return `clean spawn failed: ${run.error.message}`;
	if (run?.status !== 0)
		return `the clean run exited ${run.status}, so it is not clean — refusing to record it. Output:\n${run?.stdout ?? ""}${run?.stderr ?? ""}`;
	return null;
}

function spawnCaptured(bin, args, cwd, shellOverride) {
	const shell = shellOverride ?? needsShell(bin);
	return spawnSync(
		shell ? shellBinPath(bin) : bin,
		shell ? args.map(quoteForShell) : args,
		{
			cwd,
			encoding: "utf8",
			shell,
			maxBuffer: 32 * 1024 * 1024,
		},
	);
}

function main() {
	const { opts, rest } = parseArgs(process.argv.slice(2));
	const runner = opts.runner;
	const file = opts.file;
	if (!runner || !file) {
		console.error("--runner and --file are required");
		process.exit(2);
	}
	const tool = opts.tool ?? runner;
	const bin = resolveBin(opts.bin ?? tool, opts["bin-dir"]);
	const cwd = path.resolve(opts.cwd ?? process.cwd());
	const caseName = opts.case ?? "real";
	const versionArgs = (opts["version-args"] ?? "--version").split(/\s+/);
	const outDir = path.resolve(
		opts["out-dir"] ?? path.join(repoRoot, "tests/fixtures/runner-output"),
	);
	const shellOverride =
		opts.shell === undefined ? undefined : opts.shell === "true";

	// The probe set is required, not defaulted: the replay answers the checker's
	// exact spawn from this record, so a capture that omits it writes a fixture
	// nothing can replay against a real checker (#4473).
	// A probe is either the bare argv (`["--version"]`, command = --tool) or
	// `{command, argv}` when the checker spawns something other than the tool
	// (markdownlint's checker is `markdownlint-cli2`).
	const probes = [];
	for (let i = 0; i < process.argv.length; i++) {
		if (process.argv[i] !== "--probe") continue;
		let parsed;
		try {
			parsed = JSON.parse(process.argv[i + 1]);
		} catch {
			console.error("--probe needs JSON, e.g. --probe '[\"--version\"]'");
			process.exit(2);
		}
		const probe = Array.isArray(parsed)
			? { command: tool, argv: parsed }
			: { command: parsed?.command ?? tool, argv: parsed?.argv };
		if (
			typeof probe.command !== "string" ||
			probe.command.length === 0 ||
			!Array.isArray(probe.argv) ||
			probe.argv.some((token) => typeof token !== "string")
		) {
			console.error(
				"--probe needs either a JSON array of strings or {command, argv}",
			);
			process.exit(2);
		}
		probes.push(probe);
	}
	if (probes.length === 0) {
		console.error(
			"--probe is required: the capture records the real tool's answer to the availability probe its runner sends (#4473)",
		);
		process.exit(2);
	}

	const versionRun = spawnCaptured(bin, versionArgs, cwd, shellOverride);
	const version = extractVersion(
		`${versionRun.stdout ?? ""}${versionRun.stderr ?? ""}`,
		tool,
	);
	if (!version) {
		console.error(
			`could not read a version from \`${bin} ${versionArgs.join(" ")}\` — refusing to write a fixture with no provenance`,
		);
		process.exit(2);
	}

	// Each probe runs its OWN command: a checker that probes `cargo --version`
	// before `cargo clippy` must not be answered by the work binary wearing the
	// other program's name (#4522 F2). `--bin` still wins for the tool's own
	// probe, because it names the executable the checker resolves for `--tool`
	// (markdownlint's bin is `markdownlint-cli2`).
	const availability = probes.map((probe) => {
		const probeBin =
			probe.command === tool || probe.command === opts.bin
				? bin
				: resolveBin(probeBinaryName(probe.command), opts["bin-dir"]);
		return buildAvailability(
			probe.command,
			probe.argv,
			spawnCaptured(probeBin, probe.argv, cwd, shellOverride),
		);
	});

	// The clean run: the SAME invocation in a workspace where the analysed
	// input is clean. The argv is not rewritten — it is the invocation the
	// fixture records — only the directory it runs in changes, so the bytes are
	// evidence about this runner asking this tool for this file's verdict.
	//
	// There is no "no clean run exists" escape hatch. It used to take a prose
	// fact of 20 characters or more, so any runner could silence its clean cell
	// with a sentence, and the two facts it ever held were both false: swiftlint
	// lints a formatted file and trivy finds nothing in a manifest with no
	// kubernetes resources (#4522 F8). A tool that cannot analyse a file at all
	// has no runner to capture for.
	let clean;
	if (opts["clean-unavailable"] !== undefined) {
		console.error(
			"--clean-unavailable is gone: capture a real clean run with --clean-cwd/--clean-workspace instead of stating why none exists (#4522 F8)",
		);
		process.exit(2);
	} else if (opts["clean-cwd"]) {
		const cleanCwd = path.resolve(opts["clean-cwd"]);
		const cleanFile = opts["clean-file"] ?? file;
		// A clean run is evidence about clean INPUT: if the workspace does not hold
		// the analysed path, the tool either fails (which the exit check catches)
		// or silently reports nothing about a file that does not exist, and the
		// matrix's clean cell replays bytes nothing examined (#4522 F4).
		if (!fs.existsSync(path.join(cleanCwd, cleanFile))) {
			console.error(
				`the clean workspace ${cleanCwd} holds no ${cleanFile}, so a clean run would analyse nothing — refusing to record it`,
			);
			process.exit(2);
		}
		const cleanRun = spawnCaptured(
			bin,
			expandWorkspaceArgs(rest, cleanCwd),
			cleanCwd,
			shellOverride,
		);
		const rejection = cleanRunRejection(cleanRun);
		if (rejection) {
			console.error(rejection);
			process.exit(2);
		}
		clean = {
			workspace: (
				opts["clean-workspace"] ?? path.relative(repoRoot, cleanCwd)
			).replace(/\\/g, "/"),
			file: cleanFile,
			argv: rest,
			version,
			exitCode: cleanRun.status,
			stdout: redactHomePath(
				redactWorkspace(redactWorkspace(cleanRun.stdout ?? "", cwd), cleanCwd),
			),
			stderr: redactHomePath(
				redactWorkspace(redactWorkspace(cleanRun.stderr ?? "", cwd), cleanCwd),
			),
		};
	} else if (opts["clean-file"] !== undefined) {
		console.error("--clean-file needs --clean-cwd");
		process.exit(2);
	}

	const records = {
		availability,
		...(clean ? { clean } : {}),
		versionArgv: versionArgs,
	};

	if (opts["merge-into"]) {
		const dest = path.resolve(opts["merge-into"]);
		const merged = mergeRecords(dest, records);
		console.log(
			`merged ${availability.length} availability record(s)${clean ? " and the clean run" : ""} into ${path.relative(repoRoot, dest)}`,
		);
		for (const record of merged.availability) {
			console.log(
				`  ${record.command} ${JSON.stringify(record.argv)} → exit ${record.exitCode} (${record.version})`,
			);
		}
		return;
	}

	const run = spawnCaptured(
		bin,
		expandWorkspaceArgs(rest, cwd),
		cwd,
		shellOverride,
	);
	if (run.error) {
		console.error(`spawn failed: ${run.error.message}`);
		process.exit(2);
	}

	const envelope = {
		provenance: {
			runner,
			tool,
			version,
			command: [tool, ...rest].join(" "),
			// The argv as an ARRAY as well as a string. The string is for
			// humans; splitting it back on whitespace is lossy for a quoted
			// argument like `{{json .}}`, and the argv-tie assertion in
			// runners/captured-real-output.test.ts needs the exact tokens in
			// the exact order to notice a runner's invocation drifting.
			argv: rest,
			versionArgv: versionArgs,
			workspace: path
				.relative(repoRoot, opts.workspace ? path.resolve(opts.workspace) : cwd)
				.replace(/\\/g, "/"),
			platform: `${process.platform}-${process.arch}`,
			capturedAt: new Date().toISOString().slice(0, 10),
			...(opts.note ? { note: opts.note } : {}),
		},
		availability,
		...(clean ? { clean } : {}),
		file,
		exitCode: run.status,
		stdout: redactWorkspace(run.stdout ?? "", cwd),
		stderr: redactWorkspace(run.stderr ?? "", cwd),
	};

	const dest = path.join(outDir, runner, `${caseName}.captured.json`);
	// The same gate the retrofit path uses: a record must be about this binary,
	// this invocation, and this workspace before it becomes evidence.
	const problems = recordProblems(envelope);
	if (problems.length > 0) {
		console.error(
			`refusing to write ${path.relative(repoRoot, dest)}:\n  ${problems.join("\n  ")}`,
		);
		process.exit(2);
	}
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, `${JSON.stringify(envelope, null, "\t")}\n`, "utf8");
	console.log(
		`captured ${tool} ${version} → ${path.relative(repoRoot, dest)} (exit ${run.status}, ${envelope.stdout.length}B stdout, ${envelope.stderr.length}B stderr)`,
	);
}

if (isMainModule(import.meta.url)) {
	main();
}
