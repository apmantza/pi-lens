import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	classify,
	fixtureDispatchCwd,
	FIXTURES,
} from "../../scripts/smoke-tools.mjs";
import { dispatchLintDetailed } from "../../clients/dispatch/integration.js";
import * as safeSpawn from "../../clients/safe-spawn.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

describe("tool-smoke cwd-sensitive rows (#2697)", () => {
	it("uses the dispatch cwd for real yamllint config discovery (#2691)", async () => {
		const fixture = FIXTURES.find((row) => row.lang === "yaml-cwd");
		if (!fixture) throw new Error("yaml-cwd fixture row is missing");
		const source = path.join(repoRoot, fixture.dir);
		fs.mkdirSync(path.join(repoRoot, ".probe-home"), { recursive: true });
		const workspace = fs.mkdtempSync(
			path.join(repoRoot, ".probe-home", "cwd-"),
		);
		const shimDir = fs.mkdtempSync(
			path.join(repoRoot, ".probe-home", "yamllint-"),
		);
		const previousPath = process.env.PATH;
		const previousProcessCwd = process.cwd();
		const spawn = vi.spyOn(safeSpawn, "safeSpawnAsync");
		try {
			const shim = path.join(shimDir, "yamllint");
			fs.writeFileSync(
				shim,
				"#!/bin/sh\nprintf '%s:1:1: [error] hermetic shim (%s)\\n' \"$3\" key-ordering\n",
			);
			fs.chmodSync(shim, 0o755);
			process.env.PATH = `${shimDir}${path.delimiter}${previousPath ?? ""}`;
			fs.cpSync(source, workspace, { recursive: true });
			const dispatchCwd = fixtureDispatchCwd(fixture, workspace);
			const filePath = path.join(workspace, fixture.file);
			const decoy = path.join(workspace, "host-cwd-decoy");
			fs.mkdirSync(decoy);
			fs.writeFileSync(
				path.join(decoy, ".yamllint"),
				"rules:\n  key-ordering: disable\n",
			);
			process.chdir(decoy);

			const { runners } = await dispatchLintDetailed(
				filePath,
				dispatchCwd,
				{ getFlag: (flag) => (flag === "no-delta" ? true : undefined) },
				{ blockingOnly: false },
			);
			const outcome = runners.find((row) => row.runnerId === "yamllint");
			const diagnostics = outcome?.result.diagnostics ?? [];
			const toolSpawn = spawn.mock.calls.find(([, args]) =>
				args?.includes("-f"),
			);

			expect(process.cwd()).toBe(decoy);
			if (!toolSpawn) {
				throw new Error(
					"yamllint spawn was not observed; the hermetic shim was not discovered",
				);
			}
			expect(toolSpawn[2]?.cwd).toBe(dispatchCwd);
			expect(toolSpawn[1]).toEqual(["-f", "parsable", filePath]);
			expect(diagnostics.map((diagnostic) => diagnostic.rule)).toContain(
				"key-ordering",
			);
			expect(diagnostics).toHaveLength(1);
		} finally {
			process.chdir(previousProcessCwd);
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			spawn.mockRestore();
			fs.rmSync(workspace, { recursive: true, force: true });
			fs.rmSync(shimDir, { recursive: true, force: true });
		}
	});

	it("renders a missing tool through the shared visible skip classifier", () => {
		const verdict = classify({
			runnerId: "yamllint",
			result: {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
			},
		});

		expect(verdict).toEqual({
			state: "skip",
			detail: "runner skipped (tool/config unavailable)",
			diags: 0,
		});
	});
});
