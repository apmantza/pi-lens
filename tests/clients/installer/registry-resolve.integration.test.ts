import { describe, expect, it } from "vitest";
import { TOOLS, parsePinnedVersion } from "../../../clients/installer/index.js";

/**
 * #2638: `vscode-css-languageserver` (the bare npm package this id's
 * `packageName` used to name) was unpublished from the registry in 2021 —
 * `ensureTool` for that id could never succeed, and nothing in the suite
 * noticed because every other check on `TOOLS` is network-free (by design,
 * per `tool-registry-consistency.test.ts`'s own doc comment) and so cannot
 * tell "a syntactically fine package name" from "a dead one".
 *
 * This is the missing net: every `installStrategy: "npm"` entry's bare
 * package name (the pin stripped, if any — `parsePinnedVersion` is the
 * production function that already knows how to strip it) must resolve on
 * the real npm registry AT THE VERSION THIS REGISTRY WOULD ACTUALLY INSTALL
 * (the pin, or `dist-tags.latest` when unpinned) — and that version's own
 * published `bin` map must contain the entry's `binaryName`. The second half
 * closes the other #2638 finding: the installer's header comment claimed
 * this exact server installed from `vscode-langservers-extracted` while the
 * entry's `packageName` field disagreed, and nothing checked the two against
 * each other OR against what npm actually publishes. Gated behind
 * `PI_LENS_INTEGRATION=1` like the other live-network suites
 * (`typescript-classic-repair.integration.test.ts`,
 * `typescript-native-vitest.integration.test.ts`) — it hits the network and
 * has no place in the default per-PR run; a nightly/tool-smoke lane opts in
 * via the env var.
 */
const RUN_LIVE_REGISTRY_RESOLVE = process.env.PI_LENS_INTEGRATION === "1";

function bareNpmName(packageName: string): string {
	const pinned = parsePinnedVersion(packageName);
	return pinned === undefined
		? packageName
		: packageName.slice(0, packageName.lastIndexOf("@"));
}

/**
 * npm's registry path-encodes a scoped package's `/` (not its leading `@`):
 * `@scope/name` -> `/@scope%2Fname`. A bare name has no `/` to encode.
 */
function registryPath(bareName: string): string {
	if (bareName.startsWith("@")) {
		const slash = bareName.indexOf("/");
		return `${bareName.slice(0, slash)}%2F${bareName.slice(slash + 1)}`;
	}
	return encodeURIComponent(bareName);
}

interface RegistryResolution {
	ok: boolean;
	status: number;
	detail: string;
	/** The `bin` map of the resolved version, when one was found. */
	bin?: Record<string, string>;
}

/**
 * A GET on both a genuinely-unknown name (HTTP 404, body `{"error":"Not
 * found"}`) AND an unpublished package's doc (HTTP 200, a name-squat-
 * prevention stub with `time.unpublished` set) come back as valid JSON
 * with no `dist-tags` — verified live for both
 * `pi-lens-definitely-does-not-exist-2638` and the exact dead package
 * #2638 shipped, `vscode-css-languageserver`. `npm install`/`npm view`
 * resolve through `dist-tags.latest` (or the pinned version, when the
 * TOOLS entry pins one), so checking THAT (rather than the HTTP status,
 * which a mutation probe showed never independently distinguishes these
 * two failure shapes from a real install) is the one signal this helper
 * needs; a non-JSON body is a genuine registry/network failure and is
 * left to throw and fail the test loudly rather than being swallowed
 * into a soft "not ok".
 *
 * `wantVersion`, when given, resolves the PINNED version's own manifest
 * rather than `dist-tags.latest` — the version actually installed can
 * differ from latest, and its `bin` map is the one that matters (#2638
 * review: the header/registry-resolve gap this test exists to close is
 * exactly "the entry and what npm actually publishes disagree").
 */
async function resolvesOnNpmRegistry(
	bareName: string,
	wantVersion?: string,
): Promise<RegistryResolution> {
	const res = await fetch(
		`https://registry.npmjs.org/${registryPath(bareName)}`,
		{ method: "GET" },
	);
	const body = (await res.json()) as {
		"dist-tags"?: Record<string, string>;
		time?: { unpublished?: unknown };
		versions?: Record<string, { bin?: string | Record<string, string> }>;
	};
	const latest = body["dist-tags"]?.latest;
	if (!latest) {
		return {
			ok: false,
			status: res.status,
			detail: body.time?.unpublished
				? `unpublished (HTTP ${res.status}, no dist-tags.latest)`
				: `no dist-tags.latest (HTTP ${res.status})`,
		};
	}
	const targetVersion = wantVersion ?? latest;
	const manifest = body.versions?.[targetVersion];
	if (!manifest) {
		return {
			ok: false,
			status: res.status,
			detail: `version ${targetVersion} not in the registry's own versions map (latest=${latest})`,
		};
	}
	// npm allows a package's `bin` field to be either a name->path map, or a
	// bare string — the latter means "one binary, named after the package"
	// (npm derives the name from `name`, scope stripped).
	const bin =
		typeof manifest.bin === "string"
			? { [bareName.replace(/^@[^/]+\//, "")]: manifest.bin }
			: (manifest.bin ?? {});
	return {
		ok: true,
		status: res.status,
		detail: `version=${targetVersion}`,
		bin,
	};
}

describe.skipIf(!RUN_LIVE_REGISTRY_RESOLVE)(
	"managed npm tool packages resolve on the real registry (#2638)",
	() => {
		const npmTools = TOOLS.filter((t) => t.installStrategy === "npm");

		it("registry has at least one npm-strategy tool to check (sanity)", () => {
			expect(npmTools.length).toBeGreaterThan(0);
		});

		// Nothing in the TOOLS registry today is a genuinely nonexistent name
		// (only #2638's real regression, an unpublished-but-once-real name), so
		// the helper's rejection of a plain 404 is proven directly here rather
		// than left unverified.
		it("resolvesOnNpmRegistry rejects a genuinely nonexistent package name (HTTP 404 branch)", async () => {
			const result = await resolvesOnNpmRegistry(
				"pi-lens-definitely-does-not-exist-2638",
			);
			expect(result.ok).toBe(false);
			expect(result.status).toBe(404);
		});

		it("resolvesOnNpmRegistry rejects the historically-dead #2638 package name directly", async () => {
			const result = await resolvesOnNpmRegistry("vscode-css-languageserver");
			expect(result.ok).toBe(false);
			expect(result.detail).toContain("unpublished");
		});

		for (const tool of npmTools) {
			const bareName = bareNpmName(tool.packageName as string);
			const pinnedVersion = parsePinnedVersion(tool.packageName as string);
			it(`${tool.id} (${bareName}) resolves on npmjs.org`, async () => {
				const result = await resolvesOnNpmRegistry(bareName, pinnedVersion);
				expect(
					result.ok,
					`${tool.id}: package "${bareName}" is not installable (${result.detail}) — the TOOLS entry names a dead/unpublished package (or a version npm no longer has) and ensureTool() for this id can never succeed`,
				).toBe(true);
			});

			// #2638 review: the exact contradiction this issue shipped —
			// checkCommand/binaryName naming a bin the packageName's OWN
			// published `bin` map doesn't have — must be caught here, not just
			// "the package exists".
			if (tool.binaryName) {
				it(`${tool.id}: binaryName "${tool.binaryName}" is a real bin of ${bareName}`, async () => {
					const result = await resolvesOnNpmRegistry(bareName, pinnedVersion);
					expect(result.ok, `${tool.id}: ${result.detail}`).toBe(true);
					expect(
						Object.keys(result.bin ?? {}),
						`${tool.id}: package "${bareName}"'s bin map does not publish "${tool.binaryName}"`,
					).toContain(tool.binaryName);
				});
			}
		}
	},
);
