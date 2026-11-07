/**
 * A venv install is an out-of-band change, by property: #5009 (refs #4532).
 *
 * Recurrence it prevents (shape 6, incomplete freshness). The out-of-band
 * look stamped lockfiles and `node_modules`, so a `pip install` into a project
 * virtualenv that keeps no lockfile wrote no file the stamp listed: nothing
 * published, no language server restarted, and pyright kept its cached
 * `Import "x" could not be resolved` for the server's life (#5009 measured 40
 * calls over 20.3 s stale). #5009 stamps the venv's `site-packages`.
 *
 * `server-config-forward-4532.test.ts` pins the cells its author listed: a
 * pure-Python install under `.venv`, one under `venv`, and the Windows layout.
 * This property crosses the axes those cells fix by hand: the venv directory
 * name, the interpreter directory (`lib/python3.X` or Windows `Lib`), and what
 * the install wrote (importable code, a stub-only package, or a `.dist-info`
 * entry alone). Whatever lands in the project virtualenv after the baseline
 * look must publish an out-of-band change for the root. No lockfile is written:
 * with one, the lock change publishes by itself and the venv would not be the
 * thing under test.
 *
 * The venv names are the two `detectPythonEnvironment` resolves for a project
 * root (`PROJECT_VENV_DIRS` in `clients/python-environment.ts`: `.venv`,
 * `venv`). A directory named `env` is not one of them, so an install there is
 * not a project environment and is outside the property. The names are spelled
 * here rather than imported, because the parent commit has no export to import
 * and a test that fails on a missing export names no defect.
 *
 * Real: `lookForOutOfBandChanges` and the real `subscribeDiskChange`
 * publisher, over real directories. fast-check runs a bounded `numRuns` under a
 * fixed seed; `examples` is the cell the parent fails on (a stub-only install).
 *
 * Lane: ubuntu Unit tests.
 */
import fs from "node:fs";
import path from "node:path";
import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
	type DiskChange,
	subscribeDiskChange,
} from "../../clients/disk-changes.js";
import { lookForOutOfBandChanges } from "../../clients/out-of-band-changes.js";
import { setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const VENV_DIRS = [".venv", "venv"] as const;
const SITE_LAYOUTS: ReadonlyArray<readonly string[]> = [
	["lib", "python3.12", "site-packages"],
	["lib", "python3.11", "site-packages"],
	["Lib", "site-packages"],
];
type Install = "code" | "stubs" | "dist-info-only";

/** What `pip install dep` leaves in `site-packages`, per kind. */
function install(site: string, kind: Install): void {
	if (kind === "code") {
		fs.mkdirSync(path.join(site, "dep"));
		fs.writeFileSync(path.join(site, "dep", "__init__.py"), "x = 1\n");
		fs.mkdirSync(path.join(site, "dep-1.0.dist-info"));
		fs.writeFileSync(
			path.join(site, "dep-1.0.dist-info", "METADATA"),
			"Name: dep\n",
		);
	} else if (kind === "stubs") {
		fs.mkdirSync(path.join(site, "dep"));
		fs.writeFileSync(path.join(site, "dep", "__init__.pyi"), "x: int\n");
		fs.writeFileSync(path.join(site, "dep", "py.typed"), "");
	} else {
		fs.mkdirSync(path.join(site, "dep-1.0.dist-info"));
		fs.writeFileSync(path.join(site, "dep-1.0.dist-info", "RECORD"), "");
	}
}

describe("a package installed into a project virtualenv (#5009)", () => {
	it("publishes an out-of-band change for any venv name, layout and install kind", async () => {
		// RECURRENCE GUARDED: #5009 / #4532 gap 3. The parent publishes nothing
		// for a lockfile-less venv install, so pyright keeps the stale import.
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...VENV_DIRS),
				fc.constantFrom(...SITE_LAYOUTS),
				fc.constantFrom<Install>("code", "stubs", "dist-info-only"),
				async (venv, layout, kind) => {
					const env = setupTestEnvironment("pi-lens-pbt-5009-");
					try {
						const root = env.tmpDir;
						const site = path.join(root, venv, ...layout);
						fs.mkdirSync(site, { recursive: true });
						fs.writeFileSync(
							path.join(root, venv, "pyvenv.cfg"),
							"home = /x\n",
						);
						fs.writeFileSync(
							path.join(root, "pyproject.toml"),
							"[project]\nname = 'x'\n",
						);
						fs.writeFileSync(path.join(root, "app.py"), "import dep\n");
						// The baseline must not share a timestamp tick with the install:
						// age the directory instead of sleeping.
						fs.utimesSync(site, 1_000, 1_000);
						await lookForOutOfBandChanges(root, "tool_result");
						const seen: DiskChange[] = [];
						cleanups.push(
							subscribeDiskChange(
								"pbt-5009-observes-publish",
								(change) => {
									seen.push(change);
								},
								["out-of-band"],
							),
						);
						install(site, kind);
						await lookForOutOfBandChanges(root, "tool_result");
						const cell = { venv, layout: layout.join("/"), kind };
						expect({
							...cell,
							published: seen.map((change) => change.sources),
						}).toEqual({ ...cell, published: [["install"]] });
					} finally {
						for (const cleanup of cleanups.splice(0)) cleanup();
						env.cleanup();
					}
				},
			),
			{
				numRuns: 24,
				seed: 5370,
				examples: [[".venv", ["lib", "python3.12", "site-packages"], "stubs"]],
			},
		);
	});
});
