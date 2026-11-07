// flake-shape: in-process-mock — the LSP client is a spawned language-server process (JSON-RPC over stdio), and this file's subject is the registry's root and spawn bookkeeping, not the process
/**
 * #4760 — a loose file (no `.git` ancestor) gets its auxiliary root at its own
 * directory, never at the session cwd.
 *
 * In a `$HOME`-cwd pi session the aux scanners used `process.cwd()` as their
 * root fallback, so a file such as `~/bin/loose.sh` was hosted at `$HOME`.
 * opengrep's workspace-targets walk never finished there (measured: no
 * `initialize` answer in 150 s on a 151 GB home), the 15 s handshake timed out,
 * the spawn ladder spent five attempts, and the cwd key latched permanently
 * broken for the rest of the process.
 *
 * The root functions under test are the production ones (`OpengrepServer.root`,
 * the same fallback shape ast-grep, zizmor and typos declare). The spawn and
 * the initialize handshake are the process boundary, so they are the doubles:
 * the stub never answers initialize, exactly like the field failure.
 *
 * The loose-file tree is created under the harness scratch, not under the
 * checkout: every `pinFixtureHome` home sits inside this repository, so the
 * ancestor `.git` would answer `NearestRoot` and the fallback would never be
 * reached. A marker-less tree is what a real `$HOME` outside a checkout is.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { truncateForLedger } from "../../../clients/ledger-bounds.js";
import {
	AstGrepServer,
	OpengrepServer,
	TyposServer,
	ZizmorServer,
	type LSPServerInfo,
} from "../../../clients/lsp/server.js";
import {
	ClientRegistry,
	type ClientGenerationHooks,
} from "../../../clients/lsp/client-registry.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { pinFixtureHome, removeTempDirSync } from "../test-utils.js";

const createLSPClient = vi.hoisted(() => vi.fn());

vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

function makeFakeProcess() {
	return {
		process: {
			killed: false,
			kill: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 4242,
	};
}

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

/**
 * The production opengrep row with only the process boundary stubbed: the root
 * function is the subject, the spawn is the launched binary.
 */
function opengrepWithStubSpawn(): LSPServerInfo & {
	spawn: ReturnType<typeof vi.fn>;
} {
	return {
		...OpengrepServer,
		spawn: vi.fn(async () => ({
			// The launched process is the boundary; only the registry's root and
			// spawn bookkeeping are under test.
			process: makeFakeProcess() as never,
			source: "direct" as const,
		})),
	} as LSPServerInfo & { spawn: ReturnType<typeof vi.fn> };
}

const keyFor = (id: string, root: string) => `${id}:${normalizeMapKey(root)}`;

const tempDirs: string[] = [];
const openedHomes: Array<{ restore: () => void }> = [];

beforeEach(() => {
	resetDegradationLedger();
	createLSPClient.mockReset();
	// The stub never answers `initialize`: the handshake times out, exactly as
	// it does at a root opengrep cannot finish walking.
	createLSPClient.mockRejectedValue(new Error("Timeout after 15000ms"));
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
	for (const home of openedHomes.splice(0)) home.restore();
	resetDegradationLedger();
});

/**
 * A marker-less home-shaped tree (the real `$HOME` of the field report has no
 * `.git` above `~/bin` or `~/.pi/agent`). Lives outside the checkout on
 * purpose: a tree inside it always has this repository's `.git` as an
 * ancestor, which `NearestRoot` would answer before any fallback.
 */
function looseHomeTree(slug: string): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-4760-${slug}-`)),
	);
	tempDirs.push(root);
	fs.mkdirSync(path.join(root, "bin"), { recursive: true });
	fs.mkdirSync(path.join(root, ".pi", "agent"), { recursive: true });
	return root;
}

/**
 * Advance past the breaker's cooldown so each attempt is a real spawn, the way
 * five separate edits over five minutes reach the permanent latch.
 */
async function attemptFiveTimes(
	registry: ClientRegistry,
	file: string,
	server: LSPServerInfo,
): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await registry.ensureClientForServer(file, server);
		vi.setSystemTime(Date.now() + 6 * 60 * 1000);
	}
}

describe("auxiliary loose-file root (#4760)", () => {
	it("roots a loose ~/bin file at its own directory, not at the session cwd", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		try {
			const home = looseHomeTree("aux-bin");
			const file = path.join(home, "bin", "loose.sh");
			fs.writeFileSync(file, "#!/bin/sh\necho ok\n");

			const server = opengrepWithStubSpawn();
			const registry = new ClientRegistry(makeHooks(), undefined, home);
			await attemptFiveTimes(registry, file, server);

			// GREEN: the scanner walks ~/bin, the file's own directory. Pre-fix the
			// fallback was `process.cwd()`, which the root ceiling rewrote to the
			// session cwd (the field `$HOME`), so the first spawn was root=<session>.
			expect(server.spawn).toHaveBeenCalledTimes(5);
			expect(server.spawn.mock.calls[0]?.[0]).toBe(path.join(home, "bin"));
			expect(registry.permanentlyBroken.has(keyFor("opengrep", home))).toBe(
				false,
			);
			expect(
				registry.permanentlyBroken.has(
					keyFor("opengrep", path.join(home, "bin")),
				),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a loose file under ~/.pi/agent eligible at that directory", async () => {
		const home = looseHomeTree("aux-agent");
		const file = path.join(home, ".pi", "agent", "settings.json");
		fs.writeFileSync(file, "{}\n");
		const server = opengrepWithStubSpawn();
		const registry = new ClientRegistry(makeHooks(), undefined, home);

		await registry.ensureClientForServer(file, server);

		expect(server.spawn).toHaveBeenCalledTimes(1);
		expect(server.spawn.mock.calls[0]?.[0]).toBe(
			path.join(home, ".pi", "agent"),
		);
	});

	it("declares the loose-file root on all four auxiliary rows", async () => {
		const home = looseHomeTree("aux-all-rows");
		const file = path.join(home, "bin", "loose.sh");
		fs.writeFileSync(file, "#!/bin/sh\n");
		const registry = new ClientRegistry(makeHooks(), undefined, home);

		for (const server of [
			OpengrepServer,
			AstGrepServer,
			ZizmorServer,
			TyposServer,
		]) {
			expect(server.role).toBe("auxiliary");
			expect(server.looseFileRoot).toBe("decline");
			expect(await registry.resolveServerRoot(server, file)).toBe(
				path.join(home, "bin"),
			);
		}
	});

	it("declines a file whose own directory is $HOME, with one bounded record", async () => {
		const { home, restore } = pinFixtureHome("aux-root-decline");
		openedHomes.push({ restore });
		const first = path.join(home, "one.sh");
		const second = path.join(home, "two.md");
		fs.writeFileSync(first, "#!/bin/sh\n");
		fs.writeFileSync(second, "text\n");

		const server = opengrepWithStubSpawn();
		const registry = new ClientRegistry(makeHooks(), undefined, home);
		await registry.ensureClientForServer(first, server);
		await registry.ensureClientForServer(second, server);

		expect(server.spawn).not.toHaveBeenCalled();
		expect(registry.permanentlyBroken.size).toBe(0);
		expect(registry.broken.size).toBe(0);
		const declined = getDegradationSummary().find(
			(group) => group.kind === "lsp-root-declined",
		);
		expect(declined?.count).toBe(1);
		// The ledger RETAINS every identity field through `subjectForLedger` →
		// `truncateForLedger` (#1366), so at a checkout path long enough to push
		// the key past `LEDGER_FIELD_MAX` the record carries the bounded form with
		// an ellipsis, and the assertion compares that same bound (#5246). The
		// in-memory breaker keys above are the raw `keyFor` spelling: only the
		// retained ledger record is cut.
		expect(declined?.latestReasons[0]?.subject).toBe(
			truncateForLedger(keyFor("opengrep", home)),
		);
	});

	// #4769 review F1: the decline reads the RESOLVED root. A file in
	// `~/testdata` (its directory is below `$HOME`) still resolves to `$HOME`
	// and must not spawn there; pre-fix it spawned at `$HOME`, the #4760 hang.
	it("declines a file below $HOME whose resolved root is $HOME", async () => {
		const { home, restore } = pinFixtureHome("aux-root-excluded");
		openedHomes.push({ restore });
		const file = path.join(home, "testdata", "x.sh");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "#!/bin/sh\n");

		const server = opengrepWithStubSpawn();
		const registry = new ClientRegistry(makeHooks(), undefined, home);
		expect(await registry.resolveServerRoot(server, file)).toBe(home);
		await registry.ensureClientForServer(file, server);

		expect(server.spawn).not.toHaveBeenCalled();
		const declined = getDegradationSummary().find(
			(group) => group.kind === "lsp-root-declined",
		);
		expect(declined?.count).toBe(1);
		// The retained subject is the bounded form, as in the case above.
		expect(declined?.latestReasons[0]?.subject).toBe(
			truncateForLedger(keyFor("opengrep", home)),
		);
	});

	// #4769 review F3: `os.homedir()` answers the spelling `$HOME` holds, and a
	// symlink to it is the same directory. The decline compares real paths on
	// both sides, as the sibling `lsp-root-declined` writer
	// (`clients/ephemeral-root.ts`) does, so each side is a cell: a root
	// spelled through a link, and a `$HOME` spelled through one.
	it("declines a $HOME reached through a symlink, on either side", async () => {
		const { home, restore } = pinFixtureHome("aux-root-symlink");
		openedHomes.push({ restore });
		const linkParent = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4760-aux-link-")),
		);
		tempDirs.push(linkParent);
		const rootLink = path.join(linkParent, "home-link");
		fs.symlinkSync(home, rootLink, "dir");

		const cells = [
			// `$HOME` is the real directory; the file and its root use the link.
			{
				homeSpelling: home,
				sessionCwd: rootLink,
				file: path.join(rootLink, "a.sh"),
			},
			// `$HOME` is the link; the file and its root use the real directory.
			{
				homeSpelling: rootLink,
				sessionCwd: home,
				file: path.join(home, "b.sh"),
			},
		];
		for (const cell of cells) {
			fs.writeFileSync(cell.file, "#!/bin/sh\n");
			resetDegradationLedger();
			vi.stubEnv("HOME", cell.homeSpelling);
			vi.stubEnv("USERPROFILE", cell.homeSpelling);
			try {
				const server = opengrepWithStubSpawn();
				const registry = new ClientRegistry(
					makeHooks(),
					undefined,
					cell.sessionCwd,
				);
				expect(await registry.resolveServerRoot(server, cell.file)).toBe(
					cell.sessionCwd,
				);
				await registry.ensureClientForServer(cell.file, server);

				expect(server.spawn).not.toHaveBeenCalled();
				expect(
					getDegradationSummary().find(
						(group) => group.kind === "lsp-root-declined",
					)?.count,
				).toBe(1);
			} finally {
				vi.unstubAllEnvs();
			}
		}
	});
});
