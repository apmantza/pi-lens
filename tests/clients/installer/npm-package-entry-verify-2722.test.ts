/**
 * #2722 — a managed npm LSP server whose transport-required marker cannot be
 * read back through a pipe.
 *
 * intelephense has no CLI: its entry calls `createConnection()` unconditionally
 * and throws, and Node prints the offending source line ahead of the message.
 * The bundle is one ~4 MB minified line, so the marker #208's rescue matches on
 * lands at byte 4,154,741 of a 4,423,356-byte stderr — while Node drops
 * everything past 1 MiB of a PIPED stderr when the child exits. The bytes never
 * leave the child, so no `checkArgs` value can produce a verdict, and
 * `installNpmTool`'s cleanup branch deleted every successful install.
 *
 * Two guarantees are pinned here:
 *
 * 1. `verification: "package-entry"` verifies the install from the tree on
 *    disk with NO spawn at all — the same class of evidence the `archive`
 *    strategy already accepts through `treeMarker`.
 * 2. A probe that ran to completion with the transport matcher ARMED, never
 *    matched, and a TRUNCATED prefix of the output is INCONCLUSIVE, not a
 *    verdict: `onInconclusive` fires and the ledger records
 *    `installer-verification-inconclusive`, so a caller keeps the install.
 *
 * Guarantee 2's fixture is the real defect, not a double that hands the seam a
 * marker: the child genuinely writes the marker to stderr and Node genuinely
 * loses it (AGENTS.md test-authoring screen 1).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	packageEntryVerification,
	TOOLS,
	verifyNpmPackageEntry,
	verifyToolBinary,
} from "../../../clients/installer/index.js";
import { removeTempDirSync } from "../test-utils.js";

/** The literal #208 rescues on — see `isLspTransportRequiredError`. */
const TRANSPORT_MARKER =
	"Connection input stream is not set. Please use listen";

let root = "";

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2722-"));
	resetDegradationLedger();
});

afterEach(() => {
	removeTempDirSync(root);
	resetDegradationLedger();
});

/** `<root>/node_modules/.bin/<name>`, as an executable POSIX/Windows shim. */
function writeShim(name: string, body: string): string {
	const binDir = path.join(root, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const isWin = process.platform === "win32";
	const file = path.join(binDir, isWin ? `${name}.cmd` : name);
	if (isWin) {
		fs.writeFileSync(file, `@echo off\r\n${body}\r\n`, "utf8");
	} else {
		fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, {
			encoding: "utf8",
			mode: 0o755,
		});
	}
	return file;
}

describe("inconclusive verification keeps its non-verdict (#2722)", () => {
	// lane: ubuntu (the authoritative Unit tests lane) and every other POSIX dev
	// box. The LOSS this fixture depends on is POSIX-only: Node's stdout/stderr
	// are asynchronous over a pipe on Linux and macOS and SYNCHRONOUS over a
	// pipe on Windows, so a Windows child flushes the tail and the marker DOES
	// arrive (streamingMatch fires and the probe verifies). That is a property
	// of the platform's stream semantics, not of the seam, so the Windows lane
	// covers the same seam through the spawn boundary itself:
	// markdownlint-verify-2045.test.ts's "bounds retained output for noisy
	// language-server probes" drives a truncated, unmatched safeSpawnAsync
	// result on every platform.
	it.skipIf(process.platform === "win32")(
		"a >2 MiB dump that swallows the transport marker is inconclusive, not broken",
		async () => {
			// The child does what intelephense does: one huge write to stderr, then
			// the transport-required line, then exit. Node's async pipe write queue
			// is dropped at exit, so the marker never reaches the parent.
			const dump = path.join(root, "dump.cjs");
			fs.writeFileSync(
				dump,
				[
					'process.stderr.write("x".repeat(2 * 1024 * 1024) + "\\n");',
					`process.stderr.write(${JSON.stringify(`${TRANSPORT_MARKER}()\n`)});`,
					"process.exit(1);",
				].join("\n"),
				"utf8",
			);
			const bin = writeShim(
				"buried-marker-lsp",
				`exec "${process.execPath}" "${dump}"`,
			);

			const onTransient = vi.fn();
			const onInconclusive = vi.fn();
			await expect(
				verifyToolBinary(
					bin,
					undefined,
					onTransient,
					10_000,
					["--version"],
					undefined,
					onInconclusive,
				),
			).resolves.toBe(false);

			// If the marker HAD reached the parent, streamingMatch would have made
			// this `true` — so the `false` above is itself the proof that the bytes
			// never left the child.
			expect(onInconclusive).toHaveBeenCalledTimes(1);
			// NOT the #1569 transient class: the prober ran to completion and
			// re-probing reproduces it exactly (catalog shape 13).
			expect(onTransient).not.toHaveBeenCalled();
			expect(getDegradationSummary()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "installer-verification-inconclusive",
						count: 1,
						latestReasons: [
							{
								subject: bin,
								reason:
									"transport-required marker unresolved in truncated output (--version)",
							},
						],
					}),
				]),
			);
		},
		20_000,
	);

	it("a bounded, UNtruncated nonzero probe stays a verdict", async () => {
		// The complement, and the reason the branch reads `outputTruncated`
		// rather than "the matcher did not match": a server that exits nonzero
		// with everything it had to say already in hand IS broken, and must keep
		// taking the cleanup branch.
		const bin = writeShim(
			"honestly-broken-lsp",
			process.platform === "win32" ? "exit /b 3" : "exit 3",
		);
		const onInconclusive = vi.fn();
		await expect(
			verifyToolBinary(
				bin,
				undefined,
				undefined,
				10_000,
				["--version"],
				undefined,
				onInconclusive,
			),
		).resolves.toBe(false);
		expect(onInconclusive).not.toHaveBeenCalled();
		expect(getDegradationSummary().map((group) => group.kind)).not.toContain(
			"installer-verification-inconclusive",
		);
	});
});

/**
 * Acceptance 4: the path is keyed on the registry's `verification` field, not
 * on intelephense. TWO fixture packages of the same shape — a bare name with a
 * `bin` MAP (intelephense's own shape) and a SCOPED name with a bare `bin`
 * STRING whose shim name differs from the last path segment — run the whole
 * table. There is no second registry member to use instead: all thirteen
 * npm-strategy LSP entries were installed and probed for real while writing
 * this, and the other twelve either print a real version (exit 0) or land
 * their transport marker at byte ~203-208, far inside the retained window.
 */
interface EntryFixture {
	label: string;
	packageName: string;
	shim: string;
	manifest: Record<string, unknown>;
	entryPath: string;
}

const ENTRY_FIXTURES: readonly EntryFixture[] = [
	{
		label: "bare package with a bin map (intelephense's shape)",
		packageName: "fixture-php-server",
		shim: "fixture-php-server",
		manifest: {
			name: "fixture-php-server",
			version: "1.18.5",
			bin: { "fixture-php-server": "./lib/server.js" },
		},
		entryPath: path.join("lib", "server.js"),
	},
	{
		label: "scoped package with a bare bin string and a differing shim name",
		packageName: "@fixture/second-lsp",
		shim: "second-server",
		manifest: {
			name: "@fixture/second-lsp",
			version: "0.4.0",
			bin: "bin/cli.js",
		},
		entryPath: path.join("bin", "cli.js"),
	},
];

describe.each(ENTRY_FIXTURES)(
	"package-entry verification — $label (#2722)",
	(fixture) => {
		let bin = "";
		let packageDir = "";
		let entryFile = "";
		let spawnMarker = "";

		beforeEach(() => {
			packageDir = path.join(
				root,
				"node_modules",
				...fixture.packageName.split("/"),
			);
			entryFile = path.join(packageDir, fixture.entryPath);
			fs.mkdirSync(path.dirname(entryFile), { recursive: true });
			fs.writeFileSync(entryFile, "module.exports = {};\n", "utf8");
			fs.writeFileSync(
				path.join(packageDir, "package.json"),
				JSON.stringify(fixture.manifest),
				"utf8",
			);
			// The shim RECORDS being executed. Verification must never run it, so
			// the absence of this file is the spawn-free proof — no spy, no mock.
			spawnMarker = path.join(root, `${fixture.shim}.spawned`);
			bin = writeShim(
				fixture.shim,
				process.platform === "win32"
					? `type nul > "${spawnMarker}"`
					: `: > "${spawnMarker}"`,
			);
		});

		it("verifies from the tree on disk without spawning the shim", async () => {
			await expect(
				verifyToolBinary(
					bin,
					undefined,
					undefined,
					10_000,
					["--version"],
					fixture.packageName,
				),
			).resolves.toBe(true);
			expect(fs.existsSync(spawnMarker)).toBe(false);
		});

		it("verifies a pinned coordinate against the unpinned install dir", async () => {
			// `packageName` carries the pin npm was told to install; the directory
			// npm creates never does.
			await expect(
				verifyNpmPackageEntry(
					bin,
					`${fixture.packageName}@${String(fixture.manifest.version)}`,
				),
			).resolves.toBe(true);
		});

		it.each([
			[
				"the entry module is missing (the partial install this replaces the spawn to catch)",
				() => fs.rmSync(entryFile),
			],
			[
				"the entry module is a zero-byte stub",
				() => fs.truncateSync(entryFile, 0),
			],
			[
				"package.json declares no version",
				() =>
					fs.writeFileSync(
						path.join(packageDir, "package.json"),
						JSON.stringify({ ...fixture.manifest, version: "" }),
						"utf8",
					),
			],
			[
				"package.json names no entry for this shim",
				() =>
					fs.writeFileSync(
						path.join(packageDir, "package.json"),
						JSON.stringify({ ...fixture.manifest, bin: { other: "x.js" } }),
						"utf8",
					),
			],
			[
				"package.json is unreadable",
				() =>
					fs.writeFileSync(
						path.join(packageDir, "package.json"),
						"{ not json",
						"utf8",
					),
			],
			[
				"the package directory is gone but the shim survives",
				() => fs.rmSync(packageDir, { recursive: true, force: true }),
			],
			// R2-F1: the function derives the package directory FROM `binPath` and
			// used to never look at `binPath` itself, so the shim npm is supposed
			// to have written could be absent, empty or a directory and this still
			// answered `true`. That answer flows into `installNpmTool`, which then
			// records the install as SUCCEEDED — and `classifyInstallOutcome`
			// grades a non-"failed" outcome as `⚠ unavailable (succeeded)`, which
			// is exactly the re-hiding of the nightly row #2722 forbids.
			["the .bin shim was never written", () => fs.rmSync(bin)],
			["the .bin shim is a zero-byte stub", () => fs.truncateSync(bin, 0)],
			[
				"the .bin shim is a directory",
				() => {
					fs.rmSync(bin);
					fs.mkdirSync(bin);
				},
			],
			// R2-F5: `!stat.isFile()` was mutation-green without this row — every
			// other refusal reached `entry-missing` through the catch instead.
			[
				"the entry module is a directory, not a file",
				() => {
					fs.rmSync(entryFile);
					fs.mkdirSync(entryFile);
				},
			],
		])("refuses when %s", async (_label, breakIt) => {
			breakIt();
			await expect(
				verifyNpmPackageEntry(bin, fixture.packageName),
			).resolves.toBe(false);
			expect(fs.existsSync(spawnMarker)).toBe(false);
		});

		// lane: ubuntu (the authoritative Unit tests lane) and every other POSIX
		// dev box — `fs.symlinkSync` needs Developer Mode or an elevated shell on
		// Windows, so the symlink is the technique, not the subject. The subject
		// (a shim that resolves to nothing) is covered cross-platform by the
		// "never written" row above, which reaches the same `statSync` throw.
		it.skipIf(process.platform === "win32")(
			"refuses when the .bin shim dangles at a target that no longer exists",
			async () => {
				fs.rmSync(bin);
				fs.symlinkSync(path.join(packageDir, "GONE.js"), bin);
				expect(fs.existsSync(bin)).toBe(false); // dangling, by construction
				expect(fs.lstatSync(bin).isSymbolicLink()).toBe(true);
				await expect(
					verifyNpmPackageEntry(bin, fixture.packageName),
				).resolves.toBe(false);
			},
		);

		// R2-F5: the `bin`-key lookup folds case on purpose (a case-insensitive
		// filesystem can hand `path.basename` a different case than the manifest
		// key npm wrote the shim from). Without this row the fold is mutation-
		// green: every fixture above already matches exactly.
		// skipIf, never a bare early return (#2089 / test-authoring screen 2): a
		// bare `bin` STRING has no key to differ in case, so that fixture has no
		// subject here rather than a passing empty body.
		it.skipIf(typeof fixture.manifest.bin !== "object")(
			"matches a bin key whose case differs from the shim on disk",
			async () => {
				fs.writeFileSync(
					path.join(packageDir, "package.json"),
					JSON.stringify({
						...fixture.manifest,
						bin: {
							[fixture.shim.toUpperCase()]: `./${fixture.entryPath.split(path.sep).join("/")}`,
						},
					}),
					"utf8",
				);
				await expect(
					verifyNpmPackageEntry(bin, fixture.packageName),
				).resolves.toBe(true);
			},
		);
	},
);

describe("registry wiring (#2722)", () => {
	it("intelephense is the declared package-entry tool", () => {
		const intelephense = TOOLS.find((tool) => tool.id === "intelephense");
		expect(intelephense?.verification).toBe("package-entry");
		expect(packageEntryVerification(intelephense!)).toBe("intelephense");
	});

	// Prevents the recurrence this fix makes cheap: reaching for
	// `verification: "package-entry"` to silence ANY tool whose `--version`
	// probe went red. Spawning is the stronger check wherever it can return a
	// verdict, so the exemption stays a one-line, deliberate registry edit that
	// a reviewer sees, not a field that quietly spreads.
	it("leaves every other tool on the spawn probe", () => {
		const declared = TOOLS.filter(
			(tool) => packageEntryVerification(tool) !== undefined,
		).map((tool) => tool.id);
		expect(declared).toEqual(["intelephense"]);
	});
});
