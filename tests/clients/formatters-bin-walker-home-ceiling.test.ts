/**
 * #2514: `findInNodeModules`'s ancestor walk (`clients/formatters.ts`) had no
 * HOME ceiling, so a stray `~/node_modules/.bin/oxfmt.cmd` (the home-level
 * pi-extensions manifest installs its own bins) was picked up as the
 * project's formatter on any box with a home-level `node_modules`. The same
 * unceilinged shape existed in `findInVendorBin` (`vendor/bin`) and
 * `findInVenv` (`.venv`/`venv`).
 *
 * #2544 review F2 folded all three onto the single shared walker,
 * `findLocalBinUpwards` (`clients/package-manager.ts`, also behind stylua,
 * taplo, knip, jscpd and madge): the ONLY thing that differs per ecosystem is
 * the `binDirs`/`windowsExt` options each `formatters.ts` delegation passes.
 * These cases therefore drive `findLocalBinUpwards` directly with exactly
 * those option sets — the ceiling has one implementation to test. That the
 * delegations pass the RIGHT options is covered through the production
 * `resolveCommand` seam by `formatters.test.ts` ("resolveCommand — .venv",
 * "resolveCommand — vendor/bin") and `formatter-unavailable-outcome.test.ts`.
 *
 * Per #2517's per-walker policy: these are TOOL-RESOLUTION walkers, not
 * config-file lookups — escaping the project upward past HOME must mean
 * STOP, not keep reading. A `node_modules/.bin`/`vendor/bin`/`.venv` match
 * found at or above HOME can never be the project's own installed dependency.
 *
 * Every case here pins a FAKE `homeDir` explicitly (never the real
 * `os.homedir()`) so the test is hermetic regardless of what the running
 * box's actual home directory contains (probe hygiene: never plant fixtures
 * under the maintainer's real `$HOME`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setProjectTrustState } from "../../clients/project-trust.js";
import {
	findLocalBinsUpwards,
	findLocalBinUpwards,
	type LocalBinWalkOptions,
	VENV_BIN_DIRS,
} from "../../clients/package-manager.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

const isWin = process.platform === "win32";

beforeEach(() => setProjectTrustState("trusted"));

interface WalkerCase {
	name: string;
	/** The option set the matching `formatters.ts` delegation passes. */
	options: Omit<LocalBinWalkOptions, "homeDir">;
	/** Directory segments under a dir that make `binary` "installed" there. */
	binSubpath: (binary: string) => string;
}

const WALKERS: WalkerCase[] = [
	{
		name: "node_modules/.bin — findInNodeModules / stylua / taplo / knip (default options)",
		options: {},
		binSubpath: (binary) =>
			path.join("node_modules", ".bin", isWin ? `${binary}.cmd` : binary),
	},
	{
		name: "vendor/bin — findInVendorBin (Composer)",
		options: { windowsExt: ".bat", binDirs: [path.join("vendor", "bin")] },
		binSubpath: (binary) =>
			path.join("vendor", "bin", isWin ? `${binary}.bat` : binary),
	},
	{
		name: ".venv/venv — findInVenv / createVenvFinder / vulture (Python)",
		options: { windowsExt: ".exe", binDirs: VENV_BIN_DIRS },
		binSubpath: (binary) =>
			isWin
				? path.join(".venv", "Scripts", `${binary}.exe`)
				: path.join(".venv", "bin", binary),
	},
];

/**
 * Re-spell a directory path: same characters, different case, and (on win32)
 * the other separator form.
 *
 * On win32 the re-cased part is the DRIVE LETTER — `C:\…` → `c:\…`, the exact
 * form VS Code URIs produce and the form the maintainer's real `latency.log`
 * carries — and `path.relative` folds it, so the re-spelling names the SAME
 * directory. On POSIX there is no drive letter and paths are case-SENSITIVE,
 * so re-casing the last segment names a DIFFERENT directory. Both behaviours
 * are load-bearing, so the cases below branch on the platform rather than
 * skipping: over-folding on POSIX would be as much a bug as under-folding on
 * win32.
 *
 * The separator flip on win32 also satisfies the repo's cross-form path rule
 * (record one separator, check the other) — it replaces the round-1 case that
 * was byte-identical to the plain ceiling case on every platform (#2544 F3).
 */
function respell(dir: string): string {
	if (!isWin) {
		const parsed = path.parse(dir);
		return path.join(parsed.dir, parsed.base.toUpperCase());
	}
	return dir
		.replace(/^([A-Za-z]):/, (_m, drive: string) => `${drive.toLowerCase()}:`)
		.split(path.sep)
		.join("/");
}

function plantBin(dir: string, subpath: string): void {
	const full = path.join(dir, subpath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, "#!/bin/sh\necho fake\n", { mode: 0o755 });
}

describe.each(WALKERS)(
	"$name home ceiling (#2514)",
	({ binSubpath, options }) => {
		let tmpDir: string;

		function makeFixture() {
			const env = setupTestEnvironment("pi-lens-bin-walker-home-");
			tmpDir = env.tmpDir;
			const fakeHome = path.join(tmpDir, "home");
			const project = path.join(fakeHome, "proj");
			const nested = path.join(project, "src");
			fs.mkdirSync(nested, { recursive: true });
			return { fakeHome, project, nested };
		}

		const walk = (binary: string, startDir: string, homeDir: string) =>
			findLocalBinUpwards(binary, startDir, { ...options, homeDir }) ?? null;

		it("a bin planted AT the home directory is not resolved from a project nested under it", () => {
			const { fakeHome, nested } = makeFixture();
			try {
				plantBin(fakeHome, binSubpath("oxfmt"));

				expect(walk("oxfmt", nested, fakeHome)).toBeNull();
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("the project's OWN bin below HOME still resolves (~/proj/… layout)", () => {
			const { fakeHome, project, nested } = makeFixture();
			try {
				plantBin(project, binSubpath("oxfmt"));

				expect(walk("oxfmt", nested, fakeHome)).toBe(
					path.join(project, binSubpath("oxfmt")),
				);
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("a re-spelled HOME still ceilings on win32 (drive-letter case) and stays case-sensitive on POSIX (#2544 F1)", () => {
			const { fakeHome, nested } = makeFixture();
			try {
				plantBin(fakeHome, binSubpath("oxfmt"));
				const respelledHome = respell(fakeHome);
				// Guard the construction itself: a no-op re-spelling would make the
				// assertions below silently duplicate the first case.
				expect(respelledHome).not.toBe(fakeHome);

				const resolved = walk("oxfmt", nested, respelledHome);

				if (isWin) {
					// `c:\…` IS `C:\…`; the ceiling must hold, or a walk started from
					// the lowercase-drive VS Code URI form climbs straight past HOME.
					expect(resolved).toBeNull();
				} else {
					// `<tmp>/HOME` is NOT `<tmp>/home` on a case-sensitive filesystem,
					// so `<tmp>/home` is an ordinary ancestor and its bin is the
					// project's own. Over-folding here would break real projects.
					expect(resolved).toBe(path.join(fakeHome, binSubpath("oxfmt")));
				}
			} finally {
				removeTempDirSync(tmpDir);
			}
		});

		it("a RELATIVE start directory is resolved against cwd before the walk (#2544 F2)", () => {
			const { fakeHome, project } = makeFixture();
			const originalCwd = process.cwd();
			try {
				plantBin(project, binSubpath("oxfmt"));
				process.chdir(project);

				// Pre-fold, `findInVendorBin`/`findInVenv` walked the literal string
				// and `path.parse("src").root` is "", so a relative start directory
				// never matched anything; only `findLocalBinUpwards` resolved it.
				expect(walk("oxfmt", "src", fakeHome)).toBe(
					path.join(project, binSubpath("oxfmt")),
				);
			} finally {
				process.chdir(originalCwd);
				removeTempDirSync(tmpDir);
			}
		});
	},
);

/**
 * The candidate ORDER — EXT-OUTER, DIR-INNER — is documented in
 * `findLocalBinUpwards`'s doc comment and in AGENTS.md, and until #2544 review
 * F4 nothing asserted it: swapping the two loops left all 213 cases green.
 *
 * The order is only OBSERVABLE when there are two names, which under a live
 * `process.platform` read means Windows only — exactly the shape that leaves
 * the ubuntu Unit tests lane enforcing nothing. So the walker takes an
 * injectable `isWindows` (defaulting to a LIVE platform read, never a
 * module-load constant — defect shape 30) and BOTH orders are pinned here on
 * EVERY lane.
 */
describe("findLocalBinUpwards candidate order (#2544 F4)", () => {
	let tmpDir: string;

	function fixture() {
		const env = setupTestEnvironment("pi-lens-bin-walker-order-");
		tmpDir = env.tmpDir;
		const fakeHome = path.join(tmpDir, "home");
		const project = path.join(fakeHome, "proj");
		fs.mkdirSync(project, { recursive: true });
		// The discriminating layout: the PREFERRED directory holds only the bare
		// name, the less-preferred one holds the `.exe`. Ext-outer picks the
		// `.exe` out of `venv/`; dir-inner would pick the bare name from `.venv/`.
		plantBin(project, path.join(".venv", "Scripts", "ruff"));
		plantBin(project, path.join("venv", "Scripts", "ruff.exe"));
		return { fakeHome, project };
	}

	it("tries EVERY binDir with windowsExt before ANY of them with the bare name", () => {
		const { fakeHome, project } = fixture();
		try {
			expect(
				findLocalBinUpwards("ruff", project, {
					windowsExt: ".exe",
					binDirs: VENV_BIN_DIRS,
					homeDir: fakeHome,
					isWindows: true,
				}),
			).toBe(path.join(project, "venv", "Scripts", "ruff.exe"));
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("has one name per tool off Windows, so the binDir order alone decides", () => {
		const { fakeHome, project } = fixture();
		try {
			expect(
				findLocalBinUpwards("ruff", project, {
					windowsExt: ".exe",
					binDirs: VENV_BIN_DIRS,
					homeDir: fakeHome,
					isWindows: false,
				}),
			).toBe(path.join(project, ".venv", "Scripts", "ruff"));
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	/**
	 * `windowsExt: ""` means "the caller already spelled every name it wants" —
	 * the ast-grep sweep passes `ast-grep.cmd`/`ast-grep.exe`/`ast-grep` in a
	 * shell-dependent order that a single `windowsExt` cannot express. Without
	 * that case the expansion produces the bare name TWICE, and the collect-all
	 * walker reports the same binary twice (one wasted `--version` spawn per
	 * duplicate).
	 */
	it("does not double-expand a name when windowsExt is empty", () => {
		const { fakeHome, project } = fixture();
		try {
			expect(
				findLocalBinsUpwards(["ruff"], project, {
					windowsExt: "",
					binDirs: [path.join(".venv", "Scripts")],
					homeDir: fakeHome,
					isWindows: true,
				}),
			).toEqual([path.join(project, ".venv", "Scripts", "ruff")]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});

/**
 * `findLocalBinsUpwards` — the collect-all arity behind the ast-grep probe
 * sweep (`runner-helpers.ts`) and vulture's venv candidates
 * (`dead-code-client.ts`). Both hand-rolled their own UNCEILINGED climb before
 * #2544 review F1 precisely because the singular helper could not say "all of
 * them": `findNodeBinRoots` returned the maintainer's real `$HOME` as an
 * ast-grep bin root on any box with a home-level `node_modules` (#2514).
 */
describe("findLocalBinsUpwards (#2544 F1)", () => {
	let tmpDir: string;

	function fixture() {
		const env = setupTestEnvironment("pi-lens-bin-walker-all-");
		tmpDir = env.tmpDir;
		const fakeHome = path.join(tmpDir, "home");
		const project = path.join(fakeHome, "proj");
		const nested = path.join(project, "pkg");
		fs.mkdirSync(nested, { recursive: true });
		return { fakeHome, project, nested };
	}

	const binName = (binary: string) => (isWin ? `${binary}.cmd` : binary);

	it("returns every ancestor match, nearest first, in tools order", () => {
		const { fakeHome, project, nested } = fixture();
		try {
			plantBin(nested, path.join("node_modules", ".bin", binName("sg")));
			plantBin(nested, path.join("node_modules", ".bin", binName("ast-grep")));
			plantBin(project, path.join("node_modules", ".bin", binName("ast-grep")));

			expect(
				findLocalBinsUpwards(["ast-grep", "sg"], nested, {
					homeDir: fakeHome,
				}),
			).toEqual([
				path.join(nested, "node_modules", ".bin", binName("ast-grep")),
				path.join(nested, "node_modules", ".bin", binName("sg")),
				path.join(project, "node_modules", ".bin", binName("ast-grep")),
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("stops at the HOME ceiling instead of collecting a home-level bin (#2514)", () => {
		const { fakeHome, project, nested } = fixture();
		try {
			plantBin(project, path.join("node_modules", ".bin", binName("ast-grep")));
			plantBin(
				fakeHome,
				path.join("node_modules", ".bin", binName("ast-grep")),
			);

			expect(
				findLocalBinsUpwards(["ast-grep"], nested, { homeDir: fakeHome }),
			).toEqual([
				path.join(project, "node_modules", ".bin", binName("ast-grep")),
			]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});
