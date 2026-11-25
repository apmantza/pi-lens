import { createServer, type ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadInstallerFile } from "../../../clients/installer/download.js";
import { waitFor } from "../interleaving-kit.js";

describe("installer download stream", () => {
	const servers: Array<ReturnType<typeof createServer>> = [];

	async function serve(
		handler: Parameters<typeof createServer>[1],
		pathname = "/asset",
	): Promise<{ url: string }> {
		const server = createServer(handler);
		server.listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise<void>((resolve) =>
			server.once("listening", () => resolve()),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("server address missing");
		return { url: `http://127.0.0.1:${address.port}${pathname}` };
	}

	// One byte per ~20 ms until the client hangs up. Paced by the governed
	// `waitFor`, not a raw timer: the flake-shape ratchet bars a new raw wait.
	async function drip(
		response: ServerResponse,
		onWrite: () => void = () => {},
	): Promise<void> {
		let closed = false;
		response.on("close", () => {
			closed = true;
		});
		response.writeHead(200);
		while (!closed) {
			response.write("x");
			onWrite();
			const next = Date.now() + 20;
			await waitFor(
				() => (closed ? Number.POSITIVE_INFINITY : Date.now()),
				(now) => now >= next,
				{ timeoutMs: 2000 },
			);
		}
	}

	afterEach(async () => {
		for (const server of servers) server.closeAllConnections();
		await Promise.all(
			servers
				.splice(0)
				.map(
					(server) =>
						new Promise<void>((resolve) => server.close(() => resolve())),
				),
		);
	});

	it("rejects an oversized real HTTP body and leaves no partial file", async () => {
		const payload = Buffer.alloc(128, 0x61);
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-length": payload.length });
			response.end(payload);
		});
		server.listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise<void>((resolve) =>
			server.once("listening", () => resolve()),
		);

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-download-"));
		const destination = path.join(root, "asset");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("server address missing");

		await expect(
			downloadInstallerFile(
				`http://127.0.0.1:${address.port}/asset`,
				destination,
				5,
				{},
				64,
			),
		).rejects.toMatchObject({ name: "InstallerDownloadError", code: "cap" });
		expect(existsSync(destination)).toBe(false);
		await fs.rm(root, { recursive: true, force: true });
	});

	// #5781 F3: the old "streams" case sent one tiny gzip body and read the
	// file after the call, so a downloader that buffered the whole body and wrote
	// it at the end passed it too. The server now holds the response open after
	// its first chunk; the bytes must reach the destination before it ends.
	it("writes the first chunk to disk while the server still holds the response open", async () => {
		const first = Buffer.alloc(256 * 1024, 0x61);
		const last = Buffer.from("tail");
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { url } = await serve((_request, response) => {
			response.writeHead(200);
			response.write(first);
			void held.then(() => response.end(last));
		});
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-download-"));
		const destination = path.join(root, "asset");
		const download = downloadInstallerFile(url, destination);
		try {
			const onDisk = await waitFor(
				() => (existsSync(destination) ? statSync(destination).size : 0),
				(size) => size >= first.length,
				{ timeoutMs: 2000 },
			);
			expect(onDisk).toBe(first.length);
		} finally {
			release();
		}
		const result = await download;
		expect(result.bytes).toBe(first.length + last.length);
		expect(await fs.readFile(destination)).toEqual(
			Buffer.concat([first, last]),
		);
		await fs.rm(root, { recursive: true, force: true });
	});

	// #5781 F4: the pack's JSON-versus-YAML check reads `prefix`. A body split
	// across chunks (a leading blank run, then `{`) must still yield exactly its
	// first 64 bytes; keeping one byte per chunk or a whole chunk both break it.
	it("returns exactly the first 64 bytes as the prefix when the body arrives in several chunks", async () => {
		const chunks = [0, 1, 2, 3].map((i) =>
			Buffer.from(String.fromCharCode(97 + i).repeat(30)),
		);
		const body = Buffer.concat(chunks);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-download-"));
		const destination = path.join(root, "asset");
		// Each chunk is released only after the previous one is on disk, so the
		// client sees four separate `data` events, not one coalesced read.
		const { url } = await serve(async (_request, response) => {
			response.writeHead(200);
			let sent = 0;
			for (const chunk of chunks) {
				response.write(chunk);
				sent += chunk.length;
				await waitFor(
					() => (existsSync(destination) ? statSync(destination).size : 0),
					(size) => size >= sent,
					{ timeoutMs: 2000 },
				);
			}
			response.end();
		});
		const result = await downloadInstallerFile(url, destination);
		expect(result.bytes).toBe(body.length);
		expect(result.prefix).toEqual(body.subarray(0, 64));
		await fs.rm(root, { recursive: true, force: true });
	});

	// #5781 F1: pre-#5781 the rule pack ran under `AbortSignal.timeout(60s)`, an
	// elapsed deadline. The shared downloader only had an idle timeout, so a server
	// that sends a byte inside every idle window held the refresh slot with no
	// bound below the byte cap. The idle timeout here is far longer than the
	// deadline, so only the deadline can reject this.
	it("rejects a slow drip at the elapsed deadline and removes the partial file", async () => {
		const { url } = await serve((_request, response) => drip(response));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-download-"));
		const destination = path.join(root, "drip");
		try {
			await expect(
				downloadInstallerFile(
					url,
					destination,
					5,
					{},
					1024 * 1024,
					60_000,
					AbortSignal.timeout(150),
				),
			).rejects.toMatchObject({
				name: "InstallerDownloadError",
				code: "timeout",
			});
			expect(existsSync(destination)).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	// #5781 F1: the deadline is one budget per download. A hop that already spent
	// most of it leaves the next hop the remainder, so a redirect cannot be used
	// to restart the clock. The drip counts its writes: a clock restarted at the
	// redirect lets it land about thirty, the shared one about seven.
	it("shares one deadline across a redirect hop and removes the partial file", async () => {
		let dripWrites = 0;
		const { url } = await serve(async (request, response) => {
			if (request.url === "/start") {
				// Spend most of the budget before the redirect.
				const release = Date.now() + 450;
				await waitFor(
					() => Date.now(),
					(now) => now >= release,
					{ timeoutMs: 2000 },
				);
				response.writeHead(302, { location: "/drip" });
				response.end();
				return;
			}
			await drip(response, () => {
				dripWrites += 1;
			});
		}, "/start");
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-download-"));
		const destination = path.join(root, "drip");
		try {
			await expect(
				downloadInstallerFile(
					url,
					destination,
					5,
					{},
					1024 * 1024,
					60_000,
					AbortSignal.timeout(600),
				),
			).rejects.toMatchObject({
				name: "InstallerDownloadError",
				code: "timeout",
			});
			expect(existsSync(destination)).toBe(false);
			expect(dripWrites).toBeLessThan(15);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("times out a stalled socket and removes its partial file", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200);
			response.write("partial");
		});
		server.listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-download-"));
		const destination = path.join(root, "stalled");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("server address missing");
		try {
			await expect(
				downloadInstallerFile(
					`http://127.0.0.1:${address.port}/stalled`,
					destination,
					5,
					{},
					1024,
					25,
				),
			).rejects.toMatchObject({
				name: "InstallerDownloadError",
				code: "timeout",
			});
			expect(existsSync(destination)).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	// #5706 F2 recurrence: a relative `Location` (`/final`) reached the next
	// request as a raw string, so a valid 302 rejected with a bare TypeError
	// (ERR_INVALID_URL) instead of following the redirect.
	it("follows a relative redirect Location and writes the final body", async () => {
		const payload = Buffer.from("final-body");
		const server = createServer((request, response) => {
			if (request.url === "/final") {
				response.writeHead(200, { "content-length": payload.length });
				response.end(payload);
				return;
			}
			response.writeHead(302, { location: "/final" });
			response.end();
		});
		server.listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise<void>((resolve) =>
			server.once("listening", () => resolve()),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("server address missing");

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-download-"));
		const destination = path.join(root, "asset");
		try {
			const result = await downloadInstallerFile(
				`http://127.0.0.1:${address.port}/x`,
				destination,
			);
			expect(result.bytes).toBe(payload.length);
			expect(await fs.readFile(destination)).toEqual(payload);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	// #5706 F2 recurrence: an unresolvable `Location` must stay inside the typed
	// error contract the installer callers record, never escape as a TypeError.
	it("rejects an unparseable redirect Location with the typed error and no file", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(302, { location: "http://" });
			response.end();
		});
		server.listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise<void>((resolve) =>
			server.once("listening", () => resolve()),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("server address missing");

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-download-"));
		const destination = path.join(root, "asset");
		try {
			await expect(
				downloadInstallerFile(
					`http://127.0.0.1:${address.port}/x`,
					destination,
				),
			).rejects.toMatchObject({
				name: "InstallerDownloadError",
				code: "stream",
			});
			expect(existsSync(destination)).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
