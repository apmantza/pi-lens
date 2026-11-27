/**
 * #3405: every capability `CLIENT_CAPABILITIES` advertises has a sender, or a
 * named admission saying why it has none.
 *
 * Recurrence this file prevents, exactly: `synchronization.didSave` was
 * advertised in the `initialize` handshake from #278 until #3405 and NO caller
 * ever emitted `textDocument/didSave`. Nothing could catch it — pi-lens's own
 * suite cannot see the difference, because the cost lands on the SERVER, which
 * changes its behaviour on the strength of the advertisement (Expert stopped
 * compiling on save for a client that claimed to send one). #3405 round 1's
 * review named the gap: the invariant went into AGENTS.md as prose, and
 * `tests/config/agents-governance.test.ts` checks that file's SHAPE, not this
 * population — AGENTS.md defect shape 34's own trap, a rule stated where no
 * check reads it.
 *
 * The population is read from the RUNTIME object, not from source text, so a
 * capability added to `CLIENT_CAPABILITIES` tomorrow is in this test's scope the
 * moment it is added. Every advertised leaf must carry a disposition below; an
 * unknown one fails rather than being skipped, which is what makes "advertise a
 * new capability with no sender" red.
 *
 * Detector policy (docs/engineering-principles.md "Detectors match code, not prose"): the needle IS
 * a string literal — the wire method name — so the scan keeps strings and
 * blanks COMMENTS (`stripSource(..., { strings: "keep" })`). A comment or a
 * doc-block quoting `"textDocument/didSave"` therefore cannot satisfy the
 * requirement; only a literal in code can.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_CAPABILITIES } from "../../clients/lsp/client.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	readWalkedFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const PRODUCTION_ROOTS = ["clients", "tools", "mcp"];

type Disposition =
	/** pi-lens must send this LSP method somewhere in production code. */
	| { kind: "sends"; method: string }
	/** Server-to-client: pi-lens must register a handler for this method. */
	| { kind: "consumes"; method: string }
	/** A modifier ON another capability, not a method of its own. */
	| { kind: "modifier"; of: string }
	/** A grouping object that carries no method of its own. */
	| { kind: "namespace" }
	/** Advertised with no sender ON PURPOSE. The reason is the admission. */
	| { kind: "admitted"; reason: string };

/**
 * One row per advertised leaf of `CLIENT_CAPABILITIES`. The mapping from a
 * capability key to its wire method is the LSP specification's, which no code
 * in this repository can derive — but the POPULATION is derived, so this table
 * can only ever be too small, never silently out of date.
 */
const DISPOSITIONS: Record<string, Disposition> = {
	general: { kind: "namespace" },
	workspace: { kind: "namespace" },
	textDocument: { kind: "namespace" },
	"textDocument.synchronization": { kind: "namespace" },
	"workspace.fileOperations": { kind: "namespace" },
	"workspace.didChangeWatchedFiles": {
		kind: "sends",
		method: "workspace/didChangeWatchedFiles",
	},
	"textDocument.completion.completionItem": {
		kind: "modifier",
		of: "textDocument/completion",
	},
	"textDocument.codeAction.resolveSupport": {
		kind: "modifier",
		of: "codeAction/resolve",
	},
	"textDocument.codeAction.codeActionLiteralSupport": {
		kind: "modifier",
		of: "textDocument/codeAction",
	},
	"textDocument.codeAction.codeActionLiteralSupport.codeActionKind": {
		kind: "modifier",
		of: "textDocument/codeAction",
	},
	"general.positionEncodings": {
		kind: "modifier",
		of: "the negotiated position encoding, read by negotiatePositionEncoding",
	},

	"workspace.workspaceFolders": {
		kind: "sends",
		method: "workspace/workspaceFolders",
	},
	"workspace.configuration": {
		kind: "sends",
		method: "workspace/configuration",
	},
	"workspace.didChangeWatchedFiles.dynamicRegistration": {
		kind: "modifier",
		of: "workspace/didChangeWatchedFiles",
	},
	"workspace.fileOperations.dynamicRegistration": {
		kind: "modifier",
		of: "workspace/willRenameFiles",
	},
	"workspace.fileOperations.willRename": {
		kind: "sends",
		method: "workspace/willRenameFiles",
	},
	"workspace.fileOperations.didRename": {
		kind: "sends",
		method: "workspace/didRenameFiles",
	},
	"workspace.fileOperations.didCreate": {
		kind: "sends",
		method: "workspace/didCreateFiles",
	},

	"textDocument.synchronization.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/didOpen",
	},
	"textDocument.synchronization.didSave": {
		kind: "sends",
		method: "textDocument/didSave",
	},

	"textDocument.completion.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/completion",
	},
	"textDocument.completion.completionItem.snippetSupport": {
		kind: "modifier",
		of: "textDocument/completion",
	},
	"textDocument.completion": {
		kind: "admitted",
		reason:
			"#3405: advertised with no sender, deliberately. `completion` is a " +
			"REQUEST — no server changes its own behaviour because a client COULD " +
			"ask, which is what made the didSave omission a defect — and pi-lens is " +
			"not an editor, so it never wants completions. It stays advertised for " +
			"#278's reason: the textDocument set is complete because servers built " +
			"on OmniSharp.Extensions.LanguageServer dereference an absent " +
			"sub-capability while handling `initialize` and hang the handshake.",
	},

	"textDocument.hover.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/hover",
	},
	"textDocument.hover": { kind: "sends", method: "textDocument/hover" },
	"textDocument.signatureHelp.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/signatureHelp",
	},
	"textDocument.signatureHelp": {
		kind: "sends",
		method: "textDocument/signatureHelp",
	},
	"textDocument.definition.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/definition",
	},
	"textDocument.definition": {
		kind: "sends",
		method: "textDocument/definition",
	},
	"textDocument.typeDefinition.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/typeDefinition",
	},
	"textDocument.typeDefinition": {
		kind: "sends",
		method: "textDocument/typeDefinition",
	},
	"textDocument.implementation.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/implementation",
	},
	"textDocument.implementation": {
		kind: "sends",
		method: "textDocument/implementation",
	},
	"textDocument.references.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/references",
	},
	"textDocument.references": {
		kind: "sends",
		method: "textDocument/references",
	},
	"textDocument.documentSymbol.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/documentSymbol",
	},
	// #5476: this changes the response shape of the existing request.
	"textDocument.documentSymbol.hierarchicalDocumentSymbolSupport": {
		kind: "modifier",
		of: "textDocument/documentSymbol",
	},
	"textDocument.documentSymbol": {
		kind: "sends",
		method: "textDocument/documentSymbol",
	},
	"textDocument.codeAction.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/codeAction",
	},
	"textDocument.codeAction.dataSupport": {
		kind: "modifier",
		of: "codeAction/resolve",
	},
	"textDocument.codeAction.resolveSupport.properties": {
		kind: "modifier",
		of: "codeAction/resolve",
	},
	"textDocument.codeAction.codeActionLiteralSupport.codeActionKind.valueSet": {
		kind: "modifier",
		of: "textDocument/codeAction",
	},
	"textDocument.codeAction": {
		kind: "sends",
		method: "textDocument/codeAction",
	},
	"textDocument.rename.dynamicRegistration": {
		kind: "modifier",
		of: "textDocument/rename",
	},
	"textDocument.rename": { kind: "sends", method: "textDocument/rename" },
	"textDocument.publishDiagnostics.relatedInformation": {
		kind: "modifier",
		of: "textDocument/publishDiagnostics",
	},
	"textDocument.publishDiagnostics.versionSupport": {
		kind: "modifier",
		of: "textDocument/publishDiagnostics",
	},
	"textDocument.publishDiagnostics": {
		kind: "consumes",
		method: "textDocument/publishDiagnostics",
	},
	// #5487: the readiness notice rust-analyzer sends only to a client that asks.
	experimental: { kind: "namespace" },
	"experimental.serverStatusNotification": {
		kind: "consumes",
		method: "experimental/serverStatus",
	},
};

/**
 * Every path `initialize` actually advertises.
 *
 * `true` and a non-empty array advertise. `false` does NOT — an explicit
 * refusal owes no sender, which is `synchronization.willSave`'s live case and
 * the reason the sweep does not demand a `textDocument/willSave` writer. An
 * OBJECT advertises as soon as it has one key, even when every key inside it is
 * `false`: per LSP the PRESENCE of the capability object is the signal a server
 * reads, and its fields only modify it — `completion: { dynamicRegistration:
 * false, completionItem: { snippetSupport: false } }` tells a server this client
 * does completion, which is exactly the kind of claim this file exists to make
 * someone answer for. An empty object (`window: {}`) advertises nothing.
 */
function advertisedPaths(value: unknown, prefix = ""): string[] {
	if (value === false) return [];
	if (value === true) return prefix ? [prefix] : [];
	if (Array.isArray(value)) return value.length > 0 && prefix ? [prefix] : [];
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		const children = entries.flatMap(([key, child]) =>
			advertisedPaths(child, prefix ? `${prefix}.${key}` : key),
		);
		if (entries.length === 0) return [];
		return prefix ? [...children, prefix] : children;
	}
	return [];
}

function productionCode(): Map<string, string> {
	const files = PRODUCTION_ROOTS.flatMap((root) =>
		listSourceFiles(path.join(REPO_ROOT, root), { skipTests: true }),
	);
	const stripped = new Map<string, string>();
	for (const { file, source } of readWalkedFiles(files)) {
		// Strings KEPT (the needle is a string literal), comments BLANKED — so a
		// doc comment naming a method can never stand in for a sender.
		stripped.set(
			relativePosix(REPO_ROOT, file),
			stripSource(source, { strings: "keep" }),
		);
	}
	return stripped;
}

describe("advertised LSP client capabilities have senders (#3405)", () => {
	const paths = advertisedPaths(CLIENT_CAPABILITIES);
	const code = productionCode();

	it(
		"scans a non-empty population on both axes",
		() => {
			// The declared floor every sweep owes (sweep-kit's own idiom, which
			// `tests/config/sweep-floor-coverage.test.ts` is the meta-sweep for): an
			// empty walk on either axis would make every assertion below vacuously
			// true. Calibration MEASURED on 2026-09-25 by this test's own walk: 33
			// advertised capability paths, 482 production source files. The floors are
			// half of each, rounded down — recalibrate by reading a re-run's numbers,
			// never by copying a figure out of this comment.
			assertNonEmptyScan("advertised capability paths", paths.length, 16);
			assertNonEmptyScan("production source files", code.size, 240);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("gives every advertised capability a disposition", () => {
		const undisposed = paths.filter((p) => !DISPOSITIONS[p]);
		expect(
			undisposed,
			`CLIENT_CAPABILITIES advertises ${undisposed.join(", ")} with no entry in ` +
				`DISPOSITIONS. A capability the client advertises has a sender, or the ` +
				`advertisement states why it has none (AGENTS.md, LSP invariants): add ` +
				`the wire method it implies, or an { kind: "admitted", reason } row.`,
		).toEqual([]);
	});

	it(
		"finds a real sender or handler for every method a capability implies",
		() => {
			const missing: string[] = [];
			for (const capabilityPath of paths) {
				const disposition = DISPOSITIONS[capabilityPath];
				if (disposition?.kind !== "sends" && disposition?.kind !== "consumes") {
					continue;
				}
				const needle = `"${disposition.method}"`;
				const found = [...code].some(([, source]) => source.includes(needle));
				if (!found) missing.push(`${capabilityPath} -> ${disposition.method}`);
			}
			expect(
				missing,
				`advertised with no sender in clients/, tools/ or mcp/: ${missing.join(", ")}`,
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("keeps the admitted-without-sender set to the one reasoned member", () => {
		// An admission is a claim the reviewer reads, so the SET is pinned, not
		// just its members' reasons: a second silent admission has to be argued.
		const admitted = paths.filter((p) => DISPOSITIONS[p]?.kind === "admitted");
		expect(admitted).toEqual(["textDocument.completion"]);
		for (const member of admitted) {
			const row = DISPOSITIONS[member];
			expect(row.kind === "admitted" && row.reason.length).toBeGreaterThan(80);
		}
	});

	it("refuses a sender that exists only in a comment", () => {
		// The detector's dangerous direction, pinned directly: prose must never
		// satisfy the requirement. `textDocument/willSave` is advertised `false`
		// and is named in no production code; a comment quoting it must not
		// change that verdict.
		const withComment = stripSource(
			`// pi-lens sends "textDocument/willSave" here one day\nconst x = 1;\n`,
			{ strings: "keep" },
		);
		expect(withComment.includes(`"textDocument/willSave"`)).toBe(false);
	});
});
