/**
 * #5131: pi-lens's own first-open `workspace/didChangeWatchedFiles` made a
 * recompile-from-disk server (groovy-language-server) publish an EMPTY set a
 * few ms after it published a real error, and the touch read the document
 * clean. The rule: an empty version-less publish that follows the client's
 * own notice for a document, with the notice naming that document alone and
 * the document still at the version it was sent at, does not downgrade a
 * non-empty publish the server already made for that version. The notice
 * itself stays (the server's closed-file view of the path, and the Created an
 * importer's cached miss needs, #4320).
 *
 * Recurrence this file prevents: the live #5123 check, where
 * `pilens_diagnostics` reported `clean=1, findings=0` for a file whose
 * `unable to resolve class Foo` error the server had published 5 ms before.
 *
 * Nothing is doubled below the server registry: the real `LSPService`, the
 * real `createLSPClient`, and `tests/fixtures/fake-lsp-server.mjs` in its
 * `FAKE_LSP_RECOMPILE_CLEARS_MS` shape, a push-only version-less server whose
 * watched-files handler recompiles an open document and publishes `[]`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { removeTempDirSync } from "../test-utils.js";

const { getServersForFileWithConfig } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
}));

const BROKEN = "class A { Foo f }\n";
const FIXED = "class A { }\n";
const CLEAN = "class B { }\n";
const ERROR_CODE = "P5131";

describe("#5131 — the client's own watched-files notice cannot clear a real error", () => {
	let tmp: string;
	let trace: string;
	beforeEach(() => {
		resetDegradationLedger();
		_setServersForFileForTests(getServersForFileWithConfig);
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5131-"));
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "5000";
		trace = path.join(tmp, "trace.log");
		fs.writeFileSync(trace, "");
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		removeTempDirSync(tmp);
	});

	const startService = (
		compileMs: number,
		extraEnv: Record<string, string> = {},
		custom = true,
	): LSPService => {
		const server = {
			id: "groovy-lang-server",
			name: "groovy-lang-server",
			extensions: [".groovy"],
			idleEviction: "resident",
			// A config-declared `lsp.servers` entry carries `custom: true`; the hold
			// is for those servers only (#5131 round 2, F2).
			...(custom ? { custom: true } : {}),
			root: async () => tmp,
			spawn: async () => ({
				process: await spawnFakeLspServer({
					cwd: tmp,
					env: {
						...process.env,
						FAKE_LSP_TRACE_FILE: trace,
						FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
						FAKE_LSP_RECOMPILE_CLEARS_MS: String(compileMs),
						...extraEnv,
					},
				}),
				source: "test",
			}),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".groovy") ? [server] : [],
		);
		return new LSPService();
	};

	const touch = (service: LSPService, name: string, content: string) => {
		const filePath = path.join(tmp, name);
		fs.writeFileSync(filePath, content);
		return service.touchFile(filePath, content, {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "dispatch",
		});
	};

	const traceLines = (): string[] =>
		fs.readFileSync(trace, "utf8").split("\n").filter(Boolean);

	const codes = (result: Awaited<ReturnType<typeof touch>>) =>
		(result?.diags ?? []).map((d) => (d as { code?: unknown }).code);

	const heldRows = () =>
		getDegradationSummary().filter(
			(group) => group.kind === "lsp-watched-echo-held",
		);

	/**
	 * A real client over the wire. The server echoes each watched-files frame it
	 * receives and follows each publish with a marker; both arrive in wire
	 * order, so a join on a marker means the client has already decided what to
	 * do with that publish.
	 */
	const startClient = async (env: Record<string, string>) => {
		const proc = await spawnFakeLspServer({
			cwd: tmp,
			env: {
				...process.env,
				FAKE_LSP_TRACE_FILE: trace,
				FAKE_LSP_NO_DIAGNOSTIC_PROVIDER: "1",
				FAKE_LSP_ECHO_WATCHED_FILES: "1",
				FAKE_LSP_RECOMPILE_MARK_PUBLISHES: "1",
				...env,
			},
		});
		const client = await createLSPClient({
			serverId: "groovy-lang-server",
			process: proc,
			root: tmp,
			custom: true,
		});
		const frames: unknown[] = [];
		const publishes: string[] = [];
		const waiters: Array<() => void> = [];
		const wake = () => {
			for (const waiter of waiters.splice(0)) waiter();
		};
		client.connection.onNotification("$/test/watchedFilesReceived", (p) => {
			frames.push(p);
			wake();
		});
		client.connection.onNotification(
			"$/test/publishSent",
			(p: { uri: string }) => {
				publishes.push(p.uri);
				wake();
			},
		);
		const until = (ready: () => boolean): Promise<void> =>
			new Promise((resolve) => {
				const check = () => (ready() ? resolve() : waiters.push(check));
				check();
			});
		return {
			client,
			until,
			frames,
			publishesFor: (file: string) =>
				publishes.filter((uri) => uri === pathToFileURL(file).href).length,
			publishCount: () => publishes.length,
		};
	};

	it("keeps the error the server publishes before it clears it, and still sends the notice", async () => {
		const service = startService(200);
		try {
			const result = await touch(service, "a.groovy", BROKEN);
			// Pre-fix: `confirmed` with no diagnostics (the live false clean).
			expect(codes(result)).toEqual([ERROR_CODE]);
			// The notice is not what changed: the server still hears it.
			expect(traceLines()).toContain(
				`watched ${pathToFileURL(path.join(tmp, "a.groovy")).href} 1`,
			);
			// Bounded observability: one counted row for the held publish.
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "lsp-watched-echo-held",
				)?.count,
			).toBe(1);
		} finally {
			await service.shutdown();
		}
	}, 30_000);

	it("reads a document the server never reported on as clean", async () => {
		const service = startService(200);
		try {
			// Nothing non-empty came first, so the empty publishes are answers.
			const result = await touch(service, "b.groovy", CLEAN);
			expect({
				confirmation: result?.confirmation,
				diags: result?.diags,
			}).toEqual({ confirmation: "confirmed", diags: [] });
			expect(heldRows()).toEqual([]);
		} finally {
			await service.shutdown();
		}
	}, 30_000);

	it("accepts the empty publish for a later edit that fixes the file", async () => {
		const service = startService(200);
		try {
			expect(codes(await touch(service, "a.groovy", BROKEN))).toEqual([
				ERROR_CODE,
			]);
			// A new send is a new version: the server's clear answers the fix.
			const fixed = await touch(service, "a.groovy", FIXED);
			expect({
				confirmation: fixed?.confirmation,
				diags: fixed?.diags,
			}).toEqual({ confirmation: "confirmed", diags: [] });
		} finally {
			await service.shutdown();
		}
	}, 30_000);

	it("does not attribute the clear to the notice when it names another document too", async () => {
		const service = startService(200);
		try {
			// #4320: an importer's cached miss clears on a sibling's Created in the
			// same batch. The batch carries news besides the document's own bytes,
			// so its clear is the server's answer.
			const [broken] = await Promise.all([
				touch(service, "a.groovy", BROKEN),
				touch(service, "b.groovy", CLEAN),
			]);
			expect(broken?.diags).toEqual([]);
			expect(heldRows()).toEqual([]);
		} finally {
			await service.shutdown();
		}
	}, 30_000);

	it("stops holding once a later notice reached the server", async () => {
		const { client, until, frames, publishesFor } = await startClient({
			FAKE_LSP_RECOMPILE_CLEARS_MS: "900",
		});
		try {
			const first = path.join(tmp, "a.groovy");
			const second = path.join(tmp, "b.groovy");
			fs.writeFileSync(first, BROKEN);
			fs.writeFileSync(second, CLEAN);
			await client.notify.open(first, BROKEN, "groovy");
			await until(() => frames.length >= 1);
			// A second notice (another document's) lands before a.groovy's clear:
			// from then on a clear may be the server's answer to either.
			await client.notify.open(second, CLEAN, "groovy");
			await until(() => frames.length >= 2);
			await until(() => publishesFor(first) >= 2);
			expect(heldRows()).toEqual([]);
		} finally {
			await client.shutdown();
		}
	}, 30_000);

	it("does not judge a server that stamps the version its publishes are about", async () => {
		const service = startService(200, { FAKE_LSP_RECOMPILE_VERSIONED: "1" });
		try {
			// A versioned publish says what it answers; only a version-less one is
			// ambiguous. Nothing here reaches a versioned built-in (typescript).
			const result = await touch(service, "a.groovy", BROKEN);
			expect(result?.diags).toEqual([]);
		} finally {
			await service.shutdown();
		}
	}, 30_000);

	it("stores the empty publish that follows a held one, with no send between", async () => {
		// Recurrence: the hold spends its entry. Without the spend, every later
		// empty for the same send is held too, and the file reads dirty until the
		// next edit (round-1 review F1: "never spend the entry" passed all nine).
		// Sequence: a dirty answer, the notice's echo (held), then an empty with
		// nothing sent or flushed since the held one (stored).
		const { client, until, publishesFor } = await startClient({
			FAKE_LSP_PUBLISH_SEQUENCE: "dirty,empty,empty",
			FAKE_LSP_PUBLISH_SEQUENCE_GAP_MS: "600",
		});
		try {
			const file = path.join(tmp, "a.groovy");
			fs.writeFileSync(file, BROKEN);
			await client.notify.open(file, BROKEN, "groovy");
			await until(() => publishesFor(file) >= 3);
			// The store is debounced: the third receipt's pending store settles this
			// wait. Under the mutation nothing is pending and the stored dirty answer
			// settles it at once, so the expectation below reads the dirty set.
			await client.waitForDiagnostics(file, 3000);
			expect(client.getDiagnostics(file)).toEqual([]);
			expect(
				heldRows().find((group) => group.kind === "lsp-watched-echo-held")
					?.count,
			).toBe(1);
		} finally {
			await client.shutdown();
		}
	}, 30_000);

	it("does not hold a built-in-shaped server's clear, which answers its own notice", async () => {
		// Recurrence: the echo hold is for config-declared (`lsp.servers`) servers
		// only (round-2 review F2). The same recompile-on-notice fake, registered
		// with no `custom` flag, keeps master's behaviour: its clear is the answer.
		const service = startService(200, {}, false);
		try {
			const result = await touch(service, "a.groovy", BROKEN);
			expect({
				confirmation: result?.confirmation,
				diags: result?.diags,
			}).toEqual({ confirmation: "confirmed", diags: [] });
			expect(heldRows()).toEqual([]);
		} finally {
			await service.shutdown();
		}
	}, 30_000);

	it("accepts a clear the server publishes before the notice was sent", async () => {
		// Recurrence: an entry that held every empty after a non-empty one would
		// swallow a server's own early clear, which the notice did not cause.
		const service = startService(-1, {
			FAKE_LSP_PUBLISH_SEQUENCE: "dirty,empty",
			FAKE_LSP_PUBLISH_SEQUENCE_GAP_MS: "10",
		});
		try {
			const result = await touch(service, "a.groovy", BROKEN);
			expect(result?.diags).toEqual([]);
			expect(heldRows()).toEqual([]);
		} finally {
			await service.shutdown();
		}
	}, 30_000);

	it("accepts the clear for a later send that kept the earlier diagnostics", async () => {
		// Recurrence: a preserve-diagnostics resync (formatting) does not clear the
		// path's bookkeeping, so only the sent version tells the new bytes' clear
		// from the notice's echo.
		const { client, until, publishCount } = await startClient({
			FAKE_LSP_RECOMPILE_CLEARS_MS: "100",
			FAKE_LSP_RECOMPILE_NO_WATCHED_CLEAR: "1",
		});
		try {
			const file = path.join(tmp, "a.groovy");
			fs.writeFileSync(file, BROKEN);
			await client.notify.open(file, BROKEN, "groovy");
			await until(() => publishCount() >= 1);
			await client.notify.open(file, FIXED, "groovy", true);
			await until(() => publishCount() >= 2);
			expect(heldRows()).toEqual([]);
		} finally {
			await client.shutdown();
		}
	}, 30_000);

	it("forgets an unanswered notice when the document is closed and reopened silently", async () => {
		// Recurrence: the version counter restarts at 0 on a first open, so an
		// entry left by the previous lifetime would match the new one and swallow
		// the clear that answers its content.
		const { client, until, publishCount } = await startClient({
			FAKE_LSP_RECOMPILE_CLEARS_MS: "100",
			FAKE_LSP_RECOMPILE_NO_WATCHED_CLEAR: "1",
		});
		try {
			const file = path.join(tmp, "a.groovy");
			fs.writeFileSync(file, BROKEN);
			await client.notify.open(file, BROKEN, "groovy");
			await until(() => publishCount() >= 1);
			await client.closeDocument(file);
			fs.writeFileSync(file, FIXED);
			await client.notify.open(file, FIXED, "groovy", false, true);
			await until(() => publishCount() >= 2);
			expect(heldRows()).toEqual([]);
		} finally {
			await client.shutdown();
		}
	}, 30_000);
});
