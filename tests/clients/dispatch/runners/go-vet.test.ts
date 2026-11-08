// lane: windows-vitest — #3277 requires a real Windows filesystem to exercise
// the case-folding arm; the safe-spawn boundary is mocked, so no Go binary is
// required by this lane admission.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { parseGoVetOutput } from "../../../../clients/dispatch/runners/utils/diagnostic-parsers.js";
import { setupTestEnvironment } from "../../test-utils.js";

// vi.hoisted keeps these available when the mock factories run below.
const { safeSpawnAsync, goExePath } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	// Mutable so the "go unavailable" case can flip it without re-importing.
	goExePath: { current: "/usr/local/bin/go" as string | null },
}));

// #2455 fix round 4, F2: `go-client.ts` now owns the process's ONE GoClient
// and the runner imports that instance, so the double is the INSTANCE, not the
// class. Production-faithful on the axis under test: the runner calls
// `findGoPathAsync()` on it exactly as before.
vi.mock("../../../../clients/go-client.js", () => ({
	goClient: {
		async findGoPathAsync() {
			return goExePath.current;
		},
	},
}));

// #2281 / the whole-module-mock rule: spread `importOriginal` rather than
// replacing the module surface. The dispatch-level cells below import the real
// `dispatchForFile`, which widens the production surface this test file
// reaches, and a bare factory would silently drop every other `safe-spawn`
// export the dispatcher touches. `tests/config/vi-mock-export-sweep.test.ts`
// is the gate that caught exactly that when the dispatch cells were added.
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

function makeCtx(filePath: string, cwd = process.cwd()) {
	return {
		// These are synthetic POSIX paths. Do not pass them through the host
		// resolver: on Windows path.resolve("/m") injects the current drive and
		// changes the fixture's contract rather than testing go-vet attribution.
		filePath,
		cwd,
		kind: "go" as const,
		fileRole: "source" as const,
		pi: { getFlag: () => false },
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

function goResult(stdout = "", status = 0, stderr = "") {
	return { status, stdout, stderr } as Awaited<
		ReturnType<typeof safeSpawnAsync>
	>;
}

describe("go-vet runner", () => {
	let runner: typeof import("../../../../clients/dispatch/runners/go-vet.js");

	beforeEach(async () => {
		goExePath.current = "/usr/local/bin/go";
		safeSpawnAsync.mockReset();
		runner = await import("../../../../clients/dispatch/runners/go-vet.js");
	});

	it("skips when go is not available", async () => {
		goExePath.current = null;
		const res = await runner.default.run(makeCtx("/m/sub/b.go", "/m"));
		expect(res.status).toBe("skipped");
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("vets the package containing the file from the module root (not the file in isolation)", async () => {
		safeSpawnAsync.mockResolvedValue(goResult());
		const ctx = makeCtx("/m/sub/b.go", "/m");
		await runner.default.run(ctx);
		expect(safeSpawnAsync).toHaveBeenCalledTimes(1);
		const [exe, args, opts] = safeSpawnAsync.mock.calls[0];
		expect(exe).toBe("/usr/local/bin/go");
		expect(args).toEqual(["vet", "./sub"]);
		// The runner resolves its cwd through the host resolver, which on Windows
		// adds the current drive to the synthetic `/m` (`D:\m`); compare the
		// spelling that resolver produces, not the raw fixture string (#4019).
		expect(opts).toMatchObject({ cwd: path.resolve("/m"), timeout: 30000 });
	});

	it("vets '.' for a file in the module-root package", async () => {
		safeSpawnAsync.mockResolvedValue(goResult());
		await runner.default.run(makeCtx("/m/main.go", "/m"));
		expect(safeSpawnAsync.mock.calls[0][1]).toEqual(["vet", "."]);
	});

	it("vets '.' for a file outside the module root", async () => {
		// Recurrence (#2556, shape 83): the containment answer is `relativeInside`'s,
		// so an out-of-tree file never becomes `./../x`.
		safeSpawnAsync.mockResolvedValue(goResult());
		await runner.default.run(makeCtx("/elsewhere/sub/b.go", "/m"));
		expect(safeSpawnAsync.mock.calls[0][1]).toEqual(["vet", "."]);
	});

	it("vets a package directory whose name starts with '..' from inside the root", async () => {
		safeSpawnAsync.mockResolvedValue(goResult());
		await runner.default.run(makeCtx("/m/..pkg/b.go", "/m"));
		expect(safeSpawnAsync.mock.calls[0][1]).toEqual(["vet", "./..pkg"]);
	});

	it("keeps diagnostics for the edited file but drops sibling-file lines", async () => {
		// Package vetting reports siblings too; only the edited file must be attributed.
		safeSpawnAsync.mockResolvedValue(
			goResult(
				'sub/a.go:7:2: fmt.Printf format %d has arg "s" of wrong type string\n' +
					'sub/b.go:4:5: fmt.Printf format %d has arg "s" of wrong type string\n',
				1,
			),
		);
		const res = await runner.default.run(makeCtx("/m/sub/b.go", "/m"));
		expect(res.status).toBe("failed");
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0].line).toBe(4);
		expect(res.diagnostics[0].filePath).toBe("/m/sub/b.go");
	});

	it("returns succeeded when only a sibling file has issues", async () => {
		safeSpawnAsync.mockResolvedValue(
			goResult(
				'sub/a.go:7:2: fmt.Printf format %d has arg "s" of wrong type string\n',
				1,
			),
		);
		const res = await runner.default.run(makeCtx("/m/sub/b.go", "/m"));
		expect(res.status).toBe("succeeded");
		expect(res.diagnostics).toHaveLength(0);
	});

	it("returns succeeded on a clean package (no output)", async () => {
		safeSpawnAsync.mockResolvedValue(goResult());
		const res = await runner.default.run(makeCtx("/m/sub/b.go", "/m"));
		expect(res.status).toBe("succeeded");
		expect(res.diagnostics).toHaveLength(0);
	});

	// go emits the path in different FORMS depending on the target: a leading
	// `./` for the module-root package, sometimes an absolute path. A raw-string
	// match would drop the edited file's own diagnostics; resolving against cwd
	// keeps them.
	it("attributes a './'-prefixed module-root path to the edited file", async () => {
		safeSpawnAsync.mockResolvedValue(
			goResult(
				'./main.go:7:2: fmt.Printf format %d has arg "s" of wrong type string\n',
				1,
			),
		);
		const res = await runner.default.run(makeCtx("/m/main.go", "/m"));
		expect(res.status).toBe("failed");
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0].filePath).toBe("/m/main.go");
	});

	it("attributes an absolute output path to the edited file", async () => {
		safeSpawnAsync.mockResolvedValue(
			goResult(
				'/m/sub/b.go:4:5: fmt.Printf format %d has arg "s" of wrong type string\n',
				1,
			),
		);
		const res = await runner.default.run(makeCtx("/m/sub/b.go", "/m"));
		expect(res.status).toBe("failed");
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0].line).toBe(4);
	});
});

/**
 * Does THIS filesystem fold case? Measured once against a real temp directory,
 * never asserted from `process.platform` (#3159 round 2: a platform-shaped case
 * claim redded EEXIST on the first real macOS run). APFS and NTFS answer true,
 * ext4 answers false, and the case-variant cell below asserts the filesystem's
 * own answer on every lane instead of skipping off Windows.
 */
function hostFoldsPathCase(): boolean {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-go-case-"));
	try {
		fs.writeFileSync(path.join(probe, "probe.go"), "");
		return fs.existsSync(path.join(probe, "PROBE.go"));
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
}

const HOST_FOLDS_PATH_CASE = hostFoldsPathCase();

/**
 * Drive one go-vet outcome through the REAL dispatcher: `createDispatchContext`
 * (which is what makes `ctx.filePath` a `normalizeMapKey`-canonical absolute
 * path, the right-hand side of the compare under test), registry lookup,
 * `dispatchForFile`, and the model-facing render. The cells below enter here
 * rather than calling `runner.run` directly because the defect is about the
 * relationship between the dispatcher's spelling of the file and the tool's.
 */
async function dispatchGoVet(
	caseName: string,
	vetOutput: string,
	status = 1,
): Promise<{
	status: string | undefined;
	semantic: string | undefined;
	diagnostics: Array<{ line?: number; filePath?: string; message?: string }>;
	/** #5412: what the dispatcher delivers after its dedupe, not the runner's list. */
	delivered: Array<{ line?: number; column?: number; message?: string }>;
	dispatchedPath: string;
}> {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-go-vet-${caseName}-`);
	try {
		fs.writeFileSync(path.join(env.tmpDir, "go.mod"), "module demo\n");
		const filePath = path.join(env.tmpDir, "sub", "b.go");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "package sub\n");

		safeSpawnAsync.mockResolvedValue(goResult(vetOutput, status));
		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const goVet = (
			await import("../../../../clients/dispatch/runners/go-vet.js")
		).default;
		const registry = new RunnerRegistry();
		registry.register(goVet);
		let observedStatus: string | undefined;
		let observedSemantic: string | undefined;
		let observedDiagnostics: Array<{
			line?: number;
			filePath?: string;
			message?: string;
		}> = [];
		const ctx = createDispatchContext(
			filePath,
			env.tmpDir,
			{ getFlag: () => false },
			new FactStore(),
		);
		const dispatched = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: ["go-vet"] }],
			registry,
			(_runnerId, runnerResult) => {
				observedStatus = runnerResult.status;
				observedSemantic = runnerResult.semantic;
				observedDiagnostics = runnerResult.diagnostics;
			},
		);
		return {
			status: observedStatus,
			semantic: observedSemantic,
			diagnostics: observedDiagnostics,
			delivered: dispatched.diagnostics,
			dispatchedPath: ctx.filePath,
		};
	} finally {
		env.cleanup();
	}
}

describe("go-vet path identity through dispatch (#3277)", () => {
	beforeEach(() => {
		goExePath.current = "/usr/local/bin/go";
		safeSpawnAsync.mockReset();
	});

	// Recurrence prevented: #209 / #1193 — the tool's spelling of the edited
	// file differs from the dispatcher's, the bare `===` filter drops every
	// line for that file, and a run with a real finding is reported CLEAN.
	it("matches a go vet diagnostic whose reported path spells the separator the other way (#3277)", async () => {
		const observed = await dispatchGoVet(
			"separator",
			'sub\\b.go:4:5: fmt.Printf format %d has arg "s" of wrong type string\n',
		);
		expect(observed.status).toBe("failed");
		expect(observed.semantic).toBe("warning");
		expect(observed.diagnostics).toHaveLength(1);
		expect(observed.diagnostics[0]?.line).toBe(4);
		expect(observed.diagnostics[0]?.message).toContain("wrong type string");
		expect(observed.diagnostics[0]?.filePath).toBe(observed.dispatchedPath);
	});

	// Recurrence prevented: the opposite direction — an unconditional case fold
	// would merge `sub/B.go` and `sub/b.go`, which are two different files on a
	// case-sensitive host, and attribute a sibling's finding to the edited file.
	// The expectation is the FILESYSTEM's own answer, so this cell is live on
	// the ubuntu, macOS and windows lanes with opposite expectations.
	it("treats a case-variant go vet path exactly as this filesystem does (#3277)", async () => {
		const observed = await dispatchGoVet(
			"case-variant",
			'sub/B.go:4:5: fmt.Printf format %d has arg "s" of wrong type string\n',
		);
		expect(observed.diagnostics).toHaveLength(HOST_FOLDS_PATH_CASE ? 1 : 0);
		expect(observed.status).toBe(HOST_FOLDS_PATH_CASE ? "failed" : "succeeded");
	});
});

/**
 * #5412: two go vet findings on one line:column. The parser gave both the same
 * line-only id (`go-vet-<line>`) and no rule, so `findingKey` (which reads
 * `rule || id`) made them one key and the dispatcher's dedupe kept one. The
 * tool printed both lines; the agent saw one. Recurrence: the 2026-11-08
 * tool-alignment audit (origin/master 90724817f).
 */
describe("go vet findings on one position keep distinct identities (#5412)", () => {
	const sameSpot = [
		"sub/b.go:3:5: fmt.Sprintf format %d has arg x of wrong type int",
		"sub/b.go:3:5: result of fmt.Sprintf call not used",
	].join("\n");

	beforeEach(() => {
		goExePath.current = "/usr/local/bin/go";
		safeSpawnAsync.mockReset();
	});

	it("gives the two rule-less findings two different ids", () => {
		const diags = parseGoVetOutput(`${sameSpot}\n`, "/proj/sub/b.go", "/proj");
		expect(diags).toHaveLength(2);
		expect(diags[0]?.id).not.toBe(diags[1]?.id);
	});

	it("delivers both findings through the real dispatcher dedupe", async () => {
		const observed = await dispatchGoVet("same-spot", `${sameSpot}\n`);
		expect(observed.delivered.map((d) => d.message).sort()).toEqual([
			"fmt.Sprintf format %d has arg x of wrong type int",
			"result of fmt.Sprintf call not used",
		]);
	});
});
