/**
 * The tool-probe spawn seam (#2894).
 *
 * A sibling of `tool-cwd.ts`: that module owns where a child that READS A
 * PROJECT starts, this one owns the fact that a child which reads no project
 * starts nowhere in particular.
 *
 * It is a module of its own rather than another export on `safe-spawn.ts`
 * deliberately. Every availability test in this repo fakes the process
 * boundary with `vi.mock("clients/safe-spawn.js", … { safeSpawnAsync })`, and
 * a same-module helper would call the module's own unmocked binding — the
 * probe would spawn for real while the test believed it had the boundary. One
 * module hop keeps every existing double production-faithful.
 */

import type { SafeSpawnOptions, SpawnResult } from "./safe-spawn.js";
import { safeSpawnAsync } from "./safe-spawn.js";

/**
 * What a tool probe may set. `cwd` is deliberately ABSENT — see
 * {@link probeToolAsync}.
 */
export type ProbeSpawnOptions = Omit<SafeSpawnOptions, "cwd">;

/**
 * Run a tool's own presence/version invocation — `<tool> --version`, `cl`,
 * `go version`, `which <pm>`, `Get-Module -ListAvailable …` — and hand back
 * the raw spawn result for the caller's availability policy to classify.
 *
 * ## The contract: a probe never gets a `cwd`
 *
 * A probe asks whether a binary exists and what it calls itself. The answer
 * does not depend on the directory the child starts in, so this seam passes
 * NONE — the child inherits the host's directory and nothing it reports is
 * read out of a project. That is why the sweep in
 * `tests/clients/dispatch/runners/runner-spawn-cwd-sweep.test.ts` admits ONE
 * cwd-less spawn here instead of the 24 it admitted before: every one of those
 * sites re-decided the same thing in its own words, and two dozen sentences a
 * reviewer has to re-read one at a time is how an admission table stops being
 * auditable (#2872 round 3 shipped 127 rows carrying two canned sentences,
 * four of them false where they were read).
 *
 * `cwd` is STRIPPED rather than merely left out of {@link ProbeSpawnOptions}:
 * the type stops an object literal from carrying one, and the explicit
 * `cwd: undefined` below stops one that arrives inside an already-typed
 * options object a caller widened or spread. A probe that genuinely needs to
 * run somewhere — `mix credo --version` needs a mix project, `cargo clippy
 * --version` needs a package, `eslint --version` resolves a project-local
 * binary — must call `safeSpawnAsync` directly and be admitted by that sweep
 * on its own reason.
 */
export async function probeToolAsync(
	command: string,
	args: readonly string[],
	options?: ProbeSpawnOptions,
): Promise<SpawnResult> {
	return safeSpawnAsync(command, [...args], { ...options, cwd: undefined });
}
