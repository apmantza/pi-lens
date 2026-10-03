/**
 * Shared owner of the "can a pull request run this job" model (#3043, #3087,
 * #3941). One module, because two sweeps ask the same question in opposite
 * directions and a second copy is exactly how they drift apart:
 *
 * - `tests/config/workflow-pull-request-reachability.test.ts` (#3043/#3087)
 *   enumerates every job-level `if:` in a pull_request-triggerable workflow
 *   and flags the ones a pull request can NEVER satisfy.
 * - `tests/config/heavy-advisory-gate-workflow.test.ts` (#3941) classifies each
 *   checkout site's stage and asks whether a job's `if:` PROVES it can never
 *   run on a pull request, so its checkout cannot be an early-start advisory
 *   one. That consumer is `provesNotPullRequestEligible` at the bottom, built
 *   on this module's expression syntax handling so the two never fork.
 *
 * EVALUATION: the same technique as tests/config/ci-infra-kill-rerun-gate.ts
 * and install-smoke-gates.ts -- yaml.load the REAL workflow, substitute every
 * context path in the LOADED `if:` string with a literal, evaluate with
 * `new Function`, and fold every comparison whose two operands are literals
 * through `githubEquals`, this module's one owner of GitHub's equality. GitHub
 * compares strings case-insensitively and coerces a mismatched type to a
 * number; JS strict equality does neither, so a bare `new Function`
 * UNDER-approximates GitHub truth and can read a real pull-request job as
 * unreachable. Folding keeps this a PARTIAL approximation, and the model is
 * NOT a GitHub expression compiler: two residuals are refused loudly rather
 * than guessed at. A comparison with a non-literal operand still runs under JS
 * strict equality -- the workflow population reaches none, because every
 * context path substitutes to a literal. A literal comparison that is not a
 * COMPLETE operand -- immediately beside `!`, a relational operator, or
 * another comparison operator -- throws `WorkflowExpressionError` (#3941 r5,
 * F7). GitHub binds every one of those at or above equality, so folding such a
 * pair reads `1 < 2 == true` as `1 < (2 == true)` (GitHub: `(1 < 2) == true`)
 * and `0 == 1 < 2` as `(0 == 1) < 2` (GitHub: `0 == (1 < 2)`). That topology is
 * the model's declared excluded default, never a silently wrong `false`. A run
 * of literal `==`/`!=` comparisons is folded LEFT-ASSOCIATIVELY, as GitHub
 * does. An unrecognised context path THROWS rather than being guessed at, so a
 * workflow that grows a new one fails loudly instead of being silently read as
 * reachable.
 *
 * CODE versus DATA (#3941 r4, F6). A transform that edits raw text cannot see
 * where the code ends and a string literal begins, so it rewrote the INSIDE of
 * a quoted literal too: a context path, an `always()`, or an `==` inside a
 * workflow string is DATA, not a reference or an operator. Every pass here
 * first tokenizes the expression into CODE (identifiers, operators,
 * punctuation, bare literals) and DATA (a single-quoted string's bytes); only
 * CODE is rewritten, and the fold compares a literal's decoded value through
 * `githubEquals`. GitHub's only string escape is a doubled single quote
 * (`'It''s'`); a backslash is a literal backslash, NOT a JS escape, so a
 * backslash is carried as data and never decoded. Normative source: GitHub
 * Docs "Evaluate expressions in workflows and actions" (literals, and the
 * loose-equality conversion table this file's `githubEquals` implements).
 *
 * THE MODEL, and what it cannot see. Reachability is decided against a small
 * declared set of pull_request contexts (PR_CONTEXTS below) -- a job is
 * reachable if ANY of them makes its `if:` true. `needs.*.result` reads
 * `success` and `needs.*.outputs.*` reads `'true'`, the permissive reading:
 * a job that is reachable only when an upstream job FAILS will read as
 * unreachable and needs a registry entry naming that. A job's
 * `strategy.matrix` is evaluated under the same contexts (#3085 gap 2); the
 * matrix helpers live in the reachability test, which imports this model.
 * One known blind spot, stated rather than papered over: a workflow with no
 * `pull_request`/`pull_request_target` trigger at all is out of scope -- the
 * nightly-only lanes (tool-smoke, compat-smoke, parser-smoke, release,
 * labels, ...) are deliberate, and flagging every job in them would bury the
 * sweep's real signal in a registry nobody reads (#3085 gap 1).
 */
import yaml from "../../clients/deps/js-yaml.js";

export interface PullRequestContext {
	label: string;
	eventName: string;
	action: string;
	merged: boolean;
}

// A job is PR-reachable if ANY of these makes its `if:` true. Two rows,
// because one cannot serve both: `clear-stale-verdict-labels` requires
// action `synchronize`, and a job restricted to other actions (as
// `pr-body-lint` was before #3864 F2) needs a non-synchronize row; both kinds
// are genuinely PR-reachable.
export const PR_CONTEXTS: readonly PullRequestContext[] = [
	{
		label: "pull_request / opened",
		eventName: "pull_request",
		action: "opened",
		merged: false,
	},
	{
		label: "pull_request / synchronize",
		eventName: "pull_request",
		action: "synchronize",
		merged: false,
	},
];

/**
 * The closed domain of a value a declared context path injects: exactly the
 * literals GitHub expressions have (string, number, boolean, null). A row that
 * returned an object does not type-check, so `literalToken` needs no runtime
 * non-scalar branch and no cast (F8.2).
 */
export type ScalarLiteralValue = string | number | boolean | null;

const CONTEXT_PATHS: Array<
	[string, (ctx: PullRequestContext) => ScalarLiteralValue]
> = [
	["github.event_name", (ctx) => ctx.eventName],
	["github.event.action", (ctx) => ctx.action],
	["github.event.pull_request.merged", (ctx) => ctx.merged],
	// Same-repo PR by a human: the common case, and the permissive one for
	// every fork / bot guard in the tree.
	["github.event.pull_request.head.repo.full_name", () => "acme/repo"],
	["github.event.pull_request.user.login", () => "a-human"],
	["github.repository", () => "acme/repo"],
	// A `pull_request` event carries no workflow_run payload at all, so every
	// path under it reads null -- which is what makes a workflow_run-only job
	// correctly unreachable from a PR.
	["github.event.workflow_run.head_repository.full_name", () => null],
	["github.event.workflow_run.head_branch", () => null],
	["github.event.workflow_run.conclusion", () => null],
	["github.event.workflow_run.run_attempt", () => null],
	["github.event.workflow_run.event", () => null],
];

// Zero-argument status functions carry a fixed result; the permissive
// `needs.*` reading substitutes `success` and `'true'`. These are CODE-only
// rewrites on the token stream below, never a raw regex over the text.
const NEEDS_RESULT = /^needs\.[A-Za-z0-9_-]+\.result$/;
const NEEDS_OUTPUT = /^needs\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+$/;

function statusFunctionResult(name: string): boolean | undefined {
	switch (name) {
		case "always":
		case "success":
			return true;
		case "failure":
		case "cancelled":
			return false;
		default:
			return undefined;
	}
}

/**
 * `${{ ... }}` is optional around a job-level `if:`; release.yml writes it
 * that way. Strip it before evaluating or projecting either spelling. Shared
 * by `substituteForPullRequest` and the event-name projection below so the two
 * cannot disagree about what counts as the expression body.
 */
function expressionBody(expr: string): string {
	return expr.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
}

/**
 * GitHub's equality, and the module's ONE owner of it (see EVALUATION above).
 * A string pair compares case-insensitively ("GitHub ignores case when
 * comparing strings"); a mismatched scalar pair coerces to a number
 * (`null`/`""` -> 0, `false` -> 0, `true` -> 1, any other non-numeric string
 * -> NaN), and NaN equals nothing -- including itself. This is the seam the
 * #3941 projection and the `substituteForPullRequest` fold both ask, so the
 * two cannot drift onto different comparison semantics.
 */
export function githubEquals(left: unknown, right: unknown): boolean {
	if (typeof left === "string" && typeof right === "string") {
		return left.toLowerCase() === right.toLowerCase();
	}
	return toGithubNumber(left) === toGithubNumber(right);
}

function toGithubNumber(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") return value;
	if (typeof value === "string") return Number(value);
	return Number.NaN;
}

// A literal operand, kept as its decoded value: a GitHub `'…'` string, a
// number, a boolean, or null. CODE and DATA are separate token kinds, so no
// transform can reach inside a string's bytes.
type LiteralToken =
	| { kind: "string"; value: string }
	| { kind: "number"; value: number }
	| { kind: "bool"; value: boolean }
	| { kind: "null" };
type ExpressionToken =
	| LiteralToken
	| { kind: "word"; text: string }
	| { kind: "punct"; text: string };

class WorkflowExpressionError extends Error {
	constructor(detail: string) {
		super(
			`workflow-pull-request-reachability: unsupported expression: ${detail}`,
		);
		this.name = "WorkflowExpressionError";
	}
}

// Sticky so each scan starts exactly where the previous token ended. A number
// keeps the docs' hex spelling (`0xff`) and a negative sign.
const IDENTIFIER_TOKEN =
	/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/y;
const NUMBER_TOKEN =
	/-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const OPERATOR_TOKEN = /(?:!==|===|==|!=|<=|>=|&&|\|\||[!<>(,)[\]*+\-/%.])/y;

function identifierToken(text: string): ExpressionToken {
	if (text === "true") return { kind: "bool", value: true };
	if (text === "false") return { kind: "bool", value: false };
	if (text === "null") return { kind: "null" };
	return { kind: "word", text };
}

/** Index just past a GitHub single-quoted literal, `''` counting as a quote. */
function scanGithubString(expr: string, start: number): number {
	let index = start + 1;
	while (index < expr.length) {
		if (expr[index] !== "'") {
			index += 1;
			continue;
		}
		if (expr[index + 1] === "'") {
			index += 2;
			continue;
		}
		return index + 1;
	}
	throw new WorkflowExpressionError(
		`unterminated string literal at index ${start} in ${JSON.stringify(expr)}`,
	);
}

/**
 * Split an expression into CODE and DATA tokens. GitHub's string escape is a
 * doubled single quote; a backslash is a literal backslash (never a JS escape),
 * and a double-quoted string is not GitHub syntax, so both are carried or
 * reported rather than guessed at.
 */
function tokenizeExpression(expr: string): ExpressionToken[] {
	const tokens: ExpressionToken[] = [];
	let index = 0;
	while (index < expr.length) {
		const char = expr[index] as string;
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (char === "'") {
			const end = scanGithubString(expr, index);
			tokens.push({
				kind: "string",
				value: expr.slice(index + 1, end - 1).replace(/''/g, "'"),
			});
			index = end;
			continue;
		}
		if (char === '"') {
			throw new WorkflowExpressionError(
				`double-quoted string at index ${index}: GitHub expressions use single quotes, in ${JSON.stringify(expr)}`,
			);
		}
		IDENTIFIER_TOKEN.lastIndex = index;
		const identifier = IDENTIFIER_TOKEN.exec(expr);
		if (identifier !== null) {
			tokens.push(identifierToken(identifier[0]));
			index += identifier[0].length;
			continue;
		}
		NUMBER_TOKEN.lastIndex = index;
		const number = NUMBER_TOKEN.exec(expr);
		if (number !== null) {
			tokens.push({ kind: "number", value: Number(number[0]) });
			index += number[0].length;
			continue;
		}
		OPERATOR_TOKEN.lastIndex = index;
		const operator = OPERATOR_TOKEN.exec(expr);
		if (operator !== null) {
			tokens.push({ kind: "punct", text: operator[0] });
			index += operator[0].length;
			continue;
		}
		throw new WorkflowExpressionError(
			`unrecognised character ${JSON.stringify(char)} at index ${index} in ${JSON.stringify(expr)}`,
		);
	}
	return tokens;
}

function literalToken(value: ScalarLiteralValue): LiteralToken {
	if (value === null) return { kind: "null" };
	if (typeof value === "boolean") return { kind: "bool", value };
	if (typeof value === "number") return { kind: "number", value };
	return { kind: "string", value };
}

/** Rewrite CODE only: context reads, status functions, and the needs forms. */
function substituteTokens(
	tokens: readonly ExpressionToken[],
	ctx: PullRequestContext,
): ExpressionToken[] {
	const substituted: ExpressionToken[] = [];
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] as ExpressionToken;
		if (token.kind === "word") {
			const context = CONTEXT_PATHS.find(([path]) => path === token.text);
			if (context !== undefined) {
				substituted.push(literalToken(context[1](ctx)));
				index += 1;
				continue;
			}
			if (NEEDS_RESULT.test(token.text)) {
				substituted.push({ kind: "string", value: "success" });
				index += 1;
				continue;
			}
			if (NEEDS_OUTPUT.test(token.text)) {
				substituted.push({ kind: "string", value: "true" });
				index += 1;
				continue;
			}
			const status = statusFunctionResult(token.text);
			const open = tokens[index + 1] as ExpressionToken | undefined;
			const close = tokens[index + 2] as ExpressionToken | undefined;
			if (
				status !== undefined &&
				open?.kind === "punct" &&
				open.text === "(" &&
				close?.kind === "punct" &&
				close.text === ")"
			) {
				substituted.push({ kind: "bool", value: status });
				index += 3;
				continue;
			}
		}
		substituted.push(token);
		index += 1;
	}
	return substituted;
}

function isLiteralToken(
	token: ExpressionToken | undefined,
): token is LiteralToken {
	return token !== undefined && token.kind !== "word" && token.kind !== "punct";
}

function literalValueOf(token: LiteralToken): string | number | boolean | null {
	return token.kind === "null" ? null : token.value;
}

// Operators GitHub binds at or above equality (`!` and the relationals), plus
// equality itself. A literal comparison beside one of these is not a complete
// operand: it is `!`'s operand, a relational's operand, or the non-literal side
// of a longer equality chain. Folding it would guess a topology GitHub
// evaluates differently, so the fold refuses instead (F7).
const COMPARISON_BOUNDARY_OPERATORS: ReadonlySet<string> = new Set([
	"!",
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
]);

/**
 * Fold every run of literal `==`/`!=` comparisons through GitHub's equality,
 * LEFT-ASSOCIATIVELY as GitHub does (`a == b == c` is `(a == b) == c`). A
 * literal comparison run that is not a COMPLETE operand -- the token before its
 * first literal, or the token after its last operand, is `!`, a relational, or
 * another comparison operator -- is REFUSED with a bounded
 * `WorkflowExpressionError` rather than folded into a guessed boolean. The
 * refusal names the neighbouring operator and the reason; it never echoes the
 * expression's own data (F7).
 */
function foldLiteralComparisons(
	tokens: readonly ExpressionToken[],
): ExpressionToken[] {
	const folded: ExpressionToken[] = [];
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] as ExpressionToken;
		const firstOperator = tokens[index + 1] as ExpressionToken | undefined;
		if (
			!isLiteralToken(token) ||
			firstOperator?.kind !== "punct" ||
			(firstOperator.text !== "==" && firstOperator.text !== "!=") ||
			!isLiteralToken(tokens[index + 2])
		) {
			folded.push(token);
			index += 1;
			continue;
		}
		// Measure the whole run `LITERAL (==|!= LITERAL)+` first, so the boundary
		// check below sees the comparison chain rather than one pair.
		let end = index + 3;
		for (;;) {
			const next = tokens[end] as ExpressionToken | undefined;
			if (
				next?.kind !== "punct" ||
				(next.text !== "==" && next.text !== "!=") ||
				!isLiteralToken(tokens[end + 1])
			) {
				break;
			}
			end += 2;
		}
		const before = tokens[index - 1] as ExpressionToken | undefined;
		if (
			before?.kind === "punct" &&
			COMPARISON_BOUNDARY_OPERATORS.has(before.text)
		) {
			throw new WorkflowExpressionError(
				`a literal ==/!= comparison is preceded by ${JSON.stringify(before.text)}, ` +
					`which GitHub binds at or above equality; this topology is outside the model's partial evaluation`,
			);
		}
		const after = tokens[end] as ExpressionToken | undefined;
		if (
			after?.kind === "punct" &&
			COMPARISON_BOUNDARY_OPERATORS.has(after.text)
		) {
			throw new WorkflowExpressionError(
				`a literal ==/!= comparison is followed by ${JSON.stringify(after.text)}, ` +
					`which GitHub binds at or above equality; this topology is outside the model's partial evaluation`,
			);
		}
		let accumulator = token;
		for (let at = index + 1; at < end; at += 2) {
			const operator = tokens[at] as { kind: "punct"; text: "==" | "!=" };
			const right = tokens[at + 1] as LiteralToken;
			const equal = githubEquals(
				literalValueOf(accumulator),
				literalValueOf(right),
			);
			accumulator = {
				kind: "bool",
				value: operator.text === "==" ? equal : !equal,
			};
		}
		folded.push(accumulator);
		index = end;
	}
	return folded;
}

/** Rebuild JS source: operators normalized, string DATA as a JSON literal. */
function renderTokens(tokens: readonly ExpressionToken[]): string {
	return tokens
		.map((token) => {
			switch (token.kind) {
				case "string":
					return JSON.stringify(token.value);
				case "number":
					return String(token.value);
				case "bool":
					return token.value ? "true" : "false";
				case "null":
					return "null";
				case "word":
					return token.text;
				case "punct":
					return token.text === "=="
						? "==="
						: token.text === "!="
							? "!=="
							: token.text;
			}
		})
		.join(" ");
}

export function substituteForPullRequest(
	expr: string,
	ctx: PullRequestContext,
): string {
	const substituted = substituteTokens(
		tokenizeExpression(expressionBody(expr)),
		ctx,
	);
	// The residue is CODE only: a context path inside a string literal is DATA
	// and is deliberately not read as a context reference.
	const residue = substituted
		.map((token) =>
			token.kind === "word" || token.kind === "punct" ? token.text : "",
		)
		.join("");
	if (/(?:github|needs|env|inputs|steps|vars|secrets)\./.test(residue)) {
		throw new Error(
			`workflow-pull-request-reachability: unrecognised context path in an if: expression -- ` +
				`add it to CONTEXT_PATHS with the value a pull_request run would see, rather than ` +
				`letting it be guessed at. Residue: ${residue}`,
		);
	}
	return renderTokens(foldLiteralComparisons(substituted));
}

/**
 * Evaluate a workflow expression under one PR context. `fromJSON` is the one
 * function a matrix narrowing uses, and it is JSON.parse.
 */
export function evaluateForPullRequest(
	expr: string,
	ctx: PullRequestContext,
): unknown {
	const substituted = substituteForPullRequest(expr, ctx);
	// `new Function` over this repo's own workflow text plus JSON-literal
	// fixtures, never external or untrusted input -- the same argument
	// tests/config/ci-infra-kill-rerun-gate.test.ts makes for the same
	// technique.
	return new Function("fromJSON", `"use strict"; return (${substituted});`)(
		(text: string) => JSON.parse(text),
	);
}

export function isTrueForPullRequest(
	expr: string,
	ctx: PullRequestContext,
): boolean {
	return Boolean(evaluateForPullRequest(expr, ctx));
}

export function isPullRequestReachable(expr: string): boolean {
	return PR_CONTEXTS.some((ctx) => isTrueForPullRequest(expr, ctx));
}

export interface WorkflowFile {
	/** `.github/workflows/<name>.yml`, the registry key prefix. */
	path: string;
	text: string;
}

type Job = {
	if?: unknown;
	name?: unknown;
	"continue-on-error"?: unknown;
	strategy?: { matrix?: unknown };
};
type Workflow = { on?: unknown; jobs?: Record<string, Job> };

export function loadWorkflow(text: string): Workflow {
	// `on:` is YAML 1.1 truthy, so js-yaml can key it as boolean `true`.
	const parsed = yaml.load(text) as Record<string, unknown>;
	const triggers = parsed?.on ?? parsed?.[true as unknown as string];
	return { on: triggers, jobs: parsed?.jobs as Record<string, Job> };
}

export function triggersOnPullRequest(workflow: Workflow): boolean {
	const triggers = workflow.on;
	// GitHub accepts three spellings of `on:` and this must read all three.
	// The ARRAY case is checked first and explicitly (round 2, F1): an array
	// is `typeof "object"`, so the mapping branch below would key it with
	// Object.keys and get ["0","1"] -- no match, and every job in that file
	// silently skipped with jobsExamined 0, the sweep reading clean over a
	// file it never looked inside. Every workflow in the tree happens to use
	// the mapping form today, which is exactly why this read clean; the
	// sweep exists for the next member, which may use any spelling.
	const names = Array.isArray(triggers)
		? triggers.map(String)
		: typeof triggers === "string"
			? [triggers]
			: triggers && typeof triggers === "object"
				? Object.keys(triggers as Record<string, unknown>)
				: [];
	return names.some(
		(name) => name === "pull_request" || name === "pull_request_target",
	);
}

// ── #3941 event-only exclusion projection ──────────────────────────────────

/**
 * Every GitHub event whose `github.event_name` still carries a pull request:
 * the fork-safe `pull_request` and the base-checkout `pull_request_target`. A
 * condition true for EITHER is not proven excluded.
 */
const PULL_REQUEST_EVENT_NAMES = [
	"pull_request",
	"pull_request_target",
] as const;

/**
 * Read `expr` as one whole `github.event_name == '<literal>'` expression whose
 * atoms are joined by `||`, and return the literals. Returns null -- UNPROVEN
 * -- for every other operator, context path, function, group, or escaped
 * literal.
 *
 * This is a syntactic SHAPE, not an enumeration of event spellings: the atoms
 * are compared through `githubEquals`, so `'PULL_REQUEST'`, `'Pull_Request'`
 * and `'pull_request'` are one atom. The `^…$` anchor is load-bearing: a
 * `github.event_name` inside quoted prose (`'github.event_name' != …`) or
 * beside a second operator (`… && '0' == 0`) is never read as an event-name
 * comparison. A literal may not contain a quote or a backslash, so GitHub's
 * doubled quote and a JS backslash escape stay UNPROVEN rather than guessed.
 */
function eventNameEqualityLiterals(expr: string): string[] | null {
	const body = expressionBody(expr).trim();
	if (body === "") return null;
	const literals: string[] = [];
	for (const atom of body.split("||")) {
		const match = /^\s*github\.event_name\s*==\s*'([^'\\]*)'\s*$/.exec(atom);
		if (match === null) return null;
		literals.push(match[1] as string);
	}
	return literals;
}

/**
 * Does this job-level `if:` PROVE the job never runs on a pull request?
 *
 * A job is excluded only when its `if:` is a whole `github.event_name ==
 * '<literal>'` `||`-expression that is false for EVERY pull-request event
 * name. Everything the shape does not prove -- `!=`, `&&`, grouping, another
 * context path, a status function, a JS-escaped literal, a `github.event_name`
 * inside quoted prose -- returns false, so the job stays pull-request eligible
 * and the #3941 guard keeps covering a real checkout rather than losing it
 * (AGENTS.md shape 48). The trade is deliberate and asymmetric: an unproven
 * condition may keep a genuinely schedule-only job in stage C and ask it to
 * move off the merge ref (over-inclusion), but a real pull-request job is
 * never silently dropped to stage D (the false-exclusion harm this guard
 * exists to prevent).
 */
export function provesNotPullRequestEligible(expr: unknown): boolean {
	if (typeof expr !== "string") return false;
	const literals = eventNameEqualityLiterals(expr);
	if (literals === null) return false;
	return PULL_REQUEST_EVENT_NAMES.every(
		(eventName) =>
			!literals.some((literal) => githubEquals(literal, eventName)),
	);
}
