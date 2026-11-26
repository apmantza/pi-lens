/**
 * The tier-2 drain pass joins owned-child ledger work that a LATER registered
 * drain creates while it waits (#5745 r10).
 *
 * Recurrence this prevents: CI Unit tests shard 5 on #5745 (runs 45054923383
 * and 45692091709), `pi-session-teardown.test.ts:67` red. The registered
 * drains ran in one ordered pass. The loaded copy's safe-spawn ledger drain
 * returned while `npm config get prefix` from `primeGlobalBinDirs()` (its
 * `session_start` head start, #5261) was still running; the prime's drain then
 * waited for that probe, whose follow-up `which pnpm/yarn/bun` spawns wrote
 * owned-child rows and removals the finished ledger drain never joined. The
 * last removal took the registry lock after the fixture root was removed and
 * re-created it.
 *
 * The gate is deterministic: a PATH `npm` holds `config get prefix` until a
 * release file exists, and a stand-in drain registered just before the session
 * (so before the loaded copy's drains) releases it on the next macrotask, after
 * the copy's ledger drain has returned. No timer decides the order. The
 * witness is the registry's lock directory: every registry write takes a new
 * lock generation, so a second drain pass that changes the listing joined
 * ledger work the first pass left behind.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerBackgroundWriteDrain } from "../../clients/background-write-drains.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import {
	drainPiSessionWrites,
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./pi-session.js";

const fixture = piSessionFixture();
const savedPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = savedPath;
});

/** The first `npm` on `PATH`, or `undefined`; read without spawning. */
function findNpm(searchPath: string): string | undefined {
	for (const dir of searchPath.split(path.delimiter)) {
		if (dir === "") continue;
		const candidate = path.join(dir, "npm");
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// none: not on this PATH entry, try the next one.
		}
	}
	return undefined;
}

/** Resolves once `file` exists; event-driven, bounded by the case timeout. */
function whenExists(file: string): Promise<void> {
	return new Promise((resolve) => {
		const watcher = fs.watch(path.dirname(file), () => {
			if (!fs.existsSync(file)) return;
			watcher.close();
			resolve();
		});
		if (fs.existsSync(file)) {
			watcher.close();
			resolve();
		}
	});
}

/** Every registry path under `home` (the file, its locks), sorted. */
function registryFootprint(home: string): string[] {
	if (!fs.existsSync(home)) return [];
	return (fs.readdirSync(home, { recursive: true }) as string[])
		.filter((entry) => entry.startsWith("instances.json"))
		.sort();
}

describe("pi-session: the drain pass reaches a fixed point (#5745)", () => {
	it.skipIf(process.platform === "win32")(
		"joins the prime's late probe children after the ledger drain returned",
		async () => {
			const shim = setupTestEnvironment("pi-lens-npm-gate-");
			try {
				const gate = shim.tmpDir;
				const held = path.join(gate, "held");
				const released = path.join(gate, "release");
				const realNpm = findNpm(savedPath ?? "");
				// Past the gate the real npm answers when there is one: its start-up
				// keeps the probe alive well past the ledger drain's return.
				const answer =
					realNpm === undefined ? `echo "${gate}"` : `exec "${realNpm}" "$@"`;
				const script = [
					"#!/bin/sh",
					'if [ "$1" = config ]; then',
					`  : > "${held}"`,
					`  while [ ! -e "${released}" ]; do sleep 0.02; done`,
					"fi",
					answer,
					"",
				].join("\n");
				fs.writeFileSync(path.join(gate, "npm"), script, { mode: 0o755 });
				process.env.PATH = `${gate}${path.delimiter}${savedPath ?? ""}`;

				// Registered before the session loads its copy, so this runs ahead
				// of that copy's ledger drain; the release lands a macrotask later.
				let releaseScheduled = false;
				registerBackgroundWriteDrain(
					async () => {
						if (!releaseScheduled) {
							releaseScheduled = true;
							setImmediate(() => fs.writeFileSync(released, ""));
						}
						return undefined;
					},
					() => false,
				);

				const handle = await startPiSession({
					root: fixture.root,
					responses: [fauxAssistantMessage(fauxText("ready"))],
				});
				await handle.prompt("hello");
				await handle.dispose();
				// The prime's npm probe is alive and held.
				await whenExists(held);
				expect(fs.existsSync(released)).toBe(false);

				await drainPiSessionWrites();
				expect(fs.existsSync(released)).toBe(true);
				const home = path.join(fixture.root, "home");
				const settled = registryFootprint(home);
				// A second pass finds nothing left: no registry write lands after
				// the first one returned.
				await drainPiSessionWrites();
				expect(registryFootprint(home)).toEqual(settled);

				fixture.cleanup();
				expect(fs.existsSync(fixture.root)).toBe(false);
			} finally {
				fs.writeFileSync(path.join(shim.tmpDir, "release"), "");
				shim.cleanup();
			}
		},
		60_000,
	);
});
