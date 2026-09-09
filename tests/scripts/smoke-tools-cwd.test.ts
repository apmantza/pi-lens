import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	classify,
	fixtureDispatchCwd,
	FIXTURES,
} from "../../scripts/smoke-tools.mjs";
import { createDispatchContext } from "../../clients/dispatch/dispatcher.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

describe("tool-smoke cwd-sensitive rows (#2697)", () => {
	it("passes the nested row cwd into the real dispatch context without spawning", () => {
		const fixture = FIXTURES.find((row) => row.lang === "yaml-cwd");
		if (!fixture) throw new Error("yaml-cwd fixture row is missing");
		const workspace = path.join(repoRoot, "tests/fixtures/tool-smoke/yaml-cwd");
		const cwd = fixtureDispatchCwd(fixture, workspace);
		const filePath = path.join(repoRoot, fixture.dir, fixture.file);
		const ctx = createDispatchContext(
			filePath,
			cwd,
			{
				getFlag: () => undefined,
			},
			{} as never,
			false,
		);

		expect(process.cwd()).not.toBe(cwd);
		expect(ctx.cwd).toBe(cwd);
		expect(ctx.filePath).toBe(filePath);
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
