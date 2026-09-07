/**
 * The trust-gated `ProcessSpec` (#2425, scope item 5).
 *
 * Today `createCustomServer` (`clients/lsp/config.ts`) builds an argv and an
 * env straight out of project-local JSON, with no gate at that seam; the only
 * trust check is far downstream in `lsp/index.ts`. This module is the type that
 * makes the gate a property of the VALUE instead of a property of one call
 * site: a spec knows which tier described it and what the host said about that
 * tier's trust, and `toSpawnArgs` is the only way to get spawnable arguments
 * out of it.
 *
 * THIS PR SPAWNS NOTHING. `toSpawnArgs` returns arguments; #2372 slice 2 hands
 * them to `safeSpawnAsync` at `createCustomServer`. Keeping the decision pure
 * is what lets the trust matrix be tested exhaustively without a child process.
 *
 * The gate, stated as a rule: a spec whose provenance tier is `project` or
 * `nested-project` yields spawn arguments only when BOTH the spec's own trust
 * decision and the host's CURRENT decision are `"trusted"`. Two conditions
 * rather than one, because they fail differently:
 *
 * - the spec's `trust` is the decision that applied when the config was read;
 * - `getProjectTrustState()` is the decision that applies now, and a session
 *   can revoke trust between the two. A spec that carried `trusted` in its own
 *   fields would otherwise be a permanent capability token.
 *
 * `unknown` does not pass for repo tiers. Elsewhere in pi-lens `unknown` is
 * fail-open, because an older host that never had `isProjectTrusted` never had
 * a decision to honor. Here it is fail-closed, and the asymmetry is deliberate:
 * `isToolInstallAllowedByTrust` gates pi-lens's OWN managed tools, while this
 * gates a command string a repository wrote.
 */

import { incrementDegradationCount } from "../degradation-ledger.js";
import { homeRelativePath } from "../path-utils.js";
import {
	getProjectTrustGeneration,
	getProjectTrustState,
} from "../project-trust.js";
import {
	compareKeys,
	isRepoTier,
	type Provenance,
	type TrustDecision,
} from "./provenance.js";

/** Where the process runs: the project root, or the touched file's directory. */
type CwdMode = "root" | "file-dir";

/** How input reaches the process. */
type InputMode = "none" | "stdin" | "file";

/** Longest argv a spec may carry. A command line, not a file list. */
export const MAX_ARGV_ENTRIES = 128;

/** Total argv bytes a spec may carry. */
const MAX_ARGV_BYTES = 32 * 1024;

/** Most env entries a spec may carry. */
export const MAX_ENV_ENTRIES = 64;

/** Total env bytes (names plus values) a spec may carry. */
export const MAX_ENV_BYTES = 16 * 1024;

/** Longest timeout a spec may declare, in milliseconds. */
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A described process. Non-empty argv, bounded env, closed cwd/input modes, a
 * timeout, and the provenance and trust that decide whether it may run.
 */
export interface ProcessSpec {
	readonly argv: readonly [string, ...string[]];
	readonly env: Readonly<Record<string, string>>;
	readonly cwdMode: CwdMode;
	readonly inputMode: InputMode;
	readonly timeoutMs: number;
	readonly provenance: Provenance;
	readonly trust: TrustDecision;
}

/** What a caller hands `buildProcessSpec`. Everything is still untrusted here. */
export interface ProcessSpecInput {
	readonly argv: readonly unknown[];
	readonly env?: Readonly<Record<string, unknown>>;
	readonly cwdMode?: CwdMode;
	readonly inputMode?: InputMode;
	readonly timeoutMs: number;
	readonly provenance: Provenance;
	/** Defaults to the host's current decision when the caller has no better one. */
	readonly trust?: TrustDecision;
}

/** Why a spec could not be built. A closed vocabulary, greppable in tests. */
type ProcessSpecRejectionCode =
	| "empty-argv"
	| "argv-not-strings"
	| "argv-too-many"
	| "argv-too-large"
	| "env-not-strings"
	| "env-too-many"
	| "env-too-large"
	| "invalid-timeout"
	| "invalid-cwd-mode"
	| "invalid-input-mode";

interface ProcessSpecRejection {
	readonly code: ProcessSpecRejectionCode;
	/** Structural only: counts and limits, never an argv entry or an env value. */
	readonly reason: string;
}

export type ProcessSpecResult =
	| { readonly ok: true; readonly spec: ProcessSpec }
	| { readonly ok: false; readonly rejection: ProcessSpecRejection };

const CWD_MODES: readonly CwdMode[] = ["root", "file-dir"];
const INPUT_MODES: readonly InputMode[] = ["none", "stdin", "file"];

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Validate an untrusted description into a `ProcessSpec`.
 *
 * Pure and side-effect-free: a rejection is returned, not logged. The caller
 * knows which config file it was reading and turns the rejection into a
 * `MigrationRecord`; this module does not guess at a subsystem.
 *
 * Over-cap env is REFUSED rather than truncated. Silently dropping half a
 * process's environment produces a server that starts and then misbehaves,
 * which is strictly worse to diagnose than one that does not start.
 */
export function buildProcessSpec(input: ProcessSpecInput): ProcessSpecResult {
	const argv = input.argv;
	if (argv.length === 0) {
		return reject("empty-argv", "argv is empty; a spec needs a command");
	}
	if (argv.length > MAX_ARGV_ENTRIES) {
		return reject(
			"argv-too-many",
			`argv has ${argv.length} entries, limit ${MAX_ARGV_ENTRIES}`,
		);
	}
	if (!argv.every((entry) => typeof entry === "string")) {
		return reject("argv-not-strings", "argv entries must all be strings");
	}
	const argvStrings = argv as readonly string[];
	const argvBytes = argvStrings.reduce(
		(total, entry) => total + byteLength(entry),
		0,
	);
	if (argvBytes > MAX_ARGV_BYTES) {
		return reject(
			"argv-too-large",
			`argv is ${argvBytes} bytes, limit ${MAX_ARGV_BYTES}`,
		);
	}
	if (argvStrings[0].length === 0) {
		return reject("empty-argv", "argv[0] is empty; a spec needs a command");
	}

	const rawEnv = input.env ?? {};
	const envNames = Object.keys(rawEnv);
	if (envNames.length > MAX_ENV_ENTRIES) {
		return reject(
			"env-too-many",
			`env has ${envNames.length} entries, limit ${MAX_ENV_ENTRIES}`,
		);
	}
	const env: Record<string, string> = {};
	let envBytes = 0;
	for (const name of envNames) {
		const value = rawEnv[name];
		if (typeof value !== "string") {
			return reject("env-not-strings", "env values must all be strings");
		}
		envBytes += byteLength(name) + byteLength(value);
		env[name] = value;
	}
	if (envBytes > MAX_ENV_BYTES) {
		return reject(
			"env-too-large",
			`env is ${envBytes} bytes, limit ${MAX_ENV_BYTES}`,
		);
	}

	const cwdMode = input.cwdMode ?? "root";
	if (!CWD_MODES.includes(cwdMode)) {
		return reject("invalid-cwd-mode", "cwdMode must be root or file-dir");
	}
	const inputMode = input.inputMode ?? "none";
	if (!INPUT_MODES.includes(inputMode)) {
		return reject(
			"invalid-input-mode",
			"inputMode must be none, stdin or file",
		);
	}

	const timeoutMs = input.timeoutMs;
	if (
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > MAX_TIMEOUT_MS
	) {
		return reject(
			"invalid-timeout",
			`timeoutMs must be a finite value in (0, ${MAX_TIMEOUT_MS}]`,
		);
	}

	return {
		ok: true,
		spec: {
			argv: argvStrings as [string, ...string[]],
			env,
			cwdMode,
			inputMode,
			timeoutMs,
			provenance: input.provenance,
			trust: input.trust ?? getProjectTrustState(),
		},
	};
}

function reject(
	code: ProcessSpecRejectionCode,
	reason: string,
): ProcessSpecResult {
	return { ok: false, rejection: { code, reason } };
}

/** Why a spec was refused spawn arguments. Carries no env value and no argv tail. */
interface TrustRefusal {
	readonly kind: "trust-refusal";
	/** `spec-trust` when the recorded decision fails, `host-trust` when the live one does. */
	readonly cause: "spec-trust" | "host-trust";
	readonly reason: string;
	readonly tier: Provenance["tier"];
	/** argv[0] only. The tail can hold a token in a `--header` argument. */
	readonly command: string;
	readonly specTrust: TrustDecision;
	readonly hostTrust: TrustDecision;
	/** The trust generation the refusal happened in (`project-trust.ts`). */
	readonly trustGeneration: number;
}

/** What a spawn seam needs, and nothing more. */
interface SpawnArgs {
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly cwdMode: CwdMode;
	readonly inputMode: InputMode;
	readonly timeoutMs: number;
}

export type SpawnArgsResult =
	| { readonly ok: true; readonly args: SpawnArgs }
	| { readonly ok: false; readonly refusal: TrustRefusal };

/**
 * The degradation kind a refusal records under, reusing `project-trust.ts`'s
 * existing member rather than adding a parallel one. Aggregation across
 * install refusals and spawn refusals is the same question.
 */
const TRUST_REFUSAL_KIND = "trust-refusal";

/**
 * Turn a spec into spawn arguments, or refuse.
 *
 * Repo-tier specs need `spec.trust === "trusted"` AND a live host decision of
 * `"trusted"`. Operator-tier specs (built-in, global, env, cli, host) pass:
 * their content did not arrive with the checkout, and pi-lens's separate
 * host-level spawn gate (`isLspSpawnAllowedByTrust`) still applies downstream.
 *
 * Refusals go through `incrementDegradationCount`, which is the repo's choke
 * point for a REPEATED degradation: it writes the durable row on the first
 * occurrence and at power-of-two milestones, keeps the exact count, is bounded
 * per kind, and resets at `session_start` with the rest of the ledger. That is
 * why there is no once-latch in this module to re-arm — a second latch mirroring
 * the ledger is the defect the ledger exists to prevent.
 */
export function toSpawnArgs(spec: ProcessSpec): SpawnArgsResult {
	const tier = spec.provenance.tier;
	if (!isRepoTier(tier)) {
		return { ok: true, args: spawnArgsOf(spec) };
	}
	const hostTrust = getProjectTrustState();
	if (spec.trust !== "trusted") {
		return refuse(spec, "spec-trust", hostTrust);
	}
	if (hostTrust !== "trusted") {
		return refuse(spec, "host-trust", hostTrust);
	}
	return { ok: true, args: spawnArgsOf(spec) };
}

function spawnArgsOf(spec: ProcessSpec): SpawnArgs {
	return {
		argv: spec.argv,
		env: spec.env,
		cwdMode: spec.cwdMode,
		inputMode: spec.inputMode,
		timeoutMs: spec.timeoutMs,
	};
}

function refuse(
	spec: ProcessSpec,
	cause: TrustRefusal["cause"],
	hostTrust: TrustDecision,
): SpawnArgsResult {
	const tier = spec.provenance.tier;
	const command = spec.argv[0];
	const reason =
		cause === "spec-trust"
			? `${tier} config command refused: config trust is ${spec.trust}`
			: `${tier} config command refused: host trust is now ${hostTrust}`;
	const trustGeneration = getProjectTrustGeneration();
	const refusal: TrustRefusal = {
		kind: "trust-refusal",
		cause,
		reason,
		tier,
		command,
		specTrust: spec.trust,
		hostTrust,
		trustGeneration,
	};
	// Subject carries the trust GENERATION, the tier, and argv[0] only: enough to
	// say which command was refused and in which trust episode, never enough to
	// leak an argument or an env value.
	//
	// The generation belongs in the SUBJECT, not only in the metadata (#2440
	// review finding F6). `incrementDegradationCount` keys its tally on
	// `kind\0subject` and writes a durable row on the first occurrence and at
	// power-of-two milestones. A generation-free subject therefore made one
	// unbroken count across every trust episode of a session: revoke, refuse
	// three times, re-grant, revoke again, and the next refusal is count 4 — not
	// a power of two, so the second episode produces NO durable row at all and
	// the count a reader sees does not describe either episode. Re-arming the
	// subject per generation makes each episode its own bounded, durably-recorded
	// series, which is what a per-episode question needs.
	incrementDegradationCount({
		kind: TRUST_REFUSAL_KIND,
		subject: `config-command:g${trustGeneration}:${tier}:${command}`,
		reason,
		metadata: {
			cause,
			specTrust: spec.trust,
			hostTrust,
			trustGeneration,
			configKey: spec.provenance.key,
		},
	});
	return { ok: false, refusal };
}

/** A spec projected for a diagnostic or telemetry surface. */
export interface RedactedProcessSpec {
	/** argv[0] only. */
	readonly command: string;
	readonly argvCount: number;
	/** Env NAMES, sorted. Values never appear on this surface. */
	readonly envNames: readonly string[];
	readonly envCount: number;
	readonly cwdMode: CwdMode;
	readonly inputMode: InputMode;
	readonly timeoutMs: number;
	readonly tier: Provenance["tier"];
	readonly configKey: string;
	readonly file?: string;
	readonly trust: TrustDecision;
}

/**
 * The ONLY projection of a spec for diagnostics or telemetry.
 *
 * Strips env VALUES and every argv entry after `argv[0]` (#2415 AC 4). Both are
 * places a secret genuinely lives: a token in `--header`, a key in an env value.
 * Env NAMES survive because a name is a label, and "which variables did this
 * server get" is the question an operator actually asks.
 */
export function redactProcessSpec(spec: ProcessSpec): RedactedProcessSpec {
	return {
		command: spec.argv[0],
		argvCount: spec.argv.length,
		// `compareKeys`, not a bare `.sort()` (Sonar S2871) and not
		// `localeCompare`: this projection is compared across machines, so its
		// ordering may not depend on the machine's locale.
		envNames: Object.keys(spec.env).sort(compareKeys),
		envCount: Object.keys(spec.env).length,
		cwdMode: spec.cwdMode,
		inputMode: spec.inputMode,
		timeoutMs: spec.timeoutMs,
		tier: spec.provenance.tier,
		configKey: spec.provenance.key,
		// Home-relative for the same reason `provenanceView` is: a spec read from
		// the operator's global config would otherwise put their account name on
		// every diagnostic that named the file.
		...(spec.provenance.file === undefined
			? {}
			: { file: homeRelativePath(spec.provenance.file) }),
		trust: spec.trust,
	};
}
