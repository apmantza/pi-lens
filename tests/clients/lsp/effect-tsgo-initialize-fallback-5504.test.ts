// flake-shape: real-process-spawn — #5504: only a real child that exits after the launcher's startup window and before `initialize` answers reaches the registry's initialize fallback; a launcher double never exits that way.
/**
 * #5504: `@effect/tsgo` 0.55 has no `tsc` subcommand. Its bin starts, then
 * prints `Unknown subcommand "tsc"` and exits, so the launch itself succeeds
 * (the process survives `launchLSP`'s 50 ms startup window) and `initialize`
 * never answers. Before the fix the registry counted that as a spawn failure
 * and the `typescript` server was disabled for the cooldown ladder.
 *
 * The stub waits for the first header line of `initialize` from the client
 * before it exits, so it always exits after `launchLSP` returned and before
 * `initialize` is answered: deterministic, no sleeps. A stub that exits at
 * once would be caught by the existing spawn-failure branch instead.
 *
 * Everything is real: `TypeScriptServer.spawn`, `ClientRegistry.spawnClient`,
 * `launchLSP`, `createLSPClient`, the trust gate and the degradation ledger.
 * The native `.bin/tsc` is a shell stub that runs the fake LSP server.
 *
 * does not prove: Windows (the stubs are POSIX shell scripts).
 */
import fs from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { truncateForLedger } from "../../../clients/ledger-bounds.js";
import {
	ClientRegistry,
	type ClientGenerationHooks,
} from "../../../clients/lsp/client-registry.js";
import {
	TypeScriptServer,
	type LSPServerInfo,
	type LSPSpawnResult,
} from "../../../clients/lsp/server.js";
import {
	flushSessionStartLog,
	SESSIONSTART_LOG_FILE,
} from "../../../clients/sessionstart-logger.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { FAKE_LSP_SERVER_PATH } from "../../support/fake-lsp-server.js";
import { setupTestEnvironment } from "../test-utils.js";

function makeHooks(): ClientGenerationHooks {
	return {
		releaseNotifyWrite: () => undefined,
		forgetReadiness: () => undefined,
		forgetNotifyBacklog: () => undefined,
		clearStallDemotion: () => undefined,
		rearmFirstContact: () => undefined,
		noteDiagnosticsPublished: () => undefined,
	};
}

const registries: ClientRegistry[] = [];
let cleanup: (() => void) | undefined;

function writeExecutable(file: string, body: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
	fs.chmodSync(file, 0o755);
}

// lane: dev-box-only on win32 (the stubs are POSIX shell scripts); the POSIX
// lanes run these real child processes.
const POSIX_REAL_PROCESS = {
	skip: process.platform === "win32",
	timeout: 30_000,
};

const EXITS_BEFORE_INITIALIZE = `#!/bin/sh\nIFS= read -r _line || true\necho 'Unknown subcommand "tsc"' >&2\nexit 1\n`;

function makeFixture(opts: { nativeExitsToo?: boolean } = {}): {
	root: string;
	file: string;
} {
	const env = setupTestEnvironment("pi-lens-5504-");
	cleanup = env.cleanup;
	const root = env.tmpDir;
	fs.writeFileSync(path.join(root, "package.json"), "{}\n");
	fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
	const file = path.join(root, "src", "index.ts");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "export const value = 1;\n");
	const nm = path.join(root, "node_modules");
	fs.mkdirSync(path.join(nm, "typescript"), { recursive: true });
	fs.writeFileSync(
		path.join(nm, "typescript", "package.json"),
		JSON.stringify({ name: "typescript", version: "7.0.2" }),
	);
	writeExecutable(
		path.join(nm, ".bin", "tsc"),
		opts.nativeExitsToo
			? EXITS_BEFORE_INITIALIZE
			: `#!/bin/sh\nexec "${process.execPath}" "${FAKE_LSP_SERVER_PATH}" "$@"\n`,
	);
	fs.mkdirSync(path.join(nm, "@effect", "tsgo"), { recursive: true });
	fs.writeFileSync(
		path.join(nm, "@effect", "tsgo", "package.json"),
		JSON.stringify({ name: "@effect/tsgo", version: "0.55.0" }),
	);
	writeExecutable(
		path.join(nm, ".bin", "effect-tsgo"),
		EXITS_BEFORE_INITIALIZE,
	);
	return { root, file };
}

async function acquire(
	file: string,
	serverFor: (registry: ClientRegistry) => LSPServerInfo = () =>
		TypeScriptServer,
) {
	const registry = new ClientRegistry(
		makeHooks(),
		undefined,
		path.dirname(path.dirname(file)),
	);
	registries.push(registry);
	const spawned = await registry.ensureClientForServer(
		file,
		serverFor(registry),
	);
	return { registry, spawned };
}

/**
 * The production TypeScript row with only `initializeFallback` wrapped, so a
 * cell can count, answer nothing from, or interleave with the real fallback.
 */
function wrapFallback(
	wrap: (
		fallback: NonNullable<LSPSpawnResult["initializeFallback"]>,
	) => NonNullable<LSPSpawnResult["initializeFallback"]>,
): LSPServerInfo {
	return {
		...TypeScriptServer,
		async spawn(root, options) {
			const result = await TypeScriptServer.spawn(root, options);
			if (!result?.initializeFallback) {
				throw new Error("the effect-tsgo launch carries no initializeFallback");
			}
			return { ...result, initializeFallback: wrap(result.initializeFallback) };
		},
	};
}

beforeEach(() => {
	resetDegradationLedger();
	setProjectTrustState("trusted");
});

afterEach(async () => {
	for (const registry of registries.splice(0)) {
		registry.markDestroyed();
		await registry.shutdownClients({ fast: true });
	}
	resetProjectTrust();
	resetDegradationLedger();
	cleanup?.();
	cleanup = undefined;
});

it(
	"falls back to native when effect-tsgo exits before initialize",
	POSIX_REAL_PROCESS,
	async () => {
		const { root, file } = makeFixture();

		const first = await acquire(file);

		expect(first.spawned?.client.getLaunchVariant()).toBe("native-ts7");
		expect(first.spawned?.client.isAlive()).toBe(true);
		expect(first.registry.broken.size).toBe(0);
		expect(first.registry.permanentlyBroken.size).toBe(0);

		// A second registry on the same root: still one row per root and ledger
		// generation, and native again.
		const second = await acquire(file);
		expect(second.spawned?.client.getLaunchVariant()).toBe("native-ts7");
		expect(second.registry.broken.size).toBe(0);

		const rows = getDegradationSummary()
			.filter((group) => group.kind === "lsp-registry-decision")
			.flatMap((group) => group.latestReasons)
			.filter((row) => /^effect-tsgo-launch:g\d+:/.test(row.subject ?? ""));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.subject).toContain(truncateForLedger(root));
		expect(rows[0]?.reason).toMatch(
			/^effect-tsgo failed to initialize, using the native launch/,
		);
	},
);

// Each cell below is a branch of `spawnClient`'s fallback handling, through the
// real registry with only `initializeFallback` wrapped (`wrapFallback`).
it(
	"rethrows the original failure when the fallback answers nothing",
	POSIX_REAL_PROCESS,
	async () => {
		const { file } = makeFixture();
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		try {
			await flushSessionStartLog();
			const before = fs.existsSync(SESSIONSTART_LOG_FILE)
				? fs.statSync(SESSIONSTART_LOG_FILE).size
				: 0;
			let calls = 0;

			const { registry, spawned } = await acquire(file, () =>
				wrapFallback(() => async () => {
					calls += 1;
					return undefined;
				}),
			);

			expect(spawned).toBeUndefined();
			expect(calls).toBe(1);
			expect(registry.broken.size).toBe(1);
			await flushSessionStartLog();
			const written = fs
				.readFileSync(SESSIONSTART_LOG_FILE, "utf8")
				.slice(before);
			expect(written).toMatch(
				/lsp spawn typescript: failed \(\d+ms\) error=\[lsp\] typescript failed to initialize/,
			);
		} finally {
			vi.unstubAllEnvs();
		}
	},
);

it(
	"takes the fallback once and counts its own failure",
	POSIX_REAL_PROCESS,
	async () => {
		const { file } = makeFixture({ nativeExitsToo: true });
		let calls = 0;

		const { registry, spawned } = await acquire(file, () =>
			wrapFallback((fallback) => async (failure) => {
				calls += 1;
				return fallback(failure);
			}),
		);

		expect(spawned).toBeUndefined();
		expect(calls).toBe(1);
		expect(registry.broken.size).toBe(1);
	},
);

it(
	"drops the fallback launch when the service shuts down mid-fallback",
	POSIX_REAL_PROCESS,
	async () => {
		const { file } = makeFixture();
		let replacement: LSPSpawnResult | undefined;

		const { registry, spawned } = await acquire(file, (owner) =>
			wrapFallback((fallback) => async (failure) => {
				owner.markDestroyed();
				replacement = await fallback(failure);
				return replacement;
			}),
		);

		expect(spawned).toBeUndefined();
		const child = replacement?.process.process;
		if (!child) throw new Error("the fallback launched no process");
		if (child.exitCode === null && child.signalCode === null) {
			await once(child, "exit");
		}
		expect(child.killed).toBe(true);
		expect(registry.broken.size).toBe(0);
		expect(registry.getAliveClientCount()).toBe(0);
	},
);

// RECURRENCE GUARDED: #5522 review F3. The catch around the first `connect`
// took `initializeFallback` without reading `isDestroyed`, so a registry shut
// down during the first handshake launched native after shutdown (killed at
// once by `abortSpawn`) and wrote a ledger row blaming effect-tsgo for a
// teardown.
it(
	"takes no fallback when the service shuts down during the first handshake",
	POSIX_REAL_PROCESS,
	async () => {
		const { file } = makeFixture();
		let fallbackCalls = 0;

		const { registry, spawned } = await acquire(file, (owner) => {
			const production = wrapFallback((fallback) => async (failure) => {
				fallbackCalls += 1;
				return fallback(failure);
			});
			return {
				...production,
				async spawn(root, options) {
					const result = await production.spawn(root, options);
					// The stub exits once `initialize` is sent, so the shutdown lands
					// before the first connect rejects.
					setTimeout(() => owner.markDestroyed(), 0);
					return result;
				},
			};
		});

		expect(spawned).toBeUndefined();
		expect(fallbackCalls).toBe(0);
		expect(registry.broken.size).toBe(0);
		expect(registry.getAliveClientCount()).toBe(0);
		const rows = getDegradationSummary()
			.filter((group) => group.kind === "lsp-registry-decision")
			.flatMap((group) => group.latestReasons)
			.filter((row) => /^effect-tsgo-launch:g\d+:/.test(row.subject ?? ""));
		expect(rows).toHaveLength(0);
	},
);
