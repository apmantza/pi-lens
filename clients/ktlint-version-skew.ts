/**
 * Step 1 of #3000: detect ktlint version skew and decline autofix.
 *
 * An autofix that writes to the user's repository must fail toward NOT
 * writing when it cannot establish that it agrees with the project. pi-lens
 * resolves ktlint from its managed bin or PATH while a Gradle project may
 * pin a different ktlint CLI through the `org.jlleitschuh.gradle.ktlint`
 * plugin — and ktlint changes rule behaviour between releases (1.5.0 vs
 * 1.8.0 enforce `standard:blank-line-between-when-conditions` differently
 * under `android_studio`), so a foreign binary rewrites files the project's
 * own `ktlintCheck` accepts.
 *
 * What is statically readable WITHOUT executing Gradle (running Gradle to
 * answer this is too expensive for an autofix path):
 *
 * - the plugin application (`org.jlleitschuh.gradle.ktlint` in a Gradle
 *   file) — proves the project manages ktlint, but says nothing about the
 *   CLI version (mapping the plugin version to its default CLI version
 *   would be a guess dressed as a pin, so this module never does it);
 * - a `ktlint { }` block (found with the repo's one Gradle brace scanner,
 *   so comment/string braces cannot fake one);
 * - an explicit CLI pin: `version.set("1.5.0")` (Kotlin DSL),
 *   `version = "1.5.0"` (Groovy), or `version.set(libs.versions.<n>.get())`
 *   resolved through the nearest `gradle/libs.versions.toml` `[versions]`
 *   table. Positions come from the comment-and-string-blanked source (real
 *   code only) while values are read from the raw source at the same
 *   offsets — the pre-pass is length-preserving, so the two align and a
 *   commented-out pin can never be read as a declaration.
 *
 * Decision table (`checkKtlintVersionSkew`, null = no project signal):
 *
 * - no Gradle ktlint signal ................. proceed (status quo);
 * - explicit pin, equals resolved `ktlint --version` .. proceed (agreement
 *   established — the only allow-with-signal case);
 * - explicit pin, differs from resolved ..... decline, skew record naming
 *   both versions and where each came from;
 * - Gradle-managed but no readable CLI pin ... decline, unknown record
 *   stating what could not be determined (never a guessed version).
 *
 * Scope approximation, stated plainly: a `ktlint { }` block is read
 * wherever the walk finds it, without `subprojects`/`allprojects` scope
 * analysis (the #2468 question of WHO a block applies to). For a decline
 * this is the safe direction — a mismatched scope can only decline an
 * autofix that step 2 (project-toolchain resolution) will restore, never
 * apply a foreign ruleset.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractVersionToken } from "./installer/index.js";
import { isAtOrAboveHomeDir, walkUpDirs } from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import {
	gradleBlockRanges,
	stripGradleCommentsAndStrings,
} from "./tool-policy.js";

export const KTLINT_GRADLE_PLUGIN_ID = "org.jlleitschuh.gradle.ktlint";

const GRADLE_FILES = [
	"build.gradle.kts",
	"build.gradle",
	"settings.gradle.kts",
	"settings.gradle",
];

const KTLINT_VERSION_SPAWN_BUDGET_MS = 5000;

export interface KtlintProjectPin {
	/** True when the project manages ktlint through the Gradle plugin. */
	managed: boolean;
	/** The project's declared ktlint CLI version, when statically readable. */
	version: string | undefined;
	/** Where the signal came from (file + what was found). */
	evidence: string | undefined;
}

export interface KtlintSkewVerdict {
	decision: "proceed" | "decline";
	/** Human sentence naming both versions and where each came from. */
	reason: string;
	projectVersion: string | undefined;
	resolvedVersion: string | undefined;
	/** True when Gradle manages ktlint but no CLI pin is readable. */
	managedWithoutPin: boolean;
}

interface GradleFileParse {
	managed: boolean;
	/** Literal CLI pin from the ktlint block, when one is spelled out. */
	version: string | undefined;
	/** `libs.versions.<name>` reference, when the block pins indirectly. */
	catalogName: string | undefined;
	evidence: string | undefined;
}

const gradleFileCache = new Map<
	string,
	{ mtimeMs: number; parsed: GradleFileParse }
>();

/** Test-only observability for asserting the hot-path I/O bound. */
export function _getKtlintSkewGradleReadCountForTests(): number {
	return gradleReadCount;
}

let gradleReadCount = 0;

function readGradleFile(filePath: string): GradleFileParse | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;
	const cached = gradleFileCache.get(filePath);
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	gradleReadCount += 1;
	const parsed = parseGradleFile(raw, filePath);
	gradleFileCache.set(filePath, { mtimeMs: stat.mtimeMs, parsed });
	return parsed;
}

function isCommentLineStart(raw: string, matchIndex: number): boolean {
	const lineStart = raw.lastIndexOf("\n", matchIndex - 1) + 1;
	const prefix = raw.slice(lineStart, matchIndex);
	// Full-line `//`, block-comment `/*` opener, or `*` continuation: the
	// match sits in prose, not in a string literal. Residual gap, stated
	// plainly: a mention inside a multi-line block comment whose line starts
	// with other text still reads as managed — the blanked source cannot
	// tell a string from a comment, and the cost of the mistake is a
	// declined autofix with an explanatory record, never a bad write.
	if (/^\s*(\/\/|\*|\/\*)/.test(prefix)) return true;
	return isSlashCommentBeforeCode(prefix);
}

/**
 * True when a `//` before the match on the same line opens a line comment
 * (i.e. the `//` is not inside a string literal). Best-effort single-line
 * scan: counts unescaped quotes before the `//`.
 */
function isSlashCommentBeforeCode(linePrefix: string): boolean {
	const slash = linePrefix.indexOf("//");
	if (slash < 0) return false;
	const before = linePrefix.slice(0, slash);
	let quote: string | null = null;
	for (let i = 0; i < before.length; i += 1) {
		const ch = before[i];
		if (quote !== null) {
			if (ch === "\\") i += 1;
			else if (ch === quote) quote = null;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		}
	}
	return quote === null;
}

function parseGradleFile(raw: string, filePath: string): GradleFileParse {
	const stripped = stripGradleCommentsAndStrings(raw);
	const base = path.basename(filePath);
	let managed = false;
	let evidence: string | undefined;
	// The plugin id only ever appears inside a string literal (or a comment
	// about one). Bare Gradle code cannot spell it — dots are not identifier
	// characters — so a match whose blanked span is NOT whitespace is not a
	// declaration at all.
	for (
		let at = raw.indexOf(KTLINT_GRADLE_PLUGIN_ID);
		at >= 0;
		at = raw.indexOf(KTLINT_GRADLE_PLUGIN_ID, at + 1)
	) {
		const blanked = stripped.slice(at, at + KTLINT_GRADLE_PLUGIN_ID.length);
		if (/^\s+$/.test(blanked) && !isCommentLineStart(raw, at)) {
			managed = true;
			evidence = `${base} applies ${KTLINT_GRADLE_PLUGIN_ID}`;
			break;
		}
	}
	// A `ktlint { }` block only functions with the plugin applied, so it is
	// an independent management signal (ranges come from the blanked source,
	// so a commented-out block cannot match).
	const ranges = gradleBlockRanges(stripped).filter((r) => r.name === "ktlint");
	if (ranges.length > 0) {
		managed = true;
		evidence ??= `${base} declares a ktlint { } block`;
	}
	let version: string | undefined;
	let catalogName: string | undefined;
	let versionEvidence: string | undefined;
	for (const range of ranges) {
		// Nested blocks (e.g. a `filter { }` inside `ktlint { }`) cannot hold
		// the extension's version setting; exclude their spans so a nested
		// `version` token is never misread as the CLI pin.
		const nested = gradleBlockRanges(stripped).filter(
			(r) => r.start > range.start && r.end < range.end,
		);
		const found = readKtlintBlockVersion(raw, stripped, range, nested);
		if (found !== undefined) {
			if (found.catalogName !== undefined) {
				catalogName = found.catalogName;
				versionEvidence = `${base} ktlint { version libs.versions.${found.catalogName}.get() }`;
			} else {
				version = found.value;
				versionEvidence = `${base} ktlint { version "${found.value}" }`;
			}
			break;
		}
	}
	return {
		managed,
		version,
		catalogName: version === undefined ? catalogName : undefined,
		evidence: versionEvidence ?? evidence,
	};
}

interface FoundVersion {
	value: string;
	/** Present when the value is a `libs.versions.<name>.get()` reference. */
	catalogName?: string;
}

/**
 * Locate the `version` assignment in a `ktlint { }` body. Positions are
 * found in the blanked body (real code only); the value is read from the
 * raw body at the same offset.
 */
function readKtlintBlockVersion(
	raw: string,
	stripped: string,
	range: { start: number; end: number },
	nested: Array<{ start: number; end: number }>,
): FoundVersion | undefined {
	const inNested = (index: number): boolean =>
		nested.some((r) => index >= r.start && index < r.end);
	const strippedBody = stripped.slice(range.start, range.end);
	const rawBody = raw.slice(range.start, range.end);
	// Kotlin DSL `version.set(...)` and Groovy `version = ...` share one
	// tail parser: after the introducer the value is either a quoted
	// literal or a `libs.versions.<name>.get()` reference.
	const introducers: RegExp[] = [
		/\bversion\s*\.\s*set\s*\(/g,
		/\bversion\s*=\s*/g,
	];
	for (const pattern of introducers) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(strippedBody)) !== null) {
			const absolute = range.start + match.index;
			if (inNested(absolute)) continue;
			const tail = rawBody.slice(match.index + match[0].length);
			const quoted = /^\s*("|')/.exec(tail);
			if (quoted) {
				const quote = quoted[1];
				const rest = tail.slice(quoted[0].length);
				const end = rest.indexOf(quote);
				if (end < 0) continue;
				const value = rest.slice(0, end).trim();
				if (value === "") continue;
				return { value };
			}
			const ref = /^\s*libs\.versions\.([A-Za-z0-9_]+)\.get\s*\(\s*\)/.exec(
				tail,
			);
			if (ref) return { value: "", catalogName: ref[1] };
			// Anything else (a variable, a function call) is not statically
			// readable — keep looking rather than guessing.
		}
	}
	return undefined;
}

function findVersionCatalogValue(
	name: string,
	fromDir: string,
	homeDir: string,
): string | undefined {
	for (const dir of walkUpDirs(fromDir)) {
		if (isAtOrAboveHomeDir(dir, homeDir)) break;
		const catalog = path.join(dir, "gradle", "libs.versions.toml");
		let raw: string;
		try {
			raw = fs.readFileSync(catalog, "utf-8");
		} catch {
			continue;
		}
		let inVersions = false;
		for (const line of raw.split("\n")) {
			const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
			if (section) {
				inVersions = section[1].trim() === "versions";
				continue;
			}
			if (!inVersions) continue;
			const entry = new RegExp(
				`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*["']([^"']+)["']`,
			).exec(line);
			if (entry) return entry[1].trim();
		}
		// The first catalog file found wins; do not merge across levels.
		return undefined;
	}
	return undefined;
}

/**
 * The project's ktlint posture for `cwd`: whether Gradle manages ktlint
 * and, when statically readable, which CLI version it declares. Pure
 * filesystem reads, mtime-cached per Gradle file. Never executes Gradle.
 */
export function resolveKtlintProjectPin(
	cwd: string,
	homeDir: string = os.homedir(),
): KtlintProjectPin {
	let managed = false;
	let version: string | undefined;
	let evidence: string | undefined;
	for (const dir of walkUpDirs(cwd)) {
		if (isAtOrAboveHomeDir(dir, homeDir)) break;
		for (const name of GRADLE_FILES) {
			const parsed = readGradleFile(path.join(dir, name));
			if (!parsed) continue;
			if (parsed.managed && !managed) {
				managed = true;
				evidence = parsed.evidence;
			}
			if (version === undefined && parsed.version !== undefined) {
				version = parsed.version;
				evidence = parsed.evidence;
			}
			if (version === undefined && parsed.catalogName !== undefined) {
				// An indirect pin: resolve the name through the nearest
				// version catalog. Unresolvable stays unreadable (never
				// guessed); the project is still Gradle-managed.
				const resolved = findVersionCatalogValue(
					parsed.catalogName,
					dir,
					homeDir,
				);
				if (resolved !== undefined) {
					version = resolved;
					evidence = `${parsed.evidence} → gradle/libs.versions.toml "${resolved}"`;
				}
			}
		}
	}
	return { managed, version, evidence };
}

const resolvedVersionMemo = new Map<string, string | null>();

async function getResolvedKtlintVersion(
	cmd: string,
): Promise<string | undefined> {
	const memo = resolvedVersionMemo.get(cmd);
	if (memo !== undefined) return memo ?? undefined;
	let version: string | null = null;
	try {
		const probe = await safeSpawnAsync(cmd, ["--version"], {
			timeout: KTLINT_VERSION_SPAWN_BUDGET_MS,
			input: "",
		});
		if (!probe.error && probe.status === 0) {
			version = extractVersionToken(probe.stdout || "") ?? null;
		}
	} catch {
		version = null;
	}
	resolvedVersionMemo.set(cmd, version);
	return version ?? undefined;
}

/**
 * Step-1 gate for ktlint autofix. Returns null when the project shows no
 * Gradle ktlint signal (proceed, status quo); otherwise the verdict names
 * both versions and where each came from. The caller declines on
 * `decision === "decline"` and records the bounded once-per-session row.
 */
export async function checkKtlintVersionSkew(
	cmd: string,
	cwd: string,
	homeDir?: string,
): Promise<KtlintSkewVerdict | null> {
	const pin = resolveKtlintProjectPin(cwd, homeDir ?? os.homedir());
	if (!pin.managed) return null;
	const resolved = await getResolvedKtlintVersion(cmd);
	const resolvedLabel =
		resolved !== undefined
			? `resolved ktlint ${resolved} (\`ktlint --version\`)`
			: `resolved ktlint of unknown version (\`ktlint --version\` gave no parseable token)`;
	if (pin.version !== undefined && resolved !== undefined) {
		if (pin.version === resolved) {
			return {
				decision: "proceed",
				reason:
					`project pins ktlint ${pin.version} (${pin.evidence}) and ${resolvedLabel} agrees`,
				projectVersion: pin.version,
				resolvedVersion: resolved,
				managedWithoutPin: false,
			};
		}
		return {
			decision: "decline",
			reason:
				`project pins ktlint ${pin.version} (${pin.evidence}) but ${resolvedLabel} differs`,
			projectVersion: pin.version,
			resolvedVersion: resolved,
			managedWithoutPin: false,
		};
	}
	return {
		decision: "decline",
		reason:
			`project manages ktlint through Gradle (${pin.evidence ?? "ktlint-gradle plugin detected"}) ` +
			`but the pinned CLI version is not statically readable; ${resolvedLabel}. ` +
			`Not rewriting (refs #3000 step 1: agreement cannot be established)`,
		projectVersion: pin.version,
		resolvedVersion: resolved,
		managedWithoutPin: pin.version === undefined,
	};
}
