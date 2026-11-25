import { createServer } from "node:http";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { downloadInstallerFile } from "../../../clients/installer/download.js";

describe("installer download stream", () => {
	const servers: Array<ReturnType<typeof createServer>> = [];

	afterEach(async () => {
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

	it("streams a gzip body to the destination without buffering it in the caller", async () => {
		const payload = Buffer.from("gzip installer payload");
		const server = createServer((_request, response) => {
			const compressed = gzipSync(payload);
			response.writeHead(200, { "content-length": compressed.length });
			response.end(compressed);
		});
		server.listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-download-"));
		const destination = path.join(root, "asset.gz");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("server address missing");
		try {
			const result = await downloadInstallerFile(
				`http://127.0.0.1:${address.port}/asset.gz`,
				destination,
			);
			expect(result.bytes).toBeGreaterThan(payload.length / 2);
			expect(await fs.readFile(destination)).toEqual(gzipSync(payload));
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
