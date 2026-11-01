import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment, useTrackedTempDirs } from "../../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

// java present + spotbugs resolves to a stub command. createAvailabilityChecker
// is called at module load for both java and spotbugs.
vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: () => ({
			isAvailableAsync: async () => true,
			getCommand: () => null,
		}),
		resolveAvailableOrInstall: async () => "spotbugs-stub",
	}),
);

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
		fs.writeFileSync(
			path.join(classesDir, "Foo.class"),
			Buffer.from([0xca, 0xfe]),
		);
	});

	// The skip case never cleans the env this hook made, so drain every root
	// here rather than relying on each test's own `finally`.
	afterEach(() => vi.unstubAllEnvs());

	useTrackedTempDirs("pi-lens-spotbugs-");

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
			const mod =
				await import("../../../../clients/dispatch/runners/spotbugs.js");
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
			const mod =
				await import("../../../../clients/dispatch/runners/spotbugs.js");
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

	// Recurrence (the scanner temp-root fold, refs #4907): the -output file was
	// joined onto a bare `os.tmpdir()`, so a harness that owns a scanner root
	// (`PI_LENS_TEST_SCANNER_TMPDIR`) and sweeps it never saw the XML a killed
	// SpotBugs run stranded; every sibling scanner already asks
	// `scannerReportParentDir()`.
	it("writes the -output file under the scanner report root", async () => {
		const scannerRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-spotbugs-root-"),
		);
		vi.stubEnv("PI_LENS_TEST_SCANNER_TMPDIR", scannerRoot);
		try {
			const res = await run(env.tmpDir);
			expect(res.status).toBe("succeeded");
			const args = safeSpawnAsync.mock.calls[0]?.[1] as string[];
			const output = args[args.indexOf("-output") + 1];
			expect(path.dirname(output)).toBe(scannerRoot);
			expect(path.basename(output)).toMatch(/^pi-lens-spotbugs-.*\.xml$/);
		} finally {
			fs.rmSync(scannerRoot, { recursive: true, force: true });
			env.cleanup();
		}
	});

	// Recurrence (#4946 review, F3): the output file was named from the pid and
	// `Date.now()`, so two cold starts in one millisecond shared it. The run that
	// read second found the other's cleanup had removed the file and reported
	// "succeeded" with no findings, and a different interleaving attributed one
	// run's findings to the other. Registering `lens-spotbugs` made the runner
	// reachable, so the clock is pinned to force the collision the default clock
	// only makes unlikely.
	it("gives two concurrent cold starts distinct output files and each its own findings", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			const outputs: string[] = [];
			let release: () => void = () => {};
			const bothWritten = new Promise<void>((resolve) => {
				release = resolve;
			});
			safeSpawnAsync.mockReset();
			safeSpawnAsync.mockImplementation(
				async (_cmd: string, args: string[]) => {
					const out = args[args.indexOf("-output") + 1] as string;
					outputs.push(out);
					const bug = `BUG_${outputs.length}`;
					fs.writeFileSync(out, ONE_BUG_XML.replace("NP_ALWAYS_NULL", bug));
					// Both runs have written before either reads: the interleaving
					// that exposes a shared path.
					if (outputs.length === 2) release();
					await bothWritten;
					return { error: null, status: 0, stdout: "", stderr: "" };
				},
			);
			const mod =
				await import("../../../../clients/dispatch/runners/spotbugs.js");
			mod._resetSpotbugsCacheForTests();
			const runner = mod.default;
			const [first, second] = await Promise.all([
				runner.run(ctx(env.tmpDir) as never),
				runner.run(ctx(env.tmpDir) as never),
			]);

			expect(safeSpawnAsync).toHaveBeenCalledTimes(2);
			expect(new Set(outputs).size, JSON.stringify(outputs)).toBe(2);
			for (const res of [first, second]) {
				expect(res.status).toBe("succeeded");
				expect(res.diagnostics).toHaveLength(1);
			}
			expect(
				[first, second].map((res) => res.diagnostics[0]?.rule).sort(),
			).toEqual(["BUG_1", "BUG_2"]);
		} finally {
			clock.mockRestore();
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
