import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";

// vi.hoisted keeps these available when the mock factories run below.
const { safeSpawnAsync, goExePath } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	// Mutable so the "go unavailable" case can flip it without re-importing.
	goExePath: { current: "/usr/local/bin/go" as string | null },
}));

vi.mock("../../../../clients/go-client.js", () => ({
	GoClient: class {
		async findGoPathAsync() {
			return goExePath.current;
		}
	},
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

function makeCtx(filePath: string, cwd = process.cwd()) {
	return {
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
	return { status, stdout, stderr } as Awaited<ReturnType<typeof safeSpawnAsync>>;
}

describe("go-vet runner", () => {
	let runner: typeof import("../../../../clients/dispatch/runners/go-vet.js");

	beforeEach(async () => {
		goExePath.current = "/usr/local/bin/go";
		safeSpawnAsync.mockReset();
		runner = await import(
			"../../../../clients/dispatch/runners/go-vet.js"
		);
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
		expect(opts).toMatchObject({ cwd: "/m", timeout: 30000 });
	});

	it("vets '.' for a file in the module-root package", async () => {
		safeSpawnAsync.mockResolvedValue(goResult());
		await runner.default.run(makeCtx("/m/main.go", "/m"));
		expect(safeSpawnAsync.mock.calls[0][1]).toEqual(["vet", "."]);
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
