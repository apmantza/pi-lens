/**
 * #1609 layer a: every persisted-state write under `clients/` must go
 * through the shared atomic tmp+rename seam (`clients/atomic-write.ts`, #762)
 * — directly, or via the locked `commitDurableStore`/`commitDurableStoreAsync`
 * read-modify-write built on it — OR be a reviewed, reasoned exemption.
 *
 * The write-site inventory is DERIVED from the source at test-run time
 * (`tests/support/atomic-write-scan.ts`'s `scanRawWriteFiles`), not
 * hand-maintained: this test would have caught the #1217 hand-rolled-staging
 * regression and the installer-binary direct-writes this issue's sweep found
 * (bare-gzip/bare-binary/jar/launcher/shim installs — see the PR body) without
 * anyone updating a parallel list first.
 */

import { describe, expect, it } from "vitest";
import {
	EXEMPT_RAW_WRITE_FILES,
	findRawWriteSites,
	scanRawWriteFiles,
} from "../support/atomic-write-scan.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

describe("atomic-write sweep (#1609 layer a)", () => {
	it(
		"every raw filesystem-write site is either an obviously-scratch temp target or a reasoned exemption",
		() => {
			const scans = scanRawWriteFiles();
			// A site is cleared per SITE (its own target looks like a per-call temp
			// scratch file — `tmpArchive`, `os.tmpdir()`, …) or per FILE (the whole
			// file's raw-write surface is one reviewed, homogeneous shape — see
			// EXEMPT_RAW_WRITE_FILES). Deliberately NOT cleared by "this file
			// imports the atomic seam somewhere": a large multi-concern file (e.g.
			// installer/index.ts, which owns probe-cache's durable-store commit AND
			// several per-call scratch-archive writes) can satisfy that while still
			// having an unrelated raw write elsewhere — exactly what let the #1609
			// installer violations (bare-gzip/bare-binary/jar/launcher/shim writes
			// straight to their final path) go undetected before this sweep.
			const violations = scans
				.map((scan) => ({
					file: scan.file,
					sites:
						scan.file in EXEMPT_RAW_WRITE_FILES
							? []
							: scan.sites.filter((s) => !s.transientTarget),
				}))
				.filter((v) => v.sites.length > 0);

			if (violations.length > 0) {
				const detail = violations
					.map(
						(v) =>
							`  ${v.file}:\n${v.sites
								.map((s) => `    L${s.line}: ${s.snippet}`)
								.join("\n")}`,
					)
					.join("\n");
				expect.fail(
					`Found ${violations.length} file(s) with a raw filesystem write that ` +
						`neither targets an obviously-scratch temp path nor is listed in ` +
						`EXEMPT_RAW_WRITE_FILES with a reason ` +
						`(tests/support/atomic-write-scan.ts):\n${detail}\n\n` +
						`Either route the write through writeFileAtomic/writeFileAtomicAsync, ` +
						`or add a reasoned exemption if this is genuinely not crash-sensitive ` +
						`persisted state (e.g. a same-call scratch file or an append-only log ` +
						`whose readers already tolerate a torn tail).`,
				);
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it(
		"every exemption still names a real file with a raw write site (no stale entries)",
		() => {
			const scans = scanRawWriteFiles();
			const scannedFiles = new Set(scans.map((s) => s.file));
			const stale = Object.keys(EXEMPT_RAW_WRITE_FILES).filter(
				(file) => !scannedFiles.has(file),
			);
			expect(stale).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// #1609 review F2/F3: the reviewer smuggled two shapes past the scanner
	// itself. These pin the scanner's own correctness against synthetic
	// source, independent of what's currently in clients/ — a regression here
	// would silently reopen the smuggle route even if no real file happens to
	// hit it today.
	describe("scanner smuggle probes (#1609 review F2/F3)", () => {
		it("F2: a tmp-prefixed DATA argument does not clear a non-scratch TARGET", () => {
			// registryPath() is the real target; tmpData only LOOKS temp-shaped
			// because it shares the line — judging the whole line (the pre-fix
			// behavior) would wrongly clear this as scratch.
			const source = "fs.writeFileSync(registryPath(), tmpData);\n";
			const sites = findRawWriteSites("smuggle-f2.ts", source);
			expect(sites).toHaveLength(1);
			expect(sites[0].transientTarget).toBe(false);
		});

		it("F2 control: a genuinely tmp-named TARGET still clears", () => {
			const source = "fs.writeFileSync(tmpArchive, assetBuffer);\n";
			const sites = findRawWriteSites("smuggle-f2-control.ts", source);
			expect(sites).toHaveLength(1);
			expect(sites[0].transientTarget).toBe(true);
		});

		it("F3: a write reached through a differently-named fs import binding is still found", () => {
			const source = [
				'import * as nodeFs from "node:fs";',
				"",
				"function persist(p: string, d: string) {",
				"\tnodeFs.writeFileSync(p, d);",
				"}",
				"",
			].join("\n");
			const sites = findRawWriteSites("smuggle-f3.ts", source);
			expect(sites).toHaveLength(1);
			// The target is a plain parameter, not a scratch path — still a
			// violation unless the file is exempted.
			expect(sites[0].transientTarget).toBe(false);
		});

		it("F3: the fs/fsp fallback still matches when a file imports neither name", () => {
			const source = "fsp.writeFile(destPath, buf);\n";
			const sites = findRawWriteSites("smuggle-f3-fallback.ts", source);
			expect(sites).toHaveLength(1);
		});
	});
});
