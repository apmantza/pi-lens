// #1513: the nightly Resolution layer (`smoke-tools.mjs --resolution`) is the
// only witness that a project-local `.venv` / `vendor/bin` / `node_modules/.bin`
// binary is the one the resolvers return. Every other nightly layer proves a
// tool RAN; a dropped bin-dir list or a broken walk-up falls through to PATH
// and they stay green. This file runs the layer's own cases through the REAL
// compiled resolvers (no mocks of the resolvers, no hand-built resolver
// output) and proves the layer can tell a planted rung from a missing one,
// rung by rung, so a case that can never red does not ship.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	oxfmtFormatter,
	phpCsFixerFormatter,
	sqlfluffFormatter,
} from "../../clients/formatters.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { createVenvFinder } from "../../clients/dispatch/runners/utils/runner-helpers.js";
import {
	evaluateResolutionCase,
	plantResolutionFixture,
	RESOLUTION_CASES,
} from "../../scripts/smoke-tools.mjs";

// These cases plant project-local rungs on purpose; the trust gate is exercised
// by the dedicated witnesses, so this resolution sweep runs trusted.
beforeEach(() => setProjectTrustState("trusted"));

const deps = {
	formatters: {
		sqlfluff: sqlfluffFormatter,
		"php-cs-fixer": phpCsFixerFormatter,
		oxfmt: oxfmtFormatter,
	},
	createVenvFinder,
};

const roots: string[] = [];
function scratchRoot(): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-resolution-smoke-")),
	);
	roots.push(root);
	return root;
}

afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

// lane: Linux Unit tests. The stubs are `sh` scripts and the nightly layer is
// POSIX-only (it returns 0 on win32), so there is nothing to run elsewhere.
describe.skipIf(process.platform === "win32")(
	"nightly Resolution layer cases (#1513)",
	() => {
		it("every project-local rung resolves to its planted binary through the real resolvers", async () => {
			const root = scratchRoot();
			plantResolutionFixture(root);
			for (const c of RESOLUTION_CASES) {
				const row = await evaluateResolutionCase(deps, root, c);
				expect(row, c.id).toMatchObject({ state: "pass", lang: c.source });
				expect(row.detail, c.id).toContain(c.bin);
			}
		});

		it("reds every case when no rung is planted (a resolver that falls through to PATH or an install is a failure)", async () => {
			const root = scratchRoot();
			// Nested start dirs only: the walk has somewhere to climb from, but
			// no bin dir exists anywhere in the tree.
			for (const c of RESOLUTION_CASES) {
				if (c.file)
					fs.mkdirSync(path.dirname(path.join(root, c.file)), {
						recursive: true,
					});
			}
			for (const c of RESOLUTION_CASES) {
				const row = await evaluateResolutionCase(deps, root, c);
				expect(row.state, c.id).toBe("fail");
				expect(row.detail, c.id).toContain(`expected ${c.bin}`);
			}
		});

		it("reds exactly the unplanted rung, so each case witnesses its own resolution path", async () => {
			const root = scratchRoot();
			const planted = RESOLUTION_CASES.filter((c) => c.source !== "vendor/bin");
			plantResolutionFixture(root, planted);
			const vendor = RESOLUTION_CASES.find((c) => c.source === "vendor/bin");
			if (vendor?.file)
				fs.mkdirSync(path.dirname(path.join(root, vendor.file)), {
					recursive: true,
				});
			const states = Object.fromEntries(
				await Promise.all(
					RESOLUTION_CASES.map(
						async (c) =>
							[
								c.id,
								(await evaluateResolutionCase(deps, root, c)).state,
							] as const,
					),
				),
			);
			expect(states).toEqual({
				"formatter-venv": "pass",
				"formatter-vendor-bin": "fail",
				"formatter-node-modules-bin": "pass",
				"runner-venv": "pass",
			});
		});

		it("names the runner venv rung it observed, not just that the path differs", async () => {
			const root = scratchRoot();
			const runnerCase = RESOLUTION_CASES.find((c) => c.seam === "runner");
			if (!runnerCase) throw new Error("no runner case");
			const row = await evaluateResolutionCase(deps, root, runnerCase);
			expect(row.state).toBe("fail");
			expect(row.detail).toMatch(
				/via rung "(path|managed-dir|managed-release)"/,
			);
		});

		// Recurrence: a venv list that gains a second spelling (`venv/bin`) and
		// resolves a DIFFERENT project-local binary than the one the case owns
		// would still read as "found a venv binary". The case pins the exact path.
		it("reds a resolver that answers with a different project-local binary than the case's own", async () => {
			const root = scratchRoot();
			const other = RESOLUTION_CASES.map((c) => ({
				...c,
				bin: c.bin.replace(".venv", "venv"),
			})).filter((c) => c.source === "venv");
			plantResolutionFixture(root, other);
			for (const c of RESOLUTION_CASES.filter((x) => x.source === "venv")) {
				const row = await evaluateResolutionCase(deps, root, c);
				expect(row.state, c.id).toBe("fail");
				expect(row.detail, c.id).toContain(`expected ${c.bin}`);
			}
		});

		// The runner case asserts the SOURCE (the rung), not only the path: the
		// finder reporting a managed or PATH rung for a `.venv` path is a source
		// regression the path alone cannot show. Fault injection at the finder.
		it("reds a runner answer whose path is right but whose rung is not venv", async () => {
			const root = scratchRoot();
			const runnerCase = RESOLUTION_CASES.find((c) => c.seam === "runner");
			if (!runnerCase) throw new Error("no runner case");
			const wrongRung = {
				...deps,
				createVenvFinder: () => async () => ({
					path: path.join(root, runnerCase.bin),
					rung: "path",
				}),
			};
			plantResolutionFixture(root, [runnerCase]);
			const row = await evaluateResolutionCase(wrongRung, root, runnerCase);
			expect(row.state).toBe("fail");
			expect(row.detail).toContain('via rung "path"');
		});

		it("fails a case whose resolver never returns instead of hanging the layer", async () => {
			vi.useFakeTimers();
			const root = scratchRoot();
			const formatterCase = RESOLUTION_CASES.find(
				(c) => c.seam === "formatter",
			);
			if (!formatterCase) throw new Error("no formatter case");
			const hung = {
				...deps,
				formatters: {
					...deps.formatters,
					[formatterCase.tool]: { resolveCommand: () => new Promise(() => {}) },
				},
			};
			const pending = evaluateResolutionCase(hung, root, formatterCase);
			await vi.advanceTimersByTimeAsync(30_000);
			const row = await pending;
			expect(row.state).toBe("fail");
			expect(row.detail).toContain("exceeded 30000ms");
		});
	},
);
