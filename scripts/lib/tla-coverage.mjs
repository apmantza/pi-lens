// Dependency-free coverage-map seam for #3802 rule 2.
//
// `scripts/check-pr-body.mjs` runs in the `PR body (advisory)` job, which
// checks out the repo and runs plain Node with NO `npm install`. Everything
// this module imports must therefore come from `node:` only -- `minimatch` and
// the other glob packages are unavailable on that lane.
//
// A PR that changes a file the checked-in `formal/coverage-map.json` maps to
// model families must also change a `.tla`/`.cfg` under ANY ONE of the row's
// families' `formal/<family>/`, or carry a `TLA+ unaffected: <family> —
// <reason>` line in the PR body for any one of them. A row listing
// `HUB_FAMILY_THRESHOLD` or more families is too coarse for a file-level rule
// to call, so it only prints a note. `unmodelled` entries are advisory and
// never fail. #3802.
import fs from "node:fs";
import path from "node:path";

/** Repo-relative location of the checked-in coverage map. */
const COVERAGE_MAP_PATH = "formal/coverage-map.json";

/** Map value for a lifecycle seam no family models yet. */
const UNMODELLED = "unmodelled";

/** A coverage file whose change proves the family's model moved with the code. */
const MODEL_FILE = /\.(?:tla|cfg)$/;

/**
 * A row listing this many families or more is a hub file (`index.ts`, the LSP
 * client): file-level matching cannot tell which family a change moves, so an
 * unmet hub row is a note, not an error, until hunk-level matching exists.
 */
const HUB_FAMILY_THRESHOLD = 4;

function compareStrings(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

function toPosix(value) {
	return String(value).replaceAll("\\", "/");
}

/**
 * Translate the glob forms the map actually uses -- `*` (one path segment),
 * `**` (any number of segments), `?` (one non-separator character) -- into an
 * anchored RegExp over a repo-relative posix path. Character classes and brace
 * alternation are intentionally NOT expanded: the map carries none, and a
 * hand-rolled brace parser is more likely to be wrong than a future map row is
 * to use one. A literal `[`/`{` still matches itself.
 */
export function globToRegExp(glob) {
	const source = String(glob);
	let pattern = "";
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (char === "*") {
			if (source[index + 1] === "*") {
				index += 1;
				if (source[index + 1] === "/") {
					index += 1;
					pattern += "(?:[^/]+/)*";
				} else {
					pattern += ".*";
				}
			} else {
				pattern += "[^/]*";
			}
		} else if (char === "?") {
			pattern += "[^/]";
		} else if (/[.+^$()|\\[\]{}]/.test(char)) {
			pattern += `\\${char}`;
		} else {
			pattern += char;
		}
	}
	return new RegExp(`^${pattern}$`);
}

/** True when `filePath` (repo-relative, posix or not) matches `glob`. */
export function matchGlob(glob, filePath) {
	return globToRegExp(glob).test(toPosix(filePath));
}

/** Read and parse the checked-in map. Throws when it is absent or malformed. */
export function loadCoverageMap(rootDir = process.cwd()) {
	const mapPath = path.join(rootDir, COVERAGE_MAP_PATH);
	let raw;
	try {
		raw = fs.readFileSync(mapPath, "utf8");
	} catch (error) {
		throw new Error(
			`cannot read ${COVERAGE_MAP_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`cannot parse ${COVERAGE_MAP_PATH}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Every repo-relative path a unified diff touches, from each `diff --git`
 * header. Both the pre-image and post-image path are kept, so a rename away
 * from a mapped file still counts as touching it.
 */
export function parseChangedFiles(diff = "") {
	const paths = new Set();
	for (const line of String(diff).split(/\r?\n/)) {
		const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		if (!header) continue;
		for (const side of [header[1], header[2]]) paths.add(toPosix(side));
	}
	return [...paths];
}

/** Directory a glob is rooted at, or `null` when it is a literal path. */
function globStaticDir(glob) {
	const parts = toPosix(glob).split("/");
	const staticParts = [];
	for (const part of parts) {
		if (/[*?]/.test(part)) return staticParts.join("/");
		staticParts.push(part);
	}
	return null;
}

function walkFiles(rootDir, relativeDir, found) {
	if (found.length > 50_000) return;
	const absolute = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
	let entries;
	try {
		entries = fs.readdirSync(absolute, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walkFiles(rootDir, relative, found);
		else found.push(relative);
	}
}

/** Whether `glob` matches at least one file under `rootDir`. */
function globMatchesAnyFile(glob, rootDir = process.cwd()) {
	const staticDir = globStaticDir(glob);
	if (staticDir === null) {
		return fs.existsSync(path.join(rootDir, toPosix(glob)));
	}
	const found = [];
	walkFiles(rootDir, staticDir, found);
	return found.some((file) => matchGlob(glob, file));
}

/**
 * Structural validation of the map itself: every glob matches at least one
 * file, every named family exists under `formal/` with at least one
 * `.tla`/`.cfg`, every `formal/<dir>` is a listed family (a TLA lane that adds
 * a family adds it, and its map row, here), and every value is `unmodelled`
 * or a known-family array. Returns error strings (empty when the map is
 * sound).
 */
export function validateCoverageMap(map, rootDir = process.cwd()) {
	const errors = [];
	if (!map || typeof map !== "object") return ["coverage map is not an object"];
	const families = Array.isArray(map.families) ? map.families : [];
	if (!families.length) errors.push("coverage map has no families");
	for (const family of families) {
		let entries = [];
		try {
			entries = fs.readdirSync(path.join(rootDir, "formal", family));
		} catch {
			errors.push(`formal/${family}/ is missing`);
			continue;
		}
		if (!entries.some((entry) => MODEL_FILE.test(entry)))
			errors.push(`formal/${family}/ has no .tla/.cfg`);
	}
	const known = new Set(families);
	let formalEntries = [];
	try {
		formalEntries = fs.readdirSync(path.join(rootDir, "formal"), {
			withFileTypes: true,
		});
	} catch {
		// A root with no formal/ already reports every listed family missing.
	}
	for (const entry of formalEntries)
		if (entry.isDirectory() && !known.has(entry.name))
			errors.push(
				`formal/${entry.name}/ is not listed in ${COVERAGE_MAP_PATH} families; add it and a map row naming it`,
			);
	for (const [glob, value] of Object.entries(map.map ?? {})) {
		if (!globMatchesAnyFile(glob, rootDir))
			errors.push(`glob ${glob} matches no file`);
		if (value === UNMODELLED) continue;
		if (!Array.isArray(value) || !value.length) {
			errors.push(
				`map.${glob} must be "${UNMODELLED}" or a non-empty family array`,
			);
			continue;
		}
		for (const family of value)
			if (!known.has(family))
				errors.push(`map.${glob} names unknown family ${family}`);
	}
	return errors;
}

/**
 * The PR body with fenced code blocks (``` or ~~~, closed by a marker at least
 * as long) and HTML comments blanked, so a declaration a reader cannot see
 * rendered never satisfies the rule. Fences are blanked first: GitHub gives a
 * fence precedence over a `<!--` inside it.
 */
function blankFencesAndComments(body) {
	let fence = null;
	const unfenced = String(body ?? "")
		.split(/\r?\n/)
		.map((line) => {
			const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
			if (marker) {
				if (!fence) fence = marker;
				else if (marker[0] === fence[0] && marker.length >= fence.length)
					fence = null;
				return "";
			}
			return fence ? "" : line;
		})
		.join("\n");
	return unfenced.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

function bodyNamesFamily(lines, family) {
	const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `(?![\w-])` keeps `read-guard` from matching `read-guard-foo`: the family
	// must end at a word boundary before its separator dash.
	const pattern = new RegExp(
		`^\\s*(?:[-*+]\\s+)?\\**TLA\\+ unaffected:\\s*${escaped}(?![\\w-])\\s*[—–-]\\s*\\S`,
	);
	return lines.some((line) => pattern.test(line));
}

/**
 * The rule itself. Given the parsed map, the diff's changed paths, and the PR
 * body, return `{ errors, advisories }`. A changed mapped file is satisfied
 * when ANY family on its row moved (a `.tla`/`.cfg` under `formal/<family>/`)
 * or is declared unaffected in the body; an unmet row with fewer than
 * `HUB_FAMILY_THRESHOLD` families is an error, an unmet hub row a note.
 * `unmodelled` seams stay advisories.
 */
export function evaluateTlaCoverage({ map, changedFiles = [], body = "" }) {
	const changed = changedFiles.map(toPosix).sort(compareStrings);
	const formalChanged = changed.filter((file) => file.startsWith("formal/"));
	const lines = blankFencesAndComments(body).split(/\r?\n/);
	const errors = new Set();
	const advisories = new Set();
	const families = new Set(Array.isArray(map?.families) ? map.families : []);
	for (const [glob, value] of Object.entries(map?.map ?? {})) {
		const matched = changed.filter((file) => matchGlob(glob, file));
		if (!matched.length) continue;
		if (value === UNMODELLED) {
			for (const file of matched)
				advisories.add(
					`TLA+ unmodelled: ${file} has no formal family yet; leave the gap visible in ${COVERAGE_MAP_PATH}.`,
				);
			continue;
		}
		const list = Array.isArray(value) ? value : [];
		if (!list.length) {
			errors.add(
				`coverage map row ${glob} is neither "${UNMODELLED}" nor a family list`,
			);
			continue;
		}
		const unknown = list.filter((family) => !families.has(family));
		for (const family of unknown)
			errors.add(`coverage map row ${glob} names unknown family ${family}`);
		if (unknown.length) continue;
		const satisfied = list.some(
			(family) =>
				formalChanged.some(
					(file) =>
						file.startsWith(`formal/${family}/`) && MODEL_FILE.test(file),
				) || bodyNamesFamily(lines, family),
		);
		if (satisfied) continue;
		if (list.length >= HUB_FAMILY_THRESHOLD) {
			advisories.add(
				`TLA+ note: ${matched[0]} maps to ${list.length} families (${list.join(", ")}) and file-level matching cannot tell which your change moves; if it changes lifecycle, timing or identity behaviour, change a .tla/.cfg under one of them or add "TLA+ unaffected: <family> \u2014 <reason>" to the PR body (hunk-level matching is #3878).`,
			);
			continue;
		}
		const target = list.map((family) => `formal/${family}/`).join(", ");
		errors.add(
			`Changed file ${matched[0]} is modelled by ${target}: change a .tla/.cfg under any listed family, or add "TLA+ unaffected: ${list[0]} \u2014 <reason>" (naming any listed family) to the PR body.`,
		);
	}
	return {
		errors: [...errors].sort(compareStrings),
		advisories: [...advisories].sort(compareStrings),
	};
}
