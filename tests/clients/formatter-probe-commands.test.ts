/**
 * #1495 review — pin which binaries each formatter's `detect()` actually probes.
 *
 * #1539 removed the `command[0]` approximation this test was written to make
 * visible: the poison guard now reads the binaries a `detect()` really consulted
 * out of an `AsyncLocalStorage` probe record, so an unaccounted extra probe is
 * no longer invisible to it. The pin stays, for the fact it was always really
 * pinning: WHICH binaries a detection reaches for. That is a policy decision —
 * an install fallback probed eagerly, or a formatter quietly gaining a second
 * interpreter — and it should not change without someone saying so here.
 *
 * The allowance is asserted in BOTH directions (#1532 review). One-directional
 * was mutation-proven wrong: a bogus entry for zig passed, and a real one had
 * gone stale — `oxfmt: ["vp"]` was an orphan, because oxfmt's `which("vp")` and
 * `which("oxfmt")` live in `resolveCommand`, not `detect()`, whose whole body is
 * config-file checks. An unused allowance silently widens the pin.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
}));
vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: vi.fn(),
	getLastLoggedPhase: () => undefined,
}));

import {
	ALL_FORMATTERS,
	clearFormatterCache,
} from "../../clients/formatters.js";

/**
 * Binaries a formatter's `detect()` probes BESIDES its own `command[0]`, with
 * why. Every entry must be OBSERVED and every observation must be declared, so
 * the pin can neither silently widen nor silently narrow.
 */
const EXTRA_PROBED_COMMANDS: Record<string, readonly string[]> = {
	// Install fallback: `rustup component add rustfmt`. Not harmless — a stalled
	// `which rustup` skips the install that would have fixed a genuinely absent
	// rustfmt, which is one of the two cases #1539 fixed.
	rustfmt: ["rustup"],
	// Install fallback, plus the dotnet-tool form of the same formatter.
	csharpier: ["dotnet"],
	// Co-equal alternatives — either interpreter can satisfy the formatter. The
	// genuine co-equal residual, and the only one: oxfmt's `vp` is a
	// `resolveCommand` probe, not a detection probe.
	"psscriptanalyzer-format": ["pwsh", "powershell"],
};

const finder = () => (process.platform === "win32" ? "where" : "which");

let cwd: string;

beforeEach(() => {
	safeSpawnAsync.mockReset();
	// Every lookup misses, so detection walks its whole candidate list and every
	// probe it would ever make is recorded.
	safeSpawnAsync.mockResolvedValue({ stdout: "", stderr: "", status: 1 });
	clearFormatterCache();
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-probe-commands-"));
	// A Cargo.toml unlocks rustfmt's install-fallback branch, so the `rustup`
	// probe is genuinely exercised rather than merely declared below.
	fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\nname='a'\n");
});

/** Every binary each formatter's `detect()` looked up, in one full sweep. */
async function probesByFormatter(): Promise<Map<string, Set<string>>> {
	const observed = new Map<string, Set<string>>();
	for (const formatter of ALL_FORMATTERS) {
		safeSpawnAsync.mockClear();
		clearFormatterCache();
		try {
			await formatter.detect(cwd);
		} catch {
			// A detection that throws probed whatever it probed before throwing;
			// the recorded calls are still the fact under test.
		}
		observed.set(
			formatter.name,
			new Set(
				safeSpawnAsync.mock.calls
					.filter((call) => call[0] === finder())
					.map((call) => (call[1] as string[])[0])
					.filter((command): command is string => Boolean(command)),
			),
		);
	}
	return observed;
}

describe("formatter detection probes only the binaries we account for (#1495)", () => {
	it("every formatter's probed commands are its own plus a declared extra", async () => {
		const unexpected: string[] = [];

		for (const formatter of ALL_FORMATTERS) {
			safeSpawnAsync.mockClear();
			clearFormatterCache();
			try {
				await formatter.detect(cwd);
			} catch {
				// A detection that throws probed whatever it probed before throwing;
				// the recorded calls are still the fact under test.
			}
			const probed = new Set(
				safeSpawnAsync.mock.calls
					.filter((call) => call[0] === finder())
					.map((call) => (call[1] as string[])[0])
					.filter((command): command is string => Boolean(command)),
			);
			const allowed = new Set<string>([
				formatter.command[0] ?? "",
				...(EXTRA_PROBED_COMMANDS[formatter.name] ?? []),
			]);
			for (const command of probed) {
				if (!allowed.has(command)) {
					unexpected.push(`${formatter.name} probes ${command}`);
				}
			}
		}

		expect(
			unexpected,
			[
				"These formatters probe a binary this pin does not account for.",
				"Either the probe belongs to the formatter's own binary, or list it in",
				"EXTRA_PROBED_COMMANDS with the reason (install fallback vs co-equal",
				"alternative). #1539's guard reads the real probe record, so an extra",
				"is no longer invisible to it — but it is still a policy change.",
			].join(" "),
		).toEqual([]);
	});

	it("the declared extras all belong to real formatters", () => {
		// A stale entry here would quietly widen the allowance for a formatter that
		// no longer exists, or mask a rename.
		const names = new Set(ALL_FORMATTERS.map((f) => f.name));
		const orphans = Object.keys(EXTRA_PROBED_COMMANDS).filter(
			(name) => !names.has(name),
		);
		expect(orphans, "delete these stale EXTRA_PROBED_COMMANDS entries").toEqual(
			[],
		);
	});

	it("every declared extra is actually observed", async () => {
		// The reverse direction (#1532 review). Without it the allowance is
		// one-directional: a bogus entry for zig passed, and `oxfmt: ["vp"]` sat
		// there as an orphan while oxfmt's detect probed nothing at all. An unused
		// allowance is a pin that has quietly stopped pinning.
		const observed = await probesByFormatter();
		const unobserved: string[] = [];
		for (const [name, extras] of Object.entries(EXTRA_PROBED_COMMANDS)) {
			const probed = observed.get(name) ?? new Set<string>();
			for (const command of extras) {
				if (!probed.has(command))
					unobserved.push(`${name} never probes ${command}`);
			}
		}

		expect(
			unobserved,
			[
				"These EXTRA_PROBED_COMMANDS entries are dead. Either the detection",
				"stopped probing the binary (delete the entry) or the probe moved to",
				"resolveCommand, which this pin does not cover (delete it too —",
				"oxfmt's `vp` was exactly that).",
			].join(" "),
		).toEqual([]);
	});
});
