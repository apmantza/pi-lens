/**
 * #3506 wiring: activating the pi extension hands pi-lens' own writers pi's
 * REAL per-file mutation queue, the one pi's `edit`/`write` tools run under.
 * `clients/file-mutation-queue.ts` runs writers unqueued until a host adapter
 * registers a lookup, so only driving `index.ts`'s activation can show the
 * pi adapter does, and that the lookup resolves to the host's own instance.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	setHostFileMutationQueueLoader,
	withHostFileMutationQueue,
} from "../clients/file-mutation-queue.js";
import { createPiMock } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

vi.mock("../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		metricsClient: { reset: () => {} },
	}));
});

// A cold `import("../index.js")` plus the host SDK lookup, as the other
// index.ts wiring files budget it.
const WIRING_TIMEOUT_MS = 30_000;

describe("index.ts registers pi's mutation queue for pi-lens' writers (#3506)", () => {
	let tmp: string | undefined;
	afterEach(() => {
		setHostFileMutationQueueLoader(undefined);
		if (tmp) removeTempDirSync(tmp);
	});

	it(
		"a pi-lens write waits for a pi edit that holds the same file",
		async () => {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3506-wiring-"));
			const filePath = path.join(tmp, "a.ts");
			fs.writeFileSync(filePath, "export const a = 1;\n");
			const { default: registerExtension } = await import("../index.js");
			registerExtension(createPiMock({}).asExtensionAPI() as never);
			// Resolve the lookup first, so the ordering below is the queue's.
			await withHostFileMutationQueue(path.join(tmp, "warm"), async () => {});

			let releaseEdit!: () => void;
			const edit = withFileMutationQueue(
				filePath,
				() =>
					new Promise<void>((resolve) => {
						releaseEdit = resolve;
					}),
			);
			let wrote = false;
			const write = withHostFileMutationQueue(filePath, async () => {
				wrote = true;
			});
			// Every queue call made above has registered once this resolves.
			await withHostFileMutationQueue(
				path.join(tmp, "barrier"),
				async () => {},
			);
			expect(wrote).toBe(false);
			releaseEdit();
			await edit;
			await write;
			expect(wrote).toBe(true);
		},
		WIRING_TIMEOUT_MS,
	);
});
