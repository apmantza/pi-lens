/**
 * #197 — equivalence tests for the tool-install actions converted from blocking
 * `spawnSync` to async `safeSpawnAsync`.
 *
 * The conversion must preserve behaviour exactly:
 *  - same command + args spawned,
 *  - same success/failure semantics (true iff exit 0 and no spawn error),
 *  - installs run to completion regardless of an agent interrupt — i.e. they
 *    pass `ignoreAmbientSignal: true` so the ambient turn signal can't kill a
 *    half-finished install (the old sync spawns were uncancellable).
 *
 * `safeSpawnAsync` is mocked so nothing actually shells out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSafeSpawnAsync = vi.fn();

vi.mock("../../clients/safe-spawn.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/safe-spawn.js")>();
	return { ...actual, safeSpawnAsync: mockSafeSpawnAsync };
});

const ok = (overrides = {}) => ({
	stdout: "",
	stderr: "",
	status: 0,
	...overrides,
});

beforeEach(() => {
	mockSafeSpawnAsync.mockReset();
	mockSafeSpawnAsync.mockResolvedValue(ok());
});

describe("LSP server install actions (#197)", () => {
	it("tryGoInstallGopls: spawns `go install …`, runs uncancellable, true on exit 0", async () => {
		const { tryGoInstallGopls } = await import("../../clients/lsp/server.js");

		expect(await tryGoInstallGopls()).toBe(true);

		const [cmd, args, opts] = mockSafeSpawnAsync.mock.calls[0];
		expect(cmd === "go" || cmd === "go.exe").toBe(true);
		expect(args).toEqual(["install", "golang.org/x/tools/gopls@latest"]);
		expect(opts).toMatchObject({ ignoreAmbientSignal: true });
	});

	it("tryGoInstallGopls: false on non-zero exit and on spawn error", async () => {
		const { tryGoInstallGopls } = await import("../../clients/lsp/server.js");

		mockSafeSpawnAsync.mockResolvedValueOnce(ok({ status: 1 }));
		expect(await tryGoInstallGopls()).toBe(false);

		mockSafeSpawnAsync.mockResolvedValueOnce(
			ok({ status: null, error: new Error("ENOENT") }),
		);
		expect(await tryGoInstallGopls()).toBe(false);
	});

	it("tryDotnetToolInstall: install success → true, no update attempt", async () => {
		const { tryDotnetToolInstall } = await import("../../clients/lsp/server.js");

		expect(await tryDotnetToolInstall("csharp-ls")).toBe(true);
		expect(mockSafeSpawnAsync).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = mockSafeSpawnAsync.mock.calls[0];
		expect(cmd).toBe("dotnet");
		expect(args.slice(0, 2)).toEqual(["tool", "install"]);
		expect(args).toContain("csharp-ls");
		expect(opts).toMatchObject({ ignoreAmbientSignal: true });
	});

	it("tryDotnetToolInstall: missing NuGet sources → false, no update attempt", async () => {
		const { tryDotnetToolInstall } = await import("../../clients/lsp/server.js");

		mockSafeSpawnAsync.mockResolvedValueOnce(
			ok({ status: 1, stderr: "No NuGet sources are defined or enabled" }),
		);

		expect(await tryDotnetToolInstall("csharp-ls")).toBe(false);
		expect(mockSafeSpawnAsync).toHaveBeenCalledTimes(1); // did NOT try update
	});

	it("tryDotnetToolInstall: other install failure → falls back to `tool update`", async () => {
		const { tryDotnetToolInstall } = await import("../../clients/lsp/server.js");

		mockSafeSpawnAsync
			.mockResolvedValueOnce(ok({ status: 1, stderr: "already installed" }))
			.mockResolvedValueOnce(ok({ status: 0 }));

		expect(await tryDotnetToolInstall("csharp-ls")).toBe(true);
		expect(mockSafeSpawnAsync).toHaveBeenCalledTimes(2);
		expect(mockSafeSpawnAsync.mock.calls[1][1].slice(0, 2)).toEqual([
			"tool",
			"update",
		]);
	});

	it("tryGemInstall: success adds the gem bin dir to PATH; failure leaves it unchanged", async () => {
		const originalPath = process.env.PATH;
		try {
			const { tryGemInstall } = await import("../../clients/lsp/server.js");

			expect(await tryGemInstall("ruby-lsp")).toBe(true);
			const [cmd, args, opts] = mockSafeSpawnAsync.mock.calls[0];
			expect(cmd).toBe("gem");
			expect(args.slice(0, 2)).toEqual(["install", "ruby-lsp"]);
			expect(opts).toMatchObject({ ignoreAmbientSignal: true });
			expect(process.env.PATH).toContain(".pi-lens");

			process.env.PATH = originalPath;
			mockSafeSpawnAsync.mockResolvedValueOnce(ok({ status: 1 }));
			expect(await tryGemInstall("ruby-lsp")).toBe(false);
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

describe("formatter lazy-install actions (#197)", () => {
	let cwdSeq = 0;
	const freshCwd = () => `/proj/install-test-${Date.now()}-${cwdSeq++}`;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rubocop: spawns `gem install rubocop`, uncancellable, true on exit 0", async () => {
		const { tryLazyInstallFormatterTool } = await import(
			"../../clients/formatters.js"
		);

		expect(await tryLazyInstallFormatterTool("rubocop", freshCwd())).toBe(true);
		const [cmd, args, opts] = mockSafeSpawnAsync.mock.calls[0];
		expect(cmd).toBe("gem");
		expect(args).toEqual(["install", "rubocop", "--no-document"]);
		expect(opts).toMatchObject({ ignoreAmbientSignal: true });
	});

	it("rustfmt: spawns `rustup component add rustfmt`, uncancellable", async () => {
		const { tryLazyInstallFormatterTool } = await import(
			"../../clients/formatters.js"
		);

		expect(await tryLazyInstallFormatterTool("rustfmt", freshCwd())).toBe(true);
		const [cmd, args, opts] = mockSafeSpawnAsync.mock.calls[0];
		expect(cmd).toBe("rustup");
		expect(args).toEqual(["component", "add", "rustfmt"]);
		expect(opts).toMatchObject({ ignoreAmbientSignal: true });
	});

	it("returns false on a failed install and does not throw", async () => {
		const { tryLazyInstallFormatterTool } = await import(
			"../../clients/formatters.js"
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockSafeSpawnAsync.mockResolvedValueOnce(ok({ status: 1, stderr: "boom" }));

		expect(await tryLazyInstallFormatterTool("rubocop", freshCwd())).toBe(false);
	});

	it("dedupes repeated attempts for the same tool+cwd (no second spawn)", async () => {
		const { tryLazyInstallFormatterTool } = await import(
			"../../clients/formatters.js"
		);
		const cwd = freshCwd();

		expect(await tryLazyInstallFormatterTool("rubocop", cwd)).toBe(true);
		expect(mockSafeSpawnAsync).toHaveBeenCalledTimes(1);

		// Second attempt with the same key is short-circuited (returns false,
		// no new spawn) — matches the pre-conversion guard behaviour.
		expect(await tryLazyInstallFormatterTool("rubocop", cwd)).toBe(false);
		expect(mockSafeSpawnAsync).toHaveBeenCalledTimes(1);
	});
});
