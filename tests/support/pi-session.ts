/**
 * Tier 2 of the real-host test seam (#4632): the BUILT pi-lens extension inside
 * a real pi `AgentSession`, with a scripted model at the provider boundary. No
 * child process, no network, in process.
 *
 * What the seam is. `createAgentSessionServices` builds pi's real services and
 * runs pi's OWN extension loader over `index.js` (`additionalExtensionPaths` →
 * `discoverAndLoadExtensions`, the same call `tests/support/pi-runner.ts`
 * makes); `createAgentSessionFromServices` builds the real `AgentSession`;
 * pi-ai's `fauxProvider` answers every provider request and records the
 * messages pi actually sent. `tests/support/pi-mock.ts` records what
 * `index.ts` PASSED to a handler; this tier records what the host and the
 * model actually GOT.
 *
 * ONE FIXTURE ROOT PER FILE, enforced rather than documented.
 * `piSessionFixture()` pins the file's root as it
 * creates it, and `startPiSession` refuses any other root: a session started
 * under a SECOND fixture root writes into the first root's home and nothing
 * into its own — measured: the second root's session put 78 `session_start`
 * rows under the first root's home and 0 under its own, whose `home/`
 * directory it still created (#4664 F4). A case that needs another project
 * root passes another `cwd` under the same root. Every handle is registered
 * when it is created and disposed in `afterEach`, so a case that fails before
 * its own `dispose()` leaves no live session for the next case (#4664 M2); a
 * session still live in a different root would be classified by pi-lens as a
 * concurrent secondary, whose full start it declines.
 *
 * What it pins, and what it does not. It pins the session loop's own flow —
 * `session_start`, a turn, a tool-call round trip, the transcript the provider
 * receives, resume from the persisted session file, and manual compaction —
 * so a case asserts an effect of the extension's registered behaviour rather
 * than the shape of a handler's return value. It does NOT pin event payload
 * shapes: `pi-mock.ts`'s `emit` is for the payloads a scripted provider cannot
 * produce and for files the admit list still holds (AGENTS.md "Test requirements"), and
 * tier 1's `pi-runner.ts` owns registration questions.
 *
 * SIX CONSEQUENCES OF LOADING THROUGH PI'S OWN LOADER, all relied on below:
 *
 * 1. pi loads the entry with jiti and `moduleCache: false`, so the factory runs
 *    against its OWN copies of `clients/*` — never the copies this test
 *    process imported. Assert on what leaves the copy (provider requests, pi's
 *    session entries, files under the pinned root, process-wide registries),
 *    never on a module object identity.
 * 2. The copy reads `PI_LENS_HOME` / `PILENS_DATA_DIR` at its own load, so both
 *    are pinned here BEFORE the load, saved in a module-scope record and put
 *    back in `afterAll` (`tests/config/test-env-restore-sweep.test.ts`'s
 *    accepted shape). `PI_LENS_TEST_MODE=0` matches
 *    `tests/index-3521-fork-tree-witness.test.ts`: the start runs its
 *    production writes instead of the test-mode shortcuts.
 * 3. `PI_LENS_STARTUP_MODE` pins the start shape, and the pinned value is what
 *    a `session_start_total` row reports as `mode`. `"full"` (the default here)
 *    settles the start inside `bindExtensions`. `"quick"` is the shape a real
 *    process's FIRST `session_start` takes (the cold-start heuristic), and it
 *    is paired with `PI_LENS_COLD_START_QUICK=0`: a quick start otherwise arms
 *    an unref'd 2 s warmup timer (`clients/runtime-session.ts`), and the warmup's
 *    project-snapshot persist lands after this fixture root is gone and
 *    re-creates it unless the timer is off (the persist is joined at teardown
 *    when it is already queued, point 6, but a timer that has not fired is not
 *    a queue). The
 *    opt-out drops the TIMER, not the quick start: the skipped-work branch and
 *    the `mode: "quick"` row are what a quick-mode case observes.
 * 4. The load builds jiti's transform cache at `path.join(os.tmpdir(), "jiti")`,
 *    so `os.tmpdir()` is aimed inside the fixture for the load only — tier 1's
 *    `withFixtureTmpdir`, now the ONE copy in `tests/clients/test-utils.ts`
 *    (#4641 F1: a direct child of the shared tmp root is a fixture sibling to
 *    the tmp-hygiene census).
 * 5. BOTH modules this tier runs on come from the HOST install the override
 *    names, resolved at runtime through the host package's directory and one
 *    loader (`loadHostedModule`). The scripted provider
 *    (`@earendil-works/pi-ai`) has to: that package is not a dependency of
 *    this repo — it ships inside the certified host's install — so declaring
 *    it here would pin a second version of a module the host answers for
 *    itself (#4664 F1). The session API (`createAgentSessionServices`,
 *    `createAgentSessionFromServices`, `AgentSessionRuntime`, `ModelRuntime`,
 *    `SessionManager`) has to for a different reason: the spread points
 *    `PI_LENS_PI_HOST_PACKAGE` at ONE certified host, and a static import here
 *    would run this repo's dev host's session loop and print the result on
 *    that host's line (#4719 F1: a directory holding only a manifest and a
 *    pi-ai shim ran tier 2 green 16/16). A host directory that cannot supply
 *    either module is refused, never reported as probed. Nothing in this file
 *    or in a case that imports it holds a `@earendil-works/pi-ai` import
 *    specifier for knip to read, and the host package is imported for TYPES
 *    only.
 * 6. Teardown does NOT pretend to reach the loaded copy's internals. Three
 *    seams are real and are used:
 *      - pi's `ExtensionRunner.emit` AWAITS every handler
 *        (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`),
 *        and emitting `session_shutdown` therefore runs the copy's own shutdown
 *        handler: its primary release, its registry deregistration, and its
 *        writer drain (`index.ts` returns
 *        `bounded(flushAllNdjsonWriters(), …)`). That handler's effects are what
 *        the helper's contract test reads back;
 *      - the NDJSON writer map is process-global
 *        (`clients/ndjson-logger.ts`, `Symbol.for("pi-lens.ndjson-logger.state")`),
 *        so `flushAllNdjsonWriters()` from this side settles the copy's sinks
 *        too (probed: 13 writers, all under the pinned home). It is a
 *        belt-and-braces second drain, NOT the proof that the emit ran: it
 *        writes the same rows either way, so a case that must prove the emit
 *        asserts a handler effect instead;
 *      - the registry mutation tail is process-global too (#2146 keys it on
 *        `globalThis`), so `_settleRegistryMutationsForTests()` here joins the
 *        copy's own queued `deregisterInstance()` write. Without that await the
 *        write lands after `dispose()` returns and re-creates the removed
 *        fixture root (#4664 F7, probed);
 *      - the scanner report root is OWNED, not drained: every `session_start`
 *        scanner writes under `scannerReportParentDir()`, and the pin below
 *        points that seam at `<root>/scanner-tmp`. A fire-and-forget scan whose
 *        `finally` never runs (the worker ends first) therefore strands its
 *        directory inside the fixture root this file removes, never in the
 *        shared tmp root (#4632 slice 7 round 2, probed: `pi-lens-temp-find-functions-*`
 *        under the fixture after the pin, under `os.tmpdir()` before it).
 *      - the copy's module-scope deferred writers that REGISTER a drain
 *        (`clients/background-write-drains.ts`: the project-snapshot worker
 *        persist, the installer's debounced probe-cache flush) are joined
 *        by `drainPiSessionWrites` before the root is removed, and the NDJSON
 *        writers are flushed a second time there. Without the join, the copy's
 *        write landed after the removal and re-created the root (#4937: master
 *        run 40967488612; a sweep of the 45 tier-2 files found four more).
 *    The copy's module-scope persist queue in `clients/review-graph/builder.ts`
 *    and the warmup timer register no drain: they are reachable only through
 *    the copy's own module objects, which nothing here holds. None was seen to
 *    land after a removal in the 45-file sweep; that is the `p3` residual
 *    documented in the PR body, NOT a silence.
 *
 * INLINE-FACTORY MODE (opt-in, #4937 L6). `PiSessionOptions.inlineFactory`
 * hands pi the factory this test already imported, through pi's
 * `extensionFactories` resource-loader option, instead of the built entry's
 * path. The default stays the path load above. The two modes differ on one
 * axis only: with a path, consequences 1 and 4 hold (jiti, its own module
 * copies, so a `vi.mock` of a `clients/` module and a test-side singleton never
 * reach the extension); with a factory, the extension runs against THIS test
 * graph's modules, so a `vi.mock`/`vi.doMock`, a spy on a prototype and a read
 * of a process-global registry reach it. Everything else is pi's own and
 * unchanged: flags applied after the factory, the real `AgentSession`, the
 * scripted provider, teardown. The loader is called AFTER the env pins of
 * consequence 2, so a module that reads `PI_LENS_HOME` at its first import
 * reads the pinned home; a case that mocks a module registers its mock before
 * `startPiSession` and the loader's import sees it. A file in this mode owns
 * the shared module state it shares with the extension: it resets what its
 * cases leave behind (`_resetSessionLifecycleForTests()` and the like), because
 * the copy no longer isolates it.
 *
 * LAZY-TOOLS POSTURE (#4687, #4723 F5). Both harnesses start the situational
 * tools INACTIVE by default, because pi-lens's default `tools.lazy` is `true`
 * on every model. The model matters only to a case that opts into
 * `tools.lazy: "auto"` through a global config; the one decision table is
 * `lazyToolsApply` in `clients/tool-set-policy.ts`. This tier's model carries
 * {@link DEFAULT_MODEL_COMPAT} (the faux provider's real, mid-conversation
 * support), so "auto" is lazy here too; `modelCompat: {}` gives a collapsing
 * model. `pi-mock.ts`'s `makeCtx` names no model, which "auto" also treats as
 * lazy (the configured default, never eager).
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentSession,
	AgentSessionRuntime,
	AgentSessionServices,
	CreateAgentSessionResult,
	CreateAgentSessionRuntimeFactory,
	ExtensionFactory,
	ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	ToolDefinition,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll } from "vitest";
import { drainRegisteredBackgroundWritesForTests } from "./background-write-drains.js";
import { _settleRegistryMutationsForTests } from "../../clients/instance-registry-tail.js";
import { flushAllNdjsonWriters } from "../../clients/ndjson-logger.js";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
	withFixtureTmpdir,
} from "../clients/test-utils.js";
import { readNdjsonRows, type NdjsonRowRead } from "./ndjson-rows.js";

/** The built extension every case loads: `npm run build` writes this twin. */
const EXTENSION_ENTRY = fileURLToPath(
	new URL("../../index.js", import.meta.url),
);

/**
 * The scripted-provider package, and the host whose dependency graph supplies
 * it. `@earendil-works/pi-ai` is NOT a dependency of this repo: it ships inside
 * the certified host's own install, and a row for it here would pin a second
 * version of a module the host must answer for itself (#4664 F1). So the module
 * is resolved at RUNTIME through the host package's directory — never through a
 * static specifier the dependency graph (and `npm run knip`) would read.
 *
 * The host constants repeat `tests/support/pi-runner.ts`'s rather than being
 * imported from it: that module registers file-scope vitest hooks (`afterAll`)
 * on import, so a tier-2 file importing it for two strings would attach tier
 * 1's teardown to itself.
 */
const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
/**
 * Points the helper at another installed host, as a package directory or a
 * module file — tier 1's own override (`tests/support/pi-runner.ts`), honoured
 * here for the one module this tier loads from the host's graph.
 */
const HOST_PACKAGE_ENV = "PI_LENS_PI_HOST_PACKAGE";
const PI_AI_PACKAGE = "@earendil-works/pi-ai";

/** One message pi sent to the provider, as the live module shaped it. */
export interface PiMessage {
	readonly role: string;
	readonly content?: unknown;
	readonly [key: string]: unknown;
}

/** What a scripted reply receives: the request pi is answering. */
export interface PiFauxContext {
	readonly messages: readonly PiMessage[];
}

/**
 * A scripted reply computed from the request pi is answering. pi-ai's
 * `fauxProvider` awaits it, so a reply may wait on another session's prompt:
 * the way a case runs two concurrent sessions in a fixed order (#4943 R1).
 */
export type PiFauxReplyFactory = (
	context: PiFauxContext,
	options: unknown,
	state: unknown,
	model: unknown,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** A scripted provider reply: a message, or a function of the request it answers. */
export type PiFauxReply = Record<string, unknown> | PiFauxReplyFactory;

/**
 * A session replacement pi performs, named by the reason its events carry.
 * Each one runs pi's OWN code for that reason (see `PiSession.restart`); the
 * fields are the inputs pi's entry point takes, never a payload this helper
 * shapes.
 *
 * - `new`: `AgentSessionRuntime.newSession()` — a new session id, an empty
 *   conversation.
 * - `resume`: `AgentSessionRuntime.switchSession(sessionFile)` — the target
 *   file's session id and conversation.
 * - `fork`: `AgentSessionRuntime.fork(entryId, { position })` — a new session
 *   id whose conversation is branched from this one.
 * - `reload`: `AgentSession.reload()` — the SAME session id and conversation;
 *   the extension is loaded again in place.
 */
export type PiReplacement =
	| { readonly reason: "new" }
	| { readonly reason: "resume"; readonly sessionFile: string }
	| {
			readonly reason: "fork";
			readonly entryId: string;
			readonly position?: "before" | "at";
	  }
	| { readonly reason: "reload" };

/** The provider half of the host's own `pi-ai` that this tier calls. */
interface FauxProviderHandle {
	readonly provider: unknown;
	setResponses(responses: readonly PiFauxReply[]): void;
}

/**
 * The host's `@earendil-works/pi-ai` surface this tier uses. Structural on
 * purpose: the module is loaded at runtime, so no declaration of it can come
 * from its own package (see `piAiModule`).
 */
interface PiAiModule {
	fauxProvider(options?: {
		models?: readonly Record<string, unknown>[];
	}): FauxProviderHandle;
	fauxText(text: string): Record<string, unknown>;
	fauxToolCall(
		name: string,
		arguments_: Record<string, unknown>,
		options?: { id?: string },
	): Record<string, unknown>;
	fauxAssistantMessage(
		content: unknown,
		options?: Record<string, unknown>,
	): Record<string, unknown>;
}

const nodeRequire = createRequire(import.meta.url);

/** The host's scripted provider this tier last loaded, and the host it came from. */
let loadedPiAi: { dir: string; module: PiAiModule } | undefined;

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/**
 * `<dir>/node_modules/<name>` at `from` and at every ancestor, in node's own
 * order (a directory already named `node_modules` is not searched again), so a
 * nested install wins over the hoisted one exactly as it does for a real
 * `import`.
 */
function findPackageDir(name: string, from: string): string | undefined {
	for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
		if (path.basename(dir) !== "node_modules") {
			const candidate = path.join(dir, "node_modules", name);
			if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
		}
		if (path.dirname(dir) === dir) return undefined;
	}
}

/** The package directory a package directory or a module file lives in. */
function packageRootOf(target: string): string {
	if (isDirectory(target)) return target;
	for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		if (path.dirname(dir) === dir) return path.dirname(target);
	}
}

/** The install the extension under test runs in: the override, or this repo's host. */
function hostPackageDir(): string {
	const override = process.env[HOST_PACKAGE_ENV];
	if (override) return packageRootOf(path.resolve(override));
	const here = path.dirname(fileURLToPath(import.meta.url));
	const hostDir = findPackageDir(HOST_PACKAGE, here);
	if (hostDir === undefined)
		throw new Error(
			`pi-session: cannot find ${HOST_PACKAGE} from ${here}; set ${HOST_PACKAGE_ENV} to the host package's directory`,
		);
	return hostDir;
}

/** The `import` entry a package's own `package.json` declares. */
function packageEntry(packageDir: string): string {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
	) as { exports?: Record<string, unknown>; main?: string };
	const root = manifest.exports?.["."];
	const declared =
		root && typeof root === "object"
			? (root as { import?: unknown }).import
			: undefined;
	const target = typeof declared === "string" ? declared : manifest.main;
	if (typeof target !== "string")
		throw new Error(
			`pi-session: ${packageDir}/package.json declares no import entry`,
		);
	return path.join(packageDir, target);
}

/**
 * The session surface this tier calls, resolved from the host install at
 * RUNTIME (see `hostModule`). Every member is the host's own export, never a
 * copy re-imported from this repo's devDependency: the spread points
 * `PI_LENS_PI_HOST_PACKAGE` at ONE certified host, so a static import would
 * run the dev host's session loop and print its result on that host's line
 * (#4719 F1).
 */
interface HostModule {
	readonly AgentSessionRuntime: typeof AgentSessionRuntime;
	readonly ModelRuntime: typeof ModelRuntime;
	readonly SessionManager: typeof SessionManager;
	readonly createAgentSessionServices: typeof createAgentSessionServices;
	readonly createAgentSessionFromServices: typeof createAgentSessionFromServices;
}

/** The host module this tier last loaded, and the directory it came from. */
let loadedHost: { dir: string; module: HostModule } | undefined;

/**
 * One module out of a host install, loaded at RUNTIME and required to carry
 * every name the caller calls. It is the ONE resolver: the scripted provider
 * (`piAiModule`) and the session API (`hostModule`) both go through it, so a
 * host directory that carries one and not the other cannot look complete.
 * Fails loudly rather than skipping: a quiet fallback would report a host as
 * probed while its code never ran (#4719 F1, greptile P1, sourcery High,
 * CodeRabbit Functional Correctness).
 */
function loadHostedModule<T>(
	packageDir: string,
	names: readonly string[],
	what: string,
): T {
	const entry = packageEntry(packageDir);
	const loaded = nodeRequire(entry) as Record<string, unknown>;
	const missing = names.filter((name) => typeof loaded[name] !== "function");
	if (missing.length > 0)
		throw new Error(
			`pi-session: ${entry} does not export ${missing.join(", ")}, so ${what} cannot come from the host ${HOST_PACKAGE_ENV} names (${packageDir})`,
		);
	return loaded as T;
}

/**
 * The session API of the host install at `packageDir`, loaded through
 * `loadHostedModule`. The cache is one entry keyed on the directory, so a
 * second host in the same process re-loads instead of answering with the
 * first one's module; Node's own require cache makes the repeat free.
 */
export function hostModuleFor(packageDir: string): HostModule {
	const dir = path.resolve(packageDir);
	if (loadedHost?.dir === dir) return loadedHost.module;
	const module = loadHostedModule<HostModule>(
		dir,
		[
			"AgentSessionRuntime",
			"ModelRuntime",
			"SessionManager",
			"createAgentSessionServices",
			"createAgentSessionFromServices",
		],
		"the session API",
	);
	loadedHost = { dir, module };
	return module;
}

/**
 * The session API of the host the override names, or of this repo's host. Every
 * session this tier creates is built by THIS module: a host that cannot supply
 * it throws here, before any session exists. Exported because it is the seam
 * the probe's own case drives: the environment override is what the spread
 * sets, and a case that stubbed the resolver instead would not observe it.
 */
export function hostModule(): HostModule {
	return hostModuleFor(hostPackageDir());
}

/**
 * The host's own scripted provider, loaded once per host at RUNTIME. Fails
 * loudly rather than skipping: a host that stopped exporting `fauxProvider`
 * makes every case in this tier meaningless, and a quiet fallback would report
 * that as a green run.
 *
 * The cache is keyed on the host directory, exactly as `hostModuleFor` keys
 * its own (#4719 F11): a cache keyed on nothing answers a second host with the
 * first host's provider, so the session API would follow a mid-process
 * `PI_LENS_PI_HOST_PACKAGE` switch while the scripted model stayed on the old
 * install (measured: `hostA 0.86.1 aiA 0.86.1 hostB 1.3.0 aiB 0.86.1`). No
 * production path switches hosts inside one process -- the spread spawns one
 * child per host -- so the pair is what keeps the two halves agreeing about
 * which install they came from.
 */
export function piAiModule(): PiAiModule {
	const hostDir = hostPackageDir();
	if (loadedPiAi?.dir === hostDir) return loadedPiAi.module;
	const piAiDir = findPackageDir(PI_AI_PACKAGE, hostDir);
	if (piAiDir === undefined)
		throw new Error(
			`pi-session: the host install at ${hostDir} carries no ${PI_AI_PACKAGE}; ${HOST_PACKAGE_ENV} must name one that does`,
		);
	const module = loadHostedModule<PiAiModule>(
		piAiDir,
		["fauxProvider", "fauxText", "fauxToolCall", "fauxAssistantMessage"],
		"the scripted provider",
	);
	loadedPiAi = { dir: hostDir, module };
	return module;
}

/**
 * Pay the host module's one expensive load in a HOOK rather than inside the
 * first case that creates a session (#4719 F8). `require(<host entry>)` costs
 * ~0.9 s (pi's entry, its dependencies and jiti); while this tier held a static
 * import that cost landed at helper load, outside every timed case, and the
 * runtime resolver moved it into the first case -- `Unit tests (shard 5/5)`
 * then failed `tests/index-4632-s4-tool-call-verdict.test.ts` with `Test timed
 * out in 5000ms`, on a case that already ran 4.0-4.7 s against the 5 s default.
 *
 * A hook, not a case: Vitest's hookTimeout is 10 s (60 s in the projects that
 * set it), so the load can never be charged to the 5 s default a file's first
 * case runs against, and no test timeout is raised to make room for it.
 *
 * The load's own failure is the CASE's to report, never this hook's: every
 * consumer calls `hostModule()` itself, so a host that cannot supply the API
 * still refuses loudly there. Swallowing it here is what keeps a file whose
 * cases are all gated on a host being installed (they `skipIf` it) a run of
 * skips instead of a file-level hook failure.
 */
export function warmHostModule(): void {
	try {
		hostModule();
	} catch {
		// none: the case that needs the host calls hostModule() itself and raises
		// this same failure there; the hook only pre-pays a successful load.
	}
}

beforeAll(warmHostModule);

/** pi-ai's `fauxText`, through the host's own module (see `piAiModule`). */
export function fauxText(text: string): Record<string, unknown> {
	return piAiModule().fauxText(text);
}

/** pi-ai's `fauxToolCall`, through the host's own module (see `piAiModule`). */
export function fauxToolCall(
	name: string,
	arguments_: Record<string, unknown>,
	options?: { id?: string },
): Record<string, unknown> {
	return piAiModule().fauxToolCall(name, arguments_, options);
}

/** pi-ai's `fauxAssistantMessage`, through the host's own module (see `piAiModule`). */
export function fauxAssistantMessage(
	content: unknown,
	options?: Record<string, unknown>,
): Record<string, unknown> {
	return piAiModule().fauxAssistantMessage(content, options);
}

const TMP_PREFIX = "pi-lens-pi-session-";

const FAUX_MODEL: Record<string, unknown> = {
	id: "faux-1",
	name: "Faux",
	contextWindow: 200_000,
	maxTokens: 4_096,
};

/** The second scripted model a {@link PiSession.switchModel} alternates to. */
const FAUX_MODEL_ALT: Record<string, unknown> = { ...FAUX_MODEL, id: "faux-2" };

/**
 * The per-model capability facts a session's model carries unless a case
 * overrides them ({@link PiSessionOptions.modelCompat}). pi-ai's `fauxProvider`
 * drops `compat` from its model definitions, so the helper sets it on the
 * model object pi is handed, which is what `ctx.model` returns.
 *
 * `supportsMidConvoSystemMessages: true` is the faux provider's real behaviour:
 * it answers from the transcript exactly as pi sent it and never folds system
 * messages into one head. A case that needs a collapsing model (pi-ai's
 * `collapseSystemMessages` path) passes `modelCompat: {}`, the shape a catalog
 * model without the fact has (#4687 item 7: pi-lens reads this fact).
 */
const DEFAULT_MODEL_COMPAT: Readonly<Record<string, unknown>> = {
	supportsMidConvoSystemMessages: true,
};

/**
 * The flag set a case runs with unless it overrides it: the same six the
 * repo's other real-session drivers pin (`tests/index-3521-fork-tree-witness.test.ts`,
 * `tests/index-integration.test.ts`), plus `no-complexity`. The complexity
 * baseline is an analyzer pull fired by a `read`/`edit` tool call
 * (`clients/runtime-tool-call.ts`), i.e. asynchronous work this tier neither
 * observes nor can drain; a case that needs it deletes the flag.
 */
const DEFAULT_FLAGS: ReadonlyArray<[string, boolean]> = [
	["no-lsp", true],
	["no-autofix", true],
	["no-autoformat", true],
	["no-tests", true],
	["no-opengrep", true],
	["no-delta", true],
	["no-complexity", true],
];

/**
 * The flag map pi is handed: every ON entry, and nothing else.
 *
 * pi reads a BOOLEAN extension flag's PRESENCE as `true` —
 * `applyExtensionFlagValues` (`@earendil-works/pi-coding-agent`'s
 * `dist/core/agent-session-services.js`) writes `flagValues.set(name, true)`
 * for any boolean key it is given and never looks at the value. So `false`
 * cannot be expressed by the value; it means the key must be ABSENT, which for
 * these flags is also their registered default. A case that turns a default
 * off (`new Map([["no-lsp", false]])`) therefore deletes the key, and a
 * `true` entry adds it (#4632 slice 7: passing `["no-lsp", false]` turned the
 * language servers OFF, the opposite of the request).
 */
function flagMap(
	base: ReadonlyArray<readonly [string, boolean]>,
	overrides: ReadonlyMap<string, boolean | string> | undefined,
): Map<string, boolean | string> {
	const merged = new Map<string, boolean | string>([
		...base,
		...(overrides ?? []),
	]);
	for (const [name, value] of [...merged]) {
		if (value === false) merged.delete(name);
	}
	return merged;
}

/** One provider request: the messages the model received, in order. */
export type PiProviderRequest = ReadonlyArray<PiMessage>;

/**
 * The tool set a provider request declares, by the replay rule a consumer must
 * use: every `toolsAdded` entry adds, every `toolsRemoved` entry deletes, in
 * message order. pi's agent loop writes both deltas into SYSTEM messages
 * before each request, so a request's loadout is the fold over its transcript,
 * never the head message alone.
 *
 * ONE reader, two callers (#4707 F5): the contract case that pins the rule and
 * the case that reads a loadout both call this function, so the pinned reader
 * and the used reader cannot drift apart.
 */
export function replayToolNames(request: PiProviderRequest): string[] {
	const tools = new Set<string>();
	for (const message of request) {
		if (message.role !== "system") continue;
		const typed = message as {
			toolsAdded?: Array<{ name: string }>;
			toolsRemoved?: Array<{ name: string }>;
		};
		for (const tool of typed.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of typed.toolsAdded ?? []) tools.add(tool.name);
	}
	return [...tools];
}

/** One notification the loaded copy asked pi's UI to show, in order. */
export interface PiNotification {
	readonly message: string;
	readonly type?: "info" | "warning" | "error";
}

/**
 * The host-boundary recorder behind {@link PiSessionOptions.captureUi}.
 *
 * `notify` is the one member a case asserts on; `setStatus` is recorded because
 * the LSP status line rides it, and every other member is a no-op the host may
 * call. The value is a real `ExtensionUIContext` handed to pi's own
 * `bindExtensions` — never a pi-lens module — so what a case reads back is what
 * pi-lens asked the HOST to show, not a payload a handler returned.
 */
interface UiRecorder {
	readonly notifications: PiNotification[];
	readonly statuses: Array<{ key: string; text: string | undefined }>;
	readonly context: ExtensionUIContext;
}

function createUiRecorder(): UiRecorder {
	const notifications: PiNotification[] = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as ExtensionUIContext["theme"];
	const base: Record<string, unknown> = {
		notify: (message: string, type?: PiNotification["type"]) => {
			notifications.push({ message, type });
		},
		setStatus: (key: string, text: string | undefined) => {
			statuses.push({ key, text });
		},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		onTerminalInput: () => () => {},
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		getEditorComponent: () => undefined,
		getToolsExpanded: () => false,
		getEditorText: () => "",
	};
	// Anything the host calls that a case does not read is a no-op, so a pi
	// release that adds a UI member does not turn every UI case red.
	const context = new Proxy(base, {
		get: (target, property: string | symbol) => {
			if (property in target) return target[property as string];
			return () => undefined;
		},
	}) as unknown as ExtensionUIContext;
	return { notifications, statuses, context };
}

export interface PiSessionOptions {
	/** Fixture root, created by `setupTestEnvironment(TMP_PREFIX)` below. */
	root: string;
	/** Scripted provider replies, one per expected request (the host's `fauxProvider`). */
	responses: readonly PiFauxReply[];
	/**
	 * Project directory the session runs in. Defaults to `<root>/proj`, which
	 * the helper marks with `.git`; passing this checkout would make every
	 * project-state write land in it. A second session may name any other
	 * directory UNDER `root` (that is how a multi-root case runs two roots); a
	 * second ROOT is refused — see `pinEnv`.
	 */
	cwd?: string;
	/**
	 * `pi.getFlag` overrides on top of {@link DEFAULT_FLAGS}: a key named here
	 * wins, and every other default (the analyzers this tier neither observes
	 * nor can drain) stays off. `false` turns a default OFF rather than on —
	 * see {@link flagMap} for why the value cannot express that on the host's
	 * own flag map.
	 */
	flags?: ReadonlyMap<string, boolean | string>;
	/** Session store. Defaults to `<root>/sessions`. */
	sessionsDir?: string;
	/**
	 * Startup shape pinned through `PI_LENS_STARTUP_MODE`, which is also the
	 * `mode` a `session_start_total` row reports. `"full"` (the default) settles
	 * the start inside `bindExtensions`; `"quick"` is the shape a real process's
	 * first `session_start` takes, with the warmup timer opted out — see the
	 * header, point 3; `"minimal"` is the third production mode, whose only
	 * config-resolution path is the ensure (no warm-up, no deferred load).
	 */
	startupMode?: "full" | "quick" | "minimal";
	/**
	 * The session model's `compat` facts, replacing {@link DEFAULT_MODEL_COMPAT}
	 * whole (`{}` is a model with none). Carried by every session this handle
	 * builds (a replacement or a resume keeps it).
	 */
	modelCompat?: Readonly<Record<string, unknown>>;
	/**
	 * Bind a RECORDING UI context instead of pi's no-op one. A case that asserts
	 * what pi-lens asked the UI to show (a notification, the LSP status line)
	 * reads it back from {@link PiSession.notifications} / `.statuses`; the
	 * recorder is a real `ExtensionUIContext` at the host boundary and reaches
	 * no pi-lens module.
	 */
	captureUi?: boolean;
	/**
	 * Tools another extension (or an SDK host) registers beside the loaded
	 * copy's, handed to pi's own `customTools` option. pi runs them through its
	 * tool loop and fires the loaded copy's `tool_call`/`tool_result` hooks for
	 * them like any other tool, so a case can drive a tool pi-lens has never
	 * met (#4732). Every session of the handle (resume, restart) keeps them.
	 */
	customTools?: readonly ToolDefinition[];
	/**
	 * Inline-factory mode (see the header): load the extension from the factory
	 * this resolves, in THIS test graph, instead of from the built entry's path.
	 * It is called once, after the env pins, so the file's `vi.doMock`s and spies
	 * are registered before the import it makes. Every session of the handle
	 * (resume, restart, reload) keeps the factory it resolved.
	 */
	inlineFactory?: () => Promise<ExtensionFactory>;
	/**
	 * Other extensions, by path, that pi's own loader loads beside the built
	 * entry: `before` ahead of it and `after` behind it, in the order given.
	 * pi walks `tool_call` handlers in load order and stops at the first
	 * block, so the order is what a composition case tests (#5120). Path mode
	 * only: refused with {@link inlineFactory}, whose place in pi's load order
	 * this helper does not pin.
	 */
	extraExtensions?: {
		readonly before?: readonly string[];
		readonly after?: readonly string[];
	};
}

export interface PiSession {
	/** pi's real session. Its `extensionRunner` is the loaded copy's host. */
	readonly session: AgentSession;
	/** Absolute project directory the session runs in. */
	readonly cwd: string;
	/** Every provider request, in order, deep-cloned as pi sent it. */
	readonly requests: PiProviderRequest[];
	/** Errors pi reported from an extension handler (`runner.onError`). */
	readonly errors: unknown[];
	/** Notifications the copy asked pi's UI to show ({@link PiSessionOptions.captureUi}). */
	readonly notifications: readonly PiNotification[];
	/** Status lines the copy set, in order ({@link PiSessionOptions.captureUi}). */
	readonly statuses: ReadonlyArray<{ key: string; text: string | undefined }>;
	/** The persisted session file, once pi has written one. */
	sessionFile(): string | undefined;
	/**
	 * Rows the LOADED copy wrote to `<root>/home/latency.log`, in order, after a
	 * flush, together with the lines the read could not parse. The copy's
	 * writers live in the same process-global map
	 * (`Symbol.for("pi-lens.ndjson-logger.state")`), so `flushAllNdjsonWriters`
	 * settles them; reading before the await would count a row still queued
	 * (AGENTS.md shape 67). A watchdog record a case asserts on goes through
	 * here, never through a test-side logger double.
	 *
	 * `skipped` is beside the rows on purpose: a corrupt line used to be dropped
	 * silently, so an exact-count or absence assertion could not see it
	 * (Sourcery on #4699). A case whose claim depends on the total asserts it is
	 * zero; a case that names rows only reads `.rows`.
	 */
	latencyRows(): Promise<NdjsonRowRead>;
	/** Run one prompt to completion (tool calls included). */
	prompt(text: string): Promise<void>;
	/** Manual compaction, pi's `/compact` entry point. */
	compact(instructions?: string): Promise<unknown>;
	/**
	 * Switch the session to the other scripted model (`faux-1` and `faux-2`
	 * alternate) carrying `compat`, through pi's own `AgentSession.setModel`,
	 * which emits `model_select` to the loaded copy.
	 */
	switchModel(compat: Readonly<Record<string, unknown>>): Promise<void>;
	/**
	 * Reopen this session's persisted file in a NEW session with a new provider
	 * script — the resume path a restarted process takes.
	 */
	resume(responses: readonly PiFauxReply[]): Promise<PiSession>;
	/**
	 * Replace this session the way pi does, in process, through pi's own entry
	 * point for the reason (see {@link PiReplacement}). pi emits every event and
	 * builds every payload: `session_shutdown` with its `targetSessionFile`, then
	 * the next session's `session_start` with its `previousSessionFile`. Nothing
	 * process-wide is reset, because pi resets nothing. `responses` scripts the
	 * session that answers next. `new`, `resume` and `fork` return a NEW handle
	 * and end this one; `reload` returns THIS handle, whose session pi kept.
	 */
	restart(
		replacement: PiReplacement,
		responses: readonly PiFauxReply[],
	): Promise<PiSession>;
	/** Settle the loaded copy, dispose the session, drain. Idempotent. */
	dispose(): Promise<void>;
}

/** The values this file replaced, saved before the first pin (`afterAll` restores). */
const savedEnv: Record<string, string | undefined> = {};

/** The one fixture root this file pinned; a second root is refused (see below). */
let pinnedRoot: string | undefined;

/** Fixtures this file still owns; removed with the environment in `afterAll`. */
const liveFixtures: Array<() => void> = [];

/**
 * Every handle this file created and has not yet seen disposed. `afterEach`
 * below disposes them, so a case that fails between `startPiSession` and its
 * own `dispose()` cannot leave a live session behind for the next case
 * (#4664 M2: a leaked primary in another root declines the next start, which
 * turns one red assertion into a cascade).
 */
const liveHandles: PiSession[] = [];

const PINNED_KEYS = [
	"PI_LENS_HOME",
	"PILENS_DATA_DIR",
	"PI_LENS_TEST_MODE",
	"PI_LENS_TEST_SCANNER_TMPDIR",
	"PI_LENS_TEST_SCANNER_HARNESS",
	"PI_LENS_STARTUP_MODE",
	"PI_LENS_COLD_START_QUICK",
] as const;

/** The one-root rule (see `startPiSession`): a second root cannot be observed. */
function assertOneRoot(root: string): void {
	// ONE ROOT PER FILE. A session started under a SECOND fixture root writes
	// into the FIRST root's home and nothing into its own: measured — the
	// second root's session put 78 `session_start` rows under the first
	// root's home against 0 under its own, whose `home/` directory it still
	// created. The seam that holds the copy to its first home was not
	// isolated, and `clients/probe-home-state.ts` is NOT it: that module
	// re-reads `PI_LENS_HOME` on every call (#4664 F4). So this guard states
	// the measurement, not a module. Sessions that need a different project
	// root pass a different `cwd` UNDER this root.
	if (pinnedRoot !== undefined && pinnedRoot !== root)
		throw new Error(
			`pi-session: one fixture root per test file — this file already pinned ${pinnedRoot}, so the loaded copy keeps that home and ${root} would observe nothing (pass a different cwd under ${pinnedRoot} instead)`,
		);
	pinnedRoot = root;
}

/**
 * A model runtime whose only provider is the scripted one. `script` sets the
 * replies the provider gives next; it is called again when pi keeps the
 * session and a case scripts what follows (`restart({ reason: "reload" })`).
 */
async function buildModelRuntime(
	agentDir: string,
	requests: PiProviderRequest[],
	compat: Readonly<Record<string, unknown>>,
): Promise<{
	modelRuntime: ModelRuntime;
	model: unknown;
	modelFor(id: string, compat: Readonly<Record<string, unknown>>): unknown;
	script(responses: readonly PiFauxReply[]): void;
}> {
	const faux = piAiModule().fauxProvider({
		models: [FAUX_MODEL, FAUX_MODEL_ALT],
	});
	// Every scripted step is wrapped so the request it answered is recorded
	// before the reply is produced: `requests.length` is then the count of
	// provider round trips pi actually made.
	const script = (responses: readonly PiFauxReply[]): void =>
		faux.setResponses(
			responses.map(
				(step): PiFauxReplyFactory =>
					(context, options, state, model) => {
						requests.push(
							context.messages.map((message) => structuredClone(message)),
						);
						return typeof step === "function"
							? step(context, options, state, model)
							: structuredClone(step);
					},
			),
		);
	const modelRuntime = await hostModule().ModelRuntime.create({
		modelsPath: null,
		refreshOnCreate: false,
		authPath: path.join(agentDir, "auth.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider as never);
	const modelFor = (
		id: string,
		modelCompat: Readonly<Record<string, unknown>>,
	): unknown => {
		const registered = modelRuntime.getModel("faux", id);
		if (!registered) throw new Error(`the faux provider registered no ${id}`);
		return { ...registered, compat: { ...modelCompat } };
	};
	const model = modelFor(FAUX_MODEL.id as string, compat);
	return { modelRuntime, model, modelFor, script };
}

/** What every session of one file shares. */
interface SessionArgs {
	readonly root: string;
	readonly flags: ReadonlyMap<string, boolean | string>;
	/** The `compat` every session of this handle's model carries. */
	readonly modelCompat: Readonly<Record<string, unknown>>;
	/** Present only when the case asked for a recording UI context. */
	readonly ui?: UiRecorder;
	/** {@link PiSessionOptions.customTools}. */
	readonly customTools?: readonly ToolDefinition[];
	/** The resolved {@link PiSessionOptions.inlineFactory}; absent in path mode. */
	readonly inlineFactory?: ExtensionFactory;
	/** {@link PiSessionOptions.extraExtensions}. */
	readonly extraExtensions?: PiSessionOptions["extraExtensions"];
}

/** One pi session before its extensions are bound, with its provider recorder. */
interface CreatedSession {
	readonly session: AgentSession;
	readonly services: AgentSessionServices;
	/** What pi's runtime factory hands back beside the session. */
	readonly result: CreateAgentSessionResult;
	readonly requests: PiProviderRequest[];
	script(responses: readonly PiFauxReply[]): void;
	modelFor(id: string, compat: Readonly<Record<string, unknown>>): unknown;
}

/**
 * Build one session the way pi's runtime factory does: pi's services (its own
 * extension loader over the built entry), the scripted model, then
 * `createAgentSessionFromServices` with the session manager and start event
 * the CALLER chose — `startPiSession`, `resume`, or pi's own
 * `AgentSessionRuntime` for a replacement. Extensions are not bound here:
 * binding emits `session_start`, and for a replacement pi does that itself
 * (`rebindSession`, see `PiSession.restart`).
 */
async function createSession(
	args: SessionArgs,
	options: Parameters<CreateAgentSessionRuntimeFactory>[0],
	responses: readonly PiFauxReply[],
): Promise<CreatedSession> {
	const requests: PiProviderRequest[] = [];
	const { modelRuntime, model, modelFor, script } = await buildModelRuntime(
		options.agentDir,
		requests,
		args.modelCompat,
	);
	script(responses);
	const services = await withFixtureTmpdir(args.root, () =>
		hostModule().createAgentSessionServices({
			cwd: options.cwd,
			agentDir: options.agentDir,
			modelRuntime,
			extensionFlagValues: new Map(args.flags),
			resourceLoaderOptions: {
				...(args.inlineFactory
					? { extensionFactories: [args.inlineFactory] }
					: {
							additionalExtensionPaths: [
								...(args.extraExtensions?.before ?? []),
								EXTENSION_ENTRY,
								...(args.extraExtensions?.after ?? []),
							],
						}),
				// pi discovers skills under `$HOME/.agents/skills` as well as
				// `agentDir`, so a host's own skills padded every system prompt
				// (15,144 characters on one dev host, none on a CI runner) and moved
				// prefix-ratio verdicts (#4724). A direct `-e` load gives pi-lens no
				// skills of its own (index.ts `resources_discover`).
				noSkills: true,
			},
		}),
	);
	const loadErrors = services.resourceLoader.getExtensions().errors;
	if (loadErrors.length > 0) {
		throw new Error(
			`pi failed to load ${args.inlineFactory ? "the inline factory" : EXTENSION_ENTRY}: ${JSON.stringify(loadErrors.map((entry) => String(entry.error)))}`,
		);
	}
	const result = await hostModule().createAgentSessionFromServices({
		services,
		sessionManager: options.sessionManager,
		model: model as never,
		sessionStartEvent: options.sessionStartEvent,
		...(args.customTools ? { customTools: [...args.customTools] } : {}),
	});
	return {
		session: result.session,
		services,
		result,
		requests,
		script,
		modelFor,
	};
}

/** Bind the loaded copy to a session: pi emits that session's `session_start`. */
async function bindTo(
	session: AgentSession,
	errors: unknown[],
	ui?: UiRecorder,
): Promise<void> {
	await session.bindExtensions({
		onError: (error: unknown) => errors.push(error),
		...(ui ? { uiContext: ui.context, mode: "tui" as const } : {}),
	});
}

/**
 * The replacement pi performs for one reason, through pi's OWN entry point:
 * pi builds the next session manager, tears this session down (`abort`,
 * `session_shutdown` with `targetSessionFile`, `dispose`), then creates and
 * binds the next one (`session_start` with `previousSessionFile`). A reason
 * with no entry point here throws BEFORE pi tears anything down: a replacement
 * this helper cannot run faithfully is refused, never approximated.
 */
function replaceThrough(
	runtime: AgentSessionRuntime,
	replacement: Exclude<PiReplacement, { reason: "reload" }>,
): Promise<{ cancelled: boolean }> {
	switch (replacement.reason) {
		case "new":
			return runtime.newSession();
		case "resume":
			return runtime.switchSession(replacement.sessionFile);
		case "fork":
			return runtime.fork(replacement.entryId, {
				position: replacement.position,
			});
		default:
			throw new Error(
				`pi-session: no faithful replacement for reason ${JSON.stringify((replacement as { reason?: unknown }).reason)}; add pi's own entry point for it, never a synthesised event`,
			);
	}
}

/** The handle over one bound session; registered for `afterEach` at once. */
function handleFor(
	args: SessionArgs,
	created: CreatedSession,
	errors: unknown[],
): PiSession {
	const { session } = created;
	let disposed = false;
	let replacing = false;
	/**
	 * Settle every sink after the session ended. It runs whether the loaded
	 * copy's `session_shutdown` came from `dispose()` or from pi's own teardown
	 * in a replacement.
	 */
	const drain = async (): Promise<void> => {
		// The same process-global writer map the loaded copy registered into:
		// a second, test-side settle of the same sinks. It writes the same
		// rows whether or not the shutdown emit ran, so it is a belt, never the
		// proof that the handler did (a case that proves the emit asserts a
		// handler effect, not a log row).
		await flushAllNdjsonWriters();
		await drainBackgroundWritesForTests();
		// Join the copy's queued registry mutations AND the sink rows those
		// mutations log. #2146 keys the tail on `globalThis`, so this import
		// joins the copy's own queue; without the join the deregistration
		// write lands after `dispose()` returns and re-creates the removed
		// fixture root — measured on this host, warm process: 5 of 5 runs,
		// 5–8 ms after the removal, carrying `instances.json.locks/…`,
		// `cascade.log` and `latency.log` (#4664 F7).
		//
		// TWO rounds, because a round joins only what is queued when it is
		// called: the deregistration mutation logs its own sink rows, and the
		// registry read taken inside it can queue the next mutation (the
		// dead-pid prune). Measured the same way: one round still re-created
		// the root in 1 of 5 runs, two rounds in 0 of 6.
		for (let round = 0; round < 2; round += 1) {
			await _settleRegistryMutationsForTests();
			await flushAllNdjsonWriters();
		}
	};
	/** One replacement of this handle's session; `restart` serializes it. */
	const replaceSession = async (
		replacement: PiReplacement,
		responses: readonly PiFauxReply[],
	): Promise<PiSession> => {
		if (replacement.reason === "reload") {
			// pi's own reload keeps this AgentSession, its manager and its
			// session id; it re-runs the extension factories and emits
			// `session_shutdown`/`session_start` with reason `reload` itself.
			created.script(responses);
			await session.reload();
			return handle;
		}
		const replacementErrors: unknown[] = [];
		let next: CreatedSession | undefined;
		const runtime = new (hostModule().AgentSessionRuntime)(
			session,
			created.services,
			async (options) => {
				next = await createSession(args, options, responses);
				return { ...next.result, services: next.services, diagnostics: [] };
			},
		);
		runtime.setRebindSession((replaced) =>
			bindTo(replaced, replacementErrors, args.ui),
		);
		// pi calls this after the shutdown handlers ran and before it disposes
		// the session, so from here on this handle owns no live session and
		// must not emit a second shutdown. A refusal before the teardown (an
		// unknown reason, a missing file) leaves the session live, and
		// `afterEach` still disposes it.
		runtime.setBeforeSessionInvalidate(() => {
			disposed = true;
		});
		const { cancelled } = await replaceThrough(runtime, replacement);
		await drain();
		if (cancelled || next === undefined)
			throw new Error(
				`pi-session: pi did not complete the ${replacement.reason} replacement`,
			);
		return handleFor(args, next, replacementErrors);
	};
	const handle: PiSession = {
		session,
		cwd: created.services.cwd,
		requests: created.requests,
		errors,
		notifications: args.ui?.notifications ?? [],
		statuses: args.ui?.statuses ?? [],
		sessionFile: () => session.sessionManager.getSessionFile(),
		async latencyRows() {
			await flushAllNdjsonWriters();
			return readNdjsonRows(path.join(args.root, "home", "latency.log"));
		},
		async prompt(text) {
			await session.prompt(text);
		},
		async compact(instructions) {
			return session.compact(instructions);
		},
		async switchModel(compat) {
			const next =
				session.model?.id === FAUX_MODEL.id ? FAUX_MODEL_ALT : FAUX_MODEL;
			await session.setModel(
				created.modelFor(next.id as string, compat) as never,
			);
		},
		async restart(replacement, responses) {
			// A replaced handle's session is gone, and one being replaced is about
			// to be: restarting it again would build a session beside the live
			// replacement and take its identity (#4692 L2; overlapping calls,
			// Sourcery T3). ONE message per state, because a caller has to tell
			// the two apart: the stale handle is finished with, while the one
			// being replaced only has to be awaited.
			if (disposed)
				throw new Error(
					"pi-session: restart() on a session that already ended; restart the handle the previous restart() returned",
				);
			if (replacing)
				throw new Error(
					"pi-session: restart() while that session is being replaced; await the call already in flight",
				);
			replacing = true;
			try {
				return await replaceSession(replacement, responses);
			} finally {
				replacing = false;
			}
		},
		async resume(responses) {
			const file = session.sessionManager.getSessionFile();
			if (!file || !fs.existsSync(file))
				throw new Error(
					`pi-session: nothing to resume — the session wrote no file under ${args.root}/sessions`,
				);
			await handle.dispose();
			return bindSession(
				args,
				await createSession(
					args,
					{
						cwd: created.services.cwd,
						agentDir: created.services.agentDir,
						sessionManager: hostModule().SessionManager.open(
							file,
							path.dirname(file),
						),
					},
					responses,
				),
			);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			// pi awaits every handler it emits, so this runs the LOADED copy's
			// own `session_shutdown` handler: its primary release, its registry
			// deregistration, and its writer drain (the handler returns
			// `bounded(flushAllNdjsonWriters(), …)`).
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			} as never);
			session.dispose();
			await drain();
		},
	};
	// Registered the moment the session exists, BEFORE any assertion the case
	// makes: `afterEach` disposes whatever is still live, so a failing case
	// cannot leave a primary session behind for the next one (#4664 M2).
	liveHandles.push(handle);
	return handle;
}

/** Bind a created session and return its handle. */
async function bindSession(
	args: SessionArgs,
	created: CreatedSession,
): Promise<PiSession> {
	const errors: unknown[] = [];
	await bindTo(created.session, errors, args.ui);
	return handleFor(args, created, errors);
}

/**
 * Start a real session over the built extension for one fixture. Call it once
 * per test file and keep the handle: the fixture, the load (~0.2 s) and the
 * session belong to the file, and `afterAll` below removes them.
 */
export async function startPiSession(
	options: PiSessionOptions,
): Promise<PiSession> {
	const cwd = options.cwd ?? path.join(options.root, "proj");
	const agentDir = path.join(options.root, "agent");
	const sessionsDir =
		options.sessionsDir ?? path.join(options.root, "sessions");
	for (const dir of [cwd, path.join(cwd, ".git"), agentDir, sessionsDir])
		fs.mkdirSync(dir, { recursive: true });
	assertOneRoot(options.root);
	// Save before pinning: the loaded copy reads these at its own load, so the
	// pin must precede `createAgentSessionServices`.
	for (const key of PINNED_KEYS) {
		if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	}
	process.env.PI_LENS_HOME = path.join(options.root, "home");
	process.env.PILENS_DATA_DIR = path.join(options.root, "data");
	process.env.PI_LENS_TEST_MODE = "0";
	// Every background scanner's report directory (jscpd, the ast-grep exports
	// pass, ...) is created under `scannerReportParentDir()` and removed in the
	// scan's own `finally`. A `session_start` scan is fire-and-forget and the
	// LOADED copy owns its resident clients, so this side cannot drain it
	// (header, point 6): a scan still running when the worker ends would strand
	// its directory in the SHARED tmp root — measured on a host pre-push, where
	// two `pi-lens-jscpd-*` entries outlived the slice-7 ordering file and the
	// hygiene census attributed them to it. The seam's contract is that a
	// harness owning a root points the override at it, so an orphan lands inside
	// the root this file removes; the scanner-only harness marker supplies the
	// half the `PI_LENS_TEST_MODE=0` pin removes (the copy is deliberately not in
	// test mode, so `isTestMode()` alone would fall back to the shared tmpdir).
	const scannerTmp = path.join(options.root, "scanner-tmp");
	fs.mkdirSync(scannerTmp, { recursive: true });
	process.env.PI_LENS_TEST_SCANNER_TMPDIR = scannerTmp;
	process.env.PI_LENS_TEST_SCANNER_HARNESS = "1";
	const startupMode = options.startupMode ?? "full";
	process.env.PI_LENS_STARTUP_MODE = startupMode;
	// A quick start is the production FIRST-session shape, and it arms pi-lens's
	// cold-start warmup timer. That timer's project-snapshot persist is
	// module-scope in the loaded copy with no test-side drain (the `p3` residual
	// in the PR body), so it lands after this fixture root is removed and
	// re-creates it. The documented opt-out drops the TIMER only: the quick
	// start branch — the skipped work and the `mode: "quick"` row — still runs.
	if (startupMode === "quick") process.env.PI_LENS_COLD_START_QUICK = "0";
	else delete process.env.PI_LENS_COLD_START_QUICK;
	if (options.extraExtensions && options.inlineFactory)
		throw new Error(
			"startPiSession: extraExtensions is path mode only; this helper does not pin an inline factory's place in pi's load order",
		);
	const args: SessionArgs = {
		root: options.root,
		flags: flagMap(DEFAULT_FLAGS, options.flags),
		modelCompat: options.modelCompat ?? DEFAULT_MODEL_COMPAT,
		...(options.captureUi ? { ui: createUiRecorder() } : {}),
		...(options.customTools ? { customTools: options.customTools } : {}),
		...(options.extraExtensions
			? { extraExtensions: options.extraExtensions }
			: {}),
		...(options.inlineFactory
			? { inlineFactory: await options.inlineFactory() }
			: {}),
	};
	return bindSession(
		args,
		await createSession(
			args,
			{
				cwd,
				agentDir,
				sessionManager: hostModule().SessionManager.create(cwd, sessionsDir),
			},
			options.responses,
		),
	);
}

/**
 * Create the file's fixture root. The caller owns the handle for the file's
 * lifetime; `afterAll` below removes it after the drain.
 *
 * This call PINS the file's one root. The guard therefore fires even when no
 * case has started a session yet, which makes it independent of case order: a
 * second `piSessionFixture()` — or a `startPiSession` under another root —
 * fails at creation instead of quietly starting a session that observes
 * nothing (#4664 M1).
 */
export function piSessionFixture(): { root: string; cleanup: () => void } {
	const fixture = setupTestEnvironment(TMP_PREFIX);
	assertOneRoot(fixture.tmpDir);
	liveFixtures.push(fixture.cleanup);
	return { root: fixture.tmpDir, cleanup: fixture.cleanup };
}

/**
 * Dispose every handle this file created that is still live: the per-case
 * teardown, and the reason a failing assertion cannot cascade into the next
 * case (#4664 M2). `dispose()` is idempotent, so a case that disposes its own
 * handle is a no-op here.
 */
afterEach(async () => {
	for (const handle of liveHandles.splice(0)) await handle.dispose();
});

/**
 * Dispose every live handle and join every deferred writer the loaded copy can
 * still land in a fixture root. The loaded copy's module-scope deferred
 * writers that register a drain (`clients/background-write-drains.ts`: the
 * project-snapshot worker persist, the installer's debounced probe-cache flush)
 * are joined here, and the NDJSON writers are flushed a second time: a row the
 * copy appends after `dispose()` otherwise re-creates the root once it is
 * removed (#4937; master run 40967488612). The persist queue in
 * `clients/review-graph/builder.ts` and the warmup timer register no drain and
 * stay unreachable (header, point 6).
 *
 * Exported so the helper's contract test can run it ahead of a root's removal;
 * the `afterAll` below is its only other caller.
 */
export async function drainPiSessionWrites(): Promise<void> {
	for (const handle of liveHandles.splice(0)) await handle.dispose();
	await drainBackgroundWritesForTests();
	await drainRegisteredBackgroundWritesForTests();
	await flushAllNdjsonWriters();
	await _settleRegistryMutationsForTests();
}

/**
 * Settle, put the environment back, then remove every fixture root this file
 * owns. `afterEach` above already disposed each case's handles; the drain is
 * the backstop for a case that threw before its first `await`, plus the
 * settle/removal order.
 */
afterAll(async () => {
	await drainPiSessionWrites();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const cleanup of liveFixtures.splice(0)) cleanup();
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});
