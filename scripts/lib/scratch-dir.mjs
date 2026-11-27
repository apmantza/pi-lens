import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SCRATCH_DIR_ROOT = path.join(os.tmpdir(), "pi-lens-scratch");
export const SCRATCH_OWNER_FILE = "owner.pid";
const DEFAULT_SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;
/**
 * `maxAgeMs` for a caller whose rule is the PREFIX alone — "this is mine, and I
 * am done with it" — with no age condition at all.
 *
 * Not `0`: the age gate below is `Date.now() - mtimeMs < maxAgeMs`, so `0` means
 * "age >= 0" and SKIPS an entry whose mtime is in the future. That is not a
 * hypothetical — a directory created microseconds before the sweep can carry a
 * filesystem timestamp later than the process clock, and it redded CI on
 * 2026-09-16 (run 35072411511, tmp-fixture-hygiene). Every finite age is
 * >= -Infinity, so this value can never skip.
 */
export const SWEEP_ANY_AGE = Number.NEGATIVE_INFINITY;

export function ownerAlive(entryDir) {
	let pidText;
	try {
		pidText = fs.readFileSync(path.join(entryDir, SCRATCH_OWNER_FILE), "utf8");
	} catch {
		return undefined;
	}
	// The whole marker must be a pid: parseInt read "123junk" as 123 and a
	// sweep deleted a foreign directory on it (#5468 r3 F5).
	const text = pidText.trim();
	if (!/^\d+$/.test(text)) return undefined;
	const pid = Number(text);
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code !== "ESRCH";
	}
}

/**
 * Create a named scratch directory and record the process that owns it.
 *
 * The directory appears under its prefix only with owner.pid already inside:
 * it is built under a `.claim-` name no sweep matches and renamed into place.
 * A concurrent sweep that saw the prefixed name before the marker took a live
 * allocation for an orphan and deleted it (#5468 r3 F4).
 */
export function claimScratchDir(root, prefix) {
	fs.mkdirSync(root, { recursive: true });
	const staging = fs.mkdtempSync(
		path.join(root, `.claim-${prefix}-${process.pid}-${Date.now()}-`),
	);
	fs.writeFileSync(path.join(staging, SCRATCH_OWNER_FILE), String(process.pid));
	const dir = path.join(root, path.basename(staging).slice(".claim-".length));
	fs.renameSync(staging, dir);
	return dir;
}

/** Remove only dead or old orphaned scratch directories for one prefix. */
export function sweepScratchDirs(
	root,
	prefix,
	{ maxAgeMs = DEFAULT_SCRATCH_MAX_AGE_MS } = {},
) {
	let entries;
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	let swept = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
		const entryDir = path.join(root, entry.name);
		const alive = ownerAlive(entryDir);
		if (alive === true) continue;
		if (alive === undefined) {
			let mtimeMs;
			try {
				mtimeMs = fs.statSync(entryDir).mtimeMs;
			} catch {
				continue;
			}
			if (Date.now() - mtimeMs < maxAgeMs) continue;
		}
		try {
			fs.rmSync(entryDir, { recursive: true, force: true });
			swept++;
		} catch {
			// Leave permission- or platform-locked entries for a later sweep.
		}
	}
	return swept;
}
