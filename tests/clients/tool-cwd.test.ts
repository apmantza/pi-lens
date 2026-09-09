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
			}),
		).toBe(nested);
	});

	it("uses the complete formatter marker population", () => {
		const project = path.join(home, "repo");
		const file = path.join(project, "src", "main.rs");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(path.join(project, "Cargo.toml"), "[package]\n");
		expect(
			toolCwd.resolveToolCwd("formatter", "rustfmt", file, { cwd: project }),
		).toBe(project);
	});

	it("uses the dispatch root for a markerless custom LSP", () => {
		const project = path.join(home, "repo");
		const file = path.join(project, "packages", "app", "src", "main.ts");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		expect(
			toolCwd.resolveToolCwd("lsp", "custom", file, { cwd: project }),
		).toBe(project);
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
				}),
			).toBe(expected);
		}
	});

	it("uses the dispatch root for a built-in server with no marker", async () => {
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
		expect(await resolveRoot(server, file)).toBe(project);
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

		expect(await freshResolve(server, file, project)).toBe(project);
		expect(await freshResolve(server, file, project)).toBe(project);
		expect(
			freshLedger
				.getDegradationSummary()
				.filter((entry) => entry.kind === "tool-cwd-resolution"),
		).toHaveLength(1);
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
			}),
		).toBe(nested);
	});

	it("memoizes marker walks for repeated files in one ledger generation", () => {
		const project = path.join(home, "repo");
		const nested = path.join(project, "packages", "app");
		fs.mkdirSync(path.join(nested, "src"), { recursive: true });
		fs.writeFileSync(path.join(project, "Cargo.toml"), "[package]\n");
		const before = toolCwd._getToolCwdMarkerWalkCount();
		for (let i = 0; i < 20; i++) {
			toolCwd.resolveToolCwd(
				"formatter",
				"rustfmt",
				path.join(nested, "src", `file-${i}.rs`),
				{ cwd: project },
			);
		}
		const walks = toolCwd._getToolCwdMarkerWalkCount() - before;
		expect(walks).toBe(1);
	});

	it("re-walks when a memoized marker is deleted in the same session", () => {
		const project = path.join(home, "repo");
		const nested = path.join(project, "src");
		const file = path.join(nested, "main.rs");
		fs.mkdirSync(nested, { recursive: true });
		const marker = path.join(project, "Cargo.toml");
		fs.writeFileSync(marker, "[package]\n");

		expect(
			toolCwd.resolveToolCwd("formatter", "rustfmt", file, {
				cwd: project,
			}),
		).toBe(project);
		const walksAfterFirstResolution = toolCwd._getToolCwdMarkerWalkCount();
		fs.unlinkSync(marker);

		// #2777: deleting a marker must not leave the session stuck on its old root.
		expect(
			toolCwd.resolveToolCwd("formatter", "rustfmt", file, {
				cwd: project,
			}),
		).toBe(nested);
		expect(toolCwd._getToolCwdMarkerWalkCount()).toBe(
			// One marker walk plus the uncached .git fallback walk.
			walksAfterFirstResolution + 2,
		);
	});

	it("bounds and records a foreign-file fallback once per tool and session", async () => {
		const project = path.join(home, "repo");
		const foreign = path.join(home, "tmp", "outside.ts");
		fs.mkdirSync(path.dirname(foreign), { recursive: true });

		const first = toolCwd.resolveToolCwd("runner", "yamllint", foreign, {
			cwd: project,
			homeDir: home,
		});
		const second = toolCwd.resolveToolCwd("runner", "yamllint", foreign, {
			cwd: project,
			homeDir: home,
		});
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
