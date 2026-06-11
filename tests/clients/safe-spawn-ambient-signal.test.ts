/**
 * #197 — `safeSpawnAsync` defaults to the ambient turn abort signal.
 *
 * The lifecycle handlers publish pi's `ctx.signal` via `setAmbientAbortSignal`,
 * so dispatches that don't thread their own signal still cancel when the agent
 * is interrupted. These tests pin the defaulting/precedence/clearing behaviour
 * via the deterministic early-abort path (an already-aborted signal resolves
 * without spawning a real process).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	safeSpawnAsync,
	setAmbientAbortSignal,
} from "../../clients/safe-spawn.js";

// A trivial, immediately-exiting node invocation — guaranteed to exist on every
// CI platform via process.execPath.
const NODE = process.execPath;
const EXIT_OK = ["-e", "process.exit(0)"];

afterEach(() => setAmbientAbortSignal(undefined));

describe("safeSpawnAsync ambient abort signal (#197)", () => {
	it("aborts when the ambient signal is already aborted and no explicit signal is passed", async () => {
		setAmbientAbortSignal(AbortSignal.abort());

		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.status).toBeNull();
		expect(result.error?.message ?? "").toMatch(/aborted before start/i);
	});

	// `status !== null` means the child actually ran to an exit code rather than
	// being short-circuited by the early-abort path (which yields status null +
	// an "aborted before start" error). The exit code itself is irrelevant here.
	it("does not abort once the ambient signal is cleared", async () => {
		setAmbientAbortSignal(AbortSignal.abort());
		setAmbientAbortSignal(undefined); // cleared in the handler's finally

		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("an explicit signal takes precedence over the ambient one", async () => {
		// Ambient is aborted, but the call passes its own live signal — the
		// explicit option wins (`options.signal ?? ambient`), so it still runs.
		setAmbientAbortSignal(AbortSignal.abort());
		const live = new AbortController();

		const result = await safeSpawnAsync(NODE, EXIT_OK, { signal: live.signal });

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("with no ambient and no explicit signal, the spawn runs normally", async () => {
		const result = await safeSpawnAsync(NODE, EXIT_OK);

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});

	it("ignoreAmbientSignal opts out of an aborted ambient signal (installs run to completion)", async () => {
		setAmbientAbortSignal(AbortSignal.abort());

		const result = await safeSpawnAsync(NODE, EXIT_OK, {
			ignoreAmbientSignal: true,
		});

		expect(result.error?.message ?? "").not.toMatch(/aborted before start/i);
		expect(result.status).not.toBeNull();
	});
});
