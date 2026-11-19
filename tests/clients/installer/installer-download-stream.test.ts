import { createServer } from "node:http";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
});
