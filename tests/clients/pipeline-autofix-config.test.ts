import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePackagePath } from "../../clients/package-root.js";

// The autofix path must consume the SAME config-args seam as the lint runner
// (#1247). Mock the two seams it touches — tool resolution and the
// before/after diff — so we can assert the exact markdownlint invocation
// without a real binary.
vi.mock(
	"../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => {
		const original =
			await importOriginal<
				typeof import("../../clients/dispatch/runners/utils/runner-helpers.js")
			>();
		return {
			...original,
			resolveToolCommandWithInstallFallback: vi
				.fn()
				.mockResolvedValue("markdownlint-cli2"),
		};
	},
);

vi.mock("../../clients/file-utils.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../clients/file-utils.js")>();
	return {
		...original,
		detectFileChangedAfterCommand: vi.fn().mockResolvedValue(0),
	};
});

import { detectFileChangedAfterCommand } from "../../clients/file-utils.js";
import { runAutofix } from "../../clients/pipeline.js";

const markdownlintCoreJson = resolvePackagePath(
	import.meta.url,
	"config/markdownlint/core.json",
);

describe("runAutofix markdownlint config seam (#1247)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-autofix-md-"));
		// Keep the fixture aligned with the resolver's real package identity.
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { "markdownlint-cli2": "^0.23.2" } }),
		);
		fs.writeFileSync(
			path.join(tmpDir, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": {},
					"node_modules/markdownlint-cli2": { version: "0.23.2" },
				},
			}),
		);
		vi.mocked(detectFileChangedAfterCommand).mockClear();
		vi.mocked(detectFileChangedAfterCommand).mockResolvedValue(0);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("passes the package-owned core.json to markdownlint --fix when the project has no config", async () => {
		const file = path.join(tmpDir, "doc.md");
		fs.writeFileSync(
			file,
			"# Title\n\nsome long line " + "x".repeat(200) + "\n",
		);

		await runAutofix(
			file,
			tmpDir,
			() => false,
			() => {},
			{
				biomeClient: {} as never,
				ruffClient: {} as never,
				fixedThisTurn: new Set<string>(),
			},
		);

		const calls = vi
			.mocked(detectFileChangedAfterCommand)
			.mock.calls.filter(([, , args]) => args.includes("--fix"));
		expect(calls.length).toBeGreaterThan(0);
		const args = calls[0][2];
		expect(args).toContain("--config");
		expect(args).toContain(markdownlintCoreJson);
		expect(args.indexOf("--config")).toBeLessThan(args.indexOf("--fix"));
	});

	// #5544 round 2: the autofix surface hands cli2 the same path string the lint
	// runner does, and cli2 matches `ignores` against it. With an absolute target
	// in a lane under `.claude/`, `--fix` reported `Linting: 0 files` and rewrote
	// nothing, so a fixable finding stayed fixable forever with no signal.
	it("hands --fix the project-relative target so the project's ignores can match it", async () => {
		const project = path.join(tmpDir, ".claude/worktrees/lane1");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(
			path.join(project, ".markdownlint-cli2.jsonc"),
			'{ "ignores": ["**/.claude/**"] }\n',
		);
		const file = path.join(project, "doc.md");
		fs.writeFileSync(file, "# Title\n\n\n\nx\n");

		await runAutofix(
			file,
			project,
			() => false,
			() => {},
			{
				biomeClient: {} as never,
				ruffClient: {} as never,
				fixedThisTurn: new Set<string>(),
			},
		);

		const calls = vi
			.mocked(detectFileChangedAfterCommand)
			.mock.calls.filter(([, , args]) => args.includes("--fix"));
		expect(calls.length).toBeGreaterThan(0);
		const args = calls[0][2];
		// The change-detection target stays absolute; only the CLI argument moves.
		expect(calls[0][0]).toBe(file);
		expect(args).toContain("doc.md");
		expect(args).not.toContain(file);
	});

	it("does NOT pass --config when the project ships its own markdownlint config", async () => {
		fs.writeFileSync(path.join(tmpDir, ".markdownlint.json"), "{}");
		const file = path.join(tmpDir, "doc.md");
		fs.writeFileSync(file, "# Title\n");

		await runAutofix(
			file,
			tmpDir,
			() => false,
			() => {},
			{
				biomeClient: {} as never,
				ruffClient: {} as never,
				fixedThisTurn: new Set<string>(),
			},
		);

		const calls = vi
			.mocked(detectFileChangedAfterCommand)
			.mock.calls.filter(([, , args]) => args.includes("--fix"));
		expect(calls.length).toBeGreaterThan(0);
		const args = calls[0][2];
		expect(args).not.toContain("--config");
	});
});
