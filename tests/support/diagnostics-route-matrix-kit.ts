/**
 * The diagnostics route/switch matrix's shared kit (#4403, split for #3801):
 * the route list, the column table, the state table's expected rows and the
 * fixture/driver that runs one column through every route. Moved unchanged
 * from `tests/tools/diagnostics-route-switch-matrix.test.ts`, which keeps the
 * code-derived route scan; the five `diagnostics-route-switch-matrix-cols-N`
 * files each run `COLUMNS_PER_FILE` columns so the sequencer can balance them.
 * `runColumn` takes the caller's `useConfigPath()` setter because that hook
 * registers its restore in the file that calls it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getLSPService, resetLSPService } from "../../clients/lsp/index.js";
import { clearWorkspaceDiagnosticsCache } from "../../clients/lsp/workspace-diagnostics-cache.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { McpHarness } from "../mcp/harness.js";
import { scaledTestTimeout } from "./test-timeout-scale.js";
import { makeSessionStartEvent } from "./host-event-factory.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
export const fakeServer = path.join(
	repoRoot,
	"tests",
	"fixtures",
	"fake-lsp-server.mjs",
);
export const PREFIX = "pi-lens-4403-matrix-";

// ── The routes and switches ─────────────────────────────────────────────────

export const ROUTES = [
	"write-time dispatch",
	"lsp_diagnostics file",
	"lsp_diagnostics batch",
	"lsp_diagnostics directory",
	"lsp_diagnostics primary-only",
	"MCP pilens_diagnostics",
	"lsp_navigation workspaceDiagnostics",
	"turn-end actionable warnings",
	"lens_diagnostics mode=full",
] as const;
export type RouteId = (typeof ROUTES)[number];

/**
 * Which servers a route asks for, given the servers the configuration selects:
 * `all` asks every selected server; `primary` asks the language server, and
 * when none could start its clientless fallback asks every selected server
 * (#4322);
 * `sweep` is the `mode=full` engine, which leaves Opengrep to its CLI extractor
 * (`WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`, #584) and starts nothing for a file
 * whose language server cannot start.
 */
export type RouteScope = "all" | "primary" | "sweep";
export const ROUTE_SCOPE: Record<RouteId, RouteScope> = {
	"write-time dispatch": "all",
	"lsp_diagnostics file": "all",
	"lsp_diagnostics batch": "all",
	"lsp_diagnostics directory": "all",
	"lsp_diagnostics primary-only": "primary",
	"MCP pilens_diagnostics": "all",
	"lsp_navigation workspaceDiagnostics": "all",
	"turn-end actionable warnings": "all",
	"lens_diagnostics mode=full": "sweep",
};

/**
 * A route that renders no confirmation verdict, with the reason. Every other
 * route's verdict is read from what it shows the agent.
 */
export const NO_VERDICT_SURFACE: Partial<Record<RouteId, string>> = {
	"turn-end actionable warnings":
		"it reports only warnings that carry a code action; a file with none adds nothing, clean or not",
};

export type ColumnId =
	| "present"
	| "disabled"
	| "disabled, fallback"
	| "missing"
	| "present, no aux"
	| "disabled, no aux"
	| "missing, no aux"
	| "--no-opengrep"
	| "opengrep.enabled=false"
	| "--no-ast-grep"
	| "astGrep.enabled=false"
	| "--no-typos"
	| "typos.enabled=false"
	| "--no-zizmor"
	| "zizmor.enabled=false";

/** The auxiliary servers an operator switch turns off, and the flag naming each. */
export type SwitchedServer = "opengrep" | "ast-grep" | "typos" | "zizmor";
export const SWITCH_FLAG = {
	opengrep: "no-opengrep",
	"ast-grep": "no-ast-grep",
	typos: "no-typos",
	zizmor: "no-zizmor",
} as const satisfies Record<SwitchedServer, string>;
/** The global-config section whose `enabled=false` is the same switch (#4946 for typos and zizmor). */
export const SWITCH_SECTION = {
	opengrep: "opengrep",
	"ast-grep": "astGrep",
	typos: "typos",
	zizmor: "zizmor",
} as const satisfies Record<SwitchedServer, string>;

export interface Column {
	id: ColumnId;
	/** `~/.pi-lens/config.json`, through PI_LENS_CONFIG_PATH. */
	globalConfig: Record<string, unknown>;
	/** A CLI flag the factory registers; set after `extension(...)`, as pi applies it. */
	flag: (typeof SWITCH_FLAG)[SwitchedServer] | undefined;
	/**
	 * The language server: a working fake, off in lsp.json, or a missing
	 * binary. `disabledFallback` is a TypeScript file whose primary is off in
	 * lsp.json while its `fallbackFor` alternate (deno) is a missing binary
	 * (#4403 round 4, N1).
	 */
	primary: "fake" | "disabled" | "disabledFallback" | "missing";
	/**
	 * typos, Opengrep and ast-grep running; false turns all off in
	 * `lsp.disabledServers`. zizmor is off in `lsp.disabledServers` in every
	 * column (it attaches to workflow files, which the fixture is not), so its
	 * columns prove the switch's reach, not a server start.
	 */
	aux: boolean;
	/** A server is off, by `aux` or by its own switch. */
	off: ReadonlySet<SwitchedServer>;
	/** The server this column's own switch turned off; the file renderer names it. */
	switchedOff: SwitchedServer | undefined;
}

export const column = (
	id: ColumnId,
	primary: Column["primary"],
	aux: boolean,
	switches: { switchedOff?: SwitchedServer; viaConfig?: boolean } = {},
): Column => ({
	id,
	globalConfig: switches.viaConfig
		? {
				[SWITCH_SECTION[switches.switchedOff ?? "opengrep"]]: {
					enabled: false,
				},
			}
		: {},
	flag:
		switches.switchedOff && !switches.viaConfig
			? SWITCH_FLAG[switches.switchedOff]
			: undefined,
	primary,
	aux,
	off: new Set<SwitchedServer>(
		aux
			? switches.switchedOff
				? [switches.switchedOff]
				: []
			: ["opengrep", "ast-grep", "typos"],
	),
	switchedOff: switches.switchedOff,
});

/**
 * The state table's six columns (the primary present, disabled in config, or
 * missing, each with and without an auxiliary), the disabled primary whose
 * fallback cannot start, then the two switches that turn Opengrep off, which
 * must change nothing but the servers started.
 */
export const COLUMNS: readonly Column[] = [
	column("present", "fake", true),
	column("disabled", "disabled", true),
	column("disabled, fallback", "disabledFallback", true),
	column("missing", "missing", true),
	column("present, no aux", "fake", false),
	column("disabled, no aux", "disabled", false),
	column("missing, no aux", "missing", false),
	column("--no-opengrep", "fake", true, { switchedOff: "opengrep" }),
	column("opengrep.enabled=false", "fake", true, {
		switchedOff: "opengrep",
		viaConfig: true,
	}),
	column("--no-ast-grep", "fake", true, { switchedOff: "ast-grep" }),
	column("astGrep.enabled=false", "fake", true, {
		switchedOff: "ast-grep",
		viaConfig: true,
	}),
	column("--no-typos", "fake", true, { switchedOff: "typos" }),
	column("typos.enabled=false", "fake", true, {
		switchedOff: "typos",
		viaConfig: true,
	}),
	column("--no-zizmor", "fake", true, { switchedOff: "zizmor" }),
	column("zizmor.enabled=false", "fake", true, {
		switchedOff: "zizmor",
		viaConfig: true,
	}),
];

/** Columns per `diagnostics-route-switch-matrix-cols-N` file, and the file count. */
export const COLUMNS_PER_FILE = 3;
export const COLUMN_FILE_COUNT = 5;

/** The slice of {@link COLUMNS} file `fileNumber` (1-based) runs. */
export function columnsOfFile(fileNumber: number): readonly Column[] {
	const from = (fileNumber - 1) * COLUMNS_PER_FILE;
	return COLUMNS.slice(from, from + COLUMNS_PER_FILE);
}

/**
 * A cell that cannot exist, with the reason. The MCP server has no CLI flags:
 * it resolves `no-opengrep`, `no-ast-grep`, `no-typos` and `no-zizmor` from
 * config only (`createMcpHost`), so its switch is the matching
 * `<section>.enabled=false` column. A case below reds if any of them ever
 * gains an environment spelling the MCP host could read.
 */
export const NOT_APPLICABLE: ReadonlyArray<{
	route: RouteId;
	column: ColumnId;
	why: string;
}> = [
	{
		route: "MCP pilens_diagnostics",
		column: "--no-opengrep",
		why: "the MCP host has no CLI flags; it reads no-opengrep from config only",
	},
	{
		route: "MCP pilens_diagnostics",
		column: "--no-ast-grep",
		why: "the MCP host has no CLI flags; it reads no-ast-grep from config only",
	},
	{
		route: "MCP pilens_diagnostics",
		column: "--no-typos",
		why: "the MCP host has no CLI flags; it reads no-typos from config only",
	},
	{
		route: "MCP pilens_diagnostics",
		column: "--no-zizmor",
		why: "the MCP host has no CLI flags; it reads no-zizmor from config only",
	},
];

export type Verdict = "clean" | "unconfirmed" | "findings" | "unsupported";

/**
 * The file language a column checks. The fallback column is TypeScript: JSON
 * has no `fallbackFor` alternate. The rule it pins is read from that link, so
 * python/python-jedi, csharp/omnisharp, docker/docker-official and
 * elixir/expert take the same path.
 */
export const LANGUAGE = {
	json: {
		ext: ".json",
		label: "JSON",
		kind: "json",
		/** The primaries a file line names when none answered. */
		unanswered: "json",
		content: (name: string, n: number) => `{"${name}": ${n}}\n`,
	},
	ts: {
		ext: ".ts",
		label: "JavaScript/TypeScript",
		kind: "jsts",
		unanswered: "deno, typescript",
		content: (name: string, n: number) =>
			`export const ${name.replace(/\W/g, "_")} = ${n};\n`,
	},
} as const;
export type Language = (typeof LANGUAGE)[keyof typeof LANGUAGE];

export function languageOf(column: Column): Language {
	return column.primary === "disabledFallback" ? LANGUAGE.ts : LANGUAGE.json;
}

/** The servers a column's configuration selects that can start. */
export function selectedServers(column: Column): string[] {
	return [
		...(column.primary === "fake" ? ["json"] : []),
		...(column.off.has("opengrep") ? [] : ["opengrep"]),
		...(column.off.has("ast-grep") ? [] : ["ast-grep"]),
		...(column.off.has("typos") ? [] : ["typos"]),
	].sort();
}

export function expectedStarted(route: RouteId, column: Column): string[] {
	const selected = selectedServers(column);
	switch (ROUTE_SCOPE[route]) {
		case "all":
			return selected;
		case "primary":
			// A disabled primary makes the touch inconclusive at once, so the
			// clientless fallback that would ask the others never runs.
			return column.primary === "fake"
				? ["json"]
				: column.primary === "missing"
					? selected
					: [];
		case "sweep":
			// A fallback that cannot start fails the sweep's warm-up like a
			// missing primary, so its group is skipped before any touch.
			return column.primary === "missing" ||
				column.primary === "disabledFallback"
				? []
				: selected.filter((id) => id !== "opengrep");
	}
}

/**
 * The column's verdict, from the rules alone: a working language server that
 * answers clean confirms the file, switches that drop only Opengrep change
 * nothing about that, and no primary answering is never clean, whether it
 * could not start (#4322) or is off in config (#4403), with or without an
 * auxiliary.
 */
export function expectedVerdict(column: Column): Verdict {
	return column.primary === "fake" ? "clean" : "unconfirmed";
}

// ── The state table's lines ────────────────────────────────────────────────
//
// The exact user-facing lines of the round-3 state table (PR #4411): each
// route's verdict line and the cause it gives, `<ws>` for the workspace and
// `Nms` for a timing. Literal on purpose: the table is the spec, so a wording
// change reds here and is decided, not inherited from a shared constant.

export const CAUSE = {
	disabled: "it is disabled in config by lsp.disabledServers",
	disabledFallback:
		"it is disabled in config by lsp.disabledServers, and its fallback could not be started, or was still starting",
	missing: "it could not be started, or was still starting",
} as const;

export const NOTE_GENERIC =
	"🟡 1 warning(s):\nPi-lens json analysis unavailable — a language tool is missing, timed out, or failed to run, or the LSP server isn't ready yet, so this file was not fully checked (not a clean result).";
export const NOTE_DISABLED =
	"🟡 1 warning(s):\nPi-lens json analysis unconfirmed — Primary LSP (json) is disabled in config by lsp.disabledServers, so no language server checks these files this session (not a clean result).";
export const NOTE_DISABLED_FALLBACK =
	"🟡 1 warning(s):\nPi-lens jsts analysis unconfirmed — Primary LSP (typescript) is disabled in config by lsp.disabledServers and its fallback did not answer, so no language server checked these files (not a clean result).";

export function fileLine(column: Column): string {
	const { primary } = column;
	return primary === "fake"
		? "Primary LSP (json): confirmed clean."
		: `Primary LSP (${languageOf(column).unanswered}): not available — no primary language server answered for this file (${CAUSE[primary]}). NOT the same as 0 diagnostics; auxiliary scanners do not check the language itself.`;
}

/**
 * The single-file renderer's second line: the auxiliaries' answer, which names
 * a switched-off Opengrep when the read asked every server, or, when no client
 * answered at all, the health record.
 */
export function fileSecondLine(
	column: Column,
	file: string,
	route: RouteId,
): string {
	if (column.primary === "missing" && !column.aux)
		return `LSP unavailable for <ws>/${file}: no LSP client is currently ready; ready=0/1. candidates=json. No diagnostics were collected.`;
	// The single-file renderer names only a switched-off server that applies to
	// the file (`getServersForFileWithConfig`). zizmor audits workflow files
	// only (`isZizmorAuditTarget`), so a JSON fixture shows no line for it; the
	// `mode=full` sweep line below names it whatever the file (#4946).
	return column.switchedOff &&
		column.switchedOff !== "zizmor" &&
		ROUTE_SCOPE[route] === "all"
		? `No auxiliary findings. Switched off, not run: ${column.switchedOff}.`
		: "No auxiliary findings.";
}

export function tallyLine(primary: Column["primary"], count: number): string {
	return `${count} with no primary language server answer (${CAUSE[primary as Exclude<Column["primary"], "fake">]}). NOT the same as 0 diagnostics.`;
}

export function expectedLines(route: RouteId, column: Column): string[] {
	const { primary } = column;
	const { ext, label } = languageOf(column);
	const clean = primary === "fake";
	switch (route) {
		case "write-time dispatch": {
			if (clean)
				return [
					"✓ JSON clean · Nms",
					"✓ JSON clean · Nms",
					"✓ JSON clean · Nms",
				];
			const status = `⚠ ${label} unconfirmed — no primary language server answered (${CAUSE[primary]}) · Nms`;
			// First write, a later write of it, then a second file's first write:
			// one note per disabled server per session, one per file otherwise.
			return primary === "disabled"
				? [NOTE_DISABLED, status, status]
				: primary === "disabledFallback"
					? [NOTE_DISABLED_FALLBACK, status, status]
					: [NOTE_GENERIC, status, NOTE_GENERIC];
		}
		case "lsp_diagnostics file":
			return [fileLine(column), fileSecondLine(column, `file${ext}`, route)];
		case "lsp_diagnostics primary-only":
			return [fileLine(column), fileSecondLine(column, `primary${ext}`, route)];
		case "MCP pilens_diagnostics":
			return [fileLine(column), fileSecondLine(column, `mcp${ext}`, route)];
		case "lsp_diagnostics batch": {
			if (clean)
				return [
					"Outcomes: clean=2, findings=0, unsupported=0, unavailable=0, failed=0, too_large=0, inconclusive=0",
					"No diagnostics found.",
				];
			const unavailable = primary === "missing" && !column.aux;
			return [
				`Outcomes: clean=0, findings=0, unsupported=0, unavailable=${unavailable ? 2 : 0}, failed=0, too_large=0, inconclusive=${unavailable ? 0 : 2}`,
				`0 files confirmed clean, 2 unconfirmed: ${tallyLine(primary, 2)}`,
			];
		}
		case "lsp_diagnostics directory":
			if (clean) return ["No diagnostics found."];
			return [
				...(primary === "missing" && !column.aux
					? [
							"LSP unavailable for one or more files:",
							"LSP unavailable for <ws>/dir/inner.json: no LSP client is currently ready; ready=0/1. candidates=json. No diagnostics were collected.",
						]
					: []),
				`0 clean · 1 unconfirmed: ${tallyLine(primary, 1)}`,
			];
		case "lsp_navigation workspaceDiagnostics":
			return clean
				? ["ok=true status=empty"]
				: ["ok=true status=empty unconfirmed", fileLine(column)];
		case "lens_diagnostics mode=full":
			// #4403 N3: no retry hint where only a denial kept the server out.
			// #4944 F5: a server an operator switch turned off is named, as the
			// single-file renderer names it. #4947 r2 N2: as an auxiliary LSP
			// server, because this result can carry the project scan's
			// `ast-grep-napi` rows, which the switch does not turn off.
			return clean
				? column.switchedOff
					? [`Switched off, not run (auxiliary LSP): ${column.switchedOff}.`]
					: []
				: [
						`⚠ LSP sweep: 0 file(s) confirmed via LSP, 1 unconfirmed (no primary language server answered (${CAUSE[primary]})) — NOT the same as 0 diagnostics for: <ws>/sweep${ext}. These files' LSP contribution is excluded from this result${primary === "disabled" ? "" : "; re-run mode=full to retry them"} (they may still show findings above from cached/project-runner state).`,
					];
		case "turn-end actionable warnings":
			return [];
	}
}

export type Cell = {
	started: string[] | "n/a";
	verdict: string;
	lines: string[] | "n/a";
};

export function expectedRow(column: Column): Record<RouteId, Cell> {
	const row = {} as Record<RouteId, Cell>;
	for (const route of ROUTES) {
		if (
			NOT_APPLICABLE.some((na) => na.route === route && na.column === column.id)
		) {
			row[route] = { started: "n/a", verdict: "n/a", lines: "n/a" };
			continue;
		}
		row[route] = {
			started: expectedStarted(route, column),
			verdict:
				NO_VERDICT_SURFACE[route] !== undefined
					? "none"
					: expectedVerdict(column),
			lines: expectedLines(route, column),
		};
	}
	return row;
}

// ── Readers: what each route shows the agent ───────────────────────────────

/** Trimmed, non-empty lines, with the workspace and timings normalised. */
export function shownLines(text: string, workspace: string): string[] {
	return text
		.split(workspace)
		.join("<ws>")
		.replace(/\d+ms\b/g, "Nms")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * What a write shows the agent about the file's check: its tool result minus
 * the tool's own output and the read-guard advisories, which speak to the
 * edit, not the check.
 */
export function writeOutcome(text: string, workspace: string): string {
	return shownLines(text, workspace)
		.filter(
			(line) =>
				line !== "wrote" &&
				!line.startsWith("⚠ BLIND WRITE") &&
				!line.startsWith("🔴 THRASHING"),
		)
		.join("\n");
}

export function writeTimeVerdict(outcomes: readonly string[]): string {
	const verdicts = new Set(
		outcomes.map((outcome) =>
			/^✓ \S+ clean · Nms$/.test(outcome)
				? "clean"
				: /not a clean result|unconfirmed/.test(outcome)
					? "unconfirmed"
					: `unread: ${outcome}`,
		),
	);
	return verdicts.size === 1
		? ([...verdicts][0] as string)
		: `mixed: ${[...verdicts].join(",")}`;
}

/** The single-file renderer's verdict line, shared by pi and MCP. */
export function fileModeVerdict(text: string): string {
	const line = text.split("\n")[0] ?? "";
	if (/^Primary LSP[^:]*: confirmed clean\./.test(line)) return "clean";
	if (/^Primary LSP[^:]*: (not available|unconfirmed|timed out)/.test(line))
		return "unconfirmed";
	return `unread: ${line}`;
}

export const BATCH_OUTCOME_VERDICT: Record<string, Verdict> = {
	clean: "clean",
	findings: "findings",
	inconclusive: "unconfirmed",
	unavailable: "unconfirmed",
	unsupported: "unsupported",
};

export function batchVerdict(
	details: Record<string, unknown> | undefined,
): string {
	const outcomes = (details?.outcomes ?? []) as Array<{ outcome?: string }>;
	const verdicts = [
		...new Set(
			outcomes.map(
				(entry) =>
					BATCH_OUTCOME_VERDICT[entry.outcome ?? ""] ??
					`unread: ${entry.outcome}`,
			),
		),
	];
	return verdicts.length === 1
		? (verdicts[0] as string)
		: `mixed: ${verdicts.join(",")}`;
}

/** The batch's outcome tally and its unconfirmed (or clean) summary. */
export function batchLines(text: string, workspace: string): string[] {
	return shownLines(text, workspace).filter(
		(line) =>
			line.startsWith("Outcomes:") ||
			/^\d+ files? confirmed clean, /.test(line) ||
			line === "No diagnostics found.",
	);
}

/** The directory scan's lines between its header and its delivery footer. */
export function directoryLines(text: string, workspace: string): string[] {
	const lines = shownLines(text.split("\n\nresult ")[0] ?? "", workspace);
	return lines.filter(
		(line) =>
			!line.startsWith("Directory:") && !line.startsWith("Files scanned:"),
	);
}

export type NavigationEnvelope = {
	ok?: boolean;
	status?: string;
	resultCount?: number;
	notes?: string[];
	metadata?: { unconfirmed?: boolean };
};

export function navigationEnvelope(text: string): NavigationEnvelope {
	return JSON.parse(text.split("\n\nresult ")[0] ?? "") as NavigationEnvelope;
}

/**
 * The navigation envelope pi delivers (before the delivery footer). #4403 F5:
 * an envelope that is not `ok` never answered for the file, so it cannot be
 * clean; `no_server` used to score clean here.
 */
export function navigationVerdict(text: string): string {
	const envelope = navigationEnvelope(text);
	if (envelope.ok !== true || envelope.metadata?.unconfirmed === true)
		return "unconfirmed";
	return (envelope.resultCount ?? 0) > 0 ? "findings" : "clean";
}

/** The envelope's state, then each note about the primary. */
export function navigationLines(text: string): string[] {
	const envelope = navigationEnvelope(text);
	return [
		`ok=${envelope.ok} status=${envelope.status}${envelope.metadata?.unconfirmed === true ? " unconfirmed" : ""}`,
		...(envelope.notes ?? []).filter((note) => note.startsWith("Primary LSP")),
	];
}

export function sweepVerdict(
	details: Record<string, unknown> | undefined,
): string {
	const confirmed = Number(details?.lspFilesConfirmed ?? 0);
	const unconfirmed = Number(details?.lspFilesUnconfirmed ?? 0);
	if (unconfirmed > 0) return "unconfirmed";
	if (confirmed > 0) return "clean";
	return "unread: no LSP file counted";
}

export function sweepLines(text: string, workspace: string): string[] {
	return shownLines(text, workspace).filter(
		(line) =>
			line.startsWith("⚠ LSP sweep:") ||
			line.startsWith("Switched off, not run"),
	);
}

// ── Fixture ─────────────────────────────────────────────────────────────────

export interface Fixture {
	workspace: string;
	marker: string;
	configPath: string;
	/** Writes `<relative><ext>` in the column's language and returns its path. */
	file: (relative: string, n?: number) => string;
}

export function makeFixture(column: Column): Fixture {
	const env = setupTestEnvironment(PREFIX);
	// The real path: on macOS the tmpdir is a `/var` -> `/private/var` alias.
	const workspace = fs.realpathSync(env.tmpDir);
	const marker = path.join(workspace, "server-starts.txt");
	const shim = (serverId: string): string[] => {
		const file = path.join(workspace, `${serverId}-server.mjs`);
		fs.writeFileSync(
			file,
			[
				'import { appendFileSync } from "node:fs";',
				`appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${serverId}\n`)});`,
				'process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		return [process.execPath, file];
	};
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"synthetic-4403-fixture","private":true}\n',
	);
	// typos and Opengrep root at the nearest `.git` (clients/lsp/server.ts);
	// #4560: the fixture root already carries the shared marker.
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	const language = languageOf(column);
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				json: {
					command:
						column.primary === "missing"
							? [
									path.join(workspace, "missing", "json-language-server"),
									"--stdio",
								]
							: shim("json"),
				},
				// The fallback column's alternate; never started by another one.
				deno: {
					command: [path.join(workspace, "missing", "deno"), "lsp"],
				},
				typos: { command: shim("typos") },
				opengrep: { command: shim("opengrep") },
				"ast-grep": { command: shim("ast-grep") },
			},
			// `rust` is a disabled primary that can never root here (there is no
			// `Cargo.toml`): no cell may name it (#4403 F7).
			disabledServers: [
				"zizmor",
				"rust",
				...(column.primary === "disabled" ? ["json"] : []),
				...(column.primary === "disabledFallback" ? ["typescript"] : []),
				...(column.aux ? [] : ["typos", "opengrep", "ast-grep"]),
			],
			// A configured warm file that does not exist: session_start's
			// dominant-language warm-up would otherwise start the JSON server in
			// the background, inside whichever cell runs next.
			warmFiles: ["no-such-warm-file.json"],
		}),
	);
	// Outside `.pi-lens`, so it is a global config file only.
	const configPath = path.join(workspace, "global-config.json");
	// The actionable-warning switches are on in every column (#4913 part D: they
	// were pi flags on the double, which applied them before the factory).
	fs.writeFileSync(
		configPath,
		`${JSON.stringify({ ...column.globalConfig, actionableWarnings: { enabled: true, includeLspCodeActions: true } })}\n`,
	);
	return {
		workspace,
		marker,
		configPath,
		file: (relative, n = 1) => {
			const target = path.join(workspace, `${relative}${language.ext}`);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, language.content(path.basename(relative), n));
			return target;
		},
	};
}

export function markerLines(marker: string): string[] {
	if (!fs.existsSync(marker)) return [];
	return fs.readFileSync(marker, "utf8").split("\n").filter(Boolean);
}

export type ToolLike = {
	execute: (...args: unknown[]) => Promise<{
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	}>;
};

type ExtensionApi = Parameters<(typeof import("../../index.js"))["default"]>[0];

/** The part of the pi double `runColumn` drives. */
export interface MatrixPi {
	asExtensionAPI(): ExtensionApi;
	setFlag(name: string, value: boolean): void;
	emit(event: string, payload?: unknown, ctx?: unknown): Promise<unknown>;
	readonly tools: ReadonlyMap<string, unknown>;
	readonly sentMessages: ReadonlyArray<{ content: unknown }>;
}

/**
 * What a caller hands `runColumn`. The caller loads `tests/support/pi-mock.ts`
 * itself: that module refuses a test file that is not on `PI_MOCK_IMPORTERS`,
 * and `pi-mock-importer-sweep` flags a support file that loads it, so the kit
 * takes the double instead of importing it. `setConfigPath` is the caller's
 * `useConfigPath()` setter (its restore registers in the calling file).
 */
export interface MatrixHost {
	setConfigPath: (file: string | undefined, text?: string) => void;
	newPi: () => MatrixPi;
	newCtx: (options: {
		cwd: string;
		sessionId: string;
		isProjectTrusted: boolean;
	}) => unknown;
}

/** Runs every in-process route of one column through pi, then the MCP route. */
export async function runColumn(
	column: Column,
	host: MatrixHost,
): Promise<Record<RouteId, Cell>> {
	const { setConfigPath, newPi, newCtx } = host;
	const fx = makeFixture(column);
	const observed = {} as Record<RouteId, Cell>;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
	// The harness points PI_LENS_CONFIG_PATH at a missing file
	// (tests/support/vitest-setup.ts); this column's global config replaces it.
	setConfigPath(fx.configPath);
	// Never fetch a real vscode-json-language-server for the missing primary.
	process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
	try {
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(fx.workspace);
		const { default: extension } = await import("../../index.js");
		const { getLatencyReports, clearLatencyReports } =
			await import("../../clients/dispatch/dispatcher.js");
		const { _awaitDeferredLspPullForTest } =
			await import("../../clients/actionable-warnings.js");
		const pi = newPi();
		extension(pi.asExtensionAPI());
		// The CLI spelling: pi applies the value after the factory, and only
		// because the factory registered the flag (review F2; #4944 for
		// `no-ast-grep`, #4946 for `no-typos` and `no-zizmor`, which the registry
		// did not register).
		if (column.flag) pi.setFlag(column.flag, true);
		// The host's own trust decision, which session_start latches: the
		// command overrides are project config (#4248).
		const ctx = newCtx({
			cwd: fx.workspace,
			sessionId: `matrix-4403-${column.id}`,
			isProjectTrusted: true,
		});
		await pi.emit("session_start", makeSessionStartEvent(), ctx);
		await pi.emit("turn_start", {}, ctx);

		/** A fresh service, so the marker lines `work` adds are its starts. */
		const cell = async (
			route: RouteId,
			work: () => Promise<{ verdict: string; lines: string[] }>,
		): Promise<void> => {
			resetLSPService();
			getLSPService();
			clearWorkspaceDiagnosticsCache(fx.workspace);
			const from = markerLines(fx.marker).length;
			const { verdict, lines } = await work();
			observed[route] = {
				started: [...new Set(markerLines(fx.marker).slice(from))].sort(),
				verdict,
				lines,
			};
		};
		const lens = pi.tools.get("lens_diagnostics") as ToolLike;
		const nav = pi.tools.get("lsp_navigation") as ToolLike;
		const lspCheck = (params: Record<string, unknown>) =>
			lens.execute(
				"matrix-4403",
				{ source: "lsp", waitMs: 3000, ...params },
				undefined,
				null,
				{ cwd: fx.workspace },
			);

		await cell("write-time dispatch", async () => {
			clearLatencyReports();
			const written: string[] = [];
			const write = async (relative: string, n: number): Promise<string> => {
				const target = fx.file(relative, n);
				written.push(target);
				const result = (await pi.emit(
					"tool_result",
					{
						toolName: "write",
						input: { path: target, content: fs.readFileSync(target, "utf8") },
						content: [{ type: "text", text: "wrote" }],
					},
					ctx,
				)) as { content?: Array<{ text?: string }> } | undefined;
				return writeOutcome(
					(result?.content ?? []).map((part) => part.text ?? "").join("\n"),
					fx.workspace,
				);
			};
			const outcomes = [
				await write("write", 1),
				await write("write", 2),
				await write("write-2", 3),
			];
			// The runner row agrees with what the agent was shown. Judge only the
			// reports these writes produced: another dispatch of the same file can
			// land inside this window under load and plan no `lsp` runner at all,
			// which #4634 captured as `runner rows skipped,,skipped,skipped` at
			// load 74. #4634's review (F1) could not prove that filter through
			// `scripts/mutate.mjs`, which blanks the `"lsp"` literal before it
			// searches, so this case drives the off-plan dispatch itself: with the
			// runner flag set, dispatch planning drops every `lsp` runner
			// (`withPrimaryPolicyGroup`), the write still produces a latency report
			// with no `lsp` row, and the filter is what keeps that missing row from
			// standing in for one of the three writes above.
			pi.setFlag("no-lsp", true);
			try {
				await write("write", 4);
			} finally {
				pi.setFlag("no-lsp", false);
			}
			const rows = getLatencyReports()
				.filter(
					(report) =>
						written.includes(report.filePath) &&
						report.runners.some((runner) => runner.runnerId === "lsp"),
				)
				.map(
					(report) =>
						report.runners.find((runner) => runner.runnerId === "lsp")?.status,
				);
			const verdict = writeTimeVerdict(outcomes);
			const rowsAgree =
				rows.length >= outcomes.length &&
				rows.every((status) =>
					verdict === "clean" ? status === "succeeded" : status === "skipped",
				);
			return {
				verdict: rowsAgree ? verdict : `runner rows ${rows.join(",")}`,
				lines: outcomes,
			};
		});
		const fileCell = async (
			params: Record<string, unknown>,
		): Promise<{ verdict: string; lines: string[] }> => {
			const result = await lspCheck(params);
			const text = String(result.content[0]?.text);
			return {
				verdict: fileModeVerdict(text),
				lines: shownLines(text, fx.workspace).slice(0, 2),
			};
		};
		await cell("lsp_diagnostics file", () =>
			fileCell({ path: fx.file("file") }),
		);
		await cell("lsp_diagnostics batch", async () => {
			const result = await lspCheck({
				paths: [fx.file("batch-a"), fx.file("batch-b")],
			});
			return {
				verdict: batchVerdict(result.details),
				lines: batchLines(String(result.content[0]?.text), fx.workspace),
			};
		});
		await cell("lsp_diagnostics directory", async () => {
			fx.file("dir/inner");
			const result = await lspCheck({ path: path.join(fx.workspace, "dir") });
			return {
				verdict: batchVerdict(result.details),
				lines: directoryLines(String(result.content[0]?.text), fx.workspace),
			};
		});
		await cell("lsp_diagnostics primary-only", () =>
			fileCell({ path: fx.file("primary"), serverScope: "primary" }),
		);
		await cell("lsp_navigation workspaceDiagnostics", async () => {
			const result = await nav.execute(
				"matrix-4403-nav",
				{ operation: "workspaceDiagnostics", path: fx.file("nav") },
				new AbortController().signal,
				null,
				ctx,
			);
			const text = String(result.content[0]?.text);
			return { verdict: navigationVerdict(text), lines: navigationLines(text) };
		});
		await cell("lens_diagnostics mode=full", async () => {
			const result = await lens.execute(
				"matrix-4403-full",
				{ mode: "full", paths: [fx.file("sweep")] },
				undefined,
				null,
				{ cwd: fx.workspace },
			);
			return {
				verdict: sweepVerdict(result.details),
				lines: sweepLines(String(result.content[0]?.text), fx.workspace),
			};
		});
		// The turn's edit runs its own dispatch first; the cell starts after it,
		// with a fresh service, so turn_end's cold read is the only reader left.
		const edited = fx.file("turn");
		await pi.emit(
			"tool_result",
			{
				toolName: "edit",
				input: { path: edited },
				details: { diff: "+  1 changed();" },
				content: [{ type: "text", text: "changed" }],
			},
			ctx,
		);
		await cell("turn-end actionable warnings", async () => {
			const before = pi.sentMessages.length;
			await pi.emit("turn_end", {}, ctx);
			await _awaitDeferredLspPullForTest();
			return {
				verdict: "none",
				lines: pi.sentMessages
					.slice(before)
					.map((message) => JSON.stringify(message.content)),
			};
		});
		await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		await getLSPService().shutdown();
		resetLSPService();

		observed["MCP pilens_diagnostics"] = NOT_APPLICABLE.some(
			(na) => na.route === "MCP pilens_diagnostics" && na.column === column.id,
		)
			? { started: "n/a", verdict: "n/a", lines: "n/a" }
			: await runMcpCell(fx);
	} finally {
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	}
	return observed;
}

/** `pilens_diagnostics source=lsp` through the real MCP server process. */
export async function runMcpCell(fx: Fixture): Promise<Cell> {
	const from = markerLines(fx.marker).length;
	const probe = fx.file("mcp");
	const harness = new McpHarness({
		cwd: fx.workspace,
		env: {
			PI_LENS_CONFIG_PATH: fx.configPath,
			PI_LENS_DISABLE_LSP_INSTALL: "1",
			PI_LENS_DISABLE_TOOL_INSTALL: "1",
		},
	});
	try {
		await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "matrix-4403", version: "0" },
		});
		harness.notify("notifications/initialized");
		const response = await harness.request(
			2,
			"tools/call",
			{
				name: "pilens_diagnostics",
				arguments: {
					source: "lsp",
					path: probe,
					serverScope: "all",
					waitMs: 3000,
				},
			},
			scaledTestTimeout(60_000),
		);
		const result = response.result as { content: Array<{ text: string }> };
		const text = result.content[0]?.text ?? "";
		return {
			started: [...new Set(markerLines(fx.marker).slice(from))].sort(),
			verdict: fileModeVerdict(text),
			lines: shownLines(text, fx.workspace).slice(0, 2),
		};
	} finally {
		harness.dispose();
	}
}
