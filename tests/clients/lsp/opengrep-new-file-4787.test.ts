// flake-shape: real-process-spawn — Real child transport and lifecycle are the subject; a process stub cannot exercise the wire and teardown behavior.
/**
 * #4787: an auxiliary that advertises fileOperations.didCreate must hear that
 * a file exists before its first didOpen, or opengrep's cached target list
 * answers the first touch as clean.
 *
 * Every case reads what the fake server RECEIVED (`FAKE_LSP_TRACE_FILE`):
 * `workspace/didCreateFiles` (one `created` line per notification, with its
 * URIs), `textDocument/didOpen`, and the watched-files Created (type 1). The
 * fixture also withholds its finding unless didCreateFiles named the URI
 * before didOpen. State table (wire for the created path):
 *
 *   row  spawn  route            didCreate          paths  wire
 *   1    cold   open-only        in filter          one    dCF(c) < dO(c)
 *   3    cold   open-only        out of filter      one    dO(c)
 *   4    cold   open-only        not advertised     one    dO(c)
 *   6    warm   announced first  in filter, no      one    dCF(c) < dO(c), once
 *                                scheme (opengrep)
 *   7    warm   announced first  out of filter      one    dO(c)
 *   8    warm   announced first  not advertised     one    dO(c)
 *   9    warm   announced first  in filter          a, b   dCF(a b) < dO(a), dO(b)
 *   10   warm   open-only        in filter          x, y   dCF(x) < dO(x), dCF(y) < dO(y)
 *   12   warm   open-only        in filter, no file one    dO(c)
 *
 * Row 2 (cold, announced first) cannot occur: the touch announces before it
 * spawns and `announceCreatedFiles` reaches live clients only, which row 1's
 * single didCreateFiles pins. "Warm" means the auxiliary was spawned by a
 * touch of another file: `getClientForFile` skips auxiliaries, so it cannot
 * warm one (round 4 F2). Rows 10 and 12 drive the client directly: through
 * the service a warm auxiliary always hears the announcement first.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { createLSPClient } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { stopLSP } from "../../../clients/lsp/launch.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { spawnFakeLspServer } from "../../support/fake-lsp-server.js";
import { waitFor } from "../interleaving-kit.js";
import { setupTestEnvironment, useTrackedTempDirs } from "../test-utils.js";

useTrackedTempDirs("pi-lens-4787-");

/** A filter that never matches a `.py` path. */
const OUT_OF_FILTER = JSON.stringify([
	{ scheme: "file", pattern: { glob: "**/*.txt" } },
]);
/** Opengrep's own registration: `**` with no scheme (`LS.ml:37-42`). */
const OPENGREP_FILTER = JSON.stringify([{ pattern: { glob: "**/*" } }]);

describe("opengrep hears a file created after spawn (#4787)", () => {
	let dir: string;
	let traceFile: string;
	let proc: Awaited<ReturnType<typeof spawnFakeLspServer>> | undefined;
	let service: LSPService | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;

	beforeEach(() => {
		dir = setupTestEnvironment("pi-lens-4787-").tmpDir;
		traceFile = path.join(
			setupTestEnvironment("pi-lens-4787-").tmpDir,
			"wire.log",
		);
		service = new LSPService();
	});

	afterEach(async () => {
		await client?.shutdown().catch(() => {});
		await service?.shutdown({ fast: true }).catch(() => {});
		if (proc) await stopLSP(proc).catch(() => {});
		client = undefined;
		service = undefined;
		proc = undefined;
		_setServersForFileForTests(undefined);
	});

	const spawnServer = async (env: Record<string, string>) => {
		proc = await spawnFakeLspServer({
			cwd: dir,
			env: {
				...process.env,
				FAKE_LSP_TRACE_FILE: traceFile,
				FAKE_LSP_DID_CREATE_REQUIRED: "1",
				FAKE_LSP_IGNORE_PULL: "1",
				...env,
			},
		});
	};

	const useAuxiliary = async (env: Record<string, string>) => {
		await spawnServer(env);
		_setServersForFileForTests(() => [
			{
				id: "opengrep",
				name: "opengrep",
				role: "auxiliary" as const,
				extensions: [".py"],
				idleEviction: "resident" as const,
				root: async () => dir,
				spawn: async () => ({ process: proc!, source: "direct" as const }),
			},
		]);
	};

	const write = (name: string): string => {
		const file = path.join(dir, name);
		fs.writeFileSync(file, `${name.replace(/\W/g, "_")}()\n`);
		return file;
	};

	/** The wire is the evidence, so the touch does not wait for diagnostics. */
	const touch = (file: string) =>
		service!.touchFile(file, fs.readFileSync(file, "utf8"), {
			clientScope: "all",
			diagnostics: "none",
			source: "test",
		});

	const liveClients = () =>
		[
			...(
				service as unknown as {
					state: {
						clients: Map<
							string,
							{
								isAlive: () => boolean;
								getDiagnostics: (filePath: string) => unknown[];
							}
						>;
					};
				}
			).state.clients.values(),
		].filter((entry) => entry.isAlive());

	/** Spawns the auxiliary through a production touch of another file. */
	const warm = async () => {
		await touch(write("existing.py"));
		expect(liveClients()).toHaveLength(1);
	};

	/**
	 * The notices about `files`, in the order the server received them:
	 * `didCreateFiles a.py b.py` (one per notification), `didOpen a.py`, and
	 * `watched a.py <type>`.
	 */
	const wire = (files: string[]) => {
		const names = new Map(
			files.map((file) => [pathToFileURL(file).href, path.basename(file)]),
		);
		const lines = fs.existsSync(traceFile)
			? fs.readFileSync(traceFile, "utf8").split("\n")
			: [];
		return lines.flatMap((line) => {
			const [kind, ...rest] = line.split(" ");
			if (kind === "created") {
				const named = rest.flatMap((uri) => names.get(uri) ?? []);
				return named.length > 0 ? [`didCreateFiles ${named.join(" ")}`] : [];
			}
			if (kind === "recv" && rest[0] === "textDocument/didOpen") {
				const name = names.get(rest[1] ?? "");
				return name ? [`didOpen ${name}`] : [];
			}
			if (kind === "watched") {
				const name = names.get(rest[0] ?? "");
				return name ? [`watched ${name} ${rest[1]}`] : [];
			}
			return [];
		});
	};

	/**
	 * Waits for every file's didOpen and watched Created. A didCreateFiles is
	 * sent before both on every route, and the wire is ordered, so none can
	 * still arrive once they have.
	 */
	const settledWire = async (files: string[]) => {
		const expected = files.flatMap((file) => [
			`didOpen ${path.basename(file)}`,
			`watched ${path.basename(file)} 1`,
		]);
		await waitFor(
			() => wire(files),
			(seen) => expected.every((notice) => seen.includes(notice)),
			{ timeoutMs: 5_000 },
		);
		const seen = wire(files);
		return {
			order: seen.filter((notice) => !notice.startsWith("watched ")),
			createdWatched: seen.filter(
				(notice) => notice.startsWith("watched ") && notice.endsWith(" 1"),
			),
		};
	};

	const findingFor = async (file: string) => {
		const read = () =>
			liveClients().flatMap((entry) => entry.getDiagnostics(file));
		await waitFor(read, (diags) => diags.length > 0, { timeoutMs: 5_000 });
		return read();
	};

	const P4787 = expect.objectContaining({
		code: "P4787",
		message: "finding after didCreate",
	});

	it("row 1: a cold auxiliary hears didCreateFiles from the open, before didOpen", async () => {
		await useAuxiliary({ FAKE_LSP_DID_CREATE: "true" });
		const file = write("created.py");
		await touch(file);

		expect(await settledWire([file])).toEqual({
			order: ["didCreateFiles created.py", "didOpen created.py"],
			createdWatched: ["watched created.py 1"],
		});
		expect(await findingFor(file)).toEqual([P4787]);
	}, 15_000);

	it("row 3: a cold auxiliary whose filter excludes the path hears no didCreateFiles", async () => {
		await useAuxiliary({
			FAKE_LSP_DID_CREATE: "true",
			FAKE_LSP_DID_CREATE_FILTERS: OUT_OF_FILTER,
		});
		const file = write("created.py");
		await touch(file);

		expect(await settledWire([file])).toEqual({
			order: ["didOpen created.py"],
			createdWatched: ["watched created.py 1"],
		});
	}, 15_000);

	it("row 4: a cold auxiliary without didCreate hears no didCreateFiles", async () => {
		await useAuxiliary({});
		const file = write("created.py");
		await touch(file);

		expect(await settledWire([file])).toEqual({
			order: ["didOpen created.py"],
			createdWatched: ["watched created.py 1"],
		});
	}, 15_000);

	it("row 6: a warm auxiliary hears didCreateFiles from the announcement, once, before didOpen", async () => {
		await useAuxiliary({
			FAKE_LSP_DID_CREATE: "true",
			FAKE_LSP_DID_CREATE_FILTERS: OPENGREP_FILTER,
		});
		await warm();
		const file = write("created.py");
		await touch(file);

		expect(await settledWire([file])).toEqual({
			order: ["didCreateFiles created.py", "didOpen created.py"],
			createdWatched: ["watched created.py 1"],
		});
		expect(await findingFor(file)).toEqual([P4787]);
	}, 15_000);

	it("row 7: a warm auxiliary whose filter excludes the path hears no didCreateFiles", async () => {
		await useAuxiliary({
			FAKE_LSP_DID_CREATE: "true",
			FAKE_LSP_DID_CREATE_FILTERS: OUT_OF_FILTER,
		});
		await warm();
		const file = write("created.py");
		await touch(file);

		expect(await settledWire([file])).toEqual({
			order: ["didOpen created.py"],
			createdWatched: ["watched created.py 1"],
		});
	}, 15_000);

	it("row 8: a warm auxiliary without didCreate hears no didCreateFiles", async () => {
		await useAuxiliary({});
		await warm();
		const file = write("created.py");
		await touch(file);

		expect(await settledWire([file])).toEqual({
			order: ["didOpen created.py"],
			createdWatched: ["watched created.py 1"],
		});
	}, 15_000);

	it("row 9: one announcement of two created files is one didCreateFiles carrying both", async () => {
		await useAuxiliary({ FAKE_LSP_DID_CREATE: "true" });
		await warm();
		const first = write("first.py");
		const second = write("second.py");
		service!.announceCreatedFiles([first, second]);
		await touch(first);
		await touch(second);

		expect(await settledWire([first, second])).toEqual({
			order: [
				"didCreateFiles first.py second.py",
				"didOpen first.py",
				"didOpen second.py",
			],
			createdWatched: ["watched first.py 1", "watched second.py 1"],
		});
	}, 15_000);

	it("row 10: a live client opening unannounced files sends one didCreateFiles per open", async () => {
		await spawnServer({ FAKE_LSP_DID_CREATE: "true" });
		client = await createLSPClient({
			serverId: "opengrep",
			process: proc!,
			root: dir,
		});
		const first = write("first.py");
		await client.notify.open(first, fs.readFileSync(first, "utf8"), "python");
		const second = write("second.py");
		await client.notify.open(second, fs.readFileSync(second, "utf8"), "python");

		expect(await settledWire([first, second])).toEqual({
			order: [
				"didCreateFiles first.py",
				"didOpen first.py",
				"didCreateFiles second.py",
				"didOpen second.py",
			],
			createdWatched: ["watched first.py 1", "watched second.py 1"],
		});
	}, 15_000);

	it("row 12: a live client opening a document with no file on disk sends no didCreateFiles", async () => {
		await spawnServer({ FAKE_LSP_DID_CREATE: "true" });
		client = await createLSPClient({
			serverId: "opengrep",
			process: proc!,
			root: dir,
		});
		const unsaved = path.join(dir, "unsaved.py");
		await client.notify.open(unsaved, "unsaved_call()\n", "python");

		expect(await settledWire([unsaved])).toEqual({
			order: ["didOpen unsaved.py"],
			createdWatched: ["watched unsaved.py 1"],
		});
	}, 15_000);

	// Round 4 F15: the announcement is detached from the touch, so a send that
	// throws a non-stream error must leave a bounded record, never an
	// unhandled rejection or one log line per failed touch.
	it("a failed didCreateFiles send is a counted lsp-sibling-announcement degradation", async () => {
		resetDegradationLedger();
		await spawnServer({ FAKE_LSP_DID_CREATE: "true" });
		client = await createLSPClient({
			serverId: "opengrep",
			process: proc!,
			root: dir,
		});
		const connection = client.connection;
		const send = connection.sendNotification.bind(connection);
		connection.sendNotification = ((method: string, ...rest: unknown[]) =>
			method === "workspace/didCreateFiles"
				? Promise.reject(new Error("write refused"))
				: (send as (...args: unknown[]) => Promise<void>)(
						method,
						...rest,
					)) as typeof connection.sendNotification;
		const file = write("created.py");
		client.notify.announceCreated([
			{ filePath: file, stat: fs.statSync(file) },
		]);

		const group = await waitFor(
			() =>
				getDegradationSummary().find(
					(entry) => entry.kind === "lsp-sibling-announcement",
				),
			(found) => found !== undefined,
			{ timeoutMs: 5_000 },
		);
		expect(group).toEqual(
			expect.objectContaining({
				count: 1,
				latestReasons: [
					{
						subject: "opengrep:workspace/didCreateFiles",
						reason: "didCreateFiles failed: Error: write refused (count: 1)",
					},
				],
			}),
		);
	}, 15_000);
});
