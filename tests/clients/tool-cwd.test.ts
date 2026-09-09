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
