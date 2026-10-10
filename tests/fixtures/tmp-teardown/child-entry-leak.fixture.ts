// Fixture for tests/support/tmp-root-teardown.test.ts (#2912): a tmp root made
// by a GRANDCHILD process. The fixture's own interposer sees creations only in
// its own process, so this root reaches the run's creators record unobserved —
// the real-pi jscpd shape (#4292), where a child of a test file made
// `pi-lens-jscpd-*` and the prefix owner took the blame.
//
// Kept out of the scanned population: `*.fixture.ts` is not a governance test
// file, and the grandchild is a real process spawn, so this file is not walked
// by the flake-shape detectors.
import { execFileSync } from "node:child_process";
import { it } from "vitest";

it("leaves a root a grandchild process made", () => {
	execFileSync(
		process.execPath,
		[
			"-e",
			'const fs=require("node:fs"),os=require("node:os"),path=require("node:path");process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(),"pi-lens-2912child-")));',
		],
		{ encoding: "utf8" },
	);
});
