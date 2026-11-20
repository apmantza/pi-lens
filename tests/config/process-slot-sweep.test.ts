/**
 * AGENTS.md shape 25 (#2146): process-wide state has ONE seam,
 * `getProcessSingleton` (`clients/process-singletons.ts`).
 *
 * pi evaluates the pi-lens module graph more than once per process, so state
 * that must exist once per process cannot sit in module scope. The seam also
 * carries a family version: a cell another build shaped differently is
 * discarded with one `process-singleton-reset` record instead of being read as
 * this build's. A hand-rolled slot (`globalThis[Symbol.for(...)]`, a property
 * hung on `process`) shares across evaluations but adopts whatever it finds,
 * and four of them did: spawn-timeout-cooldown, the opaque baseline store,
 * the probe-home memo and safe-spawn's lifetime registry. The fold that moved
 * them onto the seam is `tests/clients/process-singleton-members.test.ts`; this
 * is the layer that keeps the next slot from being written beside it.
 *
 * The detector is `tests/support/process-slot-scan.ts`, and its state table
 * (the admitted forms, and the three plant families: alias, indirect call,
 * value through another binding) is `tests/support/process-slot-scan.test.ts`.
 * It reads syntax trees, so a comment or a string that spells the names is
 * never a site.
 *
 * SCOPE (shape 80, one verdict per root a slot can be written in): `clients/`,
 * `tools/`, `mcp/` and `index.ts`, the shipped runtime. `scripts/` is out:
 * each script is its own entry process, never a module graph evaluated twice
 * beside another (the eight scripts that spell a needle read `globalThis` or
 * `Symbol.for` for their own feature tests, none keeps cross-evaluation
 * state). `tests/` is out: a test's module state is reset by the harness, and
 * `tests/support` helpers read the seam instead of holding a slot.
 *
 * KNOWN RESIDUAL (an admitted form that is too broad, not an unread spelling):
 * a write to `process.env.<name>` is admitted because the environment is how a
 * parent hands configuration to its children, so a latch spelled as an
 * environment variable passes. Live population of that spelling used as a
 * once-per-process latch: none found by hand on the authoring head.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	mayHoldProcessSlot,
	scanProcessSlotSites,
} from "../support/process-slot-scan.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const SCAN_ROOTS = ["clients", "tools", "mcp"] as const;

/** Half the live file count per tree (clients 512, tools 16, mcp 6), so a moved root reds. */
const FILE_FLOORS: Readonly<Record<string, number>> = {
	clients: 256,
	tools: 8,
	mcp: 3,
};

const BRIDGE =
	"cross-build wire contract: the `Symbol.for` key IS the API, because a producer from another build (a harness, a bundled copy) must find the bridge by that exact name, so it cannot move behind a versioned family cell. It carries its own version in the key.";

const BRAND =
	"a class brand (`instanceof` across module evaluations), not a store: it holds no state to version and no cell to adopt, so the seam has nothing to hold for it.";

const PLATFORM_READ =
	"a read of a platform global or an optional runtime API (WebAssembly, Bun, `getActiveResourcesInfo`, `process` destructured for `platform` and `arch`), not a slot: nothing is stored.";

const CONSOLE_PATCH =
	"a console patch with its own per-evaluation restore record (the guard keeps the originals it replaced, so a later patch is never clobbered); it is a process-wide effect, not a state cell another evaluation reads.";

/** The seam's own slot. Admitted by file and symbol, so a second slot inside it still reds. */
const SEAM_ADMISSIONS: Readonly<Record<string, string>> = {
	"clients/process-singletons.ts#SINGLETON_HOST_KEY":
		"The seam's own container key (#2146): the one `Symbol.for` slot every family cell lives behind, versioned by `SINGLETON_HOST_KEY`'s own suffix.",
	"clients/process-singletons.ts#singletonHost":
		"The seam's own host object for the container above: the one `globalThis` read that every family goes through.",
};

/**
 * Every other site. The baseline only shrinks: a fold deletes its row, and a
 * row whose site moved or vanished reds as stale.
 */
const BASELINE: Readonly<Record<string, string>> = {
	"clients/io-bridge-contract.ts#IO_BRIDGE_SYMBOL": BRIDGE,
	"clients/mutation-bridge.ts#MUTATION_BRIDGE_KEY": BRIDGE,
	"clients/read-bridge.ts#READ_BRIDGE_KEY": BRIDGE,
	"clients/process-bridge.ts#registerProcessBridge": `${BRIDGE} This is the mount half.`,
	"clients/process-bridge.ts#registerProcessBridge#2": `${BRIDGE} The second \`globalThis\` use in the mount.`,
	"clients/process-bridge.ts#getProcessBridge": `${BRIDGE} This is the read half.`,
	"clients/ndjson-logger.ts#NDJSON_GLOBAL_STATE_KEY":
		"its own versioned adopt-or-decline protocol, which the seam cannot express: it adopts a LEGACY-shaped state from an older build and throws on an incompatible one rather than resetting, because the old graph still owns private write queues. Folding it would drop the legacy adoption.",
	"clients/ndjson-logger.ts#globalStateHost":
		"the host object for the logger's own versioned slot above (`globalThis` typed to carry a symbol key); it is the same deliberate stay and moves with that row.",
	"clients/lsp/request-timeout-error.ts#timeoutBrand": BRAND,
	"clients/session-scope.ts#CAPTURED_SCOPE": `${BRAND} The brand reads a captured scope off a handle another evaluation made.`,
	"clients/grammar-wasm-imports.ts#wasm": PLATFORM_READ,
	"clients/tree-sitter-client.ts#classifyTreeSitterWasmError": PLATFORM_READ,
	"clients/install-diagnostics.ts#collectInstallDiagnostics": PLATFORM_READ,
	"clients/debug-handles.ts#safeGetActiveResourcesInfo": `${PLATFORM_READ} The cast half.`,
	"clients/debug-handles.ts#safeGetActiveResourcesInfo#2": `${PLATFORM_READ} The call half.`,
	"clients/sg-runner.ts#SgRunner.probePlatformPackageBinary": PLATFORM_READ,
	"clients/extension-log.ts#installConsoleGuard": CONSOLE_PATCH,
	"clients/extension-log.ts#replacement": `${CONSOLE_PATCH} The replacement closure calls the original it captured.`,
	"clients/extension-log.ts#uninstallConsoleGuard": CONSOLE_PATCH,
	"mcp/analyze-cli.ts#<module>":
		"a standalone CLI entry that sends `console.log` to stderr so stdout stays clean; it is its own process and no second evaluation reads it.",
	"mcp/server.ts#<module>":
		"a standalone MCP server entry that redirects `console.log` so stdout carries only protocol frames; it is its own process and no second evaluation reads it.",
	"clients/background-write-drains.ts#REGISTRY_KEY":
		"stays outside the seam on purpose (its header, STATE): `_resetProcessSingletonsForTests` would drop the registration of a module copy that is already loaded, and the harness joins every copy's drain before it removes a fixture root. A foreign-shaped value is replaced by a fresh Set (`instanceof Set` guard), so it never throws.",
	"clients/background-write-drains.ts#host":
		"the host object for the registry slot above (`globalThis` typed to carry a symbol key); it is the same deliberate stay and moves with that row.",
	"clients/runtime-session.ts#handleSessionStart":
		"live member, sequenced: the `__piLensFirstSessionDone` and `__piLensWarmupScheduled` booleans are hung on `globalThis` in `handleSessionStart`, and an open change (#5707) edits `clients/runtime-session.ts`, so the fold waits for it to merge rather than conflict. Fold target: one `getProcessSingleton` family holding both flags.",
};

interface Census {
	scanned: Map<string, number>;
	occurrences: Array<{ row: string; detail: string }>;
}

let cached: Promise<Census> | undefined;

async function runCensus(): Promise<Census> {
	const scanned = new Map<string, number>();
	const occurrences: Census["occurrences"] = [];
	const files = [
		...SCAN_ROOTS.flatMap((root) =>
			listSourceFiles(path.join(REPO_ROOT, root), { extensions: [".ts"] }).map(
				(file) => ({ file, tree: root as string }),
			),
		),
		{ file: path.join(REPO_ROOT, "index.ts"), tree: "index.ts" },
	];
	for (const { file, tree } of files) {
		const rel = relativePosix(REPO_ROOT, file);
		const source = readWalkedFile(file);
		// Shape 81: free each parsed native tree before the next file.
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (source === undefined) continue;
		scanned.set(tree, (scanned.get(tree) ?? 0) + 1);
		if (!mayHoldProcessSlot(source)) continue;
		for (const site of scanProcessSlotSites(source))
			occurrences.push({
				row: `${rel}#${site.anchor}`,
				detail: `${rel}:${site.line + 1} (${site.form})`,
			});
	}
	return { scanned, occurrences };
}

function census(): Promise<Census> {
	return (cached ??= runCensus());
}

describe("process slot sweep (shape 25, #2146)", () => {
	it(
		"scans every tree the sweep's scope names",
		async () => {
			const { scanned } = await census();
			for (const root of SCAN_ROOTS)
				assertNonEmptyScan(
					`process slot sweep: ${root} files scanned`,
					scanned.get(root) ?? 0,
					FILE_FLOORS[root] ?? 1,
				);
			assertNonEmptyScan(
				"process slot sweep: index.ts scanned",
				scanned.get("index.ts") ?? 0,
				1,
			);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence: a slot hand-rolled beside `getProcessSingleton` adopts a value
	// another build shaped differently (spawn-timeout-cooldown, the opaque
	// baseline store and safe-spawn's lifetime registry each threw a TypeError on
	// it before they moved onto the seam).
	it(
		"admits no process-wide slot outside the seam without a reasoned row",
		async () => {
			const { scanned, occurrences } = await census();
			if (process.env.PI_LENS_PRINT_PINS === "1")
				for (const occurrence of occurrences)
					console.log(`ROW\t${occurrence.row}\t${occurrence.detail}`);
			const audited = auditRegistry({
				sweepName: "process slot sweep (shape 25)",
				flagged: occurrences.map((occurrence) => ({
					key: occurrence.row,
					detail: occurrence.detail,
				})),
				registered: [],
				exemptions: { ...SEAM_ADMISSIONS, ...BASELINE },
				scannedCount: [...scanned.values()].reduce((sum, n) => sum + n, 0),
				minScanned:
					Object.values(FILE_FLOORS).reduce((sum, floor) => sum + floor, 0) + 1,
				// A dead-scan floor, not a population pin: the shrink-only audit
				// above holds the population. Live: 26 sites.
				minFlagged: 14,
				minReasonLength: 80,
				remediation:
					"Keep the state behind getProcessSingleton (clients/process-singletons.ts) with a family version, or add a baseline row `<file>#<anchor>` naming why it cannot.",
			});
			expect(audited.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("keeps the seam's own slot out of the shrink-only baseline", () => {
		expect(
			Object.keys(SEAM_ADMISSIONS).filter((row) =>
				Object.hasOwn(BASELINE, row),
			),
		).toEqual([]);
		expect(Object.keys(SEAM_ADMISSIONS).sort()).toEqual([
			"clients/process-singletons.ts#SINGLETON_HOST_KEY",
			"clients/process-singletons.ts#singletonHost",
		]);
	});
});
