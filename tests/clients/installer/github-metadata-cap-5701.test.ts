/**
 * #5701 / #5781 F2: the 2 MiB cap on the GitHub release metadata body, through
 * the production entry point (`refreshManagedTool`, which resolves
 * `releases/latest` through `httpsGetWithMeta`).
 *
 * The one seam replaced is `https.get`, the network boundary: GitHub is not
 * reachable from a test and a real server would have to speak TLS. The gate,
 * the token resolver and the refresh's own error mapping all run for real.
 *
 * Recurrence this prevents: the metadata reader accumulated every chunk into a
 * `Buffer[]` with no ceiling, so a misbehaving endpoint or proxy grew the host's
 * memory until the process died. The cap's only other proof was a source-text
 * match in `data-handler-bounds-sweep`, which stays green with the condition
 * replaced by `false`.
 */
import { EventEmitter } from "node:events";
import https from "node:https";
import { Readable } from "node:stream";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { withEnv } from "../../support/with-env.js";

vi.unmock("../../../clients/installer/index.js");

const TEST_HOME = vi.hoisted(() => {
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-5701-"),
	);
	// TOOLS_DIR is a module-level const: the override must land before import.
	vi.stubEnv("PI_LENS_HOME", dir);
	return dir;
});

import * as fs from "node:fs";
import { refreshManagedTool } from "../../../clients/installer/index.js";

const CAP = 2 * 1024 * 1024;
const CHUNK = 64 * 1024;

let restoreEnv: () => void;
let pushed = 0;

/** Answer the next `https.get` with a 200 whose body is `body`, in 64 KiB chunks. */
function serveMetadata(body: Buffer): void {
	vi.spyOn(https, "get").mockImplementation(((
		_url: unknown,
		_options: unknown,
		callback: (res: unknown) => void,
	) => {
		const request = new EventEmitter();
		let sent = 0;
		const response = Object.assign(
			new Readable({
				read() {
					if (sent >= body.length) {
						this.push(null);
						return;
					}
					const chunk = body.subarray(sent, sent + CHUNK);
					sent += chunk.length;
					pushed += chunk.length;
					this.push(chunk);
				},
			}),
			{ statusCode: 200, headers: {} as Record<string, string> },
		);
		setImmediate(() => callback(response));
		return request;
	}) as unknown as typeof https.get);
}

beforeEach(() => {
	pushed = 0;
	restoreEnv = withEnv({
		PI_LENS_DISABLE_TOOL_INSTALL: "0",
		// A token in the environment keeps the resolver from spawning `gh`.
		GITHUB_TOKEN: "test-token",
		GH_TOKEN: undefined,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	restoreEnv();
});

afterAll(() => {
	vi.unstubAllEnvs();
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("GitHub release metadata cap (#5701)", () => {
	it("refuses a body past 2 MiB, stops reading it near the cap, and reports it", async () => {
		serveMetadata(Buffer.alloc(3 * 1024 * 1024, 0x20));

		const attempt = await refreshManagedTool("shellcheck", {});

		expect(attempt).toMatchObject({
			ok: false,
			unchanged: true,
			reason: `release query failed: GitHub metadata exceeds ${CAP} bytes`,
		});
		// Memory stays at the cap plus the chunk that crossed it, not the 3 MiB offered.
		expect(pushed).toBeLessThanOrEqual(CAP + 2 * CHUNK);
	});

	it("still accepts a body just under the cap", async () => {
		const pad = "x".repeat(CAP - 1024);
		serveMetadata(Buffer.from(JSON.stringify({ tag_name: "v9", pad })));

		const attempt = await refreshManagedTool("shellcheck", {
			resolutionId: "v9",
		});

		expect(attempt).toMatchObject({ ok: true, unchanged: true });
		expect(pushed).toBeGreaterThan(CAP / 2);
	});
});
