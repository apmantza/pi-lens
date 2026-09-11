import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGES } from "../../clients/language-registry.js";
import {
	LSP_SERVERS,
	resolveLspServerCwd,
	type LSPServerInfo,
} from "../../clients/lsp/server.js";
import { LSPService } from "../../clients/lsp/index.js";

let home: string;
let toolCwd: typeof import("../../clients/tool-cwd.js");
let ledger: typeof import("../../clients/degradation-ledger.js");
let log: typeof import("../../clients/extension-log.js");
let pathUtils: typeof import("../../clients/path-utils.js");

beforeEach(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tool-cwd-"));
	process.env.PI_LENS_HOME = home;
	process.env.PI_LENS_TEST_MODE = "0";
	vi.resetModules();
	toolCwd = await import("../../clients/tool-cwd.js");
	pathUtils = await import("../../clients/path-utils.js");
	ledger = await import("../../clients/degradation-ledger.js");
	log = await import("../../clients/extension-log.js");
	ledger.resetDegradationLedger();
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.PI_LENS_TEST_MODE;
});

describe("resolveToolCwd (#2777)", () => {
	it("folds Win32 case and separator variants into one ephemeral key", () => {
		// #2782 win-shape review: divergent Win32 spellings must not duplicate
		// the marker-walk memo or once-per-session resolution log record.
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
		try {
			const fileKey = toolCwd._toolCwdEphemeralKey([
				path.win32.resolve("C:\\proj\\src\\a.ts"),
			]);
			const equivalentFileKey = toolCwd._toolCwdEphemeralKey([
				path.win32.resolve("c:/proj/src/a.ts"),
			]);
			const rootKey = toolCwd._toolCwdEphemeralKey([
				path.win32.resolve("c:\\proj"),
			]);
			const equivalentRootKey = toolCwd._toolCwdEphemeralKey([
				path.win32.resolve("C:/proj"),
			]);

			expect(fileKey).toBe(equivalentFileKey);
			expect(rootKey).toBe(equivalentRootKey);
			// Verify r7 (#2782): the normalizer keeps a trailing separator, so the
			// equivalence holds only because every seam key is path.resolve()d first;
			// pin that reachability rather than the helper.
			expect(
				toolCwd._toolCwdEphemeralKey([path.win32.resolve("C:/PROJ/")]),
			).toBe(rootKey);
			expect(fileKey).toBe(
				pathUtils.normalizeEphemeralMapKey("C:\\proj\\src\\a.ts"),
			);
		} finally {
			Object.defineProperty(process, "platform", {
				configurable: true,
				value: originalPlatform,
			});
		}
	});

	it("selects a nearer marker through the real synchronous seam", () => {
		const project = path.join(home, "repo");
		const nested = path.join(project, "packages", "app");
		const file = path.join(nested, "src", "index.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(project, ".gitignore"), "dist\n");
		fs.writeFileSync(path.join(nested, ".prettierignore"), "generated\n");

		expect(
			toolCwd.resolveToolCwd("formatter", "prettier", file, {
				cwd: project,
			}).cwd,
		).toBe(nested);
	});

	it("picks the nearest directory, not the first-listed marker (#2922)", () => {
		// Recurrence: a marker-major walk would return the workspace root because
		// `biome.json` sorts before `package.json` in the marker list. The walk is
		// level-major, so the nearer directory wins even though its marker is
		// later in the list. Every other case in this file places the SAME marker
		// at both levels, which cannot tell the two orderings apart.
		const workspace = path.join(home, "ws");
		const pkg = path.join(workspace, "packages", "app");
		const file = path.join(pkg, "src", "index.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(workspace, "biome.json"), "{}\n");
		fs.writeFileSync(path.join(pkg, "package.json"), "{}\n");

		expect(
			toolCwd.resolveToolCwd("formatter", "biome", file, { cwd: workspace })
				.cwd,
		).toBe(pkg);
	});

	it("uses the complete formatter marker population", () => {
		const project = path.join(home, "repo");
		const file = path.join(project, "src", "main.rs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(project, "Cargo.toml"), "[package]\n");
		expect(
			toolCwd.resolveToolCwd("formatter", "rustfmt", file, { cwd: project })
				.cwd,
		).toBe(project);
	});

	it("uses the dispatch root for a markerless custom LSP", () => {
		const project = path.join(home, "repo");
		const file = path.join(project, "packages", "app", "src", "main.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		expect(
			toolCwd.resolveToolCwd("lsp", "custom", file, { cwd: project }).cwd,
		).toBe(project);
	});

	it("anchors runner cwd from the file kind when the runner has no private table (#2965)", () => {
		// Recurrence: 37 runner keys fell through to the git-root walk because
		// RUNNER_MARKERS covered only eight keys and markersFor returned [] for the
		// rest. This exercises the shared language vocabulary through a runner.
		const workspace = path.join(home, "repo");
		const nested = path.join(workspace, "packages", "yaml");
		const file = path.join(nested, "config.yaml");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(nested, ".yamllint.yml"), "---\n");

		expect(
			toolCwd.resolveToolCwd("runner", "actionlint", file, {
				cwd: workspace,
			}).cwd,
		).toBe(nested);
	});

	it("returns the marker that anchored the cwd (#2966)", () => {
		const workspace = path.join(home, "repo");
		const file = path.join(workspace, "src", "main.rs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(workspace, "Cargo.toml"), "[package]\n");

		expect(
			toolCwd.resolveToolCwd("runner", "rust-clippy", file, {
				cwd: workspace,
			}),
		).toEqual({ cwd: workspace, marker: "Cargo.toml" });
	});

	it("preserves every registry language root through the shared seam", async () => {
		const project = path.join(process.cwd(), ".probe-language-roots");
		fs.rmSync(project, { recursive: true, force: true });
		// #2846 H1: a workspace-priority wrapper must retain its marker metadata;
		// otherwise Go silently falls back from a nested go.mod to the dispatch cwd.
		const goServer = LSP_SERVERS.find((entry) => entry.id === "go");
		expect(goServer?.root.rootMarkers).toEqual(
			expect.arrayContaining(["go.mod"]),
		);
		const languageServers = LANGUAGES.map((language) => {
			const serverId = language.lspId ?? language.id;
			const server = LSP_SERVERS.find((entry) => entry.id === serverId);
			return { language, server };
		}).filter(
			(
				entry,
			): entry is {
				language: (typeof LANGUAGES)[number];
				server: LSPServerInfo;
			} => Boolean(entry.server?.root.rootMarkers?.length),
		);
		const table: string[] = [];

		for (const { language, server } of languageServers) {
			const nested = path.join(project, "packages", language.id);
			const file = path.join(nested, "src", `main${language.extensions[0]}`);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			for (const marker of server.root.rootMarkers ?? []) {
				const markerName = marker.replaceAll("*", "project");
				const markerPath = path.join(nested, markerName);
				fs.mkdirSync(path.dirname(markerPath), { recursive: true });
				fs.writeFileSync(markerPath, "");
			}
			const before = await server.root(file);
			const after = await resolveLspServerCwd(server, file, project);
			table.push(`${language.id}: ${before} === ${after}`);
			expect(after, table.at(-1)).toBe(before);
		}
		console.log(table.join("\n"));
		fs.rmSync(project, { recursive: true, force: true });
	});

	it("routes built-in language marker tables through the same seam", () => {
		const project = path.join(home, "repo");
		const python = path.join(project, "packages", "py", "src", "main.py");
		const typescript = path.join(project, "packages", "ts", "src", "main.ts");
		const ruby = path.join(project, "packages", "rb", "src", "main.rb");
		fs.mkdirSync(path.dirname(python), { recursive: true });
		fs.mkdirSync(path.dirname(typescript), { recursive: true });
		fs.mkdirSync(path.dirname(ruby), { recursive: true });
		fs.writeFileSync(path.join(project, "pyproject.toml"), "[tool.pyright]\n");
		fs.writeFileSync(path.join(project, "package.json"), "{}\n");
		fs.writeFileSync(
			path.join(project, "Gemfile"),
			'source "https://rubygems.org"\n',
		);

		for (const [id, file, expected] of [
			["python", python, project],
			["typescript", typescript, project],
			["ruby", ruby, project],
		] as const) {
			const server = LSP_SERVERS.find((entry) => entry.id === id);
			expect(server?.root.rootMarkers).toBeDefined();
			expect(
				toolCwd.resolveToolCwd("lsp", id, file, {
					cwd: project,
					rootMarkers: server?.root.rootMarkers,
				}).cwd,
			).toBe(expected);
		}
	});

	it("uses the file directory for a built-in server with no marker", async () => {
		const project = path.join(home, "repo");
		const file = path.join(project, "nested", "src", "main.py");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const server = LSP_SERVERS.find((entry) => entry.id === "python");
		if (!server) throw new Error("python server missing from registry");
		const service = new LSPService(undefined, project);
		const resolveRoot = (
			service as unknown as {
				resolveServerRoot(server: LSPServerInfo, file: string): Promise<string>;
			}
		).resolveServerRoot.bind(service);
		expect(await resolveRoot(server, file)).toBe(path.dirname(file));
	});

	it("keeps a markerless server-computed root at the LSP seam", async () => {
		const project = path.join(home, "repo");
		const file = path.join(project, "packages", "app", "src", "main.ts");
		const computedRoot = path.join(project, "server-owned-root");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const server: LSPServerInfo = {
			id: "markerless-test-server",
			name: "Markerless test server",
			extensions: [".ts"],
			root: async () => computedRoot,
			spawn: vi.fn(),
		};

		expect(await resolveLspServerCwd(server, file, project)).toBe(computedRoot);
	});

	it("coalesces throwing and undefined server roots into one bounded fallback", async () => {
		// #2846: a root failure must not abort selection or emit one row per touch.
		vi.resetModules();
		const { resolveLspServerCwd: freshResolve } =
			await import("../../clients/lsp/server.js");
		const freshLedger = await import("../../clients/degradation-ledger.js");
		freshLedger.resetDegradationLedger();
		const project = path.join(home, "repo");
		const file = path.join(project, "src", "main.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		let calls = 0;
		const server: LSPServerInfo = {
			id: "failing-root-test-server",
			name: "Failing root test server",
			extensions: [".ts"],
			root: async () => {
				calls++;
				if (calls === 1) throw new Error("root probe failed");
				return undefined;
			},
			rootMarkers: ["missing.marker"],
			spawn: vi.fn(),
		};

		expect(await freshResolve(server, file, project)).toBe(path.dirname(file));
		expect(await freshResolve(server, file, project)).toBe(path.dirname(file));
		// The summary groups per kind, so a `.filter(kind === …)` length can
		// never exceed 1 — that guard stayed green if the once-latch were
		// dropped and the record became an increment. Pin the group's exact
		// event count instead: two resolutions, one user-visible degradation.
		const group = freshLedger
			.getDegradationSummary()
			.find((entry) => entry.kind === "tool-cwd-resolution");
		expect(group?.count).toBe(1);
	});

	it("matches glob root markers against files in the directory", () => {
		const project = path.join(home, "repo");
		const nested = path.join(project, "packages", "app");
		const file = path.join(nested, "src", "main.cs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(nested, "app.csproj"), "<Project />\n");
		expect(
			toolCwd.resolveToolCwd("lsp", "custom", file, {
				cwd: project,
				rootMarkers: ["*.csproj"],
			}).cwd,
		).toBe(nested);
	});

	it("falls through to the outer root when a marker is deleted", () => {
		const project = path.join(home, "repo");
		const nested = path.join(project, "src");
		const file = path.join(nested, "main.rs");
		fs.mkdirSync(nested, { recursive: true });
		const marker = path.join(project, "Cargo.toml");
		fs.writeFileSync(marker, "[package]\n");

		expect(
			toolCwd.resolveToolCwd("formatter", "rustfmt", file, {
				cwd: project,
			}).cwd,
		).toBe(project);
		fs.unlinkSync(marker);

		// #2777: deleting a marker must not leave the session stuck on its old root.
		expect(
			toolCwd.resolveToolCwd("formatter", "rustfmt", file, {
				cwd: project,
			}).cwd,
		).toBe(nested);
	});

	it("re-walks a negative marker result when a marker is created later", () => {
		const project = path.join(home, "repo");
		const nested = path.join(project, "packages", "app");
		const file = path.join(nested, "src", "main.rs");
		fs.mkdirSync(path.dirname(file), { recursive: true });

		expect(
			toolCwd.resolveToolCwd("runner", "rust-clippy", file, {
				cwd: project,
			}).cwd,
		).toBe(project);
		fs.writeFileSync(path.join(nested, "Cargo.toml"), "[package]\n");

		// A negative marker memo must not hide a project created during the
		// session. The second resolution must reach the new package root.
		expect(
			toolCwd.resolveToolCwd("runner", "rust-clippy", file, {
				cwd: project,
			}).cwd,
		).toBe(nested);
	});

	it("covers shared language marker fallback and fresh marker creation (#2965)", () => {
		// Recurrence: deleting RUNNER_MARKERS left most runner keys on the git
		// fallback. The fallback must use ROOT_MARKERS_BY_KIND and re-walk next pass.
		const project = path.join(home, "repo");
		const nested = path.join(project, "packages", "app");
		const file = path.join(nested, "main.rs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		expect(
			toolCwd.resolveRunnerCwd({ cwd: project, filePath: file }, "actionlint"),
		).toBe(project);
		fs.writeFileSync(path.join(nested, "Cargo.toml"), "[package]\n");
		expect(
			toolCwd.resolveRunnerCwd({ cwd: project, filePath: file }, "actionlint"),
		).toBe(nested);
	});

	it("memoizes only the git fallback within one dispatch pass (#2964)", () => {
		// Recurrence: the same .git walk ran once per runner in one synchronous
		// dispatch. A pass memo is safe because a later dispatch receives a new
		// context and therefore a new memo.
		const project = path.join(home, "repo");
		const foreign = path.join(home, "foreign", "src", "README.unknown");
		const foreignRoot = path.dirname(path.dirname(foreign));
		fs.mkdirSync(path.dirname(foreign), { recursive: true });
		fs.mkdirSync(path.join(foreignRoot, ".git"));
		fs.writeFileSync(
			path.join(foreignRoot, ".git", "HEAD"),
			"ref: refs/heads/main\n",
		);
		const memo = {};
		const first = toolCwd.resolveToolCwd("runner", "actionlint", foreign, {
			cwd: project,
			homeDir: home,
			toolCwdMemo: memo,
		});
		fs.rmSync(path.join(foreignRoot, ".git"), { recursive: true });
		const second = toolCwd.resolveToolCwd("runner", "actionlint", foreign, {
			cwd: project,
			homeDir: home,
			toolCwdMemo: memo,
		});
		expect(second.cwd).toBe(first.cwd);
		const freshPass = toolCwd.resolveToolCwd("runner", "actionlint", foreign, {
			cwd: project,
			homeDir: home,
			toolCwdMemo: {},
		});
		expect(first.cwd).toBe(foreignRoot);
		expect(freshPass.cwd).toBe(path.dirname(foreign));
	});

	it("bounds and records a foreign-file fallback once per tool and session", async () => {
		const project = path.join(home, "repo");
		const foreign = path.join(home, "tmp", "outside.ts");
		fs.mkdirSync(path.dirname(foreign), { recursive: true });

		const first = toolCwd.resolveToolCwd("runner", "yamllint", foreign, {
			cwd: project,
			homeDir: home,
		}).cwd;
		const second = toolCwd.resolveToolCwd("runner", "yamllint", foreign, {
			cwd: project,
			homeDir: home,
		}).cwd;
		expect(first).toBe(path.dirname(foreign));
		expect(second).toBe(first);
		const summary = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "tool-cwd-resolution");
		expect(summary?.count).toBe(1);

		await log.flushExtensionLog();
		const lines = fs
			.readFileSync(log.getExtensionLogPath(), "utf8")
			.trim()
			.split("\n")
			.filter((line) => line.includes("cwd runner yamllint"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("reason=file-dir-fallback");
	});
});
