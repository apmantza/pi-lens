/**
 * Registered-or-fail sweep for the freshness kernel (#1739).
 *
 * Every mtime-vs-reference-timestamp comparison in `clients/` must go
 * through the kernel's comparator. A NEW out-of-kernel comparison fails
 * here until it is either migrated or added to EXEMPT with a reason - the
 * same ratchet shape as run-outcome-ratchet and the smoke-fixture guard.
 *
 * The needle matches the freshness SHAPE (`.mtimeMs` compared with > or >=
 * against an identifier expression), not just the words: age-based checks
 * (`Date.now() - mtime > TTL`) and max-selection comparisons
 * (`mtime > best.mtimeMs`) are structurally different and listed as
 * exemptions with reasons where they coexist in a file.
 *
 * KNOWN MISSED SHAPES (accepted floor - the needle cannot see them):
 * destructured comparisons without a dot (for (const { mtimeMs } of mtimes)
 * if (mtimeMs > ref) - exactly master's detectDrift import-loop shape),
 * reversed operand order (ref + TOL < x.mtimeMs), and aliased locals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toPosix } from "../../clients/path-utils.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLIENTS_DIR = path.join(REPO_ROOT, "clients");
const KERNEL_FILE = "freshness.ts";

/** Files whose mtime comparisons are NOT reference-timestamp freshness. */
const EXEMPT: Record<string, string> = {
	"bounded-pid-file-lock.ts":
		"age-based TTL staleness of a lock file (Date.now() - mtime), not comparison against a recorded scan/record timestamp",
	"installer/index.ts":
		"age-based maxAge expiry of a cached install probe, same TTL-not-freshness shape",
	"lsp/lombok.ts":
		"max-selection among candidates (find newest), no reference timestamp",
	"read-guard.ts":
		"session-start membership gate (mtime >= sessionStartMs) - different semantic than post-record drift",
};

describe("freshness kernel coverage (#1739)", () => {
	it("kernel module exists", () => {
		expect(fs.existsSync(path.join(CLIENTS_DIR, KERNEL_FILE))).toBe(true);
	});

	it("every mtime-comparison site uses the kernel or carries an exemption", () => {
		const violations: string[] = [];
		const walkDir = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walkDir(full);
					continue;
				}
				if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts"))
					continue;
				// Relative to CLIENTS_DIR (not REPO_ROOT): keys in EXEMPT and
				// the kernel-skip are clients/-relative by contract.
				const rel = toPosix(path.relative(CLIENTS_DIR, full));
				if (rel === KERNEL_FILE) continue;
				const source = fs.readFileSync(full, "utf8");
				// Freshness-shaped needle: `.mtimeMs > identifier` / `>=` where
				// the right side is not obviously `best.`-style selection.
				const hits = [
					...source.matchAll(/\.mtimeMs\s*(?:>|>=)\s*(?!best\b)[A-Za-z_$]/g),
				];
				if (hits.length === 0) continue;
				const base = path.basename(rel);
				if (EXEMPT[rel] || EXEMPT[base]) continue;
				violations.push(`${rel} (${hits.length} comparison[s])`);
			}
		};
		walkDir(CLIENTS_DIR);
		expect(
			violations,
			`out-of-kernel mtime comparisons found - migrate to clients/freshness.ts freshnessFromMtime(), or add an EXEMPT entry with a reason: ${violations.join(", ")}`,
		).toEqual([]);
	});

	it("exemptions still exist on disk (no phantom rows)", () => {
		const all: string[] = [];
		const walkAll = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walkAll(full);
				else if (entry.name.endsWith(".ts")) all.push(entry.name);
			}
		};
		walkAll(CLIENTS_DIR);
		const names = new Set(all);
		const phantom = Object.keys(EXEMPT).filter(
			(name) => !names.has(path.basename(name)),
		);
		expect(phantom, "exempt files must exist").toEqual([]);
	});
});
