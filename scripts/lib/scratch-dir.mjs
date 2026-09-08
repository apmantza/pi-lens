import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SCRATCH_DIR_ROOT = path.join(os.tmpdir(), "pi-lens-scratch");
export const SCRATCH_OWNER_FILE = "owner.pid";
export const DEFAULT_SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;

function ownerAlive(entryDir) {
	let pidText;
	try {
		pidText = fs.readFileSync(path.join(entryDir, SCRATCH_OWNER_FILE), "utf8");
	} catch {
		return undefined;
	}
	const pid = Number.parseInt(pidText.trim(), 10);
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code !== "ESRCH";
	}
}

/** Create a named scratch directory and record the process that owns it. */
export function claimScratchDir(root, prefix) {
	fs.mkdirSync(root, { recursive: true });
	const dir = fs.mkdtempSync(
		path.join(root, `${prefix}-${process.pid}-${Date.now()}-`),
	);
	fs.writeFileSync(path.join(dir, SCRATCH_OWNER_FILE), String(process.pid));
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
