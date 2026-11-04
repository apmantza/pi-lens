import { describe, expect, it } from "vitest";
import { getSgCommand } from "../../clients/dispatch/runners/utils/runner-helpers.js";
import { SgRunner } from "../../clients/sg-runner.js";

// #5247: the temp scans spawned the module sweep's command, whose unswept
// answer is `npx --no ...`, against a binary this runner had already resolved
// ("npm ERR! canceled", "unexpected argument '--no'"). The spawn seam now takes
// a branded `ResolvedSgCommand` only `SgRunner.getSgCommand` can produce, so
// that call is a COMPILE error. The `@ts-expect-error` lines below are checked
// by `npm run lint` (tsc over tests): removing the brand, or widening the spawn
// parameter, turns each one into "Unused '@ts-expect-error' directive".
function typeFixture(runner: SgRunner): void {
	const resolved = runner["getSgCommand"]();
	void runner["spawnResolved"](resolved, ["--version"], {});

	// @ts-expect-error a hand-built object has no brand
	void runner["spawnResolved"]({ cmd: "ast-grep", argsPrefix: [] }, [], {});

	// @ts-expect-error the module sweep's answer (swept or npx fallback) is not a resolved command
	void runner["spawnResolved"](getSgCommand(), [], {});

	const sweep = getSgCommand();
	if (sweep.kind === "npx-fallback") {
		// @ts-expect-error the fallback must be handled explicitly, never spawned as resolved
		void runner["spawnResolved"](sweep, [], {});
	}
}
void typeFixture;

describe("ResolvedSgCommand brand (#5247)", () => {
	it("an unresolved runner still names a bare ast-grep with an EMPTY prefix, never an npx preamble", () => {
		const resolved = new SgRunner()["getSgCommand"]();
		expect(resolved.cmd).toBe("ast-grep");
		expect(resolved.argsPrefix).toEqual([]);
	});
});
