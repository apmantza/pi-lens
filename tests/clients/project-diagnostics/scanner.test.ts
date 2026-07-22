import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanProjectDiagnostics } from "../../../clients/project-diagnostics/scanner.js";
import { loadProjectDiagnosticsSnapshot } from "../../../clients/project-diagnostics/cache.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-scanner-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("scanProjectDiagnostics home ceiling (#747/#250)", () => {
	// The cheap tier is file-capped, but from a cwd at/above $HOME it still walks
	// a huge unrelated tree until it keeps that many source files. Refuse to walk.
	it("refuses to walk when cwd IS the home directory", async () => {
		const snapshot = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			homeDir: tmp,
		});

		expect(snapshot.unsafeRoot).toBe(true);
		expect(snapshot.filesScanned).toBe(0);
		expect(snapshot.diagnostics).toEqual([]);
		expect(snapshot.runners).toEqual([]);
	});

	it("refuses to walk when cwd is an ANCESTOR of the home directory", async () => {
		const fakeHome = path.join(tmp, "home", "user");
		fs.mkdirSync(fakeHome, { recursive: true });

		const snapshot = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			homeDir: fakeHome,
		});

		expect(snapshot.unsafeRoot).toBe(true);
	});

	it("does NOT persist the refusal snapshot to the cross-session cache", async () => {
		await scanProjectDiagnostics({ cwd: tmp, tier: "cheap", homeDir: tmp });
		// A refusal must not poison the cache — a later cached read would wrongly
		// trust it as a complete, clean scan.
		expect(loadProjectDiagnosticsSnapshot(tmp)).toBeUndefined();
	});

	it("scans normally for a project directory UNDER the home directory", async () => {
		const fakeHome = path.join(tmp, "home", "user");
		const project = path.join(fakeHome, "code", "app");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "index.ts"), "export const x = 1;\n");

		const snapshot = await scanProjectDiagnostics({
			cwd: project,
			tier: "cheap",
			homeDir: fakeHome,
		});

		expect(snapshot.unsafeRoot).toBeUndefined();
		expect(snapshot.filesScanned).toBeGreaterThanOrEqual(1);
	});

	it("does not refuse an explicit `files` scan even at home (subset, not a walk)", async () => {
		const file = path.join(tmp, "index.ts");
		fs.writeFileSync(file, "export const x = 1;\n");

		const snapshot = await scanProjectDiagnostics({
			cwd: tmp,
			tier: "cheap",
			homeDir: tmp,
			files: [file],
		});

		expect(snapshot.unsafeRoot).toBeUndefined();
	});
});
