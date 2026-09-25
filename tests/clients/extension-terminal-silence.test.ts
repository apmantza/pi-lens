/**
 * Enforcement: nothing reachable from the pi extension entry writes raw bytes
 * to the terminal (#1333).
 *
 * pi owns the TTY (raw mode + cursor-addressed diff repaints), so a
 * `console.*` or `process.std*.write` from `clients/`, `tools/`, `index.ts` or
 * `i18n.ts` lands mid-frame and desyncs pi's model of the screen.
 *
 * Why this is a grep test and not the shipped ast-grep rules: pi-lens's
 * `no-console-except-error` / `console-statement` rules deliberately PERMIT
 * `console.error` inside a `catch` block ("useful for production triage"),
 * which is right for a general-purpose library rule aimed at user projects and
 * exactly wrong here — a large share of the original 26 offenders were inside
 * `catch`. Rather than break that rule's policy for users, the extension path
 * gets its own, stricter, structural check. Same shape as
 * `managed-tool-seam-coverage.test.ts` (#1290).
 *
 * `mcp/**`, `scripts/**`, `bin/**` and `tests/**` are deliberately NOT scanned:
 * they own their own stdout contract.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { matchingCloseIndex } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(".");

/** Directories reachable from the pi extension entry. */
const SCANNED_DIRS = ["clients", "tools"];
/** Single files reachable from the pi extension entry. */
const SCANNED_FILES = ["index.ts", "i18n.ts"];

/**
 * `clients/extension-log.ts` OWNS the console reroute — it is the one module
 * allowed to name console methods, because patching them is its job.
 */
const ALLOWED_FILES = new Set(["clients/extension-log.ts"]);

const CONSOLE_CALL =
	/\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table)\s*\(/g;
const RAW_WRITE = /\bprocess\s*\.\s*(stdout|stderr)\s*\.\s*write\s*\(/g;

/**
 * Blank out comments and string/template literal TEXT so a `console.log($MSG)`
 * inside an ast-grep pattern documentation string is not mistaken for a call.
 * Template `${...}` expressions are preserved (recursively scrubbed) — real
 * code can live there.
 */
export function scrubCommentsAndStrings(source: string): string {
	let out = "";
	let i = 0;
	const n = source.length;
	// A `/` starts a REGEX (not division) when the previous non-space token
	// cannot end an expression. Regex literals must be skipped whole: one that
	// contains a quote — `/[$(){}[\].;:'"`]/` in tools/ast-grep-search.ts — would
	// otherwise open a phantom string and desync the whole rest of the file.
	const regexPrecursor =
		/(^|[({[,;:=!&|?+\-*%~^<>]|\breturn|\btypeof|\bcase)\s*$/;
	while (i < n) {
		const c = source[i];
		if (
			c === "/" &&
			source[i + 1] !== "/" &&
			source[i + 1] !== "*" &&
			regexPrecursor.test(out.slice(-16))
		) {
			i++;
			let inClass = false;
			while (i < n) {
				const d = source[i];
				if (d === "\\") {
					i += 2;
					continue;
				}
				if (d === "[") inClass = true;
				else if (d === "]") inClass = false;
				else if (d === "/" && !inClass) {
					i++;
					break;
				} else if (d === "\n") break;
				i++;
			}
			out += "/re/";
			continue;
		}
		if (c === "/" && source[i + 1] === "/") {
			while (i < n && source[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && source[i + 1] === "*") {
			i += 2;
			while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (c === '"' || c === "'") {
			const quote = c;
			i++;
			while (i < n && source[i] !== quote) {
				if (source[i] === "\\") i++;
				i++;
			}
			i++;
			out += '""';
			continue;
		}
		if (c === "`") {
			i++;
			while (i < n) {
				if (source[i] === "\\") {
					i += 2;
					continue;
				}
				if (source[i] === "`") {
					i++;
					break;
				}
				if (source[i] === "$" && source[i + 1] === "{") {
					const close = matchingCloseIndex(source, i + 1, "{", "}");
					// Unbalanced: the rest of the source is the expression.
					const expr = source.slice(i + 2, close === -1 ? n : close);
					i = close === -1 ? n : close + 1;
					out += `(${scrubCommentsAndStrings(expr)})`;
					continue;
				}
				i++;
			}
			out += '""';
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function sourceFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		if (!entry.isFile()) return [];
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
			? [full]
			: [];
	});
}

function extensionPathFiles(): string[] {
	return [
		...SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(REPO_ROOT, dir))),
		...SCANNED_FILES.map((file) => path.join(REPO_ROOT, file)).filter((file) =>
			fs.existsSync(file),
		),
	];
}

function toRepoRelative(file: string): string {
	return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

/** Every raw-terminal-write site in `source`, as `<line>: <matched text>`. */
export function findRawTerminalWrites(source: string): string[] {
	const scrubbed = scrubCommentsAndStrings(source);
	const hits: string[] = [];
	for (const pattern of [CONSOLE_CALL, RAW_WRITE]) {
		pattern.lastIndex = 0;
		for (const match of scrubbed.matchAll(pattern)) {
			const line = scrubbed.slice(0, match.index).split("\n").length;
			hits.push(`${line}: ${match[0]}`);
		}
	}
	return hits;
}

describe("extension path terminal silence (#1333)", () => {
	it("has no console.* or process.std*.write under clients/, tools/, index.ts, i18n.ts", () => {
		const violations: string[] = [];
		for (const file of extensionPathFiles()) {
			const relative = toRepoRelative(file);
			if (ALLOWED_FILES.has(relative)) continue;
			for (const hit of findRawTerminalWrites(fs.readFileSync(file, "utf8"))) {
				violations.push(`${relative}:${hit}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("fires on a bare console.error — including one inside a catch block", () => {
		// The exact shape the shipped `no-console-except-error` rules PERMIT, and
		// the reason this test exists rather than a tweak to those rules.
		const inCatch = `
			try {
				risky();
			} catch (err) {
				console.error("boom", err);
			}
		`;
		expect(findRawTerminalWrites(inCatch)).toHaveLength(1);
		expect(findRawTerminalWrites(`console.warn("x");`)).toHaveLength(1);
		expect(findRawTerminalWrites(`process.stdout.write("x");`)).toHaveLength(1);
		expect(findRawTerminalWrites(`process.stderr.write("x");`)).toHaveLength(1);
	});

	it("does not fire on console text inside comments or string literals", () => {
		expect(findRawTerminalWrites(`// console.error("nope")`)).toEqual([]);
		expect(findRawTerminalWrites(`/* console.log($MSG) */`)).toEqual([]);
		expect(
			findRawTerminalWrites(`const doc = "console.log($MSG) matches calls";`),
		).toEqual([]);
		expect(
			findRawTerminalWrites("const doc = `use console.log($MSG) here`;"),
		).toEqual([]);
	});

	it("skips regex literals whole, so a quote inside one cannot desync the scan", () => {
		// The real shape from tools/ast-grep-search.ts. Without regex handling the
		// `'` opens a phantom string literal and swallows the following code.
		const source = [
			"const hasAstSignals = /[$(){}[\\].;:'\"`]/.test(text);",
			'console.error("still visible");',
		].join("\n");
		expect(findRawTerminalWrites(source)).toHaveLength(1);
	});

	it("leaves the hosts that own their stdout contract alone", () => {
		// mcp/ deliberately writes (JSON-RPC + its own console.log→error guard);
		// scanning it would be wrong, so assert it is outside the scan set.
		const scanned = new Set(extensionPathFiles().map(toRepoRelative));
		for (const owned of ["mcp/server.ts", "scripts", "bin", "tests"]) {
			expect([...scanned].some((file) => file.startsWith(owned))).toBe(false);
		}
		// ...and that mcp/ really does still write, so this carve-out is live.
		const mcpServer = path.join(REPO_ROOT, "mcp", "server.ts");
		if (fs.existsSync(mcpServer)) {
			expect(
				findRawTerminalWrites(fs.readFileSync(mcpServer, "utf8")).length,
			).toBeGreaterThan(0);
		}
	});
});

// #1338 review: the guard must install as index.ts's FIRST import — a
// factory-time install runs after all static imports have evaluated, leaving
// import-time console writes unguarded.
it("console guard is index.ts's first import (import-time install)", () => {
	const src = fs.readFileSync(path.join(REPO_ROOT, "index.ts"), "utf8");
	const firstImport = src.match(/^import .*$/m)?.[0] ?? "";
	expect(firstImport).toContain("./clients/console-guard-install.js");
});

// #1434 S3c: the symmetric pin. The module-evaluation window opened by the
// first import above must close as index.ts's LAST statement -- closing it
// any earlier would leave the rest of the module graph's evaluation (and any
// import between the open and the premature close) outside the window;
// leaving it open past this point (never calling it, or a later statement
// sliding below it) leaks the window into host-owned execution, capturing
// output that belongs on the real console (the exact #1333 bug this design
// fixes). The unref'd setImmediate backstop in extension-log.ts is a
// fallback for the "this line never runs" case, not a substitute for it.
it("console guard's module-load window closes as index.ts's last statement", () => {
	const src = fs.readFileSync(path.join(REPO_ROOT, "index.ts"), "utf8");
	const lastStatement = src
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.length > 0 &&
				!line.startsWith("//") &&
				!line.startsWith("/*") &&
				!line.startsWith("*"),
		)
		.pop();
	expect(lastStatement).toContain("closeModuleLoadConsoleWindow();");
});

it("captures the startup marker before installing the console guard", () => {
	// #1434 S3d: the timestamp itself now lives in eval-timestamp.ts, a
	// side-effect-free module (so importing it from startup-timing.ts never
	// installs the console guard). console-guard-install.ts must still import
	// it FIRST -- ahead of extension-log.js -- so evaluation order still
	// captures the timestamp before installConsoleGuard()'s own work.
	const markerSrc = fs.readFileSync(
		path.join(REPO_ROOT, "clients/eval-timestamp.ts"),
		"utf8",
	);
	expect(markerSrc).toContain("PI_LENS_EVAL_STARTED_MS = performance.now()");

	const installSrc = fs.readFileSync(
		path.join(REPO_ROOT, "clients/console-guard-install.ts"),
		"utf8",
	);
	expect(installSrc.indexOf('from "./eval-timestamp.js"')).toBeLessThan(
		installSrc.indexOf('from "./extension-log.js"'),
	);
	expect(installSrc.indexOf('from "./eval-timestamp.js"')).toBeLessThan(
		installSrc.indexOf("installConsoleGuard();"),
	);
	expect(installSrc).not.toContain("startup-marker");
	// #1374 review P2: strictly pin the marker as the FIRST executable
	// statement of eval-timestamp.ts -- anything sliding above it re-bills
	// that cost to host_boot and silently skews the host_boot/extension_eval
	// latency split.
	const firstStatement = markerSrc
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) =>
				line.length > 0 &&
				!line.startsWith("//") &&
				!line.startsWith("/*") &&
				!line.startsWith("*") &&
				!line.startsWith("import "),
		)[0];
	expect(firstStatement).toContain("PI_LENS_EVAL_STARTED_MS");
});

it("importing startup-timing never installs the console guard (#1434 S3d)", () => {
	// The booby trap: startup-timing.ts used to import PI_LENS_EVAL_STARTED_MS
	// FROM console-guard-install.ts, so importing startup-timing.ts anywhere
	// (e.g. a load-time measurement in a test) silently installed the guard as
	// a side effect. It must now import the constant from the
	// side-effect-free eval-timestamp.ts module instead.
	const src = fs.readFileSync(
		path.join(REPO_ROOT, "clients/startup-timing.ts"),
		"utf8",
	);
	expect(src).not.toMatch(/^import .*console-guard-install/m);
	expect(src).toContain('from "./eval-timestamp.js"');
});
