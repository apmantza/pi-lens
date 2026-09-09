import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let toolCwd: typeof import("../../clients/tool-cwd.js");
let ledger: typeof import("../../clients/degradation-ledger.js");
let log: typeof import("../../clients/extension-log.js");

beforeEach(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-tool-cwd-"));
	process.env.PI_LENS_HOME = home;
	process.env.PI_LENS_TEST_MODE = "0";
	vi.resetModules();
	toolCwd = await import("../../clients/tool-cwd.js");
	ledger = await import("../../clients/degradation-ledger.js");
	log = await import("../../clients/extension-log.js");
	ledger.resetDegradationLedger();
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	delete process.env.PI_LENS_TEST_MODE;
});

describe("resolveToolCwd (#2777)", () => {
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
