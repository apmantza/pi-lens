/**
 * #5151: a PowerShell file saved as UTF-8 with a BOM must not put the decoded
 * U+FEFF on the wire as document text.
 *
 * Recurrence this file prevents: pi-lens reads every file with
 * `readFile(path, "utf8")`, which keeps a leading U+FEFF, and
 * `clients/lsp/client.ts` forwarded that string verbatim in didOpen, didChange
 * and didSave. PowerShell Editor Services parses the in-memory text, sees the
 * U+FEFF as a token, and reports syntax errors that `Parser.ParseFile` (which
 * consumes the BOM as an encoding marker) never reports for the same file.
 *
 * Production chain: the REAL `handleNotifyOpen` / `handleNotifyChange` (the
 * one boundary every open, change, save and resync passes through) against a
 * mock `MessageConnection`, the process boundary. The bytes over a real stdio
 * stream are `powershell-bom-wire-5151.integration.test.ts`.
 *
 * The wire text replaces the BOM with ONE space, not a deletion: every
 * UTF-16 offset in the document stays where the disk-decoded text has it, and
 * `clients/lsp/edits.ts` applies server positions to that disk-decoded text.
 * The content fingerprint stays on the raw bytes (read-transform symmetry,
 * `clients/lsp/diagnostic-binding.ts`).
 */

import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	handleNotifyChange,
	handleNotifyOpen,
	setupIncomingHandlers,
	type LSPClientState,
} from "../../../clients/lsp/client.js";
import { hashDiagnosticContent } from "../../../clients/lsp/diagnostic-binding.js";
import { TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL } from "../../../clients/lsp/sync-kind.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { createMockState } from "./mock-client-state.js";

const BOM = "﻿";
// CRLF, non-ASCII (BMP and astral) and an INTERIOR U+FEFF: only the first
// character is a byte-order mark; the rest is the user's text.
const BODY =
	'Write-Host "héllo ✓ 日本 😀"\r\nfunction Get-Thing {\r\n  "a﻿b"\r\n}\r\n';
const SECOND_BODY = `${BODY}Get-Thing\r\n`;
const FILE = "/project/script.ps1";
const KEY = normalizeMapKey(FILE);

interface SentParams {
	textDocument: { text: string };
	contentChanges: Array<{
		text: string;
		range: { end: { line: number; character: number } };
	}>;
	text: string;
}

function sent(state: LSPClientState, method: string) {
	return vi
		.mocked(state.connection.sendNotification)
		.mock.calls.filter((call) => call[0] === method)
		.map((call) => call[1] as SentParams);
}

function psState(overrides?: Partial<LSPClientState>): LSPClientState {
	return createMockState({ serverId: "powershell", ...overrides });
}

describe("#5151 the document text a PowerShell server is sent", () => {
	it("didOpen replaces a leading BOM with one space and keeps every other character", async () => {
		const state = psState();
		await handleNotifyOpen(state, FILE, BOM + BODY, "powershell");

		const [open] = sent(state, "textDocument/didOpen");
		expect(open.textDocument.text).toBe(` ${BODY}`);
		// Same UTF-16 length: no offset after the first character moves.
		expect(open.textDocument.text.length).toBe((BOM + BODY).length);
		// The interior U+FEFF is the user's text and survives.
		expect(open.textDocument.text).toContain("a﻿b");
	});

	it("sends text with no leading BOM unchanged", async () => {
		const state = psState();
		await handleNotifyOpen(state, FILE, BODY, "powershell");
		expect(sent(state, "textDocument/didOpen")[0].textDocument.text).toBe(BODY);
	});

	it("leaves a U+FEFF that is not the first character alone", async () => {
		const state = psState();
		await handleNotifyOpen(state, FILE, ` ${BOM}${BODY}`, "powershell");
		expect(sent(state, "textDocument/didOpen")[0].textDocument.text).toBe(
			` ${BOM}${BODY}`,
		);
	});

	it("didChange on an open document carries the same replacement (Full sync)", async () => {
		const state = psState();
		await handleNotifyOpen(state, FILE, BOM + BODY, "powershell");
		await handleNotifyChange(state, FILE, BOM + SECOND_BODY);

		const [change] = sent(state, "textDocument/didChange");
		expect(change.contentChanges).toEqual([{ text: ` ${SECOND_BODY}` }]);
	});

	it("a change that reaches a never-opened document takes the didOpen fallback with the replacement", async () => {
		const state = psState();
		await handleNotifyChange(state, FILE, BOM + BODY);

		const [open] = sent(state, "textDocument/didOpen");
		expect(open.textDocument.text).toBe(` ${BODY}`);
	});

	it("Incremental sync retains the wire text as the basis of the next ranged change", async () => {
		const state = psState({ syncKind: TEXT_DOCUMENT_SYNC_KIND_INCREMENTAL });
		await handleNotifyOpen(state, FILE, BOM + BODY, "powershell");
		expect(state.documentContentHashes.get(KEY)?.text).toBe(` ${BODY}`);

		await handleNotifyChange(state, FILE, BOM + SECOND_BODY);
		const [change] = sent(state, "textDocument/didChange");
		expect(change.contentChanges[0].text).toBe(` ${SECOND_BODY}`);
		// The range spans the document the server holds: BODY's last line is the
		// empty line after the final CRLF, so the end is (4, 0).
		expect(change.contentChanges[0].range.end).toEqual({
			line: 4,
			character: 0,
		});
		expect(state.documentContentHashes.get(KEY)?.text).toBe(` ${SECOND_BODY}`);
	});

	it("didSave text carries the replacement too", async () => {
		const state = psState();
		state.saveOptions = { includeText: true };
		await handleNotifyOpen(
			state,
			FILE,
			BOM + BODY,
			"powershell",
			false,
			false,
			true,
		);
		const [save] = sent(state, "textDocument/didSave");
		expect(save.text).toBe(` ${BODY}`);
	});

	it.each([
		["computed from the content", undefined],
		["supplied by the caller", hashDiagnosticContent(BOM + BODY)],
	])(
		"the content fingerprint stays on the raw bytes (%s)",
		async (_how, hash) => {
			const state = psState();
			await handleNotifyOpen(
				state,
				FILE,
				BOM + BODY,
				"powershell",
				false,
				false,
				false,
				undefined,
				hash,
			);
			// `boundToCurrentDisk` re-hashes the disk read (BOM included); a hash of
			// the wire text would make every BOM file read as changed on disk.
			expect(state.documentContentHashes.get(KEY)?.hash).toBe(
				hashDiagnosticContent(BOM + BODY),
			);
			expect(hashDiagnosticContent(BOM + BODY)).not.toBe(
				hashDiagnosticContent(` ${BODY}`),
			);
		},
	);

	it("a server of another language still receives the text it was given", async () => {
		// Recurrence: stripping or blanking the BOM for every server would shift
		// line-0 offsets in `clients/lsp/edits.ts` (which applies server positions
		// to the disk-decoded text) and turn a leading space into an
		// IndentationError for a Python document. The fix is PowerShell-only.
		const state = createMockState({ serverId: "python" });
		await handleNotifyOpen(state, "/project/a.py", `${BOM}x = 1\n`, "python");
		expect(sent(state, "textDocument/didOpen")[0].textDocument.text).toBe(
			`${BOM}x = 1\n`,
		);
	});

	it("a genuine syntax error is still in the text and still reported", async () => {
		// Recurrence: the fix must not filter. The broken `if ($x {` stays at the
		// same offset on the wire, and the server's diagnostic for it reaches the
		// caller unchanged.
		const broken = `${BOM}if ($x {\r\n`;
		const state = psState();
		let publish: ((params: unknown) => void) | undefined;
		(
			state.connection.onNotification as unknown as ReturnType<typeof vi.fn>
		).mockImplementation((method: string, cb: (params: unknown) => void) => {
			if (method === "textDocument/publishDiagnostics") publish = cb;
		});
		setupIncomingHandlers(state, undefined);
		await handleNotifyOpen(state, FILE, broken, "powershell");
		const wire = sent(state, "textDocument/didOpen")[0].textDocument.text;
		expect(wire).toBe(" if ($x {\r\n");
		expect(wire.indexOf("if ($x {")).toBe(broken.indexOf("if ($x {"));

		vi.useFakeTimers();
		try {
			publish?.({
				uri: pathToFileURL(FILE).href,
				diagnostics: [
					{
						severity: 1,
						message:
							"Missing closing '}' in statement block or type definition.",
						range: {
							start: { line: 0, character: 8 },
							end: { line: 0, character: 9 },
						},
					},
				],
			});
			vi.advanceTimersByTime(500);
		} finally {
			vi.useRealTimers();
		}
		const [diagnostic] = state.pushDiagnostics.get(KEY) ?? [];
		expect(diagnostic?.message).toContain("Missing closing '}'");
		expect(diagnostic?.range.start).toEqual({ line: 0, character: 8 });
	});
});
