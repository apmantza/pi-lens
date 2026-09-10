/**
 * #2874: `getProjectDataDir`'s slug folded separators to `-`, so two roots
 * differing only in separator-vs-hyphen placement (`src/pi-lens` vs
 * `src/pi/lens`) shared one data directory. The slug now appends an 8-hex
 * SHA-256 of the canonical absolute root, and a pre-hash directory is
 * renamed once on first use.
 *
 * Probe hygiene: scratch roots live under `os.tmpdir()` (outside the
 * worktree); `PILENS_DATA_DIR`/`PI_LENS_HOME` are pointed at per-test temp
 * dirs and restored afterwards. The real HOME is never touched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	recordDegradationOnce,
	resetDegradationLedger,
	getDegradationSummary,
} from "../../clients/degradation-ledger.js";
import {
	drainProjectDataDirMigrations,
	getProjectDataDir,
	_resetProjectDataDirMemoForTests,
} from "../../clients/file-utils.js";

const savedDataDir = process.env.PILENS_DATA_DIR;
const savedHome = process.env.PI_LENS_HOME;

function isolateDataDir(): string {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-datadir-base-"));
	process.env.PILENS_DATA_DIR = base;
	process.env.PI_LENS_HOME = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-datadir-home-"),
	);
	return base;
}

afterEach(() => {
	if (savedDataDir === undefined) {
		delete process.env.PILENS_DATA_DIR;
	} else {
		process.env.PILENS_DATA_DIR = savedDataDir;
	}
	if (savedHome === undefined) {
		delete process.env.PI_LENS_HOME;
	} else {
		process.env.PI_LENS_HOME = savedHome;
	}
	drainProjectDataDirMigrations();
	resetDegradationLedger();
});

describe("project data-dir slug (#2874)", () => {
	it("gives separator/hyphen twins distinct directories", () => {
		const base = isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-twins-"));
		const rootA = path.join(scratch, "src", "pi-lens");
		const rootB = path.join(scratch, "src", "pi", "lens");
		fs.mkdirSync(rootA, { recursive: true });
		fs.mkdirSync(rootB, { recursive: true });

		const dirA = getProjectDataDir(rootA);
		const dirB = getProjectDataDir(rootB);

		expect(dirA.startsWith(base)).toBe(true);
		expect(dirB.startsWith(base)).toBe(true);
		expect(dirB).not.toBe(dirA);
		// No state leak across the twins: a file in A's directory is
		// invisible from B's.
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, "marker.json"), "{}");
		expect(fs.existsSync(path.join(dirB, "marker.json"))).toBe(false);
	});

	it("returns the same directory for the same root across calls", () => {
		isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-stable-"));
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const first = getProjectDataDir(root);
		const second = getProjectDataDir(root);
		const trailingSlash = getProjectDataDir(`${root}${path.sep}`);

		expect(second).toBe(first);
		expect(trailingSlash).toBe(first);
	});

	it("migrates an old-slug directory by rename and preserves its contents", () => {
		const base = isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-migrate-"));
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const dir = getProjectDataDir(root);
		// The pre-#2874 name is the new basename without its trailing hash.
		const oldDir = path.join(
			base,
			path.basename(dir).replace(/-[0-9a-f]{8}$/, ""),
		);
		expect(oldDir).not.toBe(dir);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "marker.json"), '{"kept":true}');
		_resetProjectDataDirMemoForTests();

		const settled = getProjectDataDir(root);

		expect(settled).toBe(dir);
		expect(fs.existsSync(oldDir)).toBe(false);
		expect(fs.readFileSync(path.join(settled, "marker.json"), "utf8")).toBe(
			'{"kept":true}',
		);
	});

	it("prefers the new directory when both old and new exist", () => {
		const base = isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-both-"));
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const dir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(dir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "old.txt"), "old");
		fs.writeFileSync(path.join(dir, "new.txt"), "new");
		_resetProjectDataDirMemoForTests();

		const settled = getProjectDataDir(root);

		expect(settled).toBe(dir);
		expect(fs.existsSync(path.join(settled, "new.txt"))).toBe(true);
		expect(fs.existsSync(oldDir)).toBe(true);
	});

	it("records data_dir_migrated once for a migration", () => {
		const base = isolateDataDir();
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-record-"));
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const dir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(dir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "marker.json"), "{}");
		_resetProjectDataDirMemoForTests();

		getProjectDataDir(root);
		const migrations = drainProjectDataDirMigrations();
		expect(migrations.length).toBe(1);
		expect(migrations[0]?.renamed).toBe(true);
		for (const migration of migrations) {
			recordDegradationOnce({
				kind: "data_dir_migrated",
				subject: path.basename(migration.to),
				reason: migration.renamed
					? `renamed ${path.basename(migration.from)}`
					: `old and new both present; using ${path.basename(migration.to)}`,
			});
		}

		const summary = getDegradationSummary();
		const row = summary.find((entry) => entry.kind === "data_dir_migrated");
		expect(row?.count).toBe(1);

		// A second drain observes nothing further: one migration, one record.
		expect(drainProjectDataDirMigrations().length).toBe(0);
		getProjectDataDir(root);
		expect(drainProjectDataDirMigrations().length).toBe(0);
	});
});
