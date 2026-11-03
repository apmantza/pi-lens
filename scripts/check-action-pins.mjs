#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { githubHeaders } from "./lib/github-rest.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const SHA = /^[0-9a-f]{40}$/i;
const FULL_VERSION = /^v?\d+\.\d+\.\d+$/;
const PREFIX_VERSION = /^v?\d+(?:\.\d+)?$/;
const USES = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SETUP_PYTHON = "actions/setup-python";
// The one admitted shape: a concrete interpreter release, x.y or x.y.z. Every
// other spelling — a channel (3.x), a bare major, a range, a wildcard, a
// pre-release, an unquoted YAML number, a null, an expression this rule cannot
// resolve — refuses, because a floating interpreter silently changes which
// wheels a job can install (#4666, #4683).
const CONCRETE_PYTHON = /^\d+\.\d+(?:\.\d+)?$/;
// `${{ matrix.<key> }}` is the only expression this rule answers: the legs are
// in the same document. Every other expression (env, inputs, a `||` fallback, a
// function call, an expression embedded in a string) is refused.
const MATRIX_REFERENCE = /^\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}$/;

export function parseActionPins(text, file = "<fixture>") {
	const pins = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const match = line.match(USES);
		if (!match) continue;
		const at = match[1].lastIndexOf("@");
		if (at < 1) continue;
		const ref = match[1].slice(at + 1);
		if (!SHA.test(ref)) continue;
		const action = match[1].slice(0, at);
		const comment = match[2]?.trim() ?? "";
		pins.push({
			action,
			sha: ref.toLowerCase(),
			tag: comment,
			file,
			line: index + 1,
		});
	}
	return pins;
}

export function validatePins(pins, resolveTag, exemptions = {}) {
	return Promise.all(
		pins.map(async (pin) => {
			const key = `${pin.action}@${pin.sha}#${pin.tag}`;
			const location = `${pin.file}:${pin.line}`;
			if (exemptions[key]) return null;
			if (!pin.tag)
				return `${location}: ${pin.action}@${pin.sha} has no version comment`;
			let resolved;
			try {
				if (FULL_VERSION.test(pin.tag)) {
					resolved = await resolveTag(pin.action, pin.tag);
					if (!resolved || !SHA.test(resolved))
						throw new Error("GitHub API response has no commit SHA");
					resolved = resolved.toLowerCase();
				} else if (PREFIX_VERSION.test(pin.tag)) {
					const matches = await resolveTag(pin.action, pin.tag);
					if (!Array.isArray(matches))
						throw new Error("GitHub API response has no matching release tags");
					const matching = matches.filter(
						(match) => match.sha.toLowerCase() === pin.sha,
					);
					if (matching.length) return null;
					const nearest =
						matches.map((match) => match.tag).join(", ") || "none";
					return `${location}: ${pin.action}@${pin.sha} is not a ${pin.tag} release; nearest tags: ${nearest}`;
				} else {
					throw new Error(`unsupported version comment ${pin.tag}`);
				}
			} catch (error) {
				return `${location}: cannot resolve ${pin.action} tag ${pin.tag}: ${error.message}`;
			}
			return resolved === pin.sha
				? null
				: `${location}: ${pin.action} # ${pin.tag} resolves to ${resolved}, not ${pin.sha}`;
		}),
	).then((results) => results.filter(Boolean));
}

/** `actions/setup-python` from a `uses:` value. Owner and repository names are
 *  case-insensitive on GitHub, and the ref after `@` is not part of the
 *  action's identity, so `Actions/Setup-Python@v7` is the same action. */
function actionName(uses) {
	return uses.split("@")[0].trim().toLowerCase();
}

const isMapping = (value) =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A value as it should read inside a message: `3.1`, `null`, `"3.12"`. */
const shown = (value) => JSON.stringify(value) ?? String(value);

/**
 * The values one `${{ matrix.<key> }}` reference can take, or an error string.
 * GitHub builds the matrix from the axis list AND from every `include:` row, so
 * both answer for the key; a key nothing declares is unanswerable, not empty.
 *
 * Every matrix shape this rule cannot read is an error, not an empty list of
 * legs (shape 69). An `include:` it cannot read used to read as absent, so a
 * concrete axis list admitted a step whose included legs it never saw (#4695
 * F-4695-1). `null` is the absent spelling of a present key — `include:` with
 * nothing after it adds no row — and every other non-list refuses.
 */
function matrixLegs(strategy, key) {
	if (!isMapping(strategy))
		return strategy === undefined || strategy === null
			? `the job declares no strategy.matrix, so matrix.${key} has no value`
			: "the job's strategy is not a mapping";
	const matrix = strategy.matrix;
	if (matrix === undefined || matrix === null)
		return `the job declares no strategy.matrix, so matrix.${key} has no value`;
	if (!isMapping(matrix)) return "strategy.matrix is not a mapping";
	if (matrix.include != null && !Array.isArray(matrix.include))
		return "matrix.include is not a list the rule can read";
	const legs = [];
	if (key in matrix) {
		if (!Array.isArray(matrix[key]))
			return `matrix.${key} is not a list of values`;
		legs.push(...matrix[key]);
	}
	for (const row of matrix.include ?? []) {
		if (!isMapping(row))
			return `matrix.include holds ${shown(row)}, which is not a mapping`;
		if (key in row) legs.push(row[key]);
	}
	if (!legs.length) return `matrix.${key} declares no value`;
	return legs;
}

/**
 * The path to the first `<<` merge key in a parsed document, or undefined.
 *
 * The default YAML 1.2 schema leaves a merge key as a literal key, so
 * everything it would bring in — a step's `uses`, a job's or a composite
 * `runs` mapping's `steps`, a matrix's legs — stays invisible to this walker.
 * One unresolved merge ANYWHERE refuses the file, rather than enumerating the
 * positions that could hide a pin (shape 69: an enumerated guard passes the
 * position it does not list).
 */
function mergeKeyAt(value, at = "") {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const found = mergeKeyAt(item, `${at}[${index}]`);
			if (found) return found;
		}
		return undefined;
	}
	if (!isMapping(value)) return undefined;
	if ("<<" in value) return at || "the document";
	for (const [key, child] of Object.entries(value)) {
		const found = mergeKeyAt(child, at ? `${at}.${key}` : key);
		if (found) return found;
	}
	return undefined;
}

/** One error for one step, or nothing when the step pins a concrete release. */
function interpreterPinError(step, at, strategy) {
	if (step.uses === undefined) return [];
	if (typeof step.uses !== "string")
		return [`${at}: uses is not a string; the action cannot be read`];
	if (actionName(step.uses) !== SETUP_PYTHON) return [];
	const inputs = step.with;
	if (!isMapping(inputs))
		return inputs === undefined || inputs === null
			? [`${at}: ${SETUP_PYTHON} has no python-version pin`]
			: [`${at}: with is not a mapping; the python-version pin cannot be read`];
	// The default YAML 1.2 schema leaves a `<<` merge key as a key, so the pin
	// it would bring in is invisible here. interpreterPinErrors refuses the whole
	// file on one, before any step is read, so this branch needs no merge case.
	if (!("python-version" in inputs))
		return [`${at}: ${SETUP_PYTHON} has no python-version pin`];
	const pin = inputs["python-version"];
	if (typeof pin !== "string")
		return [
			`${at}: ${SETUP_PYTHON} python-version ${shown(pin)} is not a string; quote the exact release`,
		];
	if (CONCRETE_PYTHON.test(pin)) return [];
	const reference = MATRIX_REFERENCE.exec(pin);
	if (!reference)
		return [
			`${at}: ${SETUP_PYTHON} python-version ${shown(pin)} is not a concrete x.y or x.y.z release`,
		];
	const key = reference[1];
	const legs = matrixLegs(strategy, key);
	if (typeof legs === "string")
		return [
			`${at}: ${SETUP_PYTHON} python-version ${shown(pin)} cannot be resolved: ${legs}`,
		];
	const floating = legs.filter(
		(leg) => typeof leg !== "string" || !CONCRETE_PYTHON.test(leg),
	);
	if (floating.length)
		return [
			`${at}: ${SETUP_PYTHON} python-version ${shown(pin)} cannot be resolved: matrix.${key} holds ${floating.map(shown).join(", ")}, which is not a concrete x.y or x.y.z release`,
		];
	return [];
}

function interpreterErrorsInSteps(steps, at, strategy) {
	if (steps === undefined) return [];
	if (!Array.isArray(steps)) return [`${at} is not a list of steps`];
	return steps.flatMap((step, index) =>
		isMapping(step)
			? interpreterPinError(step, `${at}[${index}]`, strategy)
			: [`${at}[${index}]: the step is not a mapping`],
	);
}

/** A workflow's path as a message spells it: the repository-relative path with
 *  forward slashes, on every platform. The Windows lane otherwise reads
 *  `.github\\workflows\\ci.yml` where a reader (and every test that pins an exact
 *  message) expects `.github/workflows/ci.yml` (#4683). */
export function displayPath(repoRelativePath, separator = sep) {
	return repoRelativePath.split(separator).join("/");
}

/**
 * Every `actions/setup-python` step in one workflow or composite action, with
 * the verdict for its interpreter pin (#4683).
 *
 * The file is PARSED, not scanned: flow collections, anchors, aliases, tags and
 * block scalars arrive resolved, so no shape of them can slip past a reader.
 * The rule is an admit-list — a concrete `x.y` or `x.y.z` string, or a matrix
 * reference whose every leg is one — and every form this walker cannot classify
 * is an error (#4683: six review rounds on a text scan each found a silent pass).
 */
export function interpreterPinErrors(text, file = "<fixture>") {
	let document;
	try {
		document = loadYaml(text);
	} catch (error) {
		const first = String(error?.message ?? error).split("\n")[0];
		return [`${file}: cannot be parsed as YAML: ${first}`];
	}
	if (!isMapping(document))
		return [
			`${file}: the document is not a mapping; no step's python-version can be read`,
		];
	const merge = mergeKeyAt(document);
	if (merge)
		return [
			`${file}: ${merge} carries a "<<" merge key this rule does not resolve; pin python-version on the step it applies to`,
		];
	const errors = [];
	const jobs = document.jobs;
	const runs = document.runs;
	if (jobs !== undefined && !isMapping(jobs))
		errors.push(`${file}: jobs is not a mapping of jobs`);
	if (runs !== undefined && !isMapping(runs))
		errors.push(`${file}: runs is not a mapping`);
	if (isMapping(jobs))
		for (const [id, job] of Object.entries(jobs)) {
			if (!isMapping(job)) {
				errors.push(`${file}: jobs.${id} is not a mapping`);
				continue;
			}
			errors.push(
				...interpreterErrorsInSteps(
					job.steps,
					`${file}: jobs.${id}.steps`,
					job.strategy,
				),
			);
		}
	if (isMapping(runs))
		errors.push(
			...interpreterErrorsInSteps(runs.steps, `${file}: runs.steps`, undefined),
		);
	// Fail closed on a file that is neither: a workflow always has `jobs`, a
	// composite action always has `runs`, so nothing to walk means the document
	// was not read, not that it is clean.
	if (!errors.length && !isMapping(jobs) && !isMapping(runs))
		errors.push(
			`${file}: neither a jobs nor a runs mapping; this file is not a workflow or composite action`,
		);
	return errors;
}

export async function workflowFiles(root = ROOT) {
	const found = [];
	async function walk(directory) {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (
				entry.name.endsWith(".yml") ||
				entry.name.endsWith(".yaml") ||
				entry.name === "action.yml"
			)
				found.push(path);
		}
	}
	await walk(join(root, ".github", "workflows"));
	await walk(join(root, ".github", "actions"));
	return found.sort();
}

export async function resolveGithubTag(
	action,
	tag,
	fetchImpl = fetch,
	env = process.env,
) {
	const [owner, repo] = action.split("/");
	if (!owner || !repo) throw new Error(`invalid action ${action}`);
	const base = env.GITHUB_API_URL || "https://api.github.com";
	const headers = githubHeaders(env.GITHUB_TOKEN || env.GH_TOKEN);
	const refUrl = `${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
	const response = await fetchImpl(refUrl, { headers });
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	const ref = await response.json();
	if (ref.object?.type !== "tag") return ref.object?.sha;
	const tagResponse = await fetchImpl(
		`${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/tags/${ref.object.sha}`,
		{ headers },
	);
	if (!tagResponse.ok) throw new Error(`GitHub API ${tagResponse.status}`);
	return (await tagResponse.json()).object?.sha;
}

export async function resolveGithubMatchingTags(
	action,
	prefix,
	fetchImpl = fetch,
	env = process.env,
) {
	const [owner, repo] = action.split("/");
	if (!owner || !repo) throw new Error(`invalid action ${action}`);
	const base = env.GITHUB_API_URL || "https://api.github.com";
	const headers = githubHeaders(env.GITHUB_TOKEN || env.GH_TOKEN);
	const url = `${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/matching-refs/tags/${encodeURIComponent(prefix + ".")}`;
	const response = await fetchImpl(url, { headers });
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	const refs = await response.json();
	if (!Array.isArray(refs))
		throw new Error("GitHub API response is not a ref list");
	return Promise.all(
		refs
			.filter((ref) => ref.ref?.startsWith(`refs/tags/${prefix}.`))
			.map(async (ref) => ({
				tag: ref.ref.slice("refs/tags/".length),
				sha:
					ref.object?.type === "tag"
						? await resolveGithubTagObject(
								action,
								ref.object.sha,
								fetchImpl,
								env,
							)
						: ref.object?.sha,
			})),
	).then((tags) => {
		if (tags.some((tag) => !SHA.test(tag.sha || "")))
			throw new Error("GitHub API response has a ref without a commit SHA");
		return tags.map((tag) => ({ ...tag, sha: tag.sha.toLowerCase() }));
	});
}

async function resolveGithubTagObject(action, objectSha, fetchImpl, env) {
	const [owner, repo] = action.split("/");
	const base = env.GITHUB_API_URL || "https://api.github.com";
	const headers = githubHeaders(env.GITHUB_TOKEN || env.GH_TOKEN);
	const response = await fetchImpl(
		`${base.replace(/\/$/, "")}/repos/${owner}/${repo}/git/tags/${objectSha}`,
		{ headers },
	);
	if (!response.ok) throw new Error(`GitHub API ${response.status}`);
	return (await response.json()).object?.sha;
}

export async function checkActionPins({
	root = ROOT,
	fetchImpl = fetch,
	env = process.env,
} = {}) {
	let exemptions = {};
	const exemptionsFile = join(
		root,
		"scripts",
		"check-action-pins-exemptions.json",
	);
	try {
		const entries = JSON.parse(await readFile(exemptionsFile, "utf8"));
		for (const entry of entries) {
			if (
				!entry.action ||
				!entry.sha ||
				entry.tag === undefined ||
				!entry.reason
			)
				throw new Error("invalid action pin exemption");
			exemptions[`${entry.action}@${entry.sha.toLowerCase()}#${entry.tag}`] =
				entry.reason;
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const files = await workflowFiles(root);
	const texts = await Promise.all(
		files.map(async (file) => [
			displayPath(relative(root, file)),
			await readFile(file, "utf8"),
		]),
	);
	const pins = texts.flatMap(([file, text]) => parseActionPins(text, file));
	// One rule, one entry point: the interpreter pin is returned beside the
	// action-pin verdicts, so a caller that reads this module cannot run half of
	// it (#4683).
	const interpreter = texts.flatMap(([file, text]) =>
		interpreterPinErrors(text, file),
	);
	const resolved = new Map();
	return validatePins(
		pins,
		async (action, tag) => {
			const key = `${action}@${tag}`;
			if (!resolved.has(key))
				resolved.set(
					key,
					FULL_VERSION.test(tag)
						? resolveGithubTag(action, tag, fetchImpl, env)
						: resolveGithubMatchingTags(action, tag, fetchImpl, env),
				);
			return resolved.get(key);
		},
		exemptions,
	).then((errors) => [...errors, ...interpreter]);
}

export async function main() {
	const errors = await checkActionPins();
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exitCode = 1;
	} else {
		console.log(
			"All pinned GitHub Actions match their version comments, and every actions/setup-python step pins a concrete interpreter.",
		);
	}
}

if (isMainModule(import.meta.url)) await main();
