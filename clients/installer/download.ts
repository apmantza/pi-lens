import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_BYTES = 512 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export class InstallerDownloadError extends Error {
	readonly code: "cap" | "timeout" | "network" | "stream";
	constructor(code: InstallerDownloadError["code"], message: string) {
		super(message);
		this.name = "InstallerDownloadError";
		this.code = code;
	}
}

export function downloadInstallerFile(
	url: string,
	destination: string,
	maxRedirects = 5,
	headers: Record<string, string> = {},
	maxBytes = MAX_BYTES,
): Promise<{ bytes: number; sha256: string }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			void fs.rm(destination, { force: true }).finally(() => reject(error));
		};
		const request = (url.startsWith("http:") ? http : https).get(
			url,
			{ headers: { "User-Agent": "pi-lens/1.0", ...headers } },
			(res) => {
				if (
					res.statusCode &&
					res.statusCode >= 300 &&
					res.statusCode < 400 &&
					res.headers.location
				) {
					res.resume();
					if (maxRedirects === 0) return fail(new Error("Too many redirects"));
					const nextHeaders = res.headers.location.startsWith(url)
						? headers
						: (() => {
								const { Authorization: _drop, ...rest } = headers;
								return rest;
							})();
					downloadInstallerFile(
						res.headers.location,
						destination,
						maxRedirects - 1,
						nextHeaders,
						maxBytes,
					).then(resolve, fail);
					return;
				}
				if (res.statusCode !== 200) {
					res.resume();
					return fail(new Error(`HTTP ${res.statusCode ?? 0} for ${url}`));
				}
				let bytes = 0;
				const digest = createHash("sha256");
				const limiter = new Transform({
					transform(chunk: Buffer, _encoding, callback) {
						bytes += chunk.length;
						if (bytes > maxBytes)
							return callback(
								new InstallerDownloadError(
									"cap",
									`download exceeds ${maxBytes} bytes`,
								),
							);
						digest.update(chunk);
						callback(null, chunk);
					},
				});
				const responseWithPipe = res as { pipe?: unknown };
				if (typeof responseWithPipe.pipe !== "function") {
					const output = createWriteStream(destination);
					res.on("data", (chunk: Buffer) => limiter.write(chunk));
					res.on("error", fail);
					res.on("end", () => limiter.end());
					limiter.on("data", (chunk: Buffer) => output.write(chunk));
					limiter.on("end", () => output.end());
					limiter.on("error", (error) => {
						output.destroy();
						fail(error);
					});
					output.on("error", fail);
					output.on("finish", () => {
						if (!settled) {
							settled = true;
							resolve({ bytes, sha256: digest.digest("hex") });
						}
					});
					return;
				}
				pipeline(res, limiter, createWriteStream(destination)).then(
					() => {
						if (!settled) {
							settled = true;
							resolve({ bytes, sha256: digest.digest("hex") });
						}
					},
					(error: unknown) =>
						fail(
							error instanceof InstallerDownloadError
								? error
								: new InstallerDownloadError(
										"stream",
										`download stream failed: ${(error as Error).message}`,
									),
						),
				);
			},
		);
		request.setTimeout?.(TIMEOUT_MS, () =>
			request.destroy(
				new InstallerDownloadError(
					"timeout",
					`download timed out after ${TIMEOUT_MS}ms`,
				),
			),
		);
		request.on("error", (error: Error) =>
			fail(
				error instanceof InstallerDownloadError
					? error
					: new InstallerDownloadError(
							"network",
							`download failed: ${error.message}`,
						),
			),
		);
	});
}
