import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

// java present + spotbugs resolves to a stub command. createAvailabilityChecker
// is called at module load for both java and spotbugs.
vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	createAvailabilityChecker: () => ({
		isAvailableAsync: async () => true,
		getCommand: () => null,
	}),
	resolveAvailableOrInstall: async () => "spotbugs-stub",
}));

const ONE_BUG_XML = `<BugCollection>
  <BugInstance type="NP_ALWAYS_NULL" priority="1" category="CORRECTNESS">
    <ShortMessage>Null pointer dereference</ShortMessage>
    <LongMessage>Null pointer dereference of x in Foo.bar()</LongMessage>
    <SourceLine primary="true" start="7" end="7" sourcefile="Foo.java" sourcepath="Foo.java"/>
  </BugInstance>
</BugCollection>`;

function ctx(cwd: string) {
	return {
		filePath: path.join(cwd, "src", "Foo.java"),
		cwd,
		kind: "java" as const,
		pi: { getFlag: () => true },
		facts: {},
		log: () => {},
	};
}

async function run(cwd: string) {
	const mod = await import("../../../../clients/dispatch/runners/spotbugs.js");
	mod._resetSpotbugsCacheForTests();
	const runner = mod.default;
	return runner.run(ctx(cwd) as never);
}

describe("spotbugs runner — cache + skip (#133)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let classesDir: string;

	beforeEach(() => {
		safeSpawnAsync.mockReset();
		// The runner reads SpotBugs' -output file; the real CLI writes it, so the
		// mock writes the fixture XML to that path.
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			const outIdx = args.indexOf("-output");
			if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], ONE_BUG_XML);
			return { error: null, status: 0, stdout: "", stderr: "" };
		});
		env = setupTestEnvironment("pi-lens-spotbugs-");
		classesDir = path.join(env.tmpDir, "target", "classes");
		fs.mkdirSync(classesDir, { recursive: true });
		fs.writeFileSync(path.join(classesDir, "Foo.class"), Buffer.from([0xca, 0xfe]));
	});

	it("scans the compiled tree and maps the bug to a diagnostic", async () => {
		try {
			const res = await run(env.tmpDir);
			expect(res.status).toBe("succeeded");
			expect(res.diagnostics).toHaveLength(1);
			expect(res.diagnostics[0].rule).toBe("NP_ALWAYS_NULL");
			expect(res.diagnostics[0].line).toBe(7);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("returns cached diagnostics without re-invoking SpotBugs when .class tree is unchanged", async () => {
		try {
			const mod = await import("../../../../clients/dispatch/runners/spotbugs.js");
			mod._resetSpotbugsCacheForTests();
			const runner = mod.default;
			const first = await runner.run(ctx(env.tmpDir) as never);
			expect(first.diagnostics).toHaveLength(1);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

			const second = await runner.run(ctx(env.tmpDir) as never);
			expect(second.diagnostics).toHaveLength(1);
			// Cache hit — no second invocation.
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});

	it("re-invokes SpotBugs after a rebuild (the .class tree changed)", async () => {
		try {
			const mod = await import("../../../../clients/dispatch/runners/spotbugs.js");
			mod._resetSpotbugsCacheForTests();
			const runner = mod.default;
			await runner.run(ctx(env.tmpDir) as never);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(1);

			// A rebuild adds/updates class files → signature changes.
			fs.writeFileSync(
				path.join(classesDir, "Bar.class"),
				Buffer.from([0xca, 0xfe]),
			);
			await runner.run(ctx(env.tmpDir) as never);
			expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
		} finally {
			env.cleanup();
		}
	});

	it("skips (no spawn) when the project has no compiled .class dir", async () => {
		const bare = setupTestEnvironment("pi-lens-spotbugs-bare-");
		try {
			fs.writeFileSync(path.join(bare.tmpDir, "pom.xml"), "<project/>");
			const res = await run(bare.tmpDir);
			expect(res.status).toBe("skipped");
			expect(res.diagnostics).toHaveLength(0);
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			bare.cleanup();
		}
	});
});
