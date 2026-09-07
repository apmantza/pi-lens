/**
 * The one config resolution path (#2426): lookup order, the `$HOME` ceiling,
 * canonical-wins, and the migration records legacy sources emit.
 *
 * These are the acceptance criteria that are NOT about the projected return
 * types (those live in `config-golden-layouts.test.ts`) — they are about which
 * files are read at all, in what order, and what the user is told about it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCE_TIERS } from "../../clients/config-core/index.js";
import {
	CANONICAL_GLOBAL_CONFIG_FILE,
	CANONICAL_PROJECT_CONFIG_FILE,
	DECLARED_LEGACY_FILE_SURFACES,
	PROJECT_CONFIG_LOCATIONS,
	REGISTERED_LEGACY_FILE_SURFACES,
	configSearchDirs,
} from "../../clients/config-locations.js";
import {
	deprecationRecords,
	lspSectionOf,
	resolvePiLensConfig,
} from "../../clients/config-resolve.js";
import { removeTempDirSync } from "./test-utils.js";

vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return { ...actual, logExtension: () => {} };
});

const roots: string[] = [];

function tmpRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-resolve-"));
	roots.push(dir);
	return dir;
}

function write(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

afterEach(() => {
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

describe("documented lookup order (#2426)", () => {
	/**
	 * `docs/configuration.md`'s "Which file wins" states ONE order:
	 *
	 *   builtin -> global -> project root -> nested-project -> env -> cli -> host
	 *
	 * The first assertion is that the order documented in prose is the order the
	 * core actually sorts by — not a second ordering that happens to agree today.
	 */
	it("is the config core's own tier precedence, not a second list", () => {
		expect([...SOURCE_TIERS]).toEqual([
			"builtin",
			"global",
			"project",
			"nested-project",
			"env",
			"cli",
			"host",
		]);
	});

	it("walks the documented order: each tier beats every tier before it", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const globalDir = path.join(home, ".pi-lens");
		const projectRoot = path.join(home, "proj");
		const nested = path.join(projectRoot, "packages", "a");
		fs.mkdirSync(nested, { recursive: true });

		const globalConfigPath = path.join(globalDir, CANONICAL_GLOBAL_CONFIG_FILE);
		const projectConfig = path.join(projectRoot, CANONICAL_PROJECT_CONFIG_FILE);
		const nestedConfig = path.join(nested, CANONICAL_PROJECT_CONFIG_FILE);

		const resolveAt = () =>
			resolvePiLensConfig({
				cwd: nested,
				globalDir,
				globalConfigPath,
				homeDir: home,
			});

		// Nothing at all: the resolution is empty, not a thrown error.
		expect(resolveAt().value).toEqual({});

		write(globalConfigPath, { lsp: { warmFiles: ["global"] } });
		expect(resolveAt().value.lsp).toEqual({ warmFiles: ["global"] });

		write(projectConfig, { lsp: { warmFiles: ["project"] } });
		expect(resolveAt().value.lsp).toEqual({ warmFiles: ["project"] });

		write(nestedConfig, { lsp: { warmFiles: ["nested"] } });
		expect(resolveAt().value.lsp).toEqual({ warmFiles: ["nested"] });

		// And the tier LABELS match the documented names, so the provenance
		// surface (#2427) and the doc cannot drift apart.
		const tiers = resolveAt().documents.map((document) => document.tier);
		expect(tiers).toEqual(["global", "project", "nested-project"]);
	});

	it("layers nested configs field-wise instead of the nearest one winning whole", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const projectRoot = path.join(home, "proj");
		const nested = path.join(projectRoot, "packages", "a");
		fs.mkdirSync(nested, { recursive: true });
		write(path.join(projectRoot, CANONICAL_PROJECT_CONFIG_FILE), {
			lsp: { disabledServers: ["typos"], warmFiles: ["root"] },
		});
		write(path.join(nested, CANONICAL_PROJECT_CONFIG_FILE), {
			lsp: { warmFiles: ["nested"] },
		});
		const resolved = resolvePiLensConfig({ cwd: nested, homeDir: home });
		expect(resolved.value.lsp).toEqual({
			// The root's key SURVIVES; only the key the nested file sets is replaced.
			disabledServers: ["typos"],
			warmFiles: ["nested"],
		});
	});
});

describe("walk confinement (#2426; the #622/#625 class)", () => {
	/**
	 * The regression the issue names outright as a BUG FIX rather than a
	 * deprecation: `lsp/config.ts`'s walk ran to the filesystem root with no
	 * `$HOME` stop, so a `pi-lsp.json` in the home directory — or above it — was
	 * adopted by every project on the machine.
	 *
	 * Cross-form paths per the read-guard path-key rule: the ceiling is RECORDED
	 * in `/` form and CHECKED against a native-separator cwd (and the reverse),
	 * because a ceiling that only holds when both sides were spelled the same way
	 * is a ceiling that does not hold on Windows.
	 */
	function aboveHomeFixture(): {
		home: string;
		cwd: string;
		aboveHomeFile: string;
	} {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const cwd = path.join(home, "proj", "src");
		fs.mkdirSync(cwd, { recursive: true });
		// A legacy LSP config ABOVE the home directory.
		const aboveHomeFile = path.join(root, ".pi-lens", "lsp.json");
		write(aboveHomeFile, { warmFiles: ["from-above-home"] });
		// And one IN the home directory itself, which is equally off limits.
		write(path.join(home, "pi-lsp.json"), { warmFiles: ["from-home"] });
		return { home, cwd, aboveHomeFile };
	}

	const toPosix = (value: string): string => value.replace(/\\/g, "/");
	const toNative = (value: string): string =>
		value.split(/[\\/]/).join(path.sep);

	it("does not read a legacy config at or above HOME (posix ceiling, native cwd)", () => {
		const { home, cwd, aboveHomeFile } = aboveHomeFixture();
		const resolved = resolvePiLensConfig({
			cwd: toNative(cwd),
			homeDir: toPosix(home),
		});
		expect(resolved.value).toEqual({});
		expect(resolved.documents.map((document) => document.file)).not.toContain(
			aboveHomeFile,
		);
	});

	it("does not read a legacy config at or above HOME (native ceiling, posix cwd)", () => {
		const { home, cwd } = aboveHomeFixture();
		const resolved = resolvePiLensConfig({
			cwd: toPosix(cwd),
			homeDir: toNative(home),
		});
		expect(resolved.value).toEqual({});
	});

	it("still reads a config BELOW the ceiling from the same fixture", () => {
		// The mutation guard for the two cases above: if the ceiling were the
		// reason nothing was read (rather than the file's location), this would
		// fail too and the pair would prove nothing.
		const { home, cwd } = aboveHomeFixture();
		write(path.join(home, "proj", CANONICAL_PROJECT_CONFIG_FILE), {
			lsp: { warmFiles: ["from-project"] },
		});
		const resolved = resolvePiLensConfig({ cwd, homeDir: home });
		expect(resolved.value.lsp).toEqual({ warmFiles: ["from-project"] });
	});

	it("stops the search-dir walk at the ceiling", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const cwd = path.join(home, "a", "b");
		fs.mkdirSync(cwd, { recursive: true });
		const dirs = configSearchDirs(cwd, home).map((dir) => path.resolve(dir));
		expect(dirs).toEqual(
			[cwd, path.join(home, "a")].map((d) => path.resolve(d)),
		);
		expect(dirs).not.toContain(path.resolve(home));
		expect(dirs).not.toContain(path.resolve(root));
	});
});

describe("canonical wins on collision (#2426)", () => {
	it("prefers .pi-lens.json over every legacy file in the same directory", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const projectRoot = path.join(home, "proj");
		fs.mkdirSync(projectRoot, { recursive: true });
		write(path.join(projectRoot, ".pi-lens", "lsp.json"), {
			warmFiles: ["from-lsp-json"],
		});
		write(path.join(projectRoot, "pi-lsp.json"), {
			warmFiles: ["from-pi-lsp-json"],
		});
		write(path.join(projectRoot, CANONICAL_PROJECT_CONFIG_FILE), {
			lsp: { warmFiles: ["from-canonical"] },
		});
		const resolved = resolvePiLensConfig({ cwd: projectRoot, homeDir: home });
		// The legacy root key and the canonical namespace both resolved; the
		// canonical one is what a projection reads.
		expect(resolved.value.lsp).toEqual({ warmFiles: ["from-canonical"] });
		// Mutation guard: the canonical location must be LAST in the table, since
		// `merge` keeps caller order on a precedence tie.
		expect(
			PROJECT_CONFIG_LOCATIONS[PROJECT_CONFIG_LOCATIONS.length - 1]
				.relativePath,
		).toBe(CANONICAL_PROJECT_CONFIG_FILE);
		expect(
			PROJECT_CONFIG_LOCATIONS[PROJECT_CONFIG_LOCATIONS.length - 1].legacy,
		).toBe(false);
	});

	/**
	 * #2426 review round 2, F4. The case above spells `warmFiles` at the ROOT of
	 * the legacy files and under `lsp` in the canonical one, so the namespace
	 * rule decides it and the LOCATION ORDER is never exercised. Here both files
	 * spell the key the SAME way, which leaves the table's ordering — canonical
	 * added last, `merge` keeping caller order on a precedence tie — as the only
	 * thing that can decide. It goes red under a
	 * `PROJECT_CONFIG_LOCATIONS.reverse()` mutation.
	 *
	 * The assertion reads the `lsp` SECTION rather than the resolved root
	 * (#2427 review round 2, F1). `resolvePiLensConfig` now moves a document's
	 * legacy root LSP keys into the `lsp` namespace at source injection, so the
	 * root spelling no longer survives into the resolved value — one key, one
	 * schema node. The location-order property this case exists for is
	 * unchanged, and `lspSectionOf` is how both production consumers of this
	 * resolution read the value anyway.
	 */
	it("prefers the canonical file on an identically spelled key", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const projectRoot = path.join(home, "proj");
		fs.mkdirSync(projectRoot, { recursive: true });
		write(path.join(projectRoot, "pi-lsp.json"), {
			warmFiles: ["from-pi-lsp-json"],
		});
		write(path.join(projectRoot, CANONICAL_PROJECT_CONFIG_FILE), {
			warmFiles: ["from-canonical"],
		});
		const resolved = resolvePiLensConfig({ cwd: projectRoot, homeDir: home });
		expect(resolved.value.warmFiles).toBeUndefined();
		expect(lspSectionOf(resolved.value).warmFiles).toEqual(["from-canonical"]);
	});

	it("prefers a canonical lsp.* key over the legacy root key of the same name", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const projectRoot = path.join(home, "proj");
		fs.mkdirSync(projectRoot, { recursive: true });
		write(path.join(projectRoot, CANONICAL_PROJECT_CONFIG_FILE), {
			warmFiles: ["legacy-root"],
			disabledServers: ["only-at-root"],
			lsp: { warmFiles: ["canonical"] },
		});
		const resolved = resolvePiLensConfig({ cwd: projectRoot, homeDir: home });
		const section = lspSectionOf(resolved.value);
		expect(section.warmFiles).toEqual(["canonical"]);
		// A key the user has NOT migrated yet keeps working.
		expect(section.disabledServers).toEqual(["only-at-root"]);
	});
});

describe("migration records (#2426; PILENS_CFG_0002 / 0003)", () => {
	it("emits exactly one record per (file, key) for a legacy file", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const projectRoot = path.join(home, "proj");
		fs.mkdirSync(projectRoot, { recursive: true });
		const legacy = path.join(projectRoot, ".pi-lens", "lsp.json");
		write(legacy, {
			servers: { a: { name: "A" }, b: { name: "B" } },
			warmFiles: ["x"],
		});
		const resolved = resolvePiLensConfig({ cwd: projectRoot, homeDir: home });
		const records = resolved.records.filter(
			(entry) => entry.code === "PILENS_CFG_0003",
		);
		// TWO records — one per top-level key — not one per file and not one per
		// server inside `servers`.
		expect(records.map((entry) => entry.key).sort()).toEqual([
			"servers",
			"warmFiles",
		]);
		expect(new Set(records.map((entry) => entry.file))).toEqual(
			new Set([legacy]),
		);
		// The ledger identity is <file>NUL<key>, so a per-key notice and a
		// whole-file one stay distinct rows for the same path. The separator is
		// built from its code point rather than written literally, so no control
		// byte enters this source file.
		const NUL = String.fromCharCode(0);
		for (const entry of records) {
			expect(entry.subject).toBe(`${entry.file}${NUL}${entry.key}`);
		}
	});

	it("names the canonical destination in every record, as data and as prose", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const projectRoot = path.join(home, "proj");
		fs.mkdirSync(projectRoot, { recursive: true });
		write(path.join(projectRoot, "pi-lsp.json"), { servers: { a: {} } });
		const [record] = resolvePiLensConfig({
			cwd: projectRoot,
			homeDir: home,
		}).records.filter((entry) => entry.code === "PILENS_CFG_0003");
		// `canonicalKey` is the DATA half: a later auto-migrator is a pure
		// function over these records and never parses the prose.
		expect(record.canonicalKey).toBe("lsp.servers");
		expect(record.reason).toContain(CANONICAL_PROJECT_CONFIG_FILE);
		expect(record.reason).toContain("lsp.servers");
		// And the window comes from the registry, not from a literal here.
		expect(record.reason).toMatch(/deprecated since \d+\.\d+\.\d+/);
		expect(record.reason).toMatch(/before \d+\.\d+\.\d+/);
	});

	it("emits a KEY record (0002) for a legacy root key in a canonical file", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const projectRoot = path.join(home, "proj");
		fs.mkdirSync(projectRoot, { recursive: true });
		write(path.join(projectRoot, CANONICAL_PROJECT_CONFIG_FILE), {
			servers: { a: {} },
			ignore: ["dist/**"],
		});
		const resolved = resolvePiLensConfig({ cwd: projectRoot, homeDir: home });
		const records = resolved.records.filter((entry) =>
			entry.code.startsWith("PILENS_CFG_000"),
		);
		expect(records).toHaveLength(1);
		expect(records[0].code).toBe("PILENS_CFG_0002");
		expect(records[0].key).toBe("servers");
		expect(records[0].canonicalKey).toBe("lsp.servers");
		// `ignore` is a first-class project key and gets no notice.
		expect(records.map((entry) => entry.key)).not.toContain("ignore");
	});

	it("emits ZERO records for a canonical-only layout", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const globalDir = path.join(home, ".pi-lens");
		const projectRoot = path.join(home, "proj");
		fs.mkdirSync(projectRoot, { recursive: true });
		write(path.join(globalDir, CANONICAL_GLOBAL_CONFIG_FILE), {
			ignore: ["*.snap"],
			lsp: { disabledServers: ["typos"] },
		});
		write(path.join(projectRoot, CANONICAL_PROJECT_CONFIG_FILE), {
			ignore: ["dist/**"],
			lsp: { servers: { a: { name: "A" } }, warmFiles: ["x"] },
		});
		const resolved = resolvePiLensConfig({
			cwd: projectRoot,
			globalDir,
			globalConfigPath: path.join(globalDir, CANONICAL_GLOBAL_CONFIG_FILE),
			homeDir: home,
		});
		expect(resolved.records).toEqual([]);
	});

	it("points a legacy GLOBAL file at the canonical global file", () => {
		const root = tmpRoot();
		const home = path.join(root, "home");
		const globalDir = path.join(home, ".pi-lens");
		write(path.join(globalDir, "lsp.json"), { warmFiles: ["x"] });
		const resolved = resolvePiLensConfig({
			globalDir,
			globalConfigPath: path.join(globalDir, CANONICAL_GLOBAL_CONFIG_FILE),
			homeDir: home,
		});
		const [record] = resolved.records;
		expect(record.code).toBe("PILENS_CFG_0003");
		expect(record.canonicalKey).toBe("lsp.warmFiles");
		// Home-relative, never the operator's account name (the #2440 F5 rule).
		expect(record.reason).toContain(
			`~/.pi-lens/${CANONICAL_GLOBAL_CONFIG_FILE}`,
		);
		expect(record.reason).not.toContain(home);
	});

	it("produces no record for a document a canonical location claims", () => {
		// `deprecationRecords` is the one producer; probing it directly pins that
		// "canonical" is decided by the location table rather than by the filename
		// happening to look canonical.
		const canonical = PROJECT_CONFIG_LOCATIONS.find(
			(location) => !location.legacy,
		);
		expect(canonical).toBeDefined();
		expect(
			deprecationRecords(
				[
					{
						tier: "project",
						file: "/repo/.pi-lens.json",
						location: canonical as NonNullable<typeof canonical>,
						value: { ignore: ["a"], rules: {} },
					},
				],
				"/home/someone",
			),
		).toEqual([]);
	});
});

describe("location table agrees with the deprecation registry (#2418/#2426)", () => {
	it("declares exactly the registry's file surfaces", () => {
		expect([...DECLARED_LEGACY_FILE_SURFACES].sort()).toEqual(
			[...REGISTERED_LEGACY_FILE_SURFACES].sort(),
		);
	});

	it("never marks a canonical location deprecated", () => {
		for (const location of PROJECT_CONFIG_LOCATIONS) {
			if (location.relativePath === CANONICAL_PROJECT_CONFIG_FILE) {
				expect(location.legacy).toBe(false);
				expect(location.surface).toBeUndefined();
			}
		}
	});
});
