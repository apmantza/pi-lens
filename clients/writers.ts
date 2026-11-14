/**
 * #5551: the writer census. Every route that changes a file pi-lens authored
 * or observed a tool author, against every consumer that should learn of it.
 *
 * This is the authored half of the disk-change census. Changes that arrive from
 * outside (a HEAD move, an external editor, the settled sweep) are #4535's
 * table, `clients/disk-change-consumers.ts`; the consumer ids both tables share
 * name one consumer, so a column here that is also a row there is the same
 * code. Each fix before this table covered one route (#4732, #5239, #5248,
 * #5120, #5160, #5378, #5405, #5417), and the next gap was found by a user.
 * `tests/clients/writers-census-5551.test.ts` holds this table to the code:
 *
 * - every route answers every consumer, and every cell that is not `reaches`
 *   gives a reason;
 * - a shared consumer id names a row of the #4535 table, and an authored-only
 *   id names none;
 * - each route's anchor symbol still exists in the file it names;
 * - the routes not yet recorded through `recordMutationOutcome` and the
 *   unprobed cells are pinned counts, so a fold or a probe that lands is a
 *   deliberate edit;
 * - every production file that writes user source names a route here, and a
 *   new file-writing site with no registry row fails (the census).
 *
 * Evidence: each `reaches` or `silent` cell names the probe that observed it.
 * A bare probe id is the writer-route audit's (2026-11-13, master 29a35b8d4,
 * a real pi 1.5.2 over RPC); a bracketed name is a merged witness test. An
 * `unprobed` cell is a reading-only claim and names what would settle it.
 *
 * Declarative only: nothing at runtime reads this table. Pre-write guards (the
 * root ceiling, pi's mutation queue, the abort re-check, another extension's
 * `tool_call` guard) stay with each writer, which owns the instant before its
 * first byte, so they have no column.
 */

/**
 * Consumers a disk change also reaches, by their id in
 * `DISK_CHANGE_CONSUMERS`. The census test checks each one names a row there.
 */
export const SHARED_WRITER_CONSUMERS = [
	"lsp-documents",
	"read-guard",
	"word-index",
] as const;

/**
 * Consumers only an authored write reaches. None is a row of the #4535 table.
 * `dispatch`: the write's file is dispatched (`dispatch_start`). `inline-stop`:
 * a blocker reaches the writer's own tool result. `change-log`: a change-log
 * row, with its source label. `commit-gate`: `--lens-guard` refuses a commit of
 * a blocker the write added. `pre-edit-baseline`: the commit gate judges the
 * write's delta, not the whole file (#5553). `fix-run-capture`:
 * `noteAgentMutation` protects the write from a running whole-package fixer
 * (#3598).
 */
export const AUTHORED_WRITER_CONSUMERS = [
	"dispatch",
	"inline-stop",
	"change-log",
	"commit-gate",
	"pre-edit-baseline",
	"fix-run-capture",
] as const;

export const WRITER_CONSUMERS = [
	...AUTHORED_WRITER_CONSUMERS,
	...SHARED_WRITER_CONSUMERS,
] as const;
export type WriterConsumer = (typeof WRITER_CONSUMERS)[number];

/** What a probe saw for one route and one consumer. */
export type WriterCell =
	| { cell: "reaches"; probe: string }
	| { cell: "silent"; probe: string; why: string }
	| { cell: "n/a"; why: string }
	| { cell: "unprobed"; settle: string };

/**
 * Where a route's post-write record runs. `recordMutationOutcome`
 * (`clients/mutation-bridge.ts`) is the one body; the others are the
 * hand-copied recorders still to fold onto it (the direct LSP branch folded
 * in #5551).
 */
export type WriterRecorder =
	| "recordMutationOutcome"
	| "tool-result"
	| "agent-end-drain"
	| "none";

/**
 * How a `tool_result` learns which files this call wrote (shape 88).
 * `builtin-name`: pi's own `write`/`edit`. `command-parse`: the bash command
 * names them. `disk-recovery`: the opaque net's git and content recovery.
 * `observed-window`: the observation net's disk diff over the call's window,
 * and tier 4's learned name after it. `own-details`: a pi-lens tool reports
 * them in `details.appliedFiles`, admitted by NAME (`APPLIED_FILES_TOOLS`).
 * `none`: no tool result names them (a drain, a server-initiated edit).
 * `unread`: the audit observed the dispatch; the code path is not traced.
 */
export type WriterAttribution =
	| "builtin-name"
	| "command-parse"
	| "disk-recovery"
	| "observed-window"
	| "own-details"
	| "none"
	| "unread";

export interface WriterRoute {
	id: string;
	/** The file, and a symbol in it, where the route writes or records. */
	anchor: { file: string; symbol: string };
	/** Shape 64: what the call names, against what it writes. */
	names: string;
	writes: string;
	/** Shape 65: the authorship range the route's record can state truthfully. */
	authorship: "range" | "whole-file" | "unknown" | "none";
	attribution: WriterAttribution;
	recorders: readonly WriterRecorder[];
	cells: Record<WriterConsumer, WriterCell>;
}

const reaches = (probe: string): WriterCell => ({ cell: "reaches", probe });
const silent = (probe: string, why: string): WriterCell => ({
	cell: "silent",
	probe,
	why,
});
const na = (why: string): WriterCell => ({ cell: "n/a", why });
const unprobed = (settle: string): WriterCell => ({ cell: "unprobed", settle });

const NOT_SEEDED =
	"settle: a writer-baseline probe (#5553's witness) for this route";
const FIX_RUN_UNPROBED =
	"settle: a whole-package fixer run (beginFixRun) covering the file while this route writes it";
const WORD_INDEX_UNPROBED =
	"settle: the audit's symbol_search probe came back empty even after a host write, so it cannot tell routes apart; assert the baseline first";
const G4_NO_INLINE =
	"a tool-owned write returns no STOP; the first one the agent sees is the commit gate (G4, next-turn delivery unprobed)";
const UNAUTHORED =
	"by design: unauthored bytes create no authorship (#4131), and blockers are withheld for them (#3226)";
const G2_GATE =
	"the gate judges authorship, not the staged delta, so unauthored bytes commit (G2, an owner decision)";
const G6_PROBE =
	"[skips noteAgentMutation for a direct LSP edit and reaches it through the bridge]";
const G6_SKIP =
	"the direct LSP branch passes recordMutationOutcome a no-op noteAgentMutation, as it never called it before #5551 (G6); reaching it needs the maintainer's buy-in";

/** The cells every route leaves unprobed today, for the consumers no probe read. */
function unread(settle: string): Record<WriterConsumer, WriterCell> {
	return Object.fromEntries(
		WRITER_CONSUMERS.map((consumer) => [consumer, unprobed(settle)]),
	) as Record<WriterConsumer, WriterCell>;
}

export const WRITERS: readonly WriterRoute[] = [
	{
		id: "host-write",
		anchor: {
			file: "clients/runtime-tool-result.ts",
			symbol: "handleToolResult",
		},
		names: "one path",
		writes: "the named path",
		authorship: "whole-file",
		attribution: "builtin-name",
		recorders: ["tool-result"],
		cells: {
			dispatch: reaches("write"),
			"inline-stop": reaches("write"),
			"change-log": reaches("write: agent-write"),
			"commit-gate": reaches("write"),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("write: didChange"),
			"read-guard": reaches("write: written=[a.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "host-edit",
		anchor: {
			file: "clients/runtime-tool-result.ts",
			symbol: "handleToolResult",
		},
		names: "one path",
		writes: "the named path",
		authorship: "range",
		attribution: "builtin-name",
		recorders: ["tool-result"],
		cells: {
			dispatch: reaches("edit"),
			"inline-stop": reaches("edit"),
			"change-log": reaches("edit: agent-edit"),
			"commit-gate": reaches("edit"),
			"pre-edit-baseline": reaches(
				"[control: a host edit of an unrelated line commits]",
			),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("edit: didChange"),
			"read-guard": na(
				"an edit needs a read first, so the file is already covered and gains no authorship",
			),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "host-edit-partial",
		anchor: {
			file: "clients/runtime-tool-result.ts",
			symbol: "recordProjectChange",
		},
		names: "one path",
		writes: "the applied spans of the named path",
		authorship: "range",
		attribution: "builtin-name",
		recorders: ["tool-result"],
		cells: {
			dispatch: reaches("partial-edit"),
			"inline-stop": reaches("partial-edit: PARTIAL APPLY"),
			"change-log": reaches("partial-edit: partial-apply"),
			"commit-gate": reaches("partial-edit"),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("partial-edit: didChange"),
			"read-guard": na(
				"an edit needs a read first; the partial apply logs edit_partial_apply and credits no new authorship",
			),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "codemode-nested",
		anchor: {
			file: "clients/tool-event.ts",
			symbol: "resolveReadEvidenceCorrelationId",
		},
		names: "the nested call's path or command",
		writes: "what the nested write or bash writes",
		authorship: "whole-file",
		attribution: "builtin-name",
		recorders: ["tool-result"],
		cells: {
			dispatch: reaches("codemode-write"),
			"inline-stop": reaches("codemode-write"),
			"change-log": reaches("codemode-write: agent-write"),
			"commit-gate": reaches("codemode-bash"),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("codemode-write: didChange"),
			"read-guard": reaches("codemode-write: written=[a.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "bash-recognised",
		anchor: {
			file: "clients/bash-file-access.ts",
			symbol: "extractWrittenPathsFromCommand",
		},
		names: "the command",
		writes: "the paths the command parser recognises",
		authorship: "whole-file",
		attribution: "command-parse",
		recorders: ["tool-result"],
		cells: {
			dispatch: reaches("bash-redirect, bash-sed, bash-git-checkout-path"),
			"inline-stop": reaches("bash-sed: STOP in the bash result"),
			"change-log": reaches("bash-redirect: agent-write"),
			"commit-gate": reaches("bash-sed"),
			"pre-edit-baseline": reaches(
				"[commits an unrelated change to a file whose blocker is already in HEAD] (sed -i)",
			),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("bash-sed: didChange and watched-files"),
			"read-guard": reaches("bash-redirect: written=[a.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "bash-mtime-preserving",
		anchor: {
			file: "clients/opaque-mutation-scan.ts",
			symbol: "recoverOpaqueChangesViaGit",
		},
		names: "the command",
		writes: "the named destination, with its old mtime kept (mv, cp -p)",
		authorship: "whole-file",
		attribution: "disk-recovery",
		recorders: ["tool-result"],
		cells: {
			dispatch: reaches(
				"[recovers a recognized mv overwrite when the destination keeps an old mtime (#5552)]",
			),
			"inline-stop": reaches(
				"[recovers a recognized mv overwrite when the destination keeps an old mtime (#5552)]",
			),
			"change-log": unprobed(
				"settle: read the change log after #5552's mv witness; the audit's SILENT predates #5581",
			),
			"commit-gate": unprobed(
				"settle: a commit after #5552's mv witness; the audit's allowed(committed) predates #5581",
			),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": unprobed(
				"settle: the wire trace after #5552's mv witness; the audit's SILENT predates #5581",
			),
			"read-guard": unprobed(
				"settle: the authorship sidecar after #5552's mv witness; the audit's written=[] predates #5581",
			),
			"word-index": unprobed(
				"settle: the audit saw the moved source still indexed (idx-bash-mv) before #5581; re-run after it",
			),
		},
	},
	{
		id: "bash-opaque",
		anchor: {
			file: "clients/opaque-mutation-scan.ts",
			symbol: "recoverOpaqueChangesViaGit",
		},
		names: "a command that names no path (node -e)",
		writes: "whatever the script writes",
		authorship: "none",
		attribution: "disk-recovery",
		recorders: ["tool-result"],
		cells: {
			dispatch: reaches("bash-opaque"),
			"inline-stop": silent("bash-opaque", UNAUTHORED),
			"change-log": reaches("bash-opaque: opaque-script"),
			"commit-gate": silent("bash-opaque", G2_GATE),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("bash-opaque: didChange and external resync"),
			"read-guard": silent("bash-opaque: written=[]", UNAUTHORED),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "foreign-path-less",
		anchor: {
			file: "clients/opaque-mutation-scan.ts",
			symbol: "recoverOpaqueChangesViaGit",
		},
		names: "no path",
		writes: "whatever the tool writes",
		authorship: "none",
		attribution: "disk-recovery",
		recorders: ["tool-result"],
		cells: {
			dispatch: reaches("foreign-blind"),
			"inline-stop": silent("foreign-blind: result done", UNAUTHORED),
			"change-log": reaches("foreign-blind: opaque-script"),
			"commit-gate": silent("foreign-blind", G2_GATE),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("foreign-blind: didChange"),
			"read-guard": silent("foreign-blind: written=[]", UNAUTHORED),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "foreign-named",
		anchor: {
			file: "clients/observed-mutation.ts",
			symbol: "settleObservedMutation",
		},
		names: "one path",
		writes: "any file in the call's window (the net diffs the disk)",
		authorship: "range",
		attribution: "observed-window",
		recorders: ["recordMutationOutcome"],
		cells: {
			dispatch: reaches("foreign-tool"),
			"inline-stop": silent("foreign-tool: result wrote <path>", G4_NO_INLINE),
			"change-log": reaches("foreign-tool: agent-tool:foreign_write"),
			"commit-gate": reaches("foreign-tool"),
			"pre-edit-baseline": reaches(
				"[commits an unrelated change to a file whose blocker is already in HEAD] (a foreign tool's write)",
			),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("foreign-tool: didChange"),
			"read-guard": reaches("foreign-tool: written=[a.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "foreign-bridge",
		anchor: {
			file: "clients/mutation-bridge.ts",
			symbol: "registerMutationBridge",
		},
		names: "the producer's own entry",
		writes: "the files the producer reports",
		authorship: "range",
		attribution: "observed-window",
		recorders: ["recordMutationOutcome"],
		cells: {
			dispatch: reaches("foreign-bridge"),
			"inline-stop": silent(
				"foreign-bridge: result wrote+bridge=true",
				G4_NO_INLINE,
			),
			"change-log": reaches(
				"foreign-bridge: two rows for one write, agent-tool:probe-foreign and agent-tool:foreign_bridge (G5)",
			),
			"commit-gate": reaches("foreign-bridge"),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("foreign-bridge: didChange"),
			"read-guard": reaches("foreign-bridge: written=[a.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "mcp-attached-tool",
		anchor: {
			file: "clients/mutating-tool.ts",
			symbol: "classifyMutatingTool",
		},
		names: "the attached tool's input",
		writes: "whatever the tool writes",
		authorship: "unknown",
		attribution: "observed-window",
		recorders: ["recordMutationOutcome"],
		cells: unread(
			"settle: a probe through clients/mcp; the audit read it as the foreign-tool route",
		),
	},
	{
		id: "ast-grep-apply",
		anchor: {
			file: "clients/ast-grep-client.ts",
			symbol: "recordAstGrepApply",
		},
		names: "a paths array, or the project default",
		writes: "every matched file",
		authorship: "range",
		attribution: "own-details",
		recorders: ["recordMutationOutcome"],
		cells: {
			dispatch: reaches("astgrep-apply"),
			"inline-stop": silent(
				"astgrep-apply: [APPLIED] without STOP",
				G4_NO_INLINE,
			),
			"change-log": reaches("astgrep-apply: agent-tool:ast_grep_replace"),
			"commit-gate": reaches("astgrep-apply"),
			"pre-edit-baseline": reaches(
				"[commits an unrelated change to a file whose blocker is already in HEAD] (ast_grep_replace)",
			),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("astgrep-apply: didChange and watched-files"),
			"read-guard": reaches("astgrep-apply: written=[a.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "lsp-rename",
		anchor: { file: "clients/lsp-mutation.ts", symbol: "recordLspMutation" },
		names: "one path",
		writes: "the file and every importer the server edits",
		authorship: "range",
		attribution: "own-details",
		recorders: ["recordMutationOutcome"],
		cells: {
			dispatch: reaches("lsp-rename-apply: both files"),
			"inline-stop": silent("lsp-rename-apply", G4_NO_INLINE),
			"change-log": reaches("lsp-rename-apply: lsp-rename x2"),
			"commit-gate": reaches("lsp-rename-apply: 11 issues"),
			"pre-edit-baseline": reaches(
				"[commits an unrelated change to a file whose blocker is already in HEAD] (an LSP rename)",
			),
			"fix-run-capture": silent(G6_PROBE, G6_SKIP),
			"lsp-documents": reaches("lsp-rename-apply: didChange on both"),
			"read-guard": reaches("lsp-rename-apply: written=[a.ts,b.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "lsp-rename-file",
		anchor: { file: "clients/lsp-mutation.ts", symbol: "recordLspMutation" },
		names: "one path and its new name",
		writes: "the renamed file and every importer the server edits",
		authorship: "unknown",
		attribution: "own-details",
		recorders: ["recordMutationOutcome"],
		cells: {
			dispatch: reaches("lsp-rename-file: c.ts"),
			"inline-stop": silent("lsp-rename-file", G4_NO_INLINE),
			"change-log": reaches("lsp-rename-file: row present"),
			"commit-gate": reaches("lsp-rename-file"),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": silent(G6_PROBE, G6_SKIP),
			"lsp-documents": reaches(
				"lsp-rename-file: didClose, didOpen and watched-files",
			),
			"read-guard": reaches("lsp-rename-file: written=[c.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "lsp-execute-command",
		anchor: { file: "clients/lsp-mutation.ts", symbol: "recordLspMutation" },
		names: "one path",
		writes: "any file the server edits inside the command's window",
		authorship: "range",
		attribution: "own-details",
		recorders: ["recordMutationOutcome"],
		cells: {
			dispatch: reaches("lsp-executecommand"),
			"inline-stop": silent("lsp-executecommand", G4_NO_INLINE),
			"change-log": reaches("lsp-executecommand: lsp-execute-command"),
			"commit-gate": reaches("lsp-executecommand"),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": silent(G6_PROBE, G6_SKIP),
			"lsp-documents": reaches("lsp-executecommand: didChange"),
			"read-guard": reaches("lsp-executecommand: written=[a.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "lsp-server-apply-edit",
		anchor: { file: "clients/lsp/client.ts", symbol: "telemetryContext" },
		names: "nothing: the server initiates it",
		writes: "any file the server edits",
		authorship: "range",
		attribution: "none",
		recorders: ["recordMutationOutcome"],
		cells: {
			...unread(
				"settle: release a deferred applyEdit after executeCommand times out (G9, lsp-exec-deferred)",
			),
			"fix-run-capture": reaches(G6_PROBE),
		},
	},
	{
		id: "lens-diagnostic-mark",
		anchor: {
			file: "tools/lens-diagnostic-mark.ts",
			symbol: "createLensDiagnosticMarkTool",
		},
		names: "one path",
		writes: "the named path",
		authorship: "range",
		attribution: "unread",
		recorders: ["recordMutationOutcome"],
		cells: {
			dispatch: reaches("mark-suppress: dispatch_start x2"),
			"inline-stop": reaches("mark-suppress"),
			"change-log": reaches("mark-suppress: agent-tool:lens_diagnostic_mark"),
			"commit-gate": reaches("mark-suppress"),
			"pre-edit-baseline": unprobed(NOT_SEEDED),
			"fix-run-capture": unprobed(FIX_RUN_UNPROBED),
			"lsp-documents": reaches("mark-suppress: didChange"),
			"read-guard": reaches("mark-suppress: written=[a.ts]"),
			"word-index": unprobed(WORD_INDEX_UNPROBED),
		},
	},
	{
		id: "runner-format-autofix",
		anchor: {
			file: "clients/runtime-agent-end.ts",
			symbol: "retireChangedAuthorshipBeforeDrain",
		},
		names: "the file the write dispatched",
		writes: "the formatted or fixed file",
		authorship: "whole-file",
		attribution: "none",
		recorders: ["tool-result", "agent-end-drain"],
		cells: {
			...unread(
				"settle: an agent_end hold on a blocker-free file (py-format-autofix was inconclusive)",
			),
			"inline-stop": na(
				"a format or autofix pass has no tool result of its own",
			),
			"pre-edit-baseline": na(
				"the pass rewrites a file the agent's write already seeded",
			),
		},
	},
	{
		id: "agent-end-lsp-quickfix",
		anchor: {
			file: "clients/runtime-agent-end.ts",
			symbol: "applyConservativeActionableWarningFixes",
		},
		names: "nothing: the drain picks the files",
		writes: "the files an allowlisted quickfix edits",
		authorship: "whole-file",
		attribution: "none",
		recorders: ["recordMutationOutcome"],
		cells: {
			...unread(
				"settle: an agent_end drain probe with an allowlisted quickfix",
			),
			"inline-stop": na("the drain runs at agent_end and has no tool result"),
			"pre-edit-baseline": na(
				"the drain runs after the turn's writes, with no call to seed",
			),
			"fix-run-capture": silent(G6_PROBE, G6_SKIP),
		},
	},
	{
		id: "fix-run-restore",
		anchor: { file: "clients/fix-run-restore.ts", symbol: "runWithFixRestore" },
		names: "nothing: the run restores captured agent bytes",
		writes: "files a whole-package fixer overwrote over an agent edit",
		authorship: "none",
		attribution: "none",
		recorders: ["none"],
		cells: {
			...unread(
				"settle: a cargo clippy --fix run over a file an agent edit changed",
			),
			"inline-stop": na(
				"the restore runs inside the fixer's dispatch, not a tool call",
			),
			"pre-edit-baseline": na(
				"the restore puts back bytes the agent's write already seeded",
			),
			"fix-run-capture": na("the restore is the capture's own consumer"),
		},
	},
	{
		id: "runner-whole-package-fix",
		anchor: { file: "clients/pipeline.ts", symbol: "runWithFixRestore" },
		names: "the dispatched file's package",
		writes: "every file the fixer rewrites in the package",
		authorship: "none",
		attribution: "none",
		recorders: ["none"],
		cells: {
			...unread("settle: #5310's census of write-capable runners"),
			"fix-run-capture": na(
				"the fixer is the run the capture protects agent bytes from",
			),
		},
	},
	{
		id: "tsbuildinfo-cleanup",
		anchor: { file: "index.ts", symbol: "cleanStaleTsBuildInfo" },
		names: "nothing: session start picks the files",
		writes: "deletes a stale .tsbuildinfo in the project root",
		authorship: "none",
		attribution: "none",
		recorders: ["none"],
		cells: {
			...unread(
				"settle: the census found this route (#5551); by reading it records nothing, so probe a session start over a stale .tsbuildinfo",
			),
			"inline-stop": na(
				"the cleanup runs at session start and has no tool result",
			),
			"pre-edit-baseline": na(
				"a deleted build-info file has no delta to judge",
			),
			"fix-run-capture": na(
				"the cleanup is not an agent edit a fixer could overwrite",
			),
		},
	},
];
