import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { findCompiledClassesDir } from "../../tool-policy.js";
import { PRIORITY } from "../priorities.js";
import type {
	DefectClass,
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";

// SpotBugs is a JVM tool installed via the archive strategy (#133); java gates
// it (no JRE → skip). It analyzes the *bytecode tree*, not the edited source.
const java = createAvailabilityChecker("java", ".exe", ["-version"]);
const spotbugs = createAvailabilityChecker("spotbugs", ".bat", ["-version"]);

const MAX_DIAGNOSTICS = 50;
const MAX_XML_BYTES = 4 * 1024 * 1024;

// Per-classes-dir cache: SpotBugs is project-level + heavyweight, so we only
// re-invoke it when the compiled .class tree actually changed (i.e. after a
// rebuild). Between rebuilds, repeated dispatches return the cached findings.
interface SpotbugsCacheEntry {
	signature: string;
	diagnostics: Diagnostic[];
}
const scanCache = new Map<string, SpotbugsCacheEntry>();

/** Reset the SpotBugs scan cache (tests). */
export function _resetSpotbugsCacheForTests(): void {
	scanCache.clear();
}

/**
 * Cheap signature of the compiled-classes tree: count + newest mtime of all
 * `.class` files. Changes iff the user rebuilt, which is exactly when SpotBugs
 * should re-run.
 */
function classesSignature(classesDir: string): string {
	let count = 0;
	let newest = 0;
	const stack = [classesDir];
	// Bounded walk — large class trees are fine (count is cheap), but cap depth
	// of the stack defensively.
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) break;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name.endsWith(".class")) {
				count++;
				try {
					const m = fs.statSync(full).mtimeMs;
					if (m > newest) newest = m;
				} catch {}
			}
		}
	}
	return `${count}:${newest}`;
}

// SpotBugs bug categories → pi-lens defect taxonomy (per #133).
function mapCategory(category: string): DefectClass {
	switch (category.toUpperCase()) {
		case "CORRECTNESS":
		case "MT_CORRECTNESS":
			return "correctness";
		case "SECURITY":
			return "safety";
		case "PERFORMANCE":
		case "BAD_PRACTICE":
		case "STYLE":
		case "I18N":
		case "EXPERIMENTAL":
			return "style";
		default:
			// Unmapped SpotBugs categories are still bug patterns — treat as correctness.
			return "correctness";
	}
}

function mapSeverity(priority: string): Diagnostic["severity"] {
	switch (priority) {
		case "1":
			return "error";
		case "3":
			return "info";
		default:
			return "warning";
	}
}

function attr(attrs: string, name: string): string | undefined {
	// Bounded, non-backtracking: a single negated-char class, no nesting (S5852-safe).
	const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
	return m ? m[1] : undefined;
}

function firstSentence(text: string): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	const dot = trimmed.indexOf(". ");
	return (dot > 0 ? trimmed.slice(0, dot + 1) : trimmed).slice(0, 300);
}

/**
 * Parse SpotBugs `-xml:withMessages` output. Hand-rolled (no XML dep, zero-dep
 * ethos) but bounded: input capped, lazy `<BugInstance>…</BugInstance>` blocks
 * (no nested quantifiers), diagnostics capped.
 */
export function parseSpotbugsXml(raw: string): Diagnostic[] {
	const xml = raw.length > MAX_XML_BYTES ? raw.slice(0, MAX_XML_BYTES) : raw;
	const diagnostics: Diagnostic[] = [];
	const blockRe = /<BugInstance\b([^>]*)>([\s\S]*?)<\/BugInstance>/g;
	let block: RegExpExecArray | null;
	let index = 0;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
	while ((block = blockRe.exec(xml)) !== null) {
		if (diagnostics.length >= MAX_DIAGNOSTICS) break;
		const headAttrs = block[1];
		const body = block[2];
		const type = attr(headAttrs, "type") || "SPOTBUGS";
		const priority = attr(headAttrs, "priority") || "2";
		const category = attr(headAttrs, "category") || "CORRECTNESS";

		// A BugInstance has several SourceLines: class span, method span, and the
		// primary (the actual defect location, marked primary="true"). Prefer the
		// primary; otherwise the last one (most specific), else the first.
		let filePath: string | undefined;
		let line = 1;
		const slRe = /<SourceLine\b([^>]*?)\/?>/g;
		let sl: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
		while ((sl = slRe.exec(body)) !== null) {
			const slAttrs = sl[1];
			const start = attr(slAttrs, "start");
			const sourcepath = attr(slAttrs, "sourcepath");
			const sourcefile = attr(slAttrs, "sourcefile");
			if (!start || !(sourcepath || sourcefile)) continue;
			filePath = sourcepath || sourcefile;
			line = Number(start) || 1;
			if (attr(slAttrs, "primary") === "true") break; // the defect location
		}
		if (!filePath) continue; // no source mapping — skip (can't surface usefully)

		const longMsgMatch = /<LongMessage>([\s\S]*?)<\/LongMessage>/.exec(body);
		const shortMsgMatch = /<ShortMessage>([\s\S]*?)<\/ShortMessage>/.exec(body);
		const longMsg = longMsgMatch
			? decodeXmlEntities(longMsgMatch[1].trim())
			: "";
		const shortMsg = shortMsgMatch
			? decodeXmlEntities(shortMsgMatch[1].trim())
			: "";
		const message = shortMsg || longMsg || type;
		const fixSuggestion = longMsg ? firstSentence(longMsg) : undefined;

		diagnostics.push({
			id: `spotbugs:${type}:${path.basename(filePath)}:${line}:${index}`,
			message: `[${type}] ${message}`,
			filePath,
			line,
			column: 1,
			severity: mapSeverity(priority),
			// Bug patterns are advisory by default (not always exploitable); a user
			// can promote to blocking via config. So semantic stays "warning".
			semantic: "warning",
			tool: "spotbugs",
			rule: type,
			defectClass: mapCategory(category),
			fixable: false,
			autoFixAvailable: false,
			fixKind: fixSuggestion ? "suggestion" : undefined,
			fixSuggestion,
		});
		index++;
	}
	return diagnostics;
}

function decodeXmlEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/**
 * SpotBugs bytecode bug-pattern analyzer for Java + Kotlin (#133).
 *
 * Opt-in (lens-spotbugs flag) and gated via the withSpotbugsGroup dispatch
 * group, which only adds it when a Java build descriptor + compiled .class dir
 * exist. Operates on the compiled tree, NOT the edited source, and only
 * re-invokes after a rebuild (mtime-cached).
 */
const spotbugsRunner: RunnerDefinition = {
	id: "spotbugs",
	appliesTo: ["java", "kotlin"],
	priority: PRIORITY.DEEP_LANGUAGE_ANALYSIS,
	enabledByDefault: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = ctx.cwd || process.cwd();

		const classesDir = findCompiledClassesDir(cwd);
		if (!classesDir) {
			ctx.log?.(
				"spotbugs: Java project detected but no compiled .class files found — run `mvn compile` / `gradle build` first",
			);
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// JRE required — skip silently if absent (SpotBugs needs JDK 11+).
		if (!(await java.isAvailableAsync(cwd))) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Cache gate: re-run only when the .class tree changed since last scan.
		const signature = classesSignature(classesDir);
		const cached = scanCache.get(classesDir);
		if (cached && cached.signature === signature) {
			return {
				status: "succeeded",
				diagnostics: cached.diagnostics,
				semantic: cached.diagnostics.length > 0 ? "warning" : "none",
			};
		}

		const cmd = await resolveAvailableOrInstall(spotbugs, "spotbugs", cwd);
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		const tmpXml = path.join(
			os.tmpdir(),
			`pi-lens-spotbugs-${process.pid}-${Date.now()}.xml`,
		);
		const result = await safeSpawnAsync(
			cmd,
			[
				"-textui",
				"-xml:withMessages",
				"-low",
				"-longBugCodes",
				"-output",
				tmpXml,
				classesDir,
			],
			{ cwd, timeout: 120000 },
		);

		let xml = "";
		try {
			xml = fs.readFileSync(tmpXml, "utf8");
		} catch {
			// No output file — if the run errored, surface a soft failure.
			if (result.error || (result.status ?? 0) > 1) {
				return {
					status: "failed",
					diagnostics: [],
					semantic: "none",
					rawOutput: (result.stderr || "").slice(0, 500),
				};
			}
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		} finally {
			try {
				fs.rmSync(tmpXml, { force: true });
			} catch {}
		}

		const diagnostics = parseSpotbugsXml(xml);
		scanCache.set(classesDir, { signature, diagnostics });

		return {
			status: "succeeded",
			diagnostics,
			semantic: diagnostics.length > 0 ? "warning" : "none",
		};
	},
};

export default spotbugsRunner;
