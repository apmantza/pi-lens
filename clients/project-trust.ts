/**
 * Host project-trust gate (#1334 S5).
 *
 * pi decides project trust itself: an extension may *answer* the question by
 * registering `pi.on("project_trust", handler)` (returning
 * `{ trusted: "yes" | "no" | "undecided" }`), but every other extension simply
 * *consumes* the outcome through `ExtensionContext.isProjectTrusted()`. pi-lens
 * is a consumer — it must never register the handler and answer the trust
 * question on the user's behalf.
 *
 * Verified against the pinned host types
 * (`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`):
 *   - `ExtensionContext.isProjectTrusted(): boolean`  (line 234)
 *   - `ProjectTrustEventDecision = "yes" | "no" | "undecided"`  (line 390)
 *
 * Note the asymmetry: the *event* has a three-valued decision, but the *ctx*
 * accessor collapses it to a boolean. So the only distinctions pi-lens can make
 * are "host says trusted", "host says NOT trusted", and "host gave no signal at
 * all" (older hosts with no `isProjectTrusted` on the ctx).
 *
 * Policy:
 *   - `untrusted` — the host said no or its accessor failed. Block every
 *     install/materialization path (including npx and grammar WASM downloads)
 *     and pi-lens-managed materialization. LSP project executables are gated
 *     earlier by `compileLspRegistry`; built-ins and global config remain
 *     available. Discovery and cached/in-process analysis continue; a missing
 *     grammar follows its unavailable path.
 *   - `trusted` — project executable fields may be admitted by the LSP
 *     registry compiler.
 *   - `unknown` — install policy remains compatible for pi-lens-owned tools,
 *     but project-sourced LSP executable fields fail closed at the compiler;
 *     an older host must not silently run repository commands.
 *
 * Process-wide singleton on purpose: `ensureTool()` and the LSP service sit
 * many layers below any `ctx`, and threading trust through every call site
 * would be a far larger and more fragile change than a single latched state
 * refreshed on each `session_start` and `turn_start`.
 */

import { logExtension } from "./extension-log.js";
import { recordDegradation } from "./degradation-ledger.js";

export type ProjectTrustState = "trusted" | "untrusted" | "unknown";

let trustState: ProjectTrustState = "unknown";
const installRefusalWarnings = new Set<string>();
// Bounded (#1363 review): dynamic contexts (per-formatter/per-server strings)
// must not grow without limit across a long untrusted session. Clearing on
// overflow trades an occasional repeat warning for bounded memory.
const INSTALL_REFUSAL_WARNING_CAP = 200;
// Monotonic transition counter (#1363 review): consumers needing
// clear-on-transition semantics compare this lazily at use time instead of
// registering callbacks -- a per-instance listener with no teardown path
// strongly retains every instance ever constructed.
let trustGeneration = 0;

export function getProjectTrustGeneration(): number {
	return trustGeneration;
}

function latchProjectTrustState(next: ProjectTrustState): void {
	if (next === trustState) return;
	trustState = next;
	installRefusalWarnings.clear();
	trustGeneration += 1;
}

/**
 * Feature-detected read of the host trust decision off an event ctx.
 *
 * Returns `"unknown"` when the host predates the accessor, when the accessor
 * throws, or when it returns a non-boolean — never guesses "untrusted" from a
 * missing surface, because that would silently disable pi-lens on every older
 * host.
 */
export function readProjectTrustFromContext(ctx: unknown): ProjectTrustState {
	try {
		const accessor = (ctx as { isProjectTrusted?: unknown } | null | undefined)
			?.isProjectTrusted;
		if (typeof accessor !== "function") return "unknown";
		const trusted = (accessor as () => unknown).call(ctx);
		if (typeof trusted !== "boolean") return "unknown";
		return trusted ? "trusted" : "untrusted";
	} catch (accessorErr) {
		// The accessor exists, so this is not the absent older-host signal. If it
		// fails, executable content must remain gated until a later adoption works.
		// Log it (#1350 delta review): a host whose accessor throws on every call
		// permanently gates installs/LSP, and without this line the only trace is
		// indirect refusal logs.
		logExtension({
			subsystem: "project-trust",
			level: "warn",
			message: "isProjectTrusted() threw -- latching untrusted (fail-closed)",
			metadata: { error: String(accessorErr) },
		});
		return "untrusted";
	}
}

/** Latch a trust state directly (tests, and the ctx adoption path below). */
export function setProjectTrustState(next: ProjectTrustState): void {
	const previous = trustState;
	latchProjectTrustState(next);
	if (previous !== next) {
		logExtension({
			subsystem: "project-trust",
			level: "debug",
			message: `project trust state transitioned: ${previous} -> ${next}`,
			metadata: { previous, next },
		});
	}
}

/**
 * Read the host decision off `ctx` and latch it. Called from `session_start`,
 * which fires again on fork/reload/resume — a re-read per session start is
 * exactly right, since the cwd (and therefore the trust decision) can change.
 */
export function adoptProjectTrustFromContext(ctx: unknown): ProjectTrustState {
	const next = readProjectTrustFromContext(ctx);
	const previous = trustState;
	latchProjectTrustState(next);
	if (previous !== next) {
		logExtension({
			subsystem: "project-trust",
			level: "debug",
			message: `project trust state transitioned: ${previous} -> ${next}`,
			metadata: { previous, next },
		});
	}
	return next;
}

/** Adopt through the canonical host capability boundary. */
export function adoptProjectTrustFromPorts(
	ports: import("./host-ports.js").HostPorts,
): ProjectTrustState {
	const next = ports.trust.isProjectTrusted();
	setProjectTrustState(next);
	return next;
}

export function getProjectTrustState(): ProjectTrustState {
	return trustState;
}

/** Test/teardown-only: back to the fail-open default. */
export function resetProjectTrust(): void {
	latchProjectTrustState("unknown");
	installRefusalWarnings.clear();
}

/**
 * False only when the host actively denied trust. Gates tool auto-install
 * (download + execute), never plain discovery of an already-present binary.
 */
export function isToolInstallAllowedByTrust(): boolean {
	return trustState !== "untrusted";
}

/** Central gate for operations that may download or install executable content. */
export function assertInstallAllowed(context: string): boolean {
	if (isToolInstallAllowedByTrust()) return true;
	recordDegradation({
		kind: "trust-refusal",
		subject: context,
		reason: projectTrustDenialReason() ?? "project trust denied",
	});
	if (!installRefusalWarnings.has(context)) {
		if (installRefusalWarnings.size >= INSTALL_REFUSAL_WARNING_CAP) {
			installRefusalWarnings.clear();
		}
		installRefusalWarnings.add(context);
		logExtension({
			subsystem: "project-trust",
			level: "warn",
			message: `install/materialization blocked: ${context}`,
			metadata: { context, trustState },
		});
	}
	return false;
}

/**
 * False only when the host actively denied trust. The registry compiler gates
 * repository-owned LSP fields when the host signal is absent; this downstream
 * helper preserves the legacy raw-server behavior for older hosts.
 */
export function isLspSpawnAllowedByTrust(): boolean {
	return trustState !== "untrusted";
}

/** Human/log-readable reason, or undefined when nothing is being blocked. */
export function projectTrustDenialReason(): string | undefined {
	return trustState === "untrusted"
		? "project is not trusted (host isProjectTrusted() === false)"
		: undefined;
}
