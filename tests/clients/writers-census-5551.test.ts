/**
 * #5551: the writer table (`clients/writers.ts`) is held to the code, and the
 * census fails on a file-writing site no registry row admits.
 *
 * Recurrence this prevents: eight fixes each covered one writer route (#4732,
 * #5239, #5248, #5120, #5160, #5378, #5405, #5417), because nothing listed the
 * routes or the consumers each reached; the writer-route audit (2026-11-13)
 * found 69 writing sites with no row. A new writer now fails here until it has
 * a row, and a row whose code is gone fails too.
 *
 * The scan is fail-closed (AGENTS.md "Test requirements", shape 69). It reads
 * comment- and string-blanked source. It admits only a read-only member or
 * named import of an fs module; every other member, every use of a write
 * binding, and every use it cannot follow (an alias, a value passed on, a
 * computed member, an import form it cannot read) counts as a site.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DISK_CHANGE_CONSUMERS } from "../../clients/disk-change-consumers.js";
import {
	AUTHORED_WRITER_CONSUMERS,
	SHARED_WRITER_CONSUMERS,
	WRITER_CONSUMERS,
	WRITERS,
	type WriterCell,
} from "../../clients/writers.js";
import {
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	stripSource,
} from "../support/sweep-kit.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** The census population: the audit's roots (writer-route audit, section 4). */
function productionSources(): string[] {
	const sources = [
		path.join(repoRoot, "index.ts"),
		...["clients", "tools", "mcp"].flatMap((root) =>
			listSourceFiles(path.join(repoRoot, root), { skipTests: true }),
		),
	];
	assertNonEmptyScan("writer census population", sources.length, 400);
	return sources;
}

const relative = (file: string): string =>
	path.relative(repoRoot, file).split(path.sep).join("/");

// --- The scan ---------------------------------------------------------------

/**
 * The fs members and named imports admitted as read-only: the one known-good
 * list. Every other name on an fs binding is a write site, so a write
 * primitive nobody listed counts rather than passes.
 */
const FS_READ_ONLY = new Set([
	"access",
	"accessSync",
	"BigIntStats",
	"close",
	"closeSync",
	"constants",
	"Dir",
	"Dirent",
	"existsSync",
	"FileHandle",
	"fstat",
	"fstatSync",
	"lstat",
	"lstatSync",
	"opendir",
	"opendirSync",
	"PathLike",
	"read",
	"readdir",
	"readdirSync",
	"readFile",
	"readFileSync",
	"readSync",
	"realpath",
	"realpathSync",
	"stat",
	"Stats",
	"statSync",
	"watch",
]);

/** A module whose bindings the scan follows, and which of its names write. */
interface WriteModule {
	label: string;
	/** Whether an import specifier, read from `file`, names this module. */
	matches(specifier: string, file: string): boolean;
	writes(name: string): boolean;
}

const FS_MODULE: WriteModule = {
	label: "fs",
	matches: (specifier) => /^(?:node:)?fs(?:\/promises)?$/.test(specifier),
	writes: (name) => !FS_READ_ONLY.has(name),
};

/** A project module whose registry row names the write functions it exports. */
function primitiveModule(
	file: string,
	exports: readonly string[],
): WriteModule {
	const target = path.join(repoRoot, file);
	return {
		label: file,
		matches: (specifier, from) =>
			specifier.startsWith(".") &&
			path.resolve(path.dirname(from), specifier.replace(/\.js$/, ".ts")) ===
				target,
		writes: (name) => exports.includes(name),
	};
}

/** One site the scan counted, for the failure message. */
interface Site {
	line: number;
	text: string;
	kind: "write" | "unreadable";
}

const IMPORT_STATEMENT =
	/\bimport\s+(type\s+)?([\w$*\s{},]*?)\s*from\s*(["'])([^"'\n]+)\3/g;
const ANY_SPECIFIER = /(["'])([^"'\n]+)\1/g;
const DYNAMIC_BINDING =
	/\b(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*(["'])([^"'\n]+)\2\s*\)/g;

/** The open calls admitted when their flag argument is the literal `"r"`. */
const READ_ONLY_OPEN = new Set(["open", "openSync"]);

/**
 * Whether the call that starts at `from` (just past `fs.openSync`) passes the
 * literal `"r"` as its second argument. The paren and comma structure is read
 * from the blanked text, so a string cannot fake it; the flag from the
 * string-kept text. Anything else, including a flag held in a variable, is a
 * write.
 */
function opensReadOnly(body: string, readable: string, from: number): boolean {
	const open = /^\s*\(/.exec(body.slice(from));
	if (!open) return false;
	let depth = 0;
	for (let i = from + open[0].length; i < body.length; i++) {
		const char = body[i];
		if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") {
			if (depth === 0) return false;
			depth--;
		} else if (char === "," && depth === 0)
			return /^\s*(["'])r\1\s*[,)]/.test(readable.slice(i + 1));
	}
	return false;
}

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

/**
 * The binding a clause gives each module: `module` bindings are read by member
 * (`fs.x`), `named` bindings stand for one imported name.
 */
function clauseBindings(
	clause: string,
	module: WriteModule,
): { module: string[]; named: Array<{ local: string; imported: string }> } {
	const out = {
		module: [] as string[],
		named: [] as Array<{ local: string; imported: string }>,
	};
	const braces = /\{([^}]*)\}/.exec(clause);
	const outside = clause.replace(/\{[^}]*\}/, "");
	const namespace = /\*\s*as\s+([\w$]+)/.exec(outside);
	if (namespace) out.module.push(namespace[1]);
	const leading = /^\s*([\w$]+)\s*(?:,|$)/.exec(outside);
	if (leading && leading[1] !== "type") out.module.push(leading[1]);
	for (const item of braces?.[1].split(",") ?? []) {
		const spec = item.trim();
		if (spec.length === 0 || /^type\s/.test(spec)) continue;
		const [imported, local] = spec.split(/\s+as\s+/).map((part) => part.trim());
		const binding = local ?? imported;
		// `promises` is fs's promise namespace: read it by member, like `fs`.
		if (module === FS_MODULE && imported === "promises")
			out.module.push(binding);
		else out.named.push({ local: binding, imported });
	}
	return out;
}

/**
 * Every write site in one source text. `file` resolves relative specifiers of
 * project write primitives.
 */
function writeSites(
	source: string,
	file: string,
	modules: readonly WriteModule[],
): Site[] {
	const sites: Site[] = [];
	const readable = stripSource(source, { strings: "keep" });
	const blanked = [...stripSource(source, { strings: "blank" })];
	const record = (index: number, kind: Site["kind"]) => {
		const line = lineOf(readable, index);
		sites.push({
			line,
			kind,
			text: source.split("\n")[line - 1]?.trim() ?? "",
		});
	};
	const moduleBindings: Array<{ name: string; module: WriteModule }> = [];
	const namedWrites: string[] = [];
	// The offsets of the specifiers a binding form consumed.
	const consumed = new Set<number>();
	const consume = (
		match: RegExpMatchArray & { index: number },
		quote: string,
		specifier: string,
	): WriteModule | undefined => {
		const module = modules.find((candidate) =>
			candidate.matches(specifier, file),
		);
		if (!module) return undefined;
		consumed.add(match.index + match[0].lastIndexOf(quote + specifier));
		// Blank the statement, so its own names are not read as uses.
		for (let i = match.index; i < match.index + match[0].length; i++)
			if (blanked[i] !== "\n") blanked[i] = " ";
		return module;
	};
	for (const match of readable.matchAll(IMPORT_STATEMENT)) {
		const module = consume(match, match[3], match[4]);
		if (!module || match[1] !== undefined) continue; // `import type`: no value.
		const bindings = clauseBindings(match[2], module);
		for (const name of bindings.module) moduleBindings.push({ name, module });
		for (const { local, imported } of bindings.named)
			if (module.writes(imported)) namedWrites.push(local);
	}
	// `const fs = await import("node:fs")`, `const { mkdir } = require("fs")`:
	// the same bindings, from a call.
	for (const match of readable.matchAll(DYNAMIC_BINDING)) {
		const module = consume(match, match[2], match[3]);
		if (!module) continue;
		const pattern = match[1];
		if (!pattern.startsWith("{")) {
			moduleBindings.push({ name: pattern, module });
			continue;
		}
		for (const item of pattern.slice(1, -1).split(",")) {
			const [imported, local] = item.split(":").map((part) => part.trim());
			if (imported.length === 0) continue;
			if (module.writes(imported)) namedWrites.push(local ?? imported);
		}
	}
	// A specifier no binding form consumed (`export … from`, a bare
	// `import "fs"`, an `import()` whose result is not bound, a string the code
	// passes on) is a form the scan cannot follow: each one is a site.
	for (const match of readable.matchAll(ANY_SPECIFIER))
		if (
			!consumed.has(match.index) &&
			modules.some((module) => module.matches(match[2], file))
		)
			record(match.index, "unreadable");
	const body = blanked.join("");
	for (const { name, module } of moduleBindings) {
		const use = new RegExp(
			`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])(\\s*\\??\\.\\s*(?:promises\\s*\\.\\s*)?([\\w$]+))?`,
			"g",
		);
		for (const match of body.matchAll(use)) {
			const member = match[2];
			if (member === undefined) record(match.index, "unreadable");
			else if (
				module.writes(member) &&
				!(
					module === FS_MODULE &&
					READ_ONLY_OPEN.has(member) &&
					opensReadOnly(body, readable, match.index + match[0].length)
				)
			)
				record(match.index, "write");
		}
	}
	for (const name of namedWrites) {
		const use = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "g");
		for (const match of body.matchAll(use)) record(match.index, "write");
	}
	return sites.sort((a, b) => a.line - b.line);
}

// --- The registry -----------------------------------------------------------

/**
 * What a file's write sites change. `user-source`: a project file the user
 * owns, so the file names its WRITERS route. `state`: pi-lens's own durable
 * or session data under its data directories. `scratch`: a temporary file or
 * directory pi-lens creates and removes. `install`: a tool install or its
 * stamp. `primitive`: the module exports a write function other modules call
 * (its row names them, and the census counts each importer's uses).
 * `no-write`: every site is a use the scan cannot read that a reader judged
 * is not a write (a type annotation, a string that only spells "fs").
 */
type SiteClass =
	| "user-source"
	| "state"
	| "scratch"
	| "install"
	| "primitive"
	| "no-write";

interface SiteRow {
	sites: number;
	cls: SiteClass;
	why: string;
	/** Required for `user-source`: the WRITERS route ids the file serves. */
	routes?: readonly string[];
	/** Required for `primitive`: the exported write functions. */
	exports?: readonly string[];
}

const WRITE_SITES: Record<string, SiteRow> = {
	"clients/actionable-warnings.ts": {
		sites: 4,
		cls: "state",
		why: "the actionable-warnings report, its history and its durable store under the project data directory",
	},
	"clients/ast-grep-client.ts": {
		sites: 10,
		cls: "user-source",
		why: "the apply rewrites matched project files through writeSourceFile; the rest are scratch snippet files in a temporary directory",
		routes: ["ast-grep-apply"],
	},
	"clients/atomic-write-staging.ts": {
		sites: 1,
		cls: "state",
		why: "reaps stale staging files the atomic writer left beside its targets",
	},
	"clients/atomic-write.ts": {
		sites: 6,
		cls: "primitive",
		why: "writes a whole file through a temporary file and a rename, for any caller's path",
		exports: ["writeFileAtomic", "writeFileAtomicAsync"],
	},
	"clients/bounded-pid-file-lock.ts": {
		sites: 11,
		cls: "state",
		why: "creates, quarantines and removes its own lock files",
	},
	"clients/cache-manager.ts": {
		sites: 7,
		cls: "state",
		why: "the cache and turn-state files under the project data directory",
	},
	"clients/cache/rule-cache.ts": {
		sites: 4,
		cls: "state",
		why: "the rule cache files under its cache directory",
	},
	"clients/call-graph.ts": {
		sites: 3,
		cls: "state",
		why: "the call-graph cache file",
	},
	"clients/code-quality-warnings.ts": {
		sites: 2,
		cls: "state",
		why: "the code-quality report and its history",
	},
	"clients/codebase-model.ts": {
		sites: 3,
		cls: "state",
		why: "the codebase-model cache file",
	},
	"clients/debug-heap.ts": {
		sites: 2,
		cls: "state",
		why: "heap snapshots and their pruning under the debug directory",
	},
	"clients/diagnostic-dispositions.ts": {
		sites: 2,
		cls: "state",
		why: "the disposition store under the project data directory",
	},
	"clients/dispatch/facts/try-catch-facts.ts": {
		sites: 3,
		cls: "no-write",
		why: 'the string "fs" is a boundary-category label, not a module',
	},
	"clients/dispatch/rules/error-swallowing.ts": {
		sites: 1,
		cls: "no-write",
		why: 'the string "fs" is a boundary-category label, not a module',
	},
	"clients/dispatch/runners/ast-grep-napi.ts": {
		sites: 1,
		cls: "no-write",
		why: 'an import("fs").Stats type annotation',
	},
	"clients/dispatch/runners/elixir-check.ts": {
		sites: 1,
		cls: "state",
		why: "the elixirc output directory under the project data directory",
	},
	"clients/dispatch/runners/helm-render.ts": {
		sites: 2,
		cls: "scratch",
		why: "a temporary render directory, removed after the run",
	},
	"clients/dispatch/runners/psscriptanalyzer.ts": {
		sites: 2,
		cls: "scratch",
		why: "a temporary PowerShell script, removed after the run",
	},
	"clients/dispatch/runners/spotbugs.ts": {
		sites: 1,
		cls: "scratch",
		why: "removes its temporary XML report",
	},
	"clients/durable-store.ts": {
		sites: 2,
		cls: "primitive",
		why: "commits a durable store file for its caller's path",
		exports: ["commitDurableStore", "commitDurableStoreAsync"],
	},
	"clients/file-utils.ts": {
		sites: 9,
		cls: "state",
		why: "pi-lens data directories, their migration and the ephemeral ones it removes",
	},
	"clients/fix-run-restore.ts": {
		sites: 1,
		cls: "user-source",
		why: "puts back an agent edit a whole-package fixer overwrote",
		routes: ["fix-run-restore"],
	},
	"clients/fix-worklog.ts": {
		sites: 2,
		cls: "state",
		why: "the fix worklog under the project data directory",
	},
	"clients/generation-lock.ts": {
		sites: 5,
		cls: "state",
		why: "its own lock and release marker files",
	},
	"clients/gitleaks-client.ts": {
		sites: 1,
		cls: "scratch",
		why: "a scoped gitleaks config in the scan's output directory",
	},
	"clients/grammar-source.ts": {
		sites: 2,
		cls: "install",
		why: "downloaded tree-sitter grammars",
	},
	"clients/gzip-stage-write.ts": {
		sites: 5,
		cls: "primitive",
		why: "writes and reaps a gzip stage file for its caller's path",
		exports: ["writeGzipStageFile", "reapStageFile"],
	},
	"clients/installer/index.ts": {
		sites: 63,
		cls: "install",
		why: "tool installs, their stamps and their locks",
	},
	"clients/installer/managed-tool-refresh.ts": {
		sites: 7,
		cls: "install",
		why: "managed tool downloads and their atomic swap into place",
	},
	"clients/instance-reaper.ts": {
		sites: 2,
		cls: "state",
		why: "the reaper's backstop state under the global pi-lens directory",
	},
	"clients/instance-registry-lock.ts": {
		sites: 3,
		cls: "state",
		why: "the instance registry lock file",
	},
	"clients/instance-registry.ts": {
		sites: 4,
		cls: "state",
		why: "the instance registry file",
	},
	"clients/knip-client.ts": {
		sites: 2,
		cls: "state",
		why: "the knip cache directory and its pruning",
	},
	"clients/lens-map.ts": {
		sites: 2,
		cls: "state",
		why: "the lens-map HTML report under the project data directory",
	},
	"clients/log-cleanup.ts": {
		sites: 3,
		cls: "state",
		why: "rotates and prunes pi-lens logs",
	},
	"clients/lsp/edits.ts": {
		sites: 9,
		cls: "user-source",
		why: "applies a workspace edit: text edits, creates, renames and deletes of project files",
		routes: [
			"lsp-rename",
			"lsp-rename-file",
			"lsp-execute-command",
			"lsp-server-apply-edit",
			"agent-end-lsp-quickfix",
		],
	},
	"clients/lsp/launch.ts": {
		sites: 2,
		cls: "state",
		why: "the session-start log",
	},
	"clients/lsp/server.ts": {
		sites: 3,
		cls: "install",
		why: "the pi-lens bin directory, a server binary directory and a PowerShell session log directory",
	},
	"clients/lsp/workspace-diagnostics-cache.ts": {
		sites: 2,
		cls: "state",
		why: "the workspace-diagnostics cache file",
	},
	"clients/mcp/ipc.ts": {
		sites: 2,
		cls: "state",
		why: "the MCP rendezvous socket and its record",
	},
	"clients/metrics-history.ts": {
		sites: 2,
		cls: "state",
		why: "the metrics history file",
	},
	"clients/mutation-attribution.ts": {
		sites: 2,
		cls: "state",
		why: "the learned mutation-attribution store",
	},
	"clients/ndjson-logger.ts": {
		sites: 10,
		cls: "state",
		why: "pi-lens NDJSON logs and their rotation",
	},
	"clients/out-of-band-changes.ts": {
		sites: 3,
		cls: "no-write",
		why: 'import("node:fs") type annotations',
	},
	"clients/project-changes.ts": {
		sites: 4,
		cls: "state",
		why: "the project change log",
	},
	"clients/project-diagnostics/cache.ts": {
		sites: 4,
		cls: "state",
		why: "the project-diagnostics snapshot and delta report",
	},
	"clients/project-snapshot.ts": {
		sites: 10,
		cls: "state",
		why: "the project snapshot and its staging files",
	},
	"clients/recent-touches.ts": {
		sites: 2,
		cls: "state",
		why: "the recent-touches store under the project data directory",
	},
	"clients/report-scan.ts": {
		sites: 2,
		cls: "scratch",
		why: "a temporary scanner report directory, removed after the run",
	},
	"clients/review-graph/builder.ts": {
		sites: 22,
		cls: "state",
		why: "the review-graph cache, checkpoint and staging files",
	},
	"clients/session-state-store.ts": {
		sites: 2,
		cls: "state",
		why: "the session state file",
	},
	"clients/sg-runner.ts": {
		sites: 5,
		cls: "scratch",
		why: "a temporary ast-grep config and rule directory, removed after the run",
	},
	"clients/sgconfig.ts": {
		sites: 8,
		cls: "state",
		why: "the merged ast-grep rule directory and sgconfig under the scanner report directory",
	},
	"clients/test-runner-client.ts": {
		sites: 3,
		cls: "scratch",
		why: 'a temporary test report directory, removed after the run, and an import("node:fs") type',
	},
	"clients/tool-probe.ts": {
		sites: 1,
		cls: "install",
		why: "the isolated npx working directory under the global pi-lens directory",
	},
	"clients/trivy-client.ts": {
		sites: 1,
		cls: "no-write",
		why: 'the string "fs" is trivy\'s filesystem scan mode, not a module',
	},
	"clients/write-source-file.ts": {
		sites: 0,
		cls: "primitive",
		why: "queues a project-source write and records it on every exit; the caller's callback writes",
		exports: ["writeSourceFile"],
	},
	"index.ts": {
		sites: 2,
		cls: "user-source",
		why: "deletes a stale .tsbuildinfo from the project root at session start, and passes two fs reads on as an object",
		routes: ["tsbuildinfo-cleanup"],
	},
	"tools/lens-diagnostic-mark.ts": {
		sites: 2,
		cls: "user-source",
		why: "inserts a suppress comment into a project file",
		routes: ["lens-diagnostic-mark"],
	},
	"tools/render-compact.ts": {
		sites: 3,
		cls: "state",
		why: "the full tool-result log under the pi-lens log directory",
	},
};

function writeModules(): WriteModule[] {
	return [
		FS_MODULE,
		...Object.entries(WRITE_SITES).flatMap(([file, row]) =>
			row.cls === "primitive" && row.exports
				? [primitiveModule(file, row.exports)]
				: [],
		),
	];
}

function censusOf(): Map<string, Site[]> {
	const modules = writeModules();
	const census = new Map<string, Site[]>();
	for (const file of productionSources()) {
		const sites = writeSites(fs.readFileSync(file, "utf8"), file, modules);
		if (sites.length > 0) census.set(relative(file), sites);
	}
	return census;
}

// --- The table --------------------------------------------------------------

function reasonOf(cell: WriterCell): string {
	switch (cell.cell) {
		case "reaches":
			return cell.probe;
		case "silent":
			return `${cell.probe} ${cell.why}`;
		case "n/a":
			return cell.why;
		case "unprobed":
			return cell.settle;
	}
}

describe("the writer table", () => {
	it("answers every consumer for every route, with evidence on every cell", () => {
		const ids = new Set<string>();
		for (const route of WRITERS) {
			expect(ids.has(route.id), `duplicate route ${route.id}`).toBe(false);
			ids.add(route.id);
			expect(Object.keys(route.cells).sort()).toEqual(
				[...WRITER_CONSUMERS].sort(),
			);
			for (const consumer of WRITER_CONSUMERS) {
				const reason = reasonOf(route.cells[consumer]);
				expect(
					reason.trim().length,
					`${route.id} x ${consumer} names no probe or reason`,
				).toBeGreaterThan(3);
			}
		}
	});

	it("reuses the disk-change consumer ids, and only for the shared consumers", () => {
		const incoming = new Set(DISK_CHANGE_CONSUMERS.map((row) => row.id));
		for (const id of SHARED_WRITER_CONSUMERS)
			expect(incoming.has(id), `${id} is not a #4535 consumer`).toBe(true);
		for (const id of AUTHORED_WRITER_CONSUMERS)
			expect(incoming.has(id), `${id} duplicates a #4535 consumer`).toBe(false);
	});

	it("keeps each route's anchor in the file it names", () => {
		for (const route of WRITERS) {
			const file = path.join(repoRoot, route.anchor.file);
			expect(fs.existsSync(file), `${route.id}: ${route.anchor.file}`).toBe(
				true,
			);
			const code = stripSource(fs.readFileSync(file, "utf8"));
			expect(
				new RegExp(`\\b${escapeRegExp(route.anchor.symbol)}\\b`).test(code),
				`${route.id}: ${route.anchor.symbol} is gone from ${route.anchor.file}`,
			).toBe(true);
		}
	});

	// A cell that cites a merged test by its bracketed title stays true only
	// while that test exists. Recurrence: a renamed or deleted witness leaves
	// the cell claiming a probe nothing runs. Comments are blanked, so a quote
	// of the title in prose does not count.
	it("cites only test titles that a test declares", () => {
		const declared = listTestFiles(path.join(repoRoot, "tests")).map((file) =>
			stripSource(fs.readFileSync(file, "utf8"), { strings: "keep" }),
		);
		const missing = new Set<string>();
		for (const route of WRITERS)
			for (const consumer of WRITER_CONSUMERS) {
				const cell = route.cells[consumer];
				if (cell.cell !== "reaches" && cell.cell !== "silent") continue;
				const title = /^\[([^\]]+)\]/.exec(cell.probe)?.[1];
				if (title === undefined) continue;
				const call = new RegExp(
					`\\b(?:it|test)(?:\\.\\w+)*\\(\\s*["'\`]${escapeRegExp(title)}["'\`]`,
				);
				if (!declared.some((code) => call.test(code))) missing.add(title);
			}
		expect([...missing]).toEqual([]);
	});

	it("pins the routes no fold has reached and the unprobed cells", () => {
		const byRecorder: Record<string, string[]> = {};
		for (const route of WRITERS)
			for (const recorder of route.recorders)
				(byRecorder[recorder] ??= []).push(route.id);
		// The hand-copied recorders #5551 has not folded onto
		// `recordMutationOutcome` yet: a fold that lands moves its routes here.
		expect(byRecorder).toEqual({
			recordMutationOutcome: [
				"foreign-named",
				"foreign-bridge",
				"mcp-attached-tool",
				"ast-grep-apply",
				"lsp-rename",
				"lsp-rename-file",
				"lsp-execute-command",
				"lsp-server-apply-edit",
				"lens-diagnostic-mark",
				"agent-end-lsp-quickfix",
			],
			"tool-result": [
				"host-write",
				"host-edit",
				"host-edit-partial",
				"codemode-nested",
				"bash-recognised",
				"bash-mtime-preserving",
				"bash-opaque",
				"foreign-path-less",
				"runner-format-autofix",
			],
			"agent-end-drain": ["runner-format-autofix"],
			none: [
				"fix-run-restore",
				"runner-whole-package-fix",
				"tsbuildinfo-cleanup",
			],
		});
		const unprobed = Object.fromEntries(
			WRITER_CONSUMERS.map((consumer) => [
				consumer,
				WRITERS.filter((route) => route.cells[consumer].cell === "unprobed")
					.length,
			]),
		);
		// A probe that settles a cell lowers its count here.
		expect(unprobed).toEqual({
			dispatch: 7,
			"inline-stop": 3,
			"change-log": 8,
			"commit-gate": 8,
			"pre-edit-baseline": 13,
			"fix-run-capture": 14,
			"lsp-documents": 8,
			"read-guard": 8,
			"word-index": 22,
		});
	});
});

/**
 * Each file whose census differs from its row, with the sites to read. A file
 * with sites and no row, a count that moved, and a row whose file no longer
 * writes (other than a primitive, whose importers carry its sites) all differ.
 */
function censusMismatches(
	census: Map<string, Site[]>,
	rows: Record<string, SiteRow>,
): string[] {
	const out: string[] = [];
	for (const [file, sites] of census) {
		const row = rows[file];
		if (row?.sites === sites.length) continue;
		out.push(
			`${file}: ${sites.length} site(s), row admits ${row?.sites ?? "none"}\n${sites
				.map((site) => `  ${site.line} ${site.kind}: ${site.text}`)
				.join("\n")}`,
		);
	}
	for (const [file, row] of Object.entries(rows))
		if (!census.has(file) && row.sites !== 0)
			out.push(`${file}: row admits ${row.sites} site(s), the scan found none`);
		else if (!census.has(file) && row.cls !== "primitive")
			out.push(`${file}: a row with no sites must go`);
	return out;
}

describe("the writer census", () => {
	it("admits every file-writing site in production through a row that pins its count", () => {
		const census = censusOf();
		assertNonEmptyScan("writer census files", census.size, 40);
		expect(censusMismatches(census, WRITE_SITES)).toEqual([]);
	});

	it("names a route for every user-source row and the exports of every primitive", () => {
		const routes = new Set(WRITERS.map((route) => route.id));
		for (const [file, row] of Object.entries(WRITE_SITES)) {
			expect(row.why.length, `${file} gives no reason`).toBeGreaterThan(20);
			if (row.cls === "user-source") {
				expect(row.routes?.length, `${file} names no route`).toBeGreaterThan(0);
				for (const route of row.routes ?? [])
					expect(routes.has(route), `${file}: unknown route ${route}`).toBe(
						true,
					);
			} else expect(row.routes, `${file} is not user-source`).toBeUndefined();
			if (row.cls === "primitive")
				expect(row.exports?.length, `${file} names no export`).toBeGreaterThan(
					0,
				);
			else expect(row.exports, `${file} is not a primitive`).toBeUndefined();
		}
	});

	it("fails on a planted file that writes and has no row", () => {
		const planted = new Map(censusOf());
		planted.set("clients/planted-writer.ts", [
			{ line: 1, kind: "write", text: "fs.writeFileSync(p, d)" },
		]);
		expect(censusMismatches(planted, WRITE_SITES)).toEqual([
			"clients/planted-writer.ts: 1 site(s), row admits none\n  1 write: fs.writeFileSync(p, d)",
		]);
	});

	// Recurrence: an enumerated gate admits the spellings its author thought of
	// and passes the next one (shape 69). Each plant below writes a file in a
	// form the scan was not written around; each must count.
	it("counts every spelling it was not designed around, and admits only the read-only forms", () => {
		const scan = (source: string) =>
			writeSites(
				source,
				path.join(repoRoot, "clients", "x.ts"),
				writeModules(),
			);
		const fsImport = 'import * as fs from "node:fs";\n';
		const counted = {
			alias: `${fsImport}const put = fs.writeFileSync;\nput("p", "d");`,
			indirect: `${fsImport}[fs.writeFileSync].forEach((w) => w("p", "d"));`,
			throughAnotherBinding: `${fsImport}const f = fs;\nf.writeFileSync("p", "d");`,
			computed: `${fsImport}fs["write" + "FileSync"]("p", "d");`,
			destructured: `${fsImport}const { writeFileSync } = fs;\nwriteFileSync("p", "d");`,
			passedOn: `${fsImport}run(fs);`,
			promisesMember: `${fsImport}await fs.promises.writeFile("p", "d");`,
			unlistedMember: `${fsImport}fs.lutimesSync("p", 1, 1);`,
			templateInterpolation: `${fsImport}const s = \`\${fs.rmSync("p")}\`;`,
			openForWrite: `${fsImport}const fd = fs.openSync("p", flag);`,
			namedAlias:
				'import { writeFileSync as put } from "node:fs";\nput("p", "d");',
			defaultImport:
				'import nodeFs from "fs";\nnodeFs.appendFileSync("p", "d");',
			promisesNamed:
				'import { promises as io } from "node:fs";\nawait io.rm("p");',
			reExport: 'export { writeFileSync } from "node:fs";',
			exportAll: 'export * from "node:fs/promises";',
			dynamicBound: 'const io = await import("node:fs");\nio.rmSync("p");',
			dynamicUnbound: 'await import("node:fs").then((io) => io.rmSync("p"));',
			requireDestructured:
				'const { unlinkSync } = require("fs");\nunlinkSync("p");',
			specifierInVariable:
				'const name = "node:fs";\nconst io = await import(name);',
			primitiveAliased:
				'import { writeFileAtomic as save } from "./atomic-write.js";\nsave("p", "d");',
			primitiveNamespace:
				'import * as atomic from "./atomic-write.js";\natomic.writeFileAtomic("p", "d");',
		};
		for (const [name, source] of Object.entries(counted))
			expect(scan(source).length, name).toBeGreaterThan(0);
		const admitted = {
			readOnlyMembers: `${fsImport}fs.existsSync("p");\nfs.readFileSync("p");\nfs.promises.stat("p");`,
			readOnlyNamed:
				'import { existsSync, statSync as st } from "node:fs";\nexistsSync("p");\nst("p");',
			openForRead: `${fsImport}const fd = fs.openSync(path.join(a, b), "r");`,
			typeImport: 'import type { Stats } from "node:fs";\nlet s: Stats;',
			prose: `${fsImport}// fs.writeFileSync("p", "d")\nconst s = "fs.rmSync(p)";`,
			primitiveReadExport:
				'import { STAGE_TMP_PATTERN } from "./atomic-write-staging.js";\nSTAGE_TMP_PATTERN.test("x");',
		};
		for (const [name, source] of Object.entries(admitted))
			expect(scan(source), name).toEqual([]);
	});
});

function listTestFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory())
			return entry.name === "fixtures" ? [] : listTestFiles(full);
		return entry.name.endsWith(".test.ts") ? [full] : [];
	});
}
