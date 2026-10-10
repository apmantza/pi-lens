/**
 * #2130 round 2 — the per-session writes AROUND the root set.
 *
 * #2133 pinned `projectRoot` and made registration additive. Two follow-on
 * defects survived that fix, both recorded on the issue as remainder items,
 * and both about ORDER rather than about the set itself:
 *
 *  - `deregisterInstanceRoot` bypassed the mutation tail every other registry
 *    writer queues on, so a short-lived secondary could remove its root before
 *    its own queued `registerInstanceRoot` had added it. The add then landed
 *    behind the removal and the temp root LEAKED until host exit.
 *  - A `recordLspChild` that arrives before `registerInstance` synthesizes an
 *    entry from `process.cwd()` and marks it `rootSource: "lsp-fallback"`. Once
 *    `projectRoot` became a pinned primary, that GUESS became permanent and the
 *    session's real root joined as a secondary — the same wrong-root
 *    advertisement #2130 is about, reached through a different writer.
 *
 * `getGlobalPiLensDir` is mocked to a per-test temp dir, so nothing here
 * touches the real `~/.pi-lens/instances.json`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./test-utils.js";

let dir: string;

vi.mock("../../clients/file-utils.js", () => ({
	// #2506: both resolvers, same dir. Under the vitest PI_LENS_HOME pin
	// production returns one value for both, so a double that split them
	// would diverge from production on the axis these tests measure.
	getGlobalPiLensDir: () => dir,
}));

describe("instance-registry root lifecycle (#2130 round 2)", () => {
	let realRoot: string;
	let tempRoot: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-instreg-rl-"));
		// Real directories: `normalizeFilePath` canonicalizes an EXISTING path
		// via realpath, so a made-up path would compare two differently-derived
		// spellings and prove nothing.
		realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rl-real-"));
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rl-temp-"));
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		removeTempDirSync(dir);
		removeTempDirSync(realRoot);
		removeTempDirSync(tempRoot);
	});

	function readEntry(): {
		projectRoot: string;
		projectRoots?: string[];
		rootSource?: string;
	} {
		const raw = fs.readFileSync(path.join(dir, "instances.json"), "utf-8");
		return JSON.parse(raw).instances[0];
	}

	describe("deregisterInstanceRoot serializes with the queued add", () => {
		it("does not leak a temp root when the secondary shuts down before its add lands", async () => {
			// The live shape: index.ts fires `void registerInstanceRoot(cwd)` at a
			// DECLINED session_start and never awaits it. A subagent that finishes
			// in the same tick window then reaches session_shutdown and calls
			// `deregisterInstanceRoot(cwd)`. Pre-fix the deregistration ran
			// immediately (sync, off-queue), found nothing to remove, and the
			// queued add landed afterwards — leaving the temp root in the file for
			// the rest of the host's life.
			const {
				registerInstance,
				registerInstanceRoot,
				deregisterInstanceRoot,
				_settleRegistryMutationsForTests,
			} = await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);

			// Deliberately NOT awaited, matching the production call site.
			void registerInstanceRoot(tempRoot, "holder-1");
			await deregisterInstanceRoot(tempRoot, "holder-1");
			await _settleRegistryMutationsForTests();

			const entry = readEntry();
			expect(entry.projectRoots).toEqual([entry.projectRoot]);
			expect(entry.projectRoots?.[0]).toContain(path.basename(realRoot));
			expect(JSON.stringify(entry.projectRoots)).not.toContain(
				path.basename(tempRoot),
			);
		});

		it("still removes a root that was added and awaited", async () => {
			// Guards the fix against over-correction: routing through the queue
			// must not make an ordinary scoped deregistration a no-op.
			const { registerInstance, registerInstanceRoot, deregisterInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await registerInstance(realRoot);
			await registerInstanceRoot(tempRoot, "holder-1");
			expect(readEntry().projectRoots).toHaveLength(2);

			await deregisterInstanceRoot(tempRoot, "holder-1");
			expect(readEntry().projectRoots).toHaveLength(1);
		});
	});

	describe("a guessed lsp-fallback root does not out-rank the real one", () => {
		it("the session's real root replaces a synthesized fallback primary", async () => {
			// `recordLspChild` with no `sessionIdentity` synthesizes the host entry
			// from `process.cwd()` and records that provenance as `lsp-fallback`.
			// The real `registerInstance` follows once session_start lands.
			const { recordLspChild, registerInstance } =
				await import("../../clients/instance-registry.js");
			await recordLspChild({
				pid: process.pid + 1,
				serverId: "fake-ts",
				command: "fake-tsserver",
			});
			const synthesized = readEntry();
			expect(synthesized.rootSource).toBe("lsp-fallback");
			expect(synthesized.projectRoot).not.toContain(path.basename(realRoot));

			await registerInstance(realRoot);

			const entry = readEntry();
			expect(entry.projectRoot).toContain(path.basename(realRoot));
			expect(entry.projectRoots?.[0]).toContain(path.basename(realRoot));
			// The guess is gone from the set entirely, and so is its provenance —
			// keeping it would advertise a directory this host never served.
			// Length 1 is right for THIS sequence only, because nothing appended a
			// real root to the synthesized entry in between. The case that does is
			// the next test, and it must keep what was appended.
			expect(entry.projectRoots).toHaveLength(1);
			expect(entry.rootSource).toBeUndefined();
			// The child the synthesis existed to record survives the replacement.
			const raw = JSON.parse(
				fs.readFileSync(path.join(dir, "instances.json"), "utf-8"),
			);
			expect(raw.instances[0].lspChildren).toHaveLength(1);
		});

		it("keeps a real secondary root that was appended to the synthesized entry", async () => {
			// Review round 1, F1. Only the GUESS at index 0 is evidence-free. A
			// declined secondary-root start appends its real root to whatever entry
			// exists (`registerInstanceRoot`, index.ts:1851) and does not clear
			// `rootSource`, so a fallback-synthesized entry can legitimately carry
			// real roots behind the guess. Discarding the whole set would drop them,
			// which makes the shared-checkout guard (#2107) blind to a directory
			// this host genuinely serves — the exact harm #2130 is about.
			const { recordLspChild, registerInstance, registerInstanceRoot } =
				await import("../../clients/instance-registry.js");
			await recordLspChild({
				pid: process.pid + 1,
				serverId: "fake-ts",
				command: "fake-tsserver",
			});
			await registerInstanceRoot(tempRoot, "holder-1");
			// Precondition: the guess still holds the pin and still says it is a
			// guess, so the real root really is sitting behind it.
			const before = readEntry();
			expect(before.rootSource).toBe("lsp-fallback");
			expect(before.projectRoots).toHaveLength(2);

			await registerInstance(realRoot);

			const entry = readEntry();
			// The real root takes the pin, the guess is gone, the appended root
			// survives behind it.
			expect(entry.projectRoot).toContain(path.basename(realRoot));
			expect(entry.projectRoots).toHaveLength(2);
			expect(entry.projectRoots?.[0]).toContain(path.basename(realRoot));
			expect(entry.projectRoots?.[1]).toContain(path.basename(tempRoot));
			expect(entry.rootSource).toBeUndefined();
		});

		it("a session-cwd root is NOT a guess, so it keeps the primary slot", async () => {
			// Mutation guard: the replacement must key on the `lsp-fallback`
			// provenance, not on "an entry already existed". A `service-cwd`
			// identity is real evidence of the root, so a later registration for a
			// different root must APPEND behind it, exactly as #2133 requires.
			const { recordLspChild, registerInstance } =
				await import("../../clients/instance-registry.js");
			await recordLspChild({
				pid: process.pid + 1,
				serverId: "fake-ts",
				command: "fake-tsserver",
				sessionIdentity: {
					projectRoot: realRoot,
					startedAt: new Date().toISOString(),
					rootSource: "service-cwd",
				},
			});
			await registerInstance(tempRoot);

			const entry = readEntry();
			expect(entry.projectRoot).toContain(path.basename(realRoot));
			expect(entry.projectRoots).toHaveLength(2);
		});

		it("the fallback root is replaced only once, by the first real registration", async () => {
			// After the replacement the entry is an ordinary pinned one: a second
			// registration for another root appends and must not steal the pin.
			const { recordLspChild, registerInstance } =
				await import("../../clients/instance-registry.js");
			await recordLspChild({
				pid: process.pid + 1,
				serverId: "fake-ts",
				command: "fake-tsserver",
			});
			await registerInstance(realRoot);
			await registerInstance(tempRoot);

			const entry = readEntry();
			expect(entry.projectRoot).toContain(path.basename(realRoot));
			expect(entry.projectRoots).toHaveLength(2);
			expect(entry.projectRoots?.[1]).toContain(path.basename(tempRoot));
		});
	});

	describe("two concurrent sessions in one process", () => {
		it("the second session's root joins the set instead of clobbering the first", async () => {
			// The live shape #2130 recorded, reproduced end to end: one host
			// process, two module evaluations (pi evaluates the graph up to nine
			// times per pid — #2146), each binding a session under a DIFFERENT
			// root, both registering without awaiting each other.
			const first = await import("../../clients/instance-registry.js");
			vi.resetModules();
			const second = await import("../../clients/instance-registry.js");
			expect(second).not.toBe(first);

			await Promise.all([
				first.registerInstance(realRoot),
				second.registerInstance(tempRoot),
			]);
			await first._settleRegistryMutationsForTests();

			const raw = JSON.parse(
				fs.readFileSync(path.join(dir, "instances.json"), "utf-8"),
			);
			// One host process, one entry — not two, and not a torn file.
			expect(raw.instances).toHaveLength(1);
			const entry = raw.instances[0];
			expect(entry.projectRoot).toContain(path.basename(realRoot));
			expect(entry.projectRoots).toHaveLength(2);
			expect(entry.projectRoots[1]).toContain(path.basename(tempRoot));
			// Both evaluations agree about the set, because both read the file.
			expect(second.getInstanceRoots(entry)).toEqual(
				first.getInstanceRoots(entry),
			);
		});
	});
});
