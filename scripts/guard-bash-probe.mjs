#!/usr/bin/env node

/**
 * Differential probe for the real PreToolUse Bash hook (#4071).
 *
 *   node scripts/guard-bash-probe.mjs <matrix.jsonl> [--head <ref|file>]
 *     [--base <ref|file>] [--lane linked|real|both] [--json]
 *
 * The hook is the oracle: every verdict is the exit code of a real child
 * process fed a PreToolUse JSON payload on stdin (2 = deny, 0 = allow). Rows
 * are data only; no classifier lives here.
 *
 * Without `--base` the probe judges the head hook against each row's
 * `expect`. An expect-deny row that allows, or an expect-allow row that
 * denies, fails the run; a row carrying `gap: #N` is a known gap, so an allow
 * is reported and a deny is a "now enforced" note that tells the maintainer
 * to drop the label (it never fails). With `--base` the probe prints only the
 * rows whose verdict changed between the two hooks and exits non-zero when a
 * row that satisfied `expect` on the base violates it on the head (a
 * REGRESSION: deny -> allow on an expect-deny row, or allow -> deny on an
 * expect-allow row). `gap` is ignored in that mode: it describes master, not
 * the comparison.
 *
 * `--head` and `--base` take a file, or a git ref whose
 * `scripts/hooks/guard-bash.mjs` is read from the object store, fetched once
 * with `git fetch --depth=1 origin <ref>` when absent (a depth-1 CI checkout
 * does not carry other heads). Each hook is copied into the scratch directory
 * and run from there.
 *
 * Fixtures (under TMPDIR, neutral names): `main` holds a real `node_modules`;
 * `lane` ({{LINKED}}) is a linked-worktree-shaped directory (a `.git` file)
 * whose `node_modules` is a symlink into `main`; `real` is the same shape with
 * its own `node_modules` directory. `lanelink`, `lnk`, `other/hop` and `ch1`
 * (-> `ch2` -> lane) are symlinks into the lane, its `scripts`, the lane and
 * the lane. `chain` is a lane whose `node_modules` is a two-hop link
 * (-> `chain/inner` -> `main/node_modules`). Each child runs with its cwd set to the row's payload cwd and a
 * minimal private env (PATH, HOME, TMPDIR and the row's `env`; no PI_LENS_HOME
 * or other ambient pins), as Claude Code runs it. The child's TMPDIR is a
 * fixed path outside /tmp (see CHILD_TMPDIR).
 *
 * Not coverable from a fixture cwd: the hook's unpinned-node-probe rule
 * (`node -e` loading `clients/` or `dist/` code with PI_LENS_HOME unset)
 * decides from the process cwd and the repository identity of the loaded
 * path, and a fixture cwd outside a repository is the reviewed allow case
 * (#3680). No row can reach it; the probe only guarantees PI_LENS_HOME is
 * unset in the child.
 *
 * Row `source` names agent hand-backs that live outside the repository
 * (under the orchestrator's handbacks directory). What they are:
 *   review-4054.md      adversarial review of #4054 (guard-bash npm and delete
 *                       rules): the bypass matrix, F1-F7 and the false-positive set
 *   verify-4054-r3.md   verify round 3 of #4054: null-cwd, `$PWD`/`~`
 *                       resolution, F4 value flags, R3-1 (swallowed `--prefix`),
 *                       R3-2 (symlink then `..`), R3-3 (substitution operands)
 *   verify-4054-r4.md   verify round 4 of #4054: attacks on the one rule, the
 *                       real-worktree allow set, R4-2 (two-hop link chain)
 *   fix-4054-r4.md      fixer round 4 of #4054: the 37-row state table
 *   verify-3997-r4.md   verify round 4 of #3997 (two-reading rule): the
 *                       before/after table and a representative subset of its
 *                       5720-command generator (5 guarded actions x spellings x
 *                       shapes); the verifier's own matrix files were not kept
 *   review-4078.md      review of this probe's round 1 (row 48 label)
 * The 408-row matrix of verify-4054-r4 was not retained; the corpus holds the
 * rows its hand-back lists literally.
 *
 * Row fields: command, lane (linked|real|both), expect (allow|deny), source
 * (file plus section), optional cwd (template), env (object), gap (#N, only
 * with expect deny) and reason. Placeholders: {{LINKED}} {{REAL}} {{MAIN}}
 * {{LANELINK}} {{LNK}} {{HOP}} {{CH1}} {{CHAIN}} {{SIB}} {{OTHER}} {{ROOT}}
 * {{TMPDIR}} {{HOME}}.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const HOOK = join(ROOT, "scripts", "hooks", "guard-bash.mjs");
const HOOK_PATH_IN_REPO = "scripts/hooks/guard-bash.mjs";
const LANES = ["linked", "real", "both"];
const ROW_KEYS = new Set([
	"command",
	"lane",
	"expect",
	"source",
	"cwd",
	"env",
	"gap",
	"reason",
]);
const CHILD_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
const UNRESOLVED = /\{\{[A-Z_]+\}\}/;
// The child's TMPDIR. It must stay outside /tmp: the hook's #3526 rule denies
// `mktemp` and `git worktree add` under /tmp, so a fixture TMPDIR that is
// under /tmp (the CI default) would change verdicts. Nothing is written here.
const CHILD_TMPDIR = "/var/tmp/guard-bash-probe-scratch";

export function makeFixtures() {
	const root = mkdtempSync(join(tmpdir(), "guard-bash-probe-"));
	const dir = (...parts) => {
		const path = join(root, ...parts);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const main = dir("main");
	dir("main", "node_modules", "a");
	// Directory names match the reviewers' matrices (`../lane`, `lnk`, ...).
	const linked = dir("lane");
	dir("lane", "scripts");
	dir("lane", "dist");
	const real = dir("real");
	dir("real", "scripts");
	dir("real", "dist");
	dir("real", "node_modules", "a");
	for (const lane of [linked, real]) {
		writeFileSync(join(lane, "package.json"), "{}\n");
		// a linked-worktree `.git` file, as `git worktree add` writes it
		writeFileSync(
			join(lane, ".git"),
			`gitdir: ${join(main, ".git", "worktrees", basename(lane))}\n`,
		);
	}
	const linkType = process.platform === "win32" ? "junction" : "dir";
	symlinkSync(
		join(main, "node_modules"),
		join(linked, "node_modules"),
		linkType,
	);
	symlinkSync(linked, join(root, "lanelink"), linkType);
	symlinkSync(join(linked, "scripts"), join(root, "lnk"), linkType);
	// R4-2 shape: node_modules -> chain/inner -> main/node_modules (two hops,
	// the first of which stays inside the project).
	const chain = dir("chain");
	writeFileSync(join(chain, "package.json"), "{}\n");
	symlinkSync(join(main, "node_modules"), join(chain, "inner"), linkType);
	symlinkSync(join(chain, "inner"), join(chain, "node_modules"), linkType);
	const other = dir("other");
	// A link whose lexical parent differs from its target's parent: `hop/..`
	// is `other` lexically and `root` physically (#3997 H3 shape).
	symlinkSync(linked, join(other, "hop"), linkType);
	symlinkSync(linked, join(root, "ch2"), linkType);
	symlinkSync(join(root, "ch2"), join(root, "ch1"), linkType);
	return {
		root,
		values: {
			"{{ROOT}}": root,
			"{{LINKED}}": linked,
			"{{REAL}}": real,
			"{{MAIN}}": main,
			"{{LANELINK}}": join(root, "lanelink"),
			"{{LNK}}": join(root, "lnk"),
			"{{HOP}}": join(other, "hop"),
			"{{SIB}}": dir("sib"),
			"{{OTHER}}": other,
			"{{CH1}}": join(root, "ch1"),
			"{{CHAIN}}": chain,
			"{{TMPDIR}}": CHILD_TMPDIR,
			"{{HOME}}": dir("home"),
		},
	};
}

export function materialize(value, values) {
	let result = value;
	for (const [needle, replacement] of Object.entries(values))
		result = result.replaceAll(needle, replacement);
	const left = UNRESOLVED.exec(result);
	if (left) throw new Error(`unresolved placeholder ${left[0]} in ${value}`);
	return result;
}

function blobId(bytes) {
	return createHash("sha1")
		.update(`blob ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
}

function git(args) {
	return gitExecFileSync(args, {
		cwd: ROOT,
		encoding: "buffer",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: FETCH_TIMEOUT_MS,
	});
}

/** The hook bytes for a file path or a git ref (fetched once when absent). */
function hookBytes(spec) {
	if (spec === undefined) return readFileSync(HOOK);
	let isFile = false;
	try {
		isFile = statSync(spec).isFile();
	} catch {
		// not a file: treat as a ref below
	}
	if (isFile) return readFileSync(spec);
	if (spec.startsWith("-") || /[\s\0:]/.test(spec))
		throw new Error(`not a file or a usable git ref: ${JSON.stringify(spec)}`);
	const show = (rev) => git(["show", `${rev}:${HOOK_PATH_IN_REPO}`]);
	try {
		return show(spec);
	} catch {
		// absent from the object store (a depth-1 checkout): fetch it once
	}
	try {
		git(["fetch", "--no-tags", "--depth=1", "origin", spec]);
		return show("FETCH_HEAD");
	} catch (error) {
		const detail = String(error.stderr ?? error.message)
			.trim()
			.split("\n")[0];
		throw new Error(`cannot read ${HOOK_PATH_IN_REPO} at ${spec}: ${detail}`);
	}
}

export function loadHook(spec, scratchDir, name) {
	const bytes = hookBytes(spec);
	const path = join(scratchDir, `hook-${name}.mjs`);
	writeFileSync(path, bytes);
	return { path, spec: spec ?? "checkout", blob: blobId(bytes) };
}

export function hookVerdict(hookPath, command, cwd, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [hookPath], { cwd, env });
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(`hook timed out after ${CHILD_TIMEOUT_MS}ms: ${command}`),
			);
		}, CHILD_TIMEOUT_MS);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			if (status !== 0 && status !== 2)
				reject(
					new Error(`hook exited ${status} for ${command}: ${stderr.trim()}`),
				);
			else
				resolve({
					verdict: status === 2 ? "deny" : "allow",
					stderr: stderr.trim(),
				});
		});
		child.stdin.on("error", () => {
			// the hook may exit before reading the payload; the close event decides
		});
		child.stdin.end(
			JSON.stringify({
				session_id: "guard-bash-probe",
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command },
				cwd,
			}),
		);
	});
}

function childEnv(values, rowEnv) {
	return {
		PATH: "/usr/bin:/bin",
		HOME: values["{{HOME}}"],
		TMPDIR: values["{{TMPDIR}}"],
		...Object.fromEntries(
			Object.entries(rowEnv ?? {}).map(([key, value]) => [
				key,
				materialize(value, values),
			]),
		),
	};
}

export function readMatrix(path) {
	const seen = new Map();
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.flatMap((line, index) => {
			if (!line.trim()) return [];
			const where = `${path}:${index + 1}`;
			let row;
			try {
				row = JSON.parse(line);
			} catch (error) {
				throw new Error(`${where}: ${error.message}`);
			}
			const fail = (message) => {
				throw new Error(`${where}: ${message}`);
			};
			if (!row || typeof row !== "object" || Array.isArray(row))
				fail("row must be an object");
			for (const key of Object.keys(row))
				if (!ROW_KEYS.has(key)) fail(`unknown field ${key}`);
			if (typeof row.command !== "string" || !row.command.trim())
				fail("missing command");
			if (!LANES.includes(row.lane)) fail("lane must be linked, real or both");
			if (row.expect !== "allow" && row.expect !== "deny")
				fail("expect must be allow or deny");
			if (typeof row.source !== "string" || !row.source.trim())
				fail("missing source");
			if (row.gap !== undefined && !/^#\d+$/.test(row.gap))
				fail("gap must look like #123");
			if (row.gap !== undefined && row.expect !== "deny")
				fail("gap is only valid with expect deny");
			if (row.cwd !== undefined && row.lane === "both")
				fail("a row with a cwd must name one lane");
			const key = JSON.stringify([
				row.command,
				row.lane,
				row.cwd ?? "",
				Object.entries(row.env ?? {}).sort(),
			]);
			if (seen.has(key)) fail(`duplicate of line ${seen.get(key)}`);
			seen.set(key, index + 1);
			return [{ ...row, line: index + 1 }];
		});
}

export function rowsForLane(rows, lane) {
	return rows.flatMap((row) => {
		const lanes = row.lane === "both" ? ["linked", "real"] : [row.lane];
		return lanes
			.filter((one) => lane === "both" || lane === one)
			.map((one) => ({ ...row, fixtureLane: one }));
	});
}

export function judge(row, verdict) {
	if (row.expect === "deny") {
		if (verdict === "deny") return row.gap ? "enforced" : "ok";
		return row.gap ? "gap" : "FAIL-allowed";
	}
	return verdict === "allow" ? "ok" : "FAIL-denied";
}

function judgeChange(row, base, head) {
	if (base === head) return null;
	return base === row.expect ? "REGRESSION" : "fixed";
}

async function mapPool(items, limit, work) {
	const out = Array.from({ length: items.length });
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const index = next++;
				out[index] = await work(items[index]);
			}
		},
	);
	await Promise.all(workers);
	return out;
}

export async function runMatrix(
	matrixPath,
	{ head, base, lane = "both" } = {},
) {
	if (!LANES.includes(lane))
		throw new Error(`--lane must be one of ${LANES.join(", ")}`);
	const rows = rowsForLane(readMatrix(matrixPath), lane);
	if (rows.length === 0) throw new Error(`no rows selected for lane ${lane}`);
	const fixtures = makeFixtures();
	try {
		const headHook = loadHook(head, fixtures.root, "head");
		const baseHook =
			base === undefined ? null : loadHook(base, fixtures.root, "base");
		const parallel = Math.min(16, Math.max(2, availableParallelism()));
		const results = await mapPool(rows, parallel, async (row) => {
			const command = materialize(row.command, fixtures.values);
			const cwd = materialize(
				row.cwd ?? (row.fixtureLane === "linked" ? "{{LINKED}}" : "{{REAL}}"),
				fixtures.values,
			);
			const env = childEnv(fixtures.values, row.env);
			const headResult = await hookVerdict(headHook.path, command, cwd, env);
			const baseResult = baseHook
				? await hookVerdict(baseHook.path, command, cwd, env)
				: null;
			return {
				id: `${row.line}:${row.fixtureLane}`,
				line: row.line,
				lane: row.fixtureLane,
				command: row.command,
				expect: row.expect,
				gap: row.gap ?? null,
				source: row.source,
				head: headResult.verdict,
				base: baseResult ? baseResult.verdict : null,
				status: judge(row, headResult.verdict),
				change: baseResult
					? judgeChange(row, baseResult.verdict, headResult.verdict)
					: null,
			};
		});
		const count = (pick) => results.filter(pick).length;
		const diff = baseHook !== null;
		const summary = {
			rows: results.length,
			allow: count((r) => r.head === "allow"),
			deny: count((r) => r.head === "deny"),
			ok: count((r) => r.status === "ok"),
			gap: count((r) => r.status === "gap"),
			enforced: count((r) => r.status === "enforced"),
			failAllowed: count((r) => r.status === "FAIL-allowed"),
			failDenied: count((r) => r.status === "FAIL-denied"),
			changed: diff ? count((r) => r.change !== null) : null,
			regressions: diff ? count((r) => r.change === "REGRESSION") : null,
			head: { spec: headHook.spec, blob: headHook.blob },
			base: baseHook ? { spec: baseHook.spec, blob: baseHook.blob } : null,
		};
		return { results, summary };
	} finally {
		rmSync(fixtures.root, { recursive: true, force: true });
	}
}

export function parseArgs(argv) {
	const opts = { lane: "both", json: false };
	const positional = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--json") opts.json = true;
		else if (arg === "--head" || arg === "--base" || arg === "--lane") {
			const value = argv[++index];
			if (value === undefined || value.startsWith("--"))
				throw new Error(`${arg} needs a value`);
			opts[arg.slice(2)] = value;
		} else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
		else positional.push(arg);
	}
	if (positional.length !== 1)
		throw new Error("expected exactly one matrix file");
	return { matrixPath: positional[0], ...opts };
}

const USAGE =
	"usage: scripts/guard-bash-probe.mjs <matrix.jsonl> [--head <ref|file>] [--base <ref|file>] [--lane linked|real|both] [--json]";

function report({ results, summary }, diffMode) {
	console.log(`head\t${summary.head.spec}\t${summary.head.blob}`);
	if (summary.base)
		console.log(`base\t${summary.base.spec}\t${summary.base.blob}`);
	const shown = diffMode ? results.filter((r) => r.change) : results;
	for (const r of shown) {
		const arrow = diffMode ? `${r.base} -> ${r.head}` : r.head;
		const tag = diffMode ? r.change : r.status;
		console.log(`${r.id}\t${arrow}\texpect ${r.expect}\t${tag}\t${r.command}`);
	}
	const parts = [
		`rows=${summary.rows}`,
		`allow=${summary.allow}`,
		`deny=${summary.deny}`,
		`ok=${summary.ok}`,
		`gap=${summary.gap}`,
		`enforced=${summary.enforced}`,
		`fail-allowed=${summary.failAllowed}`,
		`fail-denied=${summary.failDenied}`,
	];
	if (diffMode)
		parts.push(
			`changed=${summary.changed}`,
			`regressions=${summary.regressions}`,
		);
	console.log(`counts\t${parts.join("\t")}`);
	if (summary.enforced)
		console.error(
			`guard-bash-probe: ${summary.enforced} known-gap row(s) NOW ENFORCED by this hook; drop their gap label`,
		);
	if (diffMode && summary.regressions)
		console.error(
			`guard-bash-probe: ${summary.regressions} row(s) regressed from base to head`,
		);
	if (!diffMode && summary.failAllowed)
		console.error(
			`guard-bash-probe: ${summary.failAllowed} expected DENY row(s) allowed`,
		);
	if (!diffMode && summary.failDenied)
		console.error(
			`guard-bash-probe: ${summary.failDenied} expect ALLOW row(s) denied`,
		);
}

if (isMainModule(import.meta.url)) {
	try {
		const args = parseArgs(process.argv.slice(2));
		const outcome = await runMatrix(args.matrixPath, args);
		const diffMode = args.base !== undefined;
		if (args.json) console.log(JSON.stringify(outcome));
		else report(outcome, diffMode);
		const { summary } = outcome;
		const failed = diffMode
			? summary.regressions
			: summary.failAllowed + summary.failDenied;
		if (failed) process.exitCode = 1;
	} catch (error) {
		console.error(`guard-bash-probe: ${error.message}`);
		if (/^(--|expected exactly|unknown option)/.test(error.message))
			console.error(USAGE);
		process.exitCode = 1;
	}
}
