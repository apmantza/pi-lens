import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_BYTES = 512 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export class InstallerDownloadError extends globalThis.Error {
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
	timeoutMs = TIMEOUT_MS,
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
					if (maxRedirects === 0)
						return fail(
							new InstallerDownloadError("stream", "Too many redirects"),
						);
					// HTTP allows a relative Location; resolve it against this URL.
					if (!URL.canParse(res.headers.location, url))
						return fail(
							new InstallerDownloadError(
								"stream",
								`invalid redirect Location from ${url}`,
							),
						);
					const next = new URL(res.headers.location, url).href;
					const nextHeaders = next.startsWith(url)
						? headers
						: (() => {
								const { Authorization: _drop, ...rest } = headers;
								return rest;
							})();
					downloadInstallerFile(
						next,
						destination,
						maxRedirects - 1,
						nextHeaders,
						maxBytes,
						timeoutMs,
					).then(resolve, fail);
					return;
				}
				if (res.statusCode !== 200) {
					res.resume();
					return fail(
						new InstallerDownloadError(
							"stream",
							`HTTP ${res.statusCode ?? 0} for ${url}`,
						),
					);
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
		request.setTimeout?.(timeoutMs, () =>
			request.destroy(
				new InstallerDownloadError(
					"timeout",
					`download timed out after ${timeoutMs}ms`,
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
