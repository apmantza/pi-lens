// The one place a workflow's dispatch safety is decided (#4065, #4077): which
// jobs a `workflow_dispatch` reaches, the write scopes each holds (job over
// workflow over the repository default), and whether its job-level `if:` is a
// real schedule-or-master guard. tests/config/workflow-writers-governance.test.ts
// is the census over every workflow and imports these; the CLI below answers
// "what does a dispatch of this file on that ref do" with the same parser, so
// the two cannot disagree on what counts as a guard.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "../clients/deps/js-yaml.js";

// The one permission source not in workflow YAML is the repository setting
// Actions > Workflow permissions. This repository holds "Read repository
// contents and packages permissions": `gh api
// repos/apmantza/pi-lens/actions/permissions/workflow` returns
// `default_workflow_permissions: read` (#4076 review r2, L2), and it is a
// user-owned repository, so no organization default sits above it. `read-all`
// is the superset of that default's scopes and holds no write. A workflow with
// no `permissions:` at all therefore holds no write token; the census does not
// rely on that (a job that needs a write scope names it).
export const REPOSITORY_DEFAULT_PERMISSIONS = "read-all";
export const WRITE_SCOPES = new Set([
	"actions",
	"artifact-metadata",
	"attestations",
	"checks",
	"contents",
	"deployments",
	"discussions",
	"id-token",
	"issues",
	"models",
	"packages",
	"pages",
	"pull-requests",
	"repository-projects",
	"security-events",
	"statuses",
]);

function everyScope(access) {
	return Object.fromEntries([...WRITE_SCOPES].map((key) => [key, access]));
}

function permissionMap(value) {
	if (value === "write-all") return everyScope("write");
	if (value === "read-all") return everyScope("read");
	if (value && typeof value === "object" && !Array.isArray(value))
		return Object.fromEntries(
			Object.entries(value).filter(([key]) => WRITE_SCOPES.has(key)),
		);
	// A shape GitHub rejects (a list, an unknown word): the workflow never runs,
	// so the census resolves it to the worst case rather than to no token.
	return everyScope("write");
}

/**
 * Job over workflow over the repository default. An empty `permissions:` parses
 * to null and means "not set", so it falls to the next level; an empty mapping
 * `{}` is set and denies every scope.
 */
export function effectivePermissions(workflowPermissions, jobPermissions) {
	return permissionMap(
		jobPermissions ?? workflowPermissions ?? REPOSITORY_DEFAULT_PERMISSIONS,
	);
}

export function writeScopes(permissions) {
	return Object.entries(permissions)
		.filter(([, value]) => value === "write")
		.map(([key]) => key)
		.sort();
}

export function workflowDocument(source) {
	return yaml.load(source) ?? {};
}

/** GitHub accepts `on:` as a string, an array of names, or a map. */
export function workflowTriggers(on) {
	if (typeof on === "string") return [on];
	if (Array.isArray(on)) return on.filter((t) => typeof t === "string");
	if (on && typeof on === "object") return Object.keys(on);
	return [];
}

export function dispatchableJobs(source, workflowPath = "workflow.yml") {
	const workflow = workflowDocument(source);
	if (!workflowTriggers(workflow.on).includes("workflow_dispatch")) return [];
	return Object.entries(workflow.jobs ?? {}).map(([name, job]) => {
		const permissions = effectivePermissions(
			workflow.permissions,
			job?.permissions,
		);
		return {
			id: `${workflowPath}:${name}`,
			name,
			job: job ?? {},
			permissions,
			writeScopes: writeScopes(permissions),
		};
	});
}

export function hasWriteToken(job) {
	return job.writeScopes.length > 0;
}

// ── `if:` expressions ───────────────────────────────────────────────────────

/**
 * @typedef {{ t: "or" | "and"; l: Expr; r: Expr }
 *   | { t: "not"; e: Expr }
 *   | { t: "cmp"; op: string; l: Expr; r: Expr }
 *   | { t: "str" | "lit" | "ref"; v: string }
 *   | { t: "call"; name: string; args: Expr[] }} Expr
 */

function tokenize(src) {
	const token =
		/\s*('(?:[^']|'')*'|&&|\|\||==|!=|<=|>=|[!<>(),.[\]*]|[A-Za-z_][\w-]*|\d+(?:\.\d+)?)/y;
	const tokens = [];
	let at = 0;
	while (at < src.length) {
		if (/^\s*$/.test(src.slice(at))) break;
		token.lastIndex = at;
		const m = token.exec(src);
		if (!m) throw new Error(`unexpected character at ${at}: ${src.slice(at)}`);
		tokens.push(m[1]);
		at = token.lastIndex;
	}
	return tokens;
}

// GitHub precedence, loosest first: `||`, `&&`, comparison, `!`.
function parseExpression(src) {
	const tokens = tokenize(src);
	let at = 0;
	const next = () => {
		if (at >= tokens.length) throw new Error("unexpected end of expression");
		return tokens[at++];
	};
	const expect = (want) => {
		const got = next();
		if (got !== want) throw new Error(`expected ${want}, got ${got}`);
	};
	const parseOr = () => {
		let l = parseAnd();
		while (tokens[at] === "||") {
			at += 1;
			l = { t: "or", l, r: parseAnd() };
		}
		return l;
	};
	const parseAnd = () => {
		let l = parseCmp();
		while (tokens[at] === "&&") {
			at += 1;
			l = { t: "and", l, r: parseCmp() };
		}
		return l;
	};
	const parseCmp = () => {
		const l = parseUnary();
		const op = tokens[at];
		if (op && ["==", "!=", "<", ">", "<=", ">="].includes(op)) {
			at += 1;
			return { t: "cmp", op, l, r: parseUnary() };
		}
		return l;
	};
	const parseUnary = () => {
		if (tokens[at] === "!") {
			at += 1;
			return { t: "not", e: parseUnary() };
		}
		return parsePrimary();
	};
	const parsePrimary = () => {
		const tok = next();
		if (tok === "(") {
			const inner = parseOr();
			expect(")");
			return inner;
		}
		if (tok.startsWith("'"))
			return { t: "str", v: tok.slice(1, -1).replaceAll("''", "'") };
		if (/^\d/.test(tok)) return { t: "lit", v: tok };
		if (!/^[A-Za-z_]/.test(tok)) throw new Error(`unexpected token ${tok}`);
		if (["true", "false", "null"].includes(tok)) return { t: "lit", v: tok };
		if (tokens[at] === "(") {
			at += 1;
			const args = [];
			while (tokens[at] !== ")") {
				args.push(parseOr());
				if (tokens[at] === ",") at += 1;
				else if (tokens[at] !== ")") throw new Error("bad call arguments");
			}
			expect(")");
			return { t: "call", name: tok.toLowerCase(), args };
		}
		let path = tok;
		for (;;) {
			if (tokens[at] === "." && tokens[at + 1]) {
				path += `.${tokens[at + 1]}`;
				at += 2;
			} else if (tokens[at] === "[") {
				at += 1;
				const index = parseOr();
				expect("]");
				path += index.t === "str" ? `.${index.v}` : ".*";
			} else break;
		}
		return { t: "ref", v: path };
	};
	const result = parseOr();
	if (at !== tokens.length) throw new Error(`trailing token ${tokens[at]}`);
	return result;
}

function operands(expr, op) {
	return expr.t === op
		? [...operands(expr.l, op), ...operands(expr.r, op)]
		: [expr];
}

function isEquality(expr, context, value) {
	if (expr.t !== "cmp" || expr.op !== "==") return false;
	const pair = (a, b) =>
		a.t === "ref" && a.v === context && b.t === "str" && b.v === value;
	return pair(expr.l, expr.r) || pair(expr.r, expr.l);
}

const isSchedule = (e) => isEquality(e, "github.event_name", "schedule");
const isMaster = (e) => isEquality(e, "github.ref", "refs/heads/master");
// #5062: a job that runs only on `pull_request` never runs on a dispatch, whose
// `github.event_name` is `workflow_dispatch` (ci.yml's PR-only CodeQL job).
const isPullRequest = (e) => isEquality(e, "github.event_name", "pull_request");

// `schedule || master`, or either half alone: a stricter guard that a branch
// dispatch cannot satisfy either. `pull_request` alone is a guard too; it never
// joins an `||`, which a dispatch could satisfy through the other operand.
function isGuardConjunct(expr) {
	if (isSchedule(expr) || isMaster(expr) || isPullRequest(expr)) return true;
	const ors = operands(expr, "or");
	return ors.length === 2 && ors.some(isSchedule) && ors.some(isMaster);
}

/**
 * @typedef {{ guarded: true; conjunct: Expr }
 *   | { guarded: false; reason: string }} Guard
 */

// A step runs only when its job's `if:` AND its own `if:` hold, so the guard
// must be a conjunct of one of them: `always() || guard`, `inputs.x || guard`
// and `!(guard)` are not.
/** @returns {Guard} */
export function guardOf(...conditions) {
	for (const condition of conditions) {
		if (typeof condition !== "string") continue;
		const body =
			/^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition)?.[1] ?? condition;
		let expr;
		try {
			expr = parseExpression(body);
		} catch (error) {
			return {
				guarded: false,
				reason: `unparseable if (${error.message})`,
			};
		}
		const conjunct = operands(expr, "and").find(isGuardConjunct);
		if (conjunct) return { guarded: true, conjunct };
	}
	return { guarded: false, reason: "lacks ref guard" };
}

// A guard conjunct is only ever `schedule`, `master`, `schedule || master` or
// `pull_request`, so its truth under a dispatch context needs no general
// evaluator.
function holds(conjunct, context) {
	if (isPullRequest(conjunct)) return context.event === "pull_request";
	if (isSchedule(conjunct)) return context.event === "schedule";
	if (isMaster(conjunct)) return context.ref === "refs/heads/master";
	return (
		conjunct.t === "or" &&
		(holds(conjunct.l, context) || holds(conjunct.r, context))
	);
}

/**
 * Whether a `workflow_dispatch` on `ref` skips the whole job: its job-level
 * `if:` holds a real guard conjunct (a step-level guard never skips the job)
 * and that conjunct is false for a dispatch on that ref.
 */
export function guardSkipsOnRef(job, ref) {
	const guard = guardOf(job.job.if);
	if (!guard.guarded) return false;
	return !holds(guard.conjunct, {
		event: "workflow_dispatch",
		ref: ref.startsWith("refs/") ? ref : `refs/heads/${ref}`,
	});
}

const USAGE =
	"usage: node scripts/dispatch-safety.mjs <workflow.yml> [--ref <branch> | --ref=<branch>]";

export function parseArgs(argv) {
	let file;
	let ref = "master";
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--ref" || arg.startsWith("--ref=")) {
			const value = arg === "--ref" ? argv[(index += 1)] : arg.slice(6);
			if (!value || value.startsWith("-"))
				return { error: "--ref needs a branch name" };
			ref = value;
		} else if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
		else if (file === undefined) file = arg;
		else return { error: `unexpected argument ${arg}` };
	}
	return file === undefined
		? { error: "missing workflow file" }
		: { file, ref };
}

/**
 * One JSON line per dispatchable job: its write scopes and whether a dispatch
 * on `--ref` (default master) skips it. Exit 0 on an answer, 2 on a usage,
 * read or parse error.
 */
export function runCli(argv, cwd = process.cwd()) {
	const args = parseArgs(argv);
	if ("error" in args)
		return { code: 2, stdout: [], stderr: [`${args.error}\n${USAGE}`] };
	let jobs;
	try {
		jobs = dispatchableJobs(
			readFileSync(resolve(cwd, args.file), "utf8"),
			args.file,
		);
	} catch (error) {
		return {
			code: 2,
			stdout: [],
			stderr: [`cannot read ${args.file}: ${error.message}`],
		};
	}
	if (jobs.length === 0)
		return {
			code: 0,
			stdout: [],
			stderr: [`${args.file} has no workflow_dispatch trigger or no jobs`],
		};
	return {
		code: 0,
		stderr: [],
		stdout: jobs.map((job) =>
			JSON.stringify({
				job: job.id,
				guardSkips: guardSkipsOnRef(job, args.ref),
				writeScopes: job.writeScopes,
			}),
		),
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const { code, stdout, stderr } = runCli(process.argv.slice(2));
	for (const line of stdout) console.log(line);
	for (const line of stderr) console.error(line);
	process.exitCode = code;
}
