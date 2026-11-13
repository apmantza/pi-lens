/**
 * #1754 review F6: the runner-helpers stale-write ledger SUBJECTS.
 *
 * `guardedWrite`'s whole justification is that a dropped write stays
 * identifiable — "which shim", "which tool in which cwd" — rather than
 * collapsing into one anonymous counter. That claim was proven only at the
 * workspace-cache site. These pin it at the two dispatch-availability sites.
 *
 * Kept in its own file so `runner-helpers.test.ts`, whose #1674 straddle
 * regression is the behavior proof for this migration, stays untouched.
 *
 * #5575: the ledger retains its subject through `truncateForLedger`, so a row
 * built from a fixture path is cut at `LEDGER_FIELD_MAX` (200) characters plus
 * the `…` marker. Two assertions here used to read the END of a subject, so
 * they passed or failed with the host's TMPDIR length rather than with the
 * stamp contract. They now compare the row against the bounded rendering of the
 * identity the guard builds, and the stamp's `:size` component is pinned where
 * it is load-bearing — as the resolver's own memo key — so a long temp root
 * cannot hide it and a stamp that lost its size tail still reddens the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../../clients/degradation-ledger.js";
import { truncateForLedger } from "../../../../clients/ledger-bounds.js";
import { normalizeEphemeralMapKey } from "../../../../clients/path-utils.js";
import {
	resetDispatchAvailabilityState,
	resolveAvailableOrInstall,
	findManagedNodeToolBinary,
} from "../../../../clients/dispatch/runners/utils/runner-helpers.js";
import { setupTestEnvironment } from "../../test-utils.js";

vi.mock("../../../../clients/installer/index.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../../clients/installer/index.js")
		>();
	return { ...actual, verifyToolBinary: vi.fn().mockResolvedValue(true) };
});

/** A whole-second mtime, so a size-only edit moves exactly one stamp axis. */
const FIXTURE_MTIME_SECONDS = 1_600_000_000;

function staleWrites(): Array<{ subject: string; reason: string }> {
	return (
		getDegradationSummary().find(
			(entry) => entry.kind === "generation-guard-stale-write",
		)?.latestReasons ?? []
	);
}

const originalHome = process.env.PI_LENS_HOME;

beforeEach(() => {
	resetDegradationLedger();
	resetDispatchAvailabilityState();
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalHome;
	resetDispatchAvailabilityState();
});

describe("dispatch-availability stale-write subjects (#1754 review F6)", () => {
	it("names the (tool, cwd) pair when a resolve/install transaction straddles a reset", async () => {
		const env = setupTestEnvironment("pi-lens-genguard-resolve-");
		try {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const checker = {
				isAvailableAsync: async (): Promise<boolean> => {
					await gate;
					return true;
				},
				getCommand: (): string | null => "toolbin",
			};

			const pending = resolveAvailableOrInstall(
				checker,
				"ledgersubjecttool",
				env.tmpDir,
			);
			// The session boundary falls inside the transaction, so its eviction
			// guard must drop rather than delete a fresh session's entry.
			resetDispatchAvailabilityState();
			release?.();
			await pending;

			const writes = staleWrites();
			expect(writes).toHaveLength(1);
			// The discriminating identity: which tool, in which cwd. Compare the row
			// against the guarded write's full subject through the display bound
			// (`dispatch-availability:${tool}@${cwdKey}`), so the cwd is pinned as
			// far as the ledger retains it on any host: a subject that dropped the
			// cwd, or spelled it with anything but the pair's normalized key, misses
			// under a short and a long TMPDIR alike (#5575).
			const expectedSubject = `dispatch-availability:ledgersubjecttool@${normalizeEphemeralMapKey(env.tmpDir)}`;
			expect(writes[0]?.subject).toBe(truncateForLedger(expectedSubject));
			// One dropped write for this pair, counted once.
			expect(writes[0]?.reason).toContain("(count: 1)");
		} finally {
			env.cleanup();
		}
	});

	it("names the shim stamp when a managed verification straddles a reset", async () => {
		const installerMod = await import("../../../../clients/installer/index.js");
		const env = setupTestEnvironment("pi-lens-genguard-managed-");
		try {
			process.env.PI_LENS_HOME = env.tmpDir;
			resetDispatchAvailabilityState();
			resetDegradationLedger();
			const shim =
				process.platform === "win32"
					? path.join(
							env.tmpDir,
							"tools",
							"node_modules",
							".bin",
							"subjtool.cmd",
						)
					: path.join(env.tmpDir, "tools", "node_modules", ".bin", "subjtool");
			fs.mkdirSync(path.dirname(shim), { recursive: true });
			fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
			// Pin the mtime to a whole second and re-apply it after the size edit,
			// so the second touch of the shim differs from the first on the SIZE
			// axis only. A drifted mtime would change the stamp through a different
			// component and hide a key that stopped carrying `:size`.
			fs.utimesSync(shim, FIXTURE_MTIME_SECONDS, FIXTURE_MTIME_SECONDS);

			let straddleNextVerification = false;
			const verify = vi.mocked(installerMod.verifyToolBinary);
			verify.mockClear();
			verify.mockImplementation(async (_bin, _onVersion, onTransient) => {
				if (straddleNextVerification) {
					straddleNextVerification = false;
					resetDispatchAvailabilityState();
				}
				onTransient?.();
				return false;
			});

			// (1) A verification that never got a fair run is memoized under the
			// 60s cooldown, keyed by the shim's `<path>:<mtimeMs>:<size>` stamp. No
			// session boundary falls inside it, so the verdict write stands and the
			// ledger stays silent.
			await findManagedNodeToolBinary("subjtool");
			expect(verify).toHaveBeenCalledTimes(1);
			expect(staleWrites()).toHaveLength(0);

			// (2) Grow the shim and hold its mtime fixed: the stamp's size tail is
			// the only thing that moved. A key that dropped it would answer (3) from
			// the memo instead of probing again, which is what makes this assertion
			// the length-independent proof of the size component (#5575).
			const sizeBeforeEdit = fs.statSync(shim).size;
			straddleNextVerification = true;
			fs.appendFileSync(shim, "\n# a longer shim\n");
			fs.utimesSync(shim, FIXTURE_MTIME_SECONDS, FIXTURE_MTIME_SECONDS);
			const stat = fs.statSync(shim);
			expect(stat.mtimeMs).toBe(FIXTURE_MTIME_SECONDS * 1000);
			expect(stat.size).toBeGreaterThan(sizeBeforeEdit);

			// (3) The fresh probe straddles the session boundary, so its verdict
			// write and its in-flight eviction both drop, for THIS shim.
			await findManagedNodeToolBinary("subjtool");
			expect(verify).toHaveBeenCalledTimes(2);

			const writes = staleWrites();
			// Two drops, one identity: the verdict memo write and the in-flight
			// eviction, both for THIS shim. `incrementDegradationCount` keeps one
			// entry per subject, so a stuck shim cannot storm the ledger.
			expect(writes).toHaveLength(1);
			expect(writes[0]?.reason).toContain("(count: 2)");
			// The row is the stamp: `<path>:<mtimeMs>:<size>`, rendered through the
			// ledger's bound. On a short temp root this is the whole stamp, size tail
			// and all; on a host whose TMPDIR pushes it past `LEDGER_FIELD_MAX` the
			// tail is off the retained text for ANY producer, so the size contract is
			// carried by the probe count above rather than by the row's end.
			const expectedSubject = `dispatch-availability:${shim}:${stat.mtimeMs}:${stat.size}`;
			expect(writes[0]?.subject).toBe(truncateForLedger(expectedSubject));
		} finally {
			vi.mocked(installerMod.verifyToolBinary).mockReset();
			vi.mocked(installerMod.verifyToolBinary).mockResolvedValue(true);
			env.cleanup();
		}
	});

	it("stays silent when no reset straddles the transaction", async () => {
		const env = setupTestEnvironment("pi-lens-genguard-quiet-");
		try {
			await resolveAvailableOrInstall(
				{
					isAvailableAsync: async (): Promise<boolean> => true,
					getCommand: (): string | null => "toolbin",
				},
				"quiettool",
				env.tmpDir,
			);
			expect(staleWrites()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});
});
