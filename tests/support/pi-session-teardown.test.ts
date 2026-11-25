/**
 * The tier-2 helper's drain pass joins registered deferred writers before the
 * fixture root is removed (#4937).
 *
 * Recurrence this prevents: master run 40967488612 (shard 2/5),
 * `tests/lens-toggle-command.test.ts` left `pi-lens-pi-session-yB7mpc` in the
 * shared tmp root. The loaded extension copy's worker snapshot write was still
 * in flight when the helper removed the root, and landed afterwards. A sweep
 * of the 45 tier-2 files at the same head found four more roots that came back
 * within 600 ms (the installer's debounced probe-cache flush in `index-4687`,
 * `index-4723` and `index-4732`; NDJSON rows in `context-append-to-last-user`).
 *
 * The real writers are covered across module copies in
 * `tests/clients/background-write-drains.test.ts`. This case pins the wiring
 * those depend on: the helper's own drain pass (`drainPiSessionWrites`, the
 * first step of its `afterAll`) runs the registry before the root is removed.
 * The writer here is a stand-in with the same shape as the installer's flush:
 * it writes into the root when its drain asks it to, and otherwise only when
 * the case lets it, after the removal. No timer decides the order.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { registerBackgroundWriteDrain } from "../../clients/background-write-drains.js";
import {
	drainPiSessionWrites,
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./pi-session.js";

const fixture = piSessionFixture();

describe("pi-session: the file-level drain pass (#4937)", () => {
	it("joins a registered deferred writer before the fixture root is removed", async () => {
		const handle = await startPiSession({
			root: fixture.root,
			responses: [fauxAssistantMessage(fauxText("ready"))],
		});
		await handle.prompt("hello");
		await handle.dispose();

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let wrote = false;
		const landed = gate.then(() => {
			fs.mkdirSync(path.join(fixture.root, "data"), { recursive: true });
			fs.writeFileSync(path.join(fixture.root, "data", "late.json"), "{}");
			wrote = true;
		});
		// A stand-in writer the registry joins, as the loaded copy's would be.
		const drain = async () => {
			release();
			await landed;
			return undefined;
		};
		registerBackgroundWriteDrain(drain, () => !wrote);

		await drainPiSessionWrites();
		fixture.cleanup();
		// Without the drain pass this is the first write, and it lands after the
		// removal.
		release();
		await landed;

		expect(fs.existsSync(fixture.root)).toBe(false);
	}, 60_000);
});
