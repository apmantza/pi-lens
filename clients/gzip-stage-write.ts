import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parentPort } from "node:worker_threads";
import { createGzip } from "node:zlib";
import { stagePathFor } from "./atomic-write-staging.js";

export interface GzipStageWriteMetrics {
	/** Uncompressed byte length of the serialized JSON. */
	rawBytes: number;
	/** On-disk size of the gzipped stage file. */
	gzBytes: number;
	serializeMs: number;
	writeMs: number;
	/** Wall-clock duration of the complete stage operation. */
	durationMs: number;
	/** Optional semantic digest derived from the serialized JSON. */
	semanticFingerprint?: string;
	/** True when the digest matched and no gzip or stage write ran. */
	skippedUnchanged?: boolean;
}

export interface GzipStageWriteOptions {
	/** Runs on the worker thread over the serialized body, never on the caller. */
	semanticFingerprint?: (body: string | Uint8Array) => string;
	/** Return before gzip/write when the derived digest equals one of these. */
	skipIfFingerprints?: readonly string[];
}

/** Common request envelope every gzip-stage persist worker receives. Concrete
 * workers extend this with their own routing fields (e.g. `cwd`, `elements`). */
export interface GzipStageWorkerRequest {
	id: number;
	generation: number;
	stagePath: string;
	/**
	 * Either an object the worker serializes itself (the structured clone of the
	 * whole graph rides the message), or already-serialized JSON as UTF-8 bytes
	 * whose `ArrayBuffer` the caller lists in `postMessage`'s transfer list, so
	 * the body crosses the thread boundary zero-copy (#3789). The project
	 * snapshot uses the bytes form; the review graph still sends objects.
	 */
	data: unknown;
	testDelayMs?: number;
}

/** Common result envelope: the routing fields the worker echoes back, plus the
 * write metrics (all optional — absent together with `error` set on failure). */
export interface GzipStageWorkerResult {
	id: number;
	generation: number;
	stagePath: string;
	rawBytes?: number;
	gzBytes?: number;
	serializeMs?: number;
	writeMs?: number;
	durationMs?: number;
	semanticFingerprint?: string;
	skippedUnchanged?: boolean;
	error?: string;
}

/**
 * Shared worker-thread body-persist core (#958, single source of truth #883):
 * `JSON.stringify` (or pre-serialized bytes, #3789) → chunked `createGzip`
 * pipeline → a per-call staging file
 * from `atomic-write.ts`'s {@link stagePathFor} → atomic rename to
 * `stagePath`, returning byte/timing metrics. Both
 * `clients/review-graph/persist-worker.ts` and
 * `clients/project-snapshot-persist-worker.ts` call this so the streamed-gzip
 * write lives in exactly one place; each worker's `parentPort` wiring owns its
 * own request/result envelope and maps a thrown error onto its own `error`
 * field. The chunked generator keeps the whole JSON string off a single giant
 * Buffer (the whole reason the write is on a worker thread — a naïve sync gzip
 * on the main save path regressed host memory by +656MB, per the #950 review).
 *
 * On failure the partial `.tmp` is removed and the error is rethrown for the
 * caller to record; the `stagePath` itself is only ever created by the atomic
 * rename, so a crash mid-write can never leave a torn stage file behind.
 *
 * That crash-safety is NOT the same as concurrency isolation, and this
 * docstring used to conflate the two (#1217). The staging name is what keeps
 * two concurrent calls on one `stagePath` from writing into a shared inode,
 * and it has to come from `stagePathFor` rather than a local
 * `${stagePath}.tmp-${process.pid}`: this module runs on worker threads, which
 * share `process.pid` with the main thread and with each other, so pid alone
 * isolates nothing here (#1205's per-pid tear, verbatim). Callers normally
 * pass a per-generation `stagePath`, which makes the overlap rare — a retry, a
 * re-queued persist, a repeated generation, or a future non-generational
 * caller makes it exact. Beyond tear-freedom this offers nothing: two calls on
 * one `stagePath` are still unordered and last-rename-wins on POSIX — on
 * Windows, MoveFileEx's REPLACE_EXISTING does not serialize concurrent replaces
 * of the same destination, so one rename can fail with EPERM instead, which
 * the caller must treat as a persist failure (both persist workers fall back
 * to a main-thread rewrite on an error result).
 */
export async function writeGzipStageFile(
	data: unknown,
	stagePath: string,
	testDelayMs?: number,
	options?: GzipStageWriteOptions,
): Promise<GzipStageWriteMetrics> {
	// Worker-path duration starts inside this stage, so it includes the worker's
	// test delay, serialization, gzip, and rename, but excludes postMessage queue
	// latency. Main-thread callers measure from their inclusive persist entry.
	const startedAt = performance.now();
	const tmpPath = stagePathFor(stagePath);
	try {
		if (testDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, testDelayMs));
		}
		const serializeStarted = performance.now();
		// Pre-serialized bytes cost the worker no stringify and no copy (#3789).
		const body = data instanceof Uint8Array ? data : JSON.stringify(data);
		const serializeMs = performance.now() - serializeStarted;
		const rawBytes = Buffer.byteLength(body);
		const semanticFingerprint = options?.semanticFingerprint?.(body);
		if (
			semanticFingerprint !== undefined &&
			options?.skipIfFingerprints?.includes(semanticFingerprint)
		) {
			return {
				rawBytes,
				gzBytes: 0,
				serializeMs,
				writeMs: 0,
				durationMs: performance.now() - startedAt,
				semanticFingerprint,
				skippedUnchanged: true,
			};
		}

		const writeStarted = performance.now();
		await fs.promises.mkdir(path.dirname(stagePath), { recursive: true });
		const chunks = function* () {
			const chunkSize = 256 * 1024;
			let offset = 0;
			while (offset < body.length) {
				let end = Math.min(offset + chunkSize, body.length);
				// A string chunk is encoded on its own, so a surrogate pair split
				// across two chunks would become two U+FFFD (#3913). JSON.stringify
				// escapes lone surrogates, so a high surrogate ending a chunk always
				// pairs with the next unit: end the chunk one unit early instead.
				if (typeof body === "string" && end < body.length) {
					const last = body.charCodeAt(end - 1);
					if (last >= 0xd800 && last <= 0xdbff) end--;
				}
				yield typeof body === "string"
					? body.slice(offset, end)
					: body.subarray(offset, end);
				offset = end;
			}
		};
		await pipeline(
			Readable.from(chunks()),
			createGzip(),
			fs.createWriteStream(tmpPath),
		);
		await fs.promises.rename(tmpPath, stagePath);
		const writeMs = performance.now() - writeStarted;
		const gzBytes = (await fs.promises.stat(stagePath)).size;
		return {
			rawBytes,
			gzBytes,
			serializeMs,
			writeMs,
			durationMs: performance.now() - startedAt,
			semanticFingerprint,
		};
	} catch (err) {
		await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
		throw err;
	}
}

/**
 * Install the standard gzip-stage persist worker message loop on `parentPort`:
 * for each request, build the routing-field base result, run the shared
 * {@link writeGzipStageFile}, and post back the base merged with either the
 * write metrics or an `error`. Both persist workers (review-graph,
 * project-snapshot) use this so the loop + error mapping live in one place;
 * each supplies only how to derive its own result's routing fields from the
 * request. Throws immediately if loaded outside a worker thread.
 */
export function serveGzipStageWorker<
	Req extends GzipStageWorkerRequest,
	Base extends { id: number; generation: number; stagePath: string },
>(
	buildBaseResult: (request: Req) => Base,
	options?: {
		semanticFingerprint?: (request: Req, body: string | Uint8Array) => string;
		skipIfFingerprints?: (request: Req) => readonly string[] | undefined;
	},
): void {
	const port = parentPort;
	if (!port) {
		throw new Error("gzip stage persist worker requires a parent port");
	}
	port.on("message", (request: Req) => {
		void (async () => {
			const result: Base & GzipStageWorkerResult = {
				...buildBaseResult(request),
			};
			try {
				const fingerprint = options?.semanticFingerprint;
				const metrics = await writeGzipStageFile(
					request.data,
					request.stagePath,
					request.testDelayMs,
					{
						semanticFingerprint: fingerprint
							? (body) => fingerprint(request, body)
							: undefined,
						skipIfFingerprints: options?.skipIfFingerprints?.(request),
					},
				);
				result.rawBytes = metrics.rawBytes;
				result.gzBytes = metrics.gzBytes;
				result.serializeMs = metrics.serializeMs;
				result.writeMs = metrics.writeMs;
				result.durationMs = metrics.durationMs;
				result.semanticFingerprint = metrics.semanticFingerprint;
				result.skippedUnchanged = metrics.skippedUnchanged;
			} catch (err) {
				result.error = err instanceof Error ? err.message : String(err);
			}
			port.postMessage(result);
		})();
	});
}
