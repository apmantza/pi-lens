import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type ConfigDiagnosticCode,
	DEPRECATED_CONFIG_SURFACES,
	isConfigDiagnosticCode,
} from "../../clients/config-diagnostic-codes.js";
import {
	DECLARED_LEGACY_FILE_SURFACES,
	REGISTERED_LEGACY_FILE_SURFACES,
} from "../../clients/config-locations.js";
import { assertNonEmptyScan, escapeRegExp } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

function parseSemver(version: string): [number, number, number] {
	const matched = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!matched) throw new Error(`not a semver: ${version}`);
	return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
}

function compareSemver(a: string, b: string): number {
	const left = parseSemver(a);
	const right = parseSemver(b);
	for (let i = 0; i < 3; i += 1) {
		if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
	}
	return 0;
}

const PACKAGE_VERSION = (
	JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
	) as { version: string }
).version;

const CHANGELOG = fs.readFileSync(
	path.join(REPO_ROOT, "CHANGELOG.md"),
	"utf-8",
);

/**
 * The newest version that has actually SHIPPED, read off `CHANGELOG.md`'s
 * `## [x.y.z] - date` headings. `package.json`'s version is the same number
 * right after a release and therefore cannot tell "already out" from "about to
 * go out" — which is exactly the distinction `deprecatedSince` needs (#2418
 * review, S3).
 */
function lastReleasedVersion(): string {
	const versions = [...CHANGELOG.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]/gm)].map(
		(match) => match[1],
	);
	if (versions.length === 0) throw new Error("CHANGELOG.md names no release");
	return versions.reduce((newest, candidate) =>
		compareSemver(candidate, newest) > 0 ? candidate : newest,
	);
}

const LAST_RELEASED_VERSION = lastReleasedVersion();

/**
 * Changelog `Deprecated` prose, split by whether it has SHIPPED.
 *
 * - `released` — `### Deprecated` bodies under a `## [x.y.z]` release heading.
 * - `unreleased` — the same under `## [Unreleased]`, plus every `.changelog/`
 *   fragment declaring `section: Deprecated`.
 *
 * The split is what makes the window check honest: a row announced only in an
 * unreleased fragment cannot claim a `deprecatedSince` that already shipped,
 * because no shipped release ever emitted its warning.
 */
function deprecatedChangelogText(): { released: string; unreleased: string } {
	const released: string[] = [];
	const unreleased: string[] = [];

	let inDeprecated = false;
	let inUnreleasedRelease = false;
	for (const line of CHANGELOG.split(/\r?\n/)) {
		if (/^##\s/.test(line)) {
			inUnreleasedRelease = /^##\s+\[Unreleased\]/i.test(line);
		}
		if (/^#{2,4}\s/.test(line)) {
			inDeprecated = /^###\s+Deprecated\s*$/.test(line);
			continue;
		}
		if (inDeprecated) (inUnreleasedRelease ? unreleased : released).push(line);
	}

	const fragmentDir = path.join(REPO_ROOT, ".changelog");
	for (const name of fs.readdirSync(fragmentDir)) {
		if (!name.endsWith(".md") || name === "README.md") continue;
		const fragment = fs.readFileSync(path.join(fragmentDir, name), "utf-8");
		if (/^---[\s\S]*?section:\s*Deprecated[\s\S]*?---/m.test(fragment)) {
			unreleased.push(fragment);
		}
	}

	return { released: released.join("\n"), unreleased: unreleased.join("\n") };
}

/**
 * Is `surface` announced in `text` as a DELIMITED token?
 *
 * Backticked, because that is how the changelog spells every config surface and
 * because a bare substring test is wrong in a way that matters (#2418 review,
 * F4): `"pi-lens.json"` is a substring of `".pi-lens.json"`, so an announcement
 * of the canonical file counted as an announcement of the deprecated undotted
 * one, and a row could ship with nobody ever told about it.
 */
function isAnnounced(text: string, surface: string): boolean {
	const escaped = escapeRegExp(surface);
	return new RegExp("`\\s*" + escaped + "\\s*`").test(text);
}

const LSP_CONFIG_SOURCE = fs.readFileSync(
	path.join(REPO_ROOT, "clients", "lsp", "config.ts"),
	"utf-8",
);

/** The body of `export interface LSPConfig { ... }`. */
function lspConfigInterfaceBody(): string {
	const start = LSP_CONFIG_SOURCE.indexOf("export interface LSPConfig {");
	expect(start).toBeGreaterThan(-1);
	const end = LSP_CONFIG_SOURCE.indexOf("\n}", start);
	return LSP_CONFIG_SOURCE.slice(start, end);
}

/**
 * The legacy locations the LOADERS actually read, as spelled literally in
 * `config-locations.ts`'s location table (#2426). Not derived from the registry
 * — that would make the comparison below circular. The table names its paths as
 * string literals and tags each with the registry surface it claims to be; this
 * test is what pins the two together in both directions.
 */
const KNOWN_CONFIG_FILES = new Set<string>(DECLARED_LEGACY_FILE_SURFACES);

describe("deprecated config surface registry (#2418)", () => {
	it("is non-empty", () => {
		// Declared floor: an emptied registry must FAIL rather than read as
		// "nothing is deprecated". Eight rows exist today; the floor sits below
		// that so a legitimate removal at a major does not break the sweep.
		assertNonEmptyScan(
			"deprecated config surface registry",
			DEPRECATED_CONFIG_SURFACES.length,
			4,
		);
	});

	it("names each surface once per kind", () => {
		const keys = DEPRECATED_CONFIG_SURFACES.map(
			(row) => `${row.kind}:${row.surface}`,
		);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("carries a semver-sane deprecation window on every row", () => {
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			expect(row.deprecatedSince, row.surface).toMatch(/^\d+\.\d+\.\d+$/);
			expect(row.removeNotBefore, row.surface).toMatch(/^\d+\.\d+\.\d+$/);
			const since = parseSemver(row.deprecatedSince);
			const remove = parseSemver(row.removeNotBefore);
			// Removal happens only in a MAJOR, and only a later one.
			expect(remove[0], row.surface).toBeGreaterThan(since[0]);
			expect([remove[1], remove[2]], row.surface).toEqual([0, 0]);
		}
	});

	it("dates deprecatedSince by where the row is actually announced", () => {
		// #2418 review, S3. `<= package.json` let a row back-date itself into a
		// version that already shipped without the warning — the registry would
		// claim 4.1.3 deprecated a key while 4.1.3 is on npm saying nothing. The
		// announcement's location is the fact that settles it: announced in a
		// shipped release => at or before the last release; announced only in an
		// unreleased fragment => strictly after it.
		const { released, unreleased } = deprecatedChangelogText();
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			if (isAnnounced(released, row.surface)) {
				expect(
					compareSemver(row.deprecatedSince, LAST_RELEASED_VERSION),
					`${row.surface} is announced in a shipped release, so deprecatedSince ${row.deprecatedSince} must be <= ${LAST_RELEASED_VERSION}`,
				).toBeLessThanOrEqual(0);
				continue;
			}
			expect(
				isAnnounced(unreleased, row.surface),
				`${row.surface} is announced nowhere`,
			).toBe(true);
			expect(
				compareSemver(row.deprecatedSince, LAST_RELEASED_VERSION),
				`${row.surface} is announced only in an UNRELEASED changelog entry, so deprecatedSince ${row.deprecatedSince} must be later than the last release ${LAST_RELEASED_VERSION}`,
			).toBeGreaterThan(0);
		}
	});

	it("reads the last released version off the changelog, not package.json", () => {
		expect(LAST_RELEASED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		// The two agree today (4.1.3 shipped, no bump yet); the test must not
		// silently start reading package.json if that ever stops being true.
		expect(
			compareSemver(LAST_RELEASED_VERSION, PACKAGE_VERSION),
		).toBeLessThanOrEqual(0);
	});

	it("points every row at a registered diagnostic code", () => {
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			expect(isConfigDiagnosticCode(row.code), row.surface).toBe(true);
		}
	});

	it("uses the kind-appropriate code", () => {
		const expected: Record<"key" | "file", ConfigDiagnosticCode> = {
			key: "PILENS_CFG_0002",
			file: "PILENS_CFG_0003",
		};
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			expect(row.code, row.surface).toBe(expected[row.kind]);
		}
	});

	it("gives every row a non-empty reason", () => {
		for (const row of DEPRECATED_CONFIG_SURFACES) {
			expect(row.reason.length, row.surface).toBeGreaterThan(20);
		}
	});

	it("announces every row in a Changelog Deprecated section, as a delimited token", () => {
		const { released, unreleased } = deprecatedChangelogText();
		const announced = `${released}\n${unreleased}`;
		expect(announced.trim().length).toBeGreaterThan(0);
		const missing = DEPRECATED_CONFIG_SURFACES.filter(
			(row) => !isAnnounced(announced, row.surface),
		).map((row) => row.surface);
		expect(missing).toEqual([]);
	});

	it("does not accept a longer filename as another row's announcement", () => {
		// The F4 mutation, pinned: `.pi-lens.json` (canonical, mentioned in the
		// same fragment) must never satisfy the undotted `pi-lens.json` row.
		expect(isAnnounced("see `.pi-lens.json` for details", "pi-lens.json")).toBe(
			false,
		);
		expect(isAnnounced("see `pi-lens.json` for details", "pi-lens.json")).toBe(
			true,
		);
		// Nor may an undelimited mention in running prose count.
		expect(isAnnounced("we no longer read pi-lens.json", "pi-lens.json")).toBe(
			false,
		);
		// A regex metacharacter in the surface is matched literally.
		expect(
			isAnnounced("the `.pi-lens/lsp.json` file", ".pi-lens/lsp.json"),
		).toBe(true);
		expect(
			isAnnounced("the `Xpi-lensYlsp.json` file", ".pi-lens/lsp.json"),
		).toBe(false);
	});

	it("does not list a canonical config file as a deprecated FILE row", () => {
		// #2418 review, F5. `.pi-lens.json` and `~/.pi-lens/config.json` are the
		// two locations #2426 blesses; a row for either would promise users the
		// file they were just told to migrate TO is going away. What IS
		// deprecated is the legacy top-level LSP keys inside them — `kind: "key"`
		// rows, which this asserts are actually present.
		const files = DEPRECATED_CONFIG_SURFACES.filter(
			(row) => row.kind === "file",
		).map((row) => row.surface);
		expect(files).not.toContain(".pi-lens.json");
		expect(files).not.toContain("~/.pi-lens/config.json");
		const keys = DEPRECATED_CONFIG_SURFACES.filter(
			(row) => row.kind === "key",
		).map((row) => row.surface);
		expect(keys).toContain("servers");
		expect(keys).toContain("serverOverrides");
		expect(keys).toContain("disabledServers");
		expect(keys).toContain("warmFiles");
	});

	it("only deprecates FILE locations the loaders actually read", () => {
		const unknown = DEPRECATED_CONFIG_SURFACES.filter(
			(row) => row.kind === "file" && !KNOWN_CONFIG_FILES.has(row.surface),
		).map((row) => row.surface);
		expect(unknown).toEqual([]);
	});

	it("reads every FILE location the registry deprecates (#2426)", () => {
		// The other direction, and the one that actually bites: a row can go
		// un-honored — deprecated on paper while the loader silently stopped
		// reading it — and the check above would still pass.
		const unread = REGISTERED_LEGACY_FILE_SURFACES.filter(
			(surface) => !KNOWN_CONFIG_FILES.has(surface),
		);
		expect(unread).toEqual([]);
		expect([...KNOWN_CONFIG_FILES].sort()).toEqual(
			[...REGISTERED_LEGACY_FILE_SURFACES].sort(),
		);
	});

	it("only deprecates KEYS the LSPConfig interface declares", () => {
		const body = lspConfigInterfaceBody();
		const unknown = DEPRECATED_CONFIG_SURFACES.filter(
			(row) =>
				row.kind === "key" &&
				!new RegExp(`\\n\\s*${row.surface}\\??\\s*:`).test(body),
		).map((row) => row.surface);
		expect(unknown).toEqual([]);
	});
});
