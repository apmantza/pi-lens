/**
 * Call-shaped scanner for `logAvailabilityDecision` emission sites (#2131).
 *
 * Dogfood pass 5 on #2131 measured the gap this pins: over 8.76h of baseline,
 * 33 of 75 `cause: "ok"` availability decisions (44%) carried no
 * `classifiedBy`, while every `not-found` and `fast-path` decision carried it
 * 100%. The shape was mechanical — the failure arm sets `classifiedBy`, the
 * success (`cause: "ok"`) arm next to it does not.
 *
 * Same call-shaped-scan discipline as `bounded-telemetry-scan.ts` (#1743): a
 * bare `cause: "ok"` grep would also match a comment or an unrelated object
 * literal, so this finds CALLS to `logAvailabilityDecision`, balances their
 * parentheses, and reads `cause` and `classifiedBy` out of the call's own
 * argument text.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { stripSource } from "./sweep-kit.js";

export interface AvailabilityDecisionSite {
	/** Repo-relative path, forward slashes, so findings read the same on any OS. */
	file: string;
	line: number;
	/** True when the call can emit an available-success `cause: "ok"` row. */
	causeOk: boolean;
	/** True when the call's own arguments set `classifiedBy`. */
	hasClassifiedBy: boolean;
}

/** Directories scanned. Compiled output and tests are not sources of truth. */
const SCAN_ROOTS = ["clients"];

const CALLEE = "logAvailabilityDecision";

/** Collect every `logAvailabilityDecision` call site under `SCAN_ROOTS`. */
export function scanAvailabilityDecisionSites(
	repoRoot: string,
): AvailabilityDecisionSite[] {
	const sites: AvailabilityDecisionSite[] = [];
	for (const root of SCAN_ROOTS) {
		for (const file of listTypeScriptFiles(path.join(repoRoot, root))) {
			const relative = path.relative(repoRoot, file).split(path.sep).join("/");
			sites.push(...scanSource(fs.readFileSync(file, "utf8"), relative));
		}
	}
	return sites;
}

/** Exported for the sweep's own self-test: scan one source string. */
export function scanSource(
	raw: string,
	file: string,
): AvailabilityDecisionSite[] {
	// `strings: "keep"` (as in bounded-telemetry-scan.ts): the `cause`/
	// `classifiedBy` values this scanner reads ARE string literals, so blanking
	// string contents would blind it to the very thing it exists to check.
	const source = stripSource(raw, { strings: "keep" });
	const sites: AvailabilityDecisionSite[] = [];
	// `\b` alone would let `fakeLogAvailabilityDecision(` match; require the
	// callee to start at a non-identifier boundary on both sides, and require
	// it to be a bare call (not `foo.logAvailabilityDecision(`) so the
	// function's own declaration line reads no differently from a call — its
	// argument text never contains a `cause: "ok"` literal, so it never flags.
	const opener = new RegExp(`(?<![A-Za-z0-9_$.])${CALLEE}\\s*\\(`, "g");
	let match = opener.exec(source);
	while (match !== null) {
		// The function's OWN declaration
		// (`export function logAvailabilityDecision(decision: ...)`) reads no
		// differently from a call under the bare-identifier regex above, so it
		// is excluded by what precedes the name: only a declaration is preceded
		// by the `function` keyword. Checking for a `tool:` key instead (an
		// earlier version of this fix) also excluded real calls that carry
		// `tool` through a `{...base, ...}` spread or pass the whole decision
		// as a variable (`logAvailabilityDecision(decisionVar)`) — this is a
		// general fix, not a `tool`-shaped one (#2226 review F3).
		if (/\bfunction\s*$/.test(source.slice(0, match.index))) {
			match = opener.exec(source);
			continue;
		}
		const openIndex = source.indexOf("(", match.index);
		const argsText = readBalancedArgs(source, openIndex);
		const verdict = readTopLevelProperty(argsText, "verdict");
		const outcome = readTopLevelProperty(argsText, "outcome");
		const cause = readTopLevelProperty(argsText, "cause");
		sites.push({
			file,
			line: source.slice(0, match.index).split("\n").length,
			causeOk:
				cause?.value === '"ok"' ||
				(verdict?.value.includes('"available"') === true &&
					outcome?.value.includes('"success"') === true &&
					cause !== undefined &&
					!/^['"`]/.test(cause.value)),
			hasClassifiedBy:
				readTopLevelProperty(argsText, "classifiedBy") !== undefined,
		});
		match = opener.exec(source);
	}
	return sites.sort((a, b) => a.line - b.line);
}

/** Argument text between `(` at `openIndex` and its matching `)`. */
function readBalancedArgs(source: string, openIndex: number): string {
	let depth = 0;
	let quote: string | undefined;
	for (let i = openIndex; i < source.length; i++) {
		const ch = source[i];
		if (quote !== undefined) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return source.slice(openIndex + 1, i);
		}
	}
	return source.slice(openIndex + 1);
}

interface TopLevelProperty {
	value: string;
}

/** Read one property from the call's outer object, not nested evidence. */
function readTopLevelProperty(
	argsText: string,
	name: string,
): TopLevelProperty | undefined {
	let braceDepth = 0;
	let bracketDepth = 0;
	let parenDepth = 0;
	let quote: string | undefined;
	for (let i = 0; i < argsText.length; i++) {
		const ch = argsText[i];
		if (quote !== undefined) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			braceDepth--;
			continue;
		}
		if (ch === "[") {
			bracketDepth++;
			continue;
		}
		if (ch === "]") {
			bracketDepth--;
			continue;
		}
		if (ch === "(") {
			parenDepth++;
			continue;
		}
		if (ch === ")") {
			parenDepth--;
			continue;
		}
		if (braceDepth !== 1 || bracketDepth !== 0 || parenDepth !== 0) continue;
		if (!argsText.startsWith(name, i)) continue;
		let beforeIndex = i - 1;
		while (/\s/.test(argsText[beforeIndex] ?? "")) beforeIndex--;
		const before = argsText[beforeIndex];
		if (before !== "{" && before !== ",") continue;
		let cursor = i + name.length;
		while (/\s/.test(argsText[cursor] ?? "")) cursor++;
		if (argsText[cursor] !== ":") {
			if (cursor === i + name.length) return { value: "<shorthand>" };
			continue;
		}
		cursor++;
		const valueStart = cursor;
		let valueQuote: string | undefined;
		let nested = 0;
		for (; cursor < argsText.length; cursor++) {
			const valueChar = argsText[cursor];
			if (valueQuote !== undefined) {
				if (valueChar === "\\") cursor++;
				else if (valueChar === valueQuote) valueQuote = undefined;
				continue;
			}
			if (valueChar === '"' || valueChar === "'" || valueChar === "`") {
				valueQuote = valueChar;
				continue;
			}
			if (valueChar === "{" || valueChar === "[" || valueChar === "(") nested++;
			else if (valueChar === "}" || valueChar === "]" || valueChar === ")")
				nested--;
			else if ((valueChar === "," || valueChar === "}") && nested === 0) break;
		}
		return { value: argsText.slice(valueStart, cursor).trim() };
	}
	return undefined;
}

function listTypeScriptFiles(target: string): string[] {
	const stat = fs.statSync(target);
	if (stat.isFile()) return target.endsWith(".ts") ? [target] : [];
	const found: string[] = [];
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		const child = path.join(target, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "deps" || entry.name === "node_modules") continue;
			found.push(...listTypeScriptFiles(child));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			found.push(child);
		}
	}
	return found;
}
