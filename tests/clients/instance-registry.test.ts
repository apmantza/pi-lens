/**
 * Tests for clients/instance-registry.ts (#449 slice 1) — the cross-process
 * observability substrate: read/write atomicity, corrupt/missing-file
 * recovery, cross-form path normalization, and the kill switch.
 *
 * `getGlobalPiLensDir` is mocked to point at a per-test temp dir so these
 * tests never touch the real `~/.pi-lens/instances.json`.
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

describe("instance-registry", () => {
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-instreg-"));
		// vi.resetModules() gives every test a FRESH instance-registry.js
		// instance, which means a fresh degradation-ledger.js too (its module
		// state — the groups/onceKeys maps — is reinitialized on re-evaluation),
		// so there is nothing to reset here: each test's dynamically-imported
		// ledger already starts empty.
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		removeTempDirSync(dir);
	});

	function registryFilePath(): string {
		return path.join(dir, "instances.json");
	}

	it("registerInstance creates a fresh entry for this pid", async () => {
		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/some/project");

		const raw = fs.readFileSync(registryFilePath(), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.instances).toHaveLength(1);
		expect(parsed.instances[0].pid).toBe(process.pid);
		expect(parsed.instances[0].projectRoot).toContain("some/project");
		expect(parsed.instances[0].lspChildren).toEqual([]);
	});

	it("persists subagent identity when registering a subagent session", async () => {
		vi.stubEnv("PI_SUBAGENT_CHILD", "1");
		vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "reviewer");
		vi.stubEnv("PI_SUBAGENT_PARENT_PID", "12345");
		vi.stubEnv("PI_SUBAGENT_RUN_ID", "run-822");
		const { registerInstance } =
			await import("../../clients/instance-registry.js");

		await registerInstance("/some/project");

		const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
		expect(parsed.instances[0].subagent).toEqual({
			marker: "pi-subagents",
			agentType: "reviewer",
			parentPid: 12345,
			runId: "run-822",
		});
	});

	it("omits the subagent field entirely for a primary session", async () => {
		vi.stubEnv("PI_SUBAGENT_CHILD", "");
		vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "");
		vi.stubEnv("PI_SUBAGENT_PARENT_PID", "");
		vi.stubEnv("PI_SUBAGENT_RUN_ID", "");
		const { registerInstance } =
			await import("../../clients/instance-registry.js");

		await registerInstance("/some/project");

		const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
		expect(parsed.instances[0]).not.toHaveProperty("subagent");
	});

	it("round-trips mixed old and new registry entries through read, register, and reap", async () => {
		const now = new Date().toISOString();
		const oldPid = process.pid + 100_001;
		const newPid = process.pid + 100_002;
		const oldEntry = {
			pid: oldPid,
			startedAt: now,
			projectRoot: "/old",
			lspChildren: [],
			lspChildCount: 0,
			rssBytes: 1,
			heartbeatAt: now,
		};
		const newEntry = {
			...oldEntry,
			pid: newPid,
			projectRoot: "/new",
			subagent: {
				marker: "avtc-pi-subagent",
				agentType: "reviewer",
				parentPid: 12345,
			},
		};
		fs.writeFileSync(
			registryFilePath(),
			JSON.stringify({ instances: [oldEntry, newEntry] }),
			"utf-8",
		);
		const { readInstanceRegistry, registerInstance } =
			await import("../../clients/instance-registry.js");
		const { decideOrphanReaping } =
			await import("../../clients/instance-reaper.js");

		const before = await readInstanceRegistry();
		expect(before).toHaveLength(2);
		expect(() => decideOrphanReaping(before, () => true)).not.toThrow();
		await expect(registerInstance("/current")).resolves.not.toThrow();

		const after = await readInstanceRegistry();
		expect(after).toHaveLength(3);
		expect(
			after.find((entry) => entry.pid === oldEntry.pid)?.subagent,
		).toBeUndefined();
		expect(after.find((entry) => entry.pid === newEntry.pid)?.subagent).toEqual(
			newEntry.subagent,
		);
		expect(() => decideOrphanReaping(after, () => true)).not.toThrow();
	});

	it("registerInstance updates (not duplicates) this pid's prior entry", async () => {
		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/first/root");
		await registerInstance("/second/root");

		const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
		expect(parsed.instances).toHaveLength(1);
		// #2130 changed this contract deliberately. The second root used to
		// OVERWRITE `projectRoot`, which is how a host came to advertise a
		// subagent's temp dir as its own root. Registration is additive now:
		// the primary is pinned and the second root joins the set. See
		// tests/clients/instance-registry-multi-root.test.ts.
		expect(parsed.instances[0].projectRoot).toContain("first/root");
		expect(parsed.instances[0].projectRoots).toHaveLength(2);
		expect(parsed.instances[0].projectRoots[1]).toContain("second/root");
	});

	it("writes atomically via tmp-<pid> + rename (no tmp file left behind, no torn write)", async () => {
		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/atomic/project");

		const entries = fs.readdirSync(dir);
		expect(entries).toContain("instances.json");
		expect(entries.some((e) => e.includes(".tmp-"))).toBe(false);
	});

	it("corrupt JSON in the registry file is treated as empty, never throws", async () => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(registryFilePath(), "{not valid json!!", "utf-8");

		const { registerInstance } =
			await import("../../clients/instance-registry.js");
		await expect(registerInstance("/recovered/project")).resolves.not.toThrow();

		const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
		expect(parsed.instances).toHaveLength(1);
	});

	it("missing registry file on first read/write does not throw", async () => {
		const { registerInstance, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		expect(fs.existsSync(registryFilePath())).toBe(false);
		await expect(registerInstance("/fresh/project")).resolves.not.toThrow();
		const instances = await readInstanceRegistry();
		expect(instances).toHaveLength(1);
	});

	// #1609 layer b: a process SIGKILLed mid-write can leave `instances.json`
	// torn at an arbitrary byte offset. Recovery must be LEGIBLE, not just
	// non-throwing: a genuinely missing file (clean start) is silent, but a
	// present-and-corrupt file must be distinguishable in the logs — an empty
	// result reading the same either way would hide a real torn-write
	// regression behind "looks like a clean start" forever (the empty-must-
	// distinguish-clean-from-errored invariant).
	describe("torn-file fault injection", () => {
		const validPayload = JSON.stringify({
			instances: [
				{
					pid: 424_242,
					startedAt: "2026-01-01T00:00:00.000Z",
					projectRoot: "/some/project",
					lspChildren: [],
					lspChildCount: 0,
					rssBytes: 0,
					heartbeatAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});

		it.each([
			["zero bytes", ""],
			["truncated to an opening brace", "{"],
			[
				"mid-JSON torn tail",
				validPayload.slice(0, Math.floor(validPayload.length / 2)),
			],
			["truncated to a single valid-JSON scalar (wrong shape)", "0"],
		])("recovers legibly from a torn registry (%s)", async (_label, torn) => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(registryFilePath(), torn, "utf-8");

			// #1609 review small fix: the degradation is recorded via
			// recordDegradationOnce (deduped per session, not logged on every
			// call), so the ledger must be imported through the SAME dynamic
			// `import()` as instance-registry.js — vi.resetModules() in
			// beforeEach means a statically-imported (module-top-level) copy of
			// degradation-ledger.js would be a DIFFERENT instance from the one
			// instance-registry.js's own fresh import resolves to (AGENTS.md
			// defect shape 14).
			const { readInstanceRegistry, registerInstance } =
				await import("../../clients/instance-registry.js");
			const { getDegradationSummary } =
				await import("../../clients/degradation-ledger.js");

			// No throw escapes, and the torn bytes are never half-trusted into a
			// wrong-but-valid partial state — the read degrades to empty exactly
			// like a missing file would, never a spliced/partial instance list.
			const instances = await readInstanceRegistry();
			expect(instances).toEqual([]);

			// The recovery is OBSERVABLE: a corrupt-but-present file records a
			// degradation, unlike a genuinely missing one (see the sibling
			// "missing file" test below, which asserts nothing is recorded).
			expect(getDegradationSummary()).toContainEqual(
				expect.objectContaining({ kind: "instance-registry-corrupt" }),
			);

			// The registry keeps working afterward — no stuck latch.
			await expect(registerInstance("/after/recovery")).resolves.not.toThrow();
			const after = await readInstanceRegistry();
			expect(after).toHaveLength(1);
		});

		it("stays silent on a genuinely missing file (clean start, not an error)", async () => {
			expect(fs.existsSync(registryFilePath())).toBe(false);
			const { readInstanceRegistry } =
				await import("../../clients/instance-registry.js");
			const { getDegradationSummary } =
				await import("../../clients/degradation-ledger.js");

			const instances = await readInstanceRegistry();

			expect(instances).toEqual([]);
			expect(getDegradationSummary()).not.toContainEqual(
				expect.objectContaining({ kind: "instance-registry-corrupt" }),
			);
		});

		it("records the degradation only ONCE across repeated reads of the same torn file", async () => {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(registryFilePath(), "{not valid json!!", "utf-8");

			const { readInstanceRegistry } =
				await import("../../clients/instance-registry.js");
			const { getDegradationSummary } =
				await import("../../clients/degradation-ledger.js");

			await readInstanceRegistry();
			await readInstanceRegistry();
			await readInstanceRegistry();

			const entry = getDegradationSummary().find(
				(group) => group.kind === "instance-registry-corrupt",
			);
			expect(entry?.count).toBe(1);
		});
	});

	it("recordLspChild appends a child under this pid's entry", async () => {
		const { registerInstance, recordLspChild, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await recordLspChild({
			pid: 99999,
			serverId: "ast-grep",
			command: "C:\\fake\\ast-grep.exe",
			marker: "C:\\temp\\pi-lens-ast-grep\\baseline.sgconfig.yml",
		});

		const instances = await readInstanceRegistry();
		expect(instances).toHaveLength(1);
		expect(instances[0].lspChildren).toHaveLength(1);
		expect(instances[0].lspChildren[0].serverId).toBe("ast-grep");
		expect(instances[0].lspChildCount).toBe(1);
	});

	it("recordLspChild replaces (not duplicates) an existing pid", async () => {
		const { registerInstance, recordLspChild, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await recordLspChild({ pid: 111, serverId: "ast-grep", command: "a" });
		await recordLspChild({ pid: 111, serverId: "ast-grep", command: "b" });

		const instances = await readInstanceRegistry();
		expect(instances[0].lspChildren).toHaveLength(1);
		expect(instances[0].lspChildren[0].command).toBe("b");
	});

	it("removeLspChild drops the child by pid", async () => {
		const {
			registerInstance,
			recordLspChild,
			removeLspChild,
			readInstanceRegistry,
		} = await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await recordLspChild({ pid: 222, serverId: "typescript", command: "c" });
		await removeLspChild(222);

		const instances = await readInstanceRegistry();
		expect(instances[0].lspChildren).toHaveLength(0);
		expect(instances[0].lspChildCount).toBe(0);
	});

	describe("#1724 — recordLspChild/removeLspChild share one mutation seam", () => {
		it("a forced shutdown's removeLspChild is not lost to a concurrent recordLspChild for a different pid", async () => {
			// Reproduces the dogfood gap: a forced LSP shutdown's deregistration
			// (removeLspChild) firing at roughly the same moment as a DIFFERENT
			// client's spawn (recordLspChild) — e.g. client-ceiling eviction
			// immediately followed by the replacement spawn. Pre-#1724,
			// recordLspChild and removeLspChild each did their own unserialized
			// read-modify-write, so the later WRITE to land could be built from a
			// read taken before the earlier write, silently reverting it (this is
			// exactly the "no read-modify-write isolation" gap atomic-write.ts
			// documents — concurrent same-process writers still need to serialize
			// themselves at the caller's read-modify-write seam).
			const atomicWrite = await import("../../clients/atomic-write.js");
			const {
				registerInstance,
				recordLspChild,
				removeLspChild,
				readInstanceRegistry,
			} = await import("../../clients/instance-registry.js");
			await registerInstance("/proj");
			await recordLspChild({ pid: 111, serverId: "ast-grep", command: "a" });

			const realWrite = atomicWrite.writeFileAtomicAsync;
			let releaseRecordWrite: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				releaseRecordWrite = resolve;
			});
			let writeCallCount = 0;
			const writeSpy = vi
				.spyOn(atomicWrite, "writeFileAtomicAsync")
				.mockImplementation(async (...args) => {
					writeCallCount++;
					if (writeCallCount === 1) {
						// This is recordLspChild(222)'s write. Hold it so
						// removeLspChild(111) — started after it, on the same
						// pre-removal snapshot — can complete its own
						// read-modify-write first.
						await gate;
					}
					return realWrite(...(args as Parameters<typeof realWrite>));
				});

			// Kick off both without awaiting either individually: pre-fix, each
			// runs its own unserialized read-modify-write and removeLspChild can
			// race ahead to completion while recordLspChild's write sits gated;
			// post-fix, removeLspChild is queued behind recordLspChild and simply
			// waits for the gate too. Either way, only awaiting Promise.all AFTER
			// releasing the gate avoids assuming which ordering is in effect.
			const recordPromise = recordLspChild({
				pid: 222,
				serverId: "typescript",
				command: "b",
			});
			const removePromise = removeLspChild(111);
			// Give a real-fs read-modify-write cycle time to land before
			// releasing the gated write, so pre-fix's race is deterministic
			// rather than dependent on a single microtask tick.
			await new Promise((resolve) => setTimeout(resolve, 50));
			releaseRecordWrite();
			await Promise.all([recordPromise, removePromise]);
			writeSpy.mockRestore();

			const instances = await readInstanceRegistry();
			const pids = instances[0].lspChildren.map((child) => child.pid);
			expect(pids).toContain(222); // the concurrent registration must land
			expect(pids).not.toContain(111); // the removal must not be reverted
		});

		it("removeLspChild refuses to drop a pid whose recorded marker no longer matches (recycled-pid guard)", async () => {
			const {
				registerInstance,
				recordLspChild,
				removeLspChild,
				readInstanceRegistry,
			} = await import("../../clients/instance-registry.js");
			await registerInstance("/proj");
			await recordLspChild({
				pid: 444,
				serverId: "ast-grep",
				command: "ast-grep.exe",
				marker: "C:\\temp\\pi-lens-ast-grep\\new-spawn.sgconfig.yml",
			});

			// A caller holding a stale marker for a pid that's since been
			// recycled onto a differently-marked child must never remove it.
			await removeLspChild(
				444,
				"C:\\temp\\pi-lens-ast-grep\\stale.sgconfig.yml",
			);
			let instances = await readInstanceRegistry();
			expect(instances[0].lspChildren.map((c) => c.pid)).toContain(444);

			// The correct marker still removes it.
			await removeLspChild(
				444,
				"C:\\temp\\pi-lens-ast-grep\\new-spawn.sgconfig.yml",
			);
			instances = await readInstanceRegistry();
			expect(instances[0].lspChildren.map((c) => c.pid)).not.toContain(444);
		});
	});

	it("recordLspChild works even without a prior registerInstance (synthesizes a minimal entry)", async () => {
		const { recordLspChild, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await recordLspChild({
			pid: 333,
			serverId: "python",
			command: "d",
			sessionIdentity: {
				projectRoot: path.join(dir, "real-session-root"),
				startedAt: "2026-08-26T14:43:04.335Z",
				rootSource: "session-cwd",
			},
		});

		const instances = await readInstanceRegistry();
		expect(instances).toHaveLength(1);
		expect(instances[0].lspChildren).toHaveLength(1);
		expect(instances[0].projectRoot).toContain("real-session-root");
		expect(instances[0].rootSource).toBe("session-cwd");
		expect(instances[0].startedAt).toBe("2026-08-26T14:43:04.335Z");
	});

	it("preserves subagent identity and records missing-registration recovery", async () => {
		vi.stubEnv("PI_SUBAGENT_CHILD", "1");
		vi.stubEnv("PI_SUBAGENT_CHILD_AGENT", "reviewer");
		vi.stubEnv("PI_SUBAGENT_PARENT_PID", "12345");
		vi.stubEnv("PI_SUBAGENT_RUN_ID", "run-recovery");
		const { recordLspChild } =
			await import("../../clients/instance-registry.js");
		const { getDegradationSummary } =
			await import("../../clients/degradation-ledger.js");

		await recordLspChild({
			pid: 334,
			serverId: "typescript",
			command: "d",
			sessionIdentity: {
				projectRoot: path.join(dir, "subagent-root"),
				startedAt: "2026-08-26T14:43:04.335Z",
			},
		});

		const entry = JSON.parse(fs.readFileSync(registryFilePath(), "utf8"))
			.instances[0];
		expect(entry.subagent).toEqual({
			marker: "pi-subagents",
			agentType: "reviewer",
			parentPid: 12345,
			runId: "run-recovery",
		});
		expect(getDegradationSummary()).toContainEqual(
			expect.objectContaining({
				kind: "instance-registry-registration-missing",
				count: 1,
			}),
		);
	});

	it("records the identity fallback when child-first registration lacks session identity", async () => {
		const { recordLspChild } =
			await import("../../clients/instance-registry.js");
		const { getDegradationSummary } =
			await import("../../clients/degradation-ledger.js");

		await recordLspChild({
			pid: 335,
			serverId: "typescript",
			command: "d",
		});

		const entry = JSON.parse(fs.readFileSync(registryFilePath(), "utf8"))
			.instances[0];
		expect(entry.rootSource).toBe("lsp-fallback");
		expect(getDegradationSummary()).toContainEqual(
			expect.objectContaining({
				kind: "instance-registry-identity-fallback",
				count: 1,
			}),
		);
	});

	// #3447: a registration can be dropped for good -- the registry lock's
	// bounded wait ran out (recorded as instance-registry-lock-timeout), or
	// the file was reaped. The heartbeat used to skip a missing entry, so the
	// session stayed invisible to the shared-checkout guard for its whole
	// life. It now re-registers from the root registerInstance was given.
	describe("heartbeat re-registration (#3447)", () => {
		it("re-registers this process when its entry went missing", async () => {
			const {
				registerInstance,
				updateHeartbeat,
				_settleRegistryMutationsForTests,
			} = await import("../../clients/instance-registry.js");
			const { getDegradationSummary } =
				await import("../../clients/degradation-ledger.js");
			await registerInstance("/some/project");
			fs.writeFileSync(registryFilePath(), JSON.stringify({ instances: [] }));

			await updateHeartbeat();
			await _settleRegistryMutationsForTests();

			const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
			expect(parsed.instances.map((e: { pid: number }) => e.pid)).toEqual([
				process.pid,
			]);
			expect(parsed.instances[0].projectRoot).toContain("some/project");
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "instance-registry-registration-missing",
				)?.latestReasons[0]?.reason,
			).toMatch(/heartbeat/);
		});

		it("heals a registration the lock timeout dropped", async () => {
			const {
				registerInstance,
				updateHeartbeat,
				_settleRegistryMutationsForTests,
			} = await import("../../clients/instance-registry.js");
			// A fresh lock held by a live process that is not this one: the
			// bounded wait runs out and the registration is dropped.
			const lock = `${registryFilePath()}.lock`;
			fs.writeFileSync(lock, `${process.ppid} ${Date.now()}\n`);
			await registerInstance("/some/project");
			expect(fs.existsSync(registryFilePath())).toBe(false);
			fs.rmSync(lock);

			await updateHeartbeat();
			await _settleRegistryMutationsForTests();

			const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
			expect(parsed.instances.map((e: { pid: number }) => e.pid)).toEqual([
				process.pid,
			]);
		});

		it("does not resurrect an instance that deregistered", async () => {
			const {
				registerInstance,
				deregisterInstance,
				updateHeartbeat,
				_settleRegistryMutationsForTests,
			} = await import("../../clients/instance-registry.js");
			await registerInstance("/some/project");
			deregisterInstance();

			await updateHeartbeat();
			await _settleRegistryMutationsForTests();

			const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
			expect(parsed.instances).toEqual([]);
		});

		it("does not resurrect an entry whose last root was deregistered", async () => {
			const {
				registerInstance,
				deregisterInstanceRoot,
				updateHeartbeat,
				_settleRegistryMutationsForTests,
			} = await import("../../clients/instance-registry.js");
			await registerInstance("/some/project");
			await deregisterInstanceRoot("/some/project");

			await updateHeartbeat();
			await _settleRegistryMutationsForTests();

			const parsed = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
			expect(parsed.instances).toEqual([]);
		});

		it("does not re-register a root deregistered while its entry was already missing", async () => {
			const {
				registerInstance,
				deregisterInstanceRoot,
				updateHeartbeat,
				_settleRegistryMutationsForTests,
			} = await import("../../clients/instance-registry.js");
			const lock = `${registryFilePath()}.lock`;
			fs.writeFileSync(lock, `${process.ppid} ${Date.now()}\n`);
			await registerInstance("/some/project");
			fs.rmSync(lock);
			await deregisterInstanceRoot("/some/project");

			await updateHeartbeat();
			await _settleRegistryMutationsForTests();

			expect(fs.existsSync(registryFilePath())).toBe(false);
		});

		it("never replays a registration into a different registry file", async () => {
			// The intent is process-wide. A registration made against one
			// registry (an earlier PI_LENS_HOME, or an earlier test) must not be
			// written into another the first time its heartbeat misses.
			const {
				registerInstance,
				updateHeartbeat,
				_settleRegistryMutationsForTests,
			} = await import("../../clients/instance-registry.js");
			await registerInstance("/some/project");
			const firstDir = dir;
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-instreg-"));
			try {
				await updateHeartbeat();
				await _settleRegistryMutationsForTests();

				expect(fs.existsSync(registryFilePath())).toBe(false);
			} finally {
				removeTempDirSync(firstDir);
			}
		});
	});

	it("updateHeartbeat refreshes heartbeatAt and rssBytes for this pid", async () => {
		const { registerInstance, updateHeartbeat, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		const before = (await readInstanceRegistry())[0].heartbeatAt;

		await new Promise((r) => setTimeout(r, 5));
		await updateHeartbeat();

		const after = await readInstanceRegistry();
		expect(after[0].heartbeatAt).not.toBe(before);
		expect(after[0].rssBytes).toBeGreaterThan(0);
	});

	// --- #620: CPU%/child resource-usage patch fields on updateHeartbeat -----

	it("updateHeartbeat records host cpuPercent when the patch supplies one", async () => {
		const { registerInstance, updateHeartbeat, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await updateHeartbeat({ cpuPercent: 37.5 });

		const instances = await readInstanceRegistry();
		expect(instances[0].cpuPercent).toBe(37.5);
	});

	it("updateHeartbeat leaves cpuPercent untouched when the patch omits it (best-effort — never zeroed)", async () => {
		const { registerInstance, updateHeartbeat, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await updateHeartbeat({ cpuPercent: 20 });
		await updateHeartbeat(); // no cpuPercent this tick — sampling may have failed

		const instances = await readInstanceRegistry();
		expect(instances[0].cpuPercent).toBe(20);
	});

	it("updateHeartbeat applies childUsage onto matching lspChildren by pid", async () => {
		const {
			registerInstance,
			recordLspChild,
			updateHeartbeat,
			readInstanceRegistry,
		} = await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await recordLspChild({
			pid: 4001,
			serverId: "typescript",
			command: "tsserver",
		});
		await recordLspChild({ pid: 4002, serverId: "ast-grep", command: "sg" });

		await updateHeartbeat({
			childUsage: {
				4001: { rssBytes: 123456, cpuPercent: 8 },
			},
		});

		const instances = await readInstanceRegistry();
		const children = instances[0].lspChildren;
		const tsChild = children.find((c) => c.pid === 4001);
		const sgChild = children.find((c) => c.pid === 4002);
		expect(tsChild?.rssBytes).toBe(123456);
		expect(tsChild?.cpuPercent).toBe(8);
		// Un-sampled child this tick keeps no stale garbage — simply undefined,
		// never a fabricated zero.
		expect(sgChild?.rssBytes).toBeUndefined();
		expect(sgChild?.cpuPercent).toBeUndefined();
	});

	it("updateHeartbeat's childUsage for a pid no longer in lspChildren is silently ignored", async () => {
		const {
			registerInstance,
			recordLspChild,
			updateHeartbeat,
			readInstanceRegistry,
		} = await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		await recordLspChild({ pid: 5001, serverId: "python", command: "pyright" });

		await expect(
			updateHeartbeat({ childUsage: { 9999: { cpuPercent: 99 } } }),
		).resolves.not.toThrow();

		const instances = await readInstanceRegistry();
		expect(instances[0].lspChildren).toHaveLength(1);
		expect(instances[0].lspChildren[0].pid).toBe(5001);
	});

	it("deregisterInstance removes this pid's entry synchronously", async () => {
		const { registerInstance, deregisterInstance, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("/proj");
		deregisterInstance();

		const instances = await readInstanceRegistry();
		expect(instances).toHaveLength(0);
	});

	it("deregisterInstance on an already-empty registry is a safe no-op", async () => {
		const { deregisterInstance } =
			await import("../../clients/instance-registry.js");
		expect(() => deregisterInstance()).not.toThrow();
	});

	it("cross-form project roots (backslash vs forward-slash) normalize to the same entry", async () => {
		const { registerInstance, readInstanceRegistry } =
			await import("../../clients/instance-registry.js");
		await registerInstance("C:\\foo\\bar");
		const first = (await readInstanceRegistry())[0].projectRoot;

		await registerInstance("C:/foo/bar");
		const instances = await readInstanceRegistry();

		expect(instances).toHaveLength(1); // same pid, same normalized root — one entry
		expect(instances[0].projectRoot).toBe(first);
	});

	describe("computeResourceFootprint / getResourceFootprint (#620)", () => {
		it("computeResourceFootprint is pure: aggregates host + lspChildren across instances", async () => {
			const { computeResourceFootprint } =
				await import("../../clients/instance-registry.js");
			const footprint = computeResourceFootprint([
				{
					pid: 1,
					startedAt: "t",
					projectRoot: "/a",
					rssBytes: 100,
					cpuPercent: 5,
					heartbeatAt: "t",
					lspChildCount: 2,
					lspChildren: [
						{
							pid: 11,
							serverId: "typescript",
							command: "tsserver",
							spawnedAt: "t",
							rssBytes: 50,
							cpuPercent: 3,
						},
						{
							pid: 12,
							serverId: "ast-grep",
							command: "sg",
							spawnedAt: "t",
							// unsampled — no rss/cpu this tick
						},
					],
				},
				{
					pid: 2,
					startedAt: "t",
					projectRoot: "/b",
					rssBytes: 200,
					// no cpuPercent sampled yet for this instance
					heartbeatAt: "t",
					lspChildCount: 0,
					lspChildren: [],
				},
			]);

			expect(footprint.instanceCount).toBe(2);
			expect(footprint.totalLspChildCount).toBe(2);
			// 100 (host1) + 50 (child 11) + 0 (unsampled child 12) + 200 (host2)
			expect(footprint.totalRssBytes).toBe(350);
			// 5 (host1) + 3 (child11) + 0 (unsampled) + 0 (instance2 unsampled)
			expect(footprint.totalCpuPercent).toBe(8);

			const inst1 = footprint.perInstance.find((i) => i.pid === 1);
			expect(inst1?.lspChildRssBytes).toBe(50);
			expect(inst1?.lspChildCpuPercent).toBe(3);
		});

		it("computeResourceFootprint on an empty registry returns all-zero totals", async () => {
			const { computeResourceFootprint } =
				await import("../../clients/instance-registry.js");
			const footprint = computeResourceFootprint([]);
			expect(footprint).toEqual({
				instanceCount: 0,
				totalRssBytes: 0,
				totalCpuPercent: 0,
				totalLspChildCount: 0,
				perInstance: [],
			});
		});

		it("getResourceFootprint reads the live registry and aggregates it end-to-end", async () => {
			const {
				registerInstance,
				recordLspChild,
				updateHeartbeat,
				getResourceFootprint,
			} = await import("../../clients/instance-registry.js");
			await registerInstance("/proj");
			await recordLspChild({
				pid: 7001,
				serverId: "typescript",
				command: "tsserver",
			});
			await updateHeartbeat({
				cpuPercent: 10,
				childUsage: { 7001: { rssBytes: 999, cpuPercent: 2 } },
			});

			const footprint = await getResourceFootprint();
			expect(footprint.instanceCount).toBe(1);
			expect(footprint.totalLspChildCount).toBe(1);
			expect(footprint.totalCpuPercent).toBe(12);
			expect(footprint.totalRssBytes).toBeGreaterThan(999); // host rss + 999
		});

		// --- #735: dead-pid registry entries must not report as live instances ---

		it("computeResourceFootprint drops instances whose pid is confirmed dead when isPidAlive is supplied", async () => {
			const { computeResourceFootprint } =
				await import("../../clients/instance-registry.js");
			const deadPid = process.pid + 100_003;
			const registry = [
				{
					pid: 1,
					startedAt: "t",
					projectRoot: "/alive",
					rssBytes: 100,
					cpuPercent: 5,
					heartbeatAt: "t",
					lspChildCount: 0,
					lspChildren: [],
				},
				{
					pid: deadPid, // classified by the injected predicate below
					startedAt: "t",
					projectRoot: "/dead",
					rssBytes: 233 * 1024 * 1024,
					cpuPercent: 12,
					heartbeatAt: "t",
					lspChildCount: 0,
					lspChildren: [],
				},
			];
			const isPidAlive = (pid: number) => pid !== deadPid;

			const footprint = computeResourceFootprint(registry, isPidAlive);

			expect(footprint.instanceCount).toBe(1);
			expect(footprint.perInstance.map((i) => i.pid)).toEqual([1]);
			expect(footprint.totalRssBytes).toBe(100);
			expect(footprint.totalCpuPercent).toBe(5);
		});

		it("computeResourceFootprint applies no filtering when isPidAlive is omitted (pure default, unchanged pre-#735 behavior)", async () => {
			const { computeResourceFootprint } =
				await import("../../clients/instance-registry.js");
			const registry = [
				{
					pid: 99999,
					startedAt: "t",
					projectRoot: "/whatever",
					rssBytes: 50,
					cpuPercent: 1,
					heartbeatAt: "t",
					lspChildCount: 0,
					lspChildren: [],
				},
			];

			const footprint = computeResourceFootprint(registry);

			expect(footprint.instanceCount).toBe(1);
			expect(footprint.totalRssBytes).toBe(50);
		});

		it("getResourceFootprint excludes a dead-pid instance and opportunistically prunes it from the registry file", async () => {
			const {
				registerInstance,
				recordLspChild,
				getResourceFootprint,
				readInstanceRegistry,
			} = await import("../../clients/instance-registry.js");
			const deadPid = process.pid + 100_000;
			await registerInstance("/proj");
			await recordLspChild({
				pid: 7002,
				serverId: "typescript",
				command: "tsserver",
			});

			// Simulate a second, hard-killed instance's stale registry entry by
			// writing directly to the registry file (bypassing registerInstance,
			// which always stamps the CURRENT process's own live pid).
			const raw = JSON.parse(fs.readFileSync(registryFilePath(), "utf-8"));
			raw.instances.push({
				pid: deadPid, // classified by the injected predicate below
				startedAt: "t",
				projectRoot: "/dead-project",
				rssBytes: 233 * 1024 * 1024,
				cpuPercent: 9,
				heartbeatAt: new Date().toISOString(),
				lspChildCount: 0,
				lspChildren: [],
			});
			fs.writeFileSync(registryFilePath(), JSON.stringify(raw), "utf-8");

			const isPidAlive = (pid: number) => pid !== deadPid;
			const footprint = await getResourceFootprint(isPidAlive);

			expect(footprint.instanceCount).toBe(1);
			expect(footprint.perInstance.map((i) => i.pid)).not.toContain(deadPid);

			// Prune is fire-and-forget, so poll for the background write instead
			// of budgeting a fixed sleep. A loaded CI runner can take well over
			// 20ms to land a locked read-modify-write, which made the fixed wait
			// fail as a host-dependent flake rather than a real regression.
			let remaining = await readInstanceRegistry();
			const pruneDeadline = Date.now() + 5000;
			while (
				remaining.some((i) => i.pid === deadPid) &&
				Date.now() < pruneDeadline
			) {
				await new Promise((r) => setTimeout(r, 20));
				remaining = await readInstanceRegistry();
			}
			expect(remaining.map((i) => i.pid)).not.toContain(deadPid);
			expect(remaining).toHaveLength(1);
		});

		it("getResourceFootprint leaves the registry untouched when every pid is alive", async () => {
			const { registerInstance, getResourceFootprint, readInstanceRegistry } =
				await import("../../clients/instance-registry.js");
			await registerInstance("/proj");

			const footprint = await getResourceFootprint(() => true);
			expect(footprint.instanceCount).toBe(1);

			await new Promise((r) => setTimeout(r, 20));
			const remaining = await readInstanceRegistry();
			expect(remaining).toHaveLength(1);
		});
	});

	describe("kill switch (PI_LENS_INSTANCE_REGISTRY=0)", () => {
		const originalEnv = process.env.PI_LENS_INSTANCE_REGISTRY;

		afterEach(() => {
			if (originalEnv === undefined) {
				delete process.env.PI_LENS_INSTANCE_REGISTRY;
			} else {
				process.env.PI_LENS_INSTANCE_REGISTRY = originalEnv;
			}
		});

		it("disables every mutating export as a no-op", async () => {
			process.env.PI_LENS_INSTANCE_REGISTRY = "0";
			const {
				registerInstance,
				recordLspChild,
				removeLspChild,
				updateHeartbeat,
				deregisterInstance,
				_resetInstanceRegistryEnabledForTests,
			} = await import("../../clients/instance-registry.js");
			_resetInstanceRegistryEnabledForTests();

			await registerInstance("/proj");
			await recordLspChild({ pid: 1, serverId: "x", command: "y" });
			await removeLspChild(1);
			await updateHeartbeat();
			deregisterInstance();

			expect(fs.existsSync(registryFilePath())).toBe(false);
		});

		it("re-enables when the env var is unset again (memoized cache reset)", async () => {
			process.env.PI_LENS_INSTANCE_REGISTRY = "0";
			const mod = await import("../../clients/instance-registry.js");
			mod._resetInstanceRegistryEnabledForTests();
			await mod.registerInstance("/proj");
			expect(fs.existsSync(registryFilePath())).toBe(false);

			delete process.env.PI_LENS_INSTANCE_REGISTRY;
			mod._resetInstanceRegistryEnabledForTests();
			await mod.registerInstance("/proj");
			expect(fs.existsSync(registryFilePath())).toBe(true);
		});
	});
});
