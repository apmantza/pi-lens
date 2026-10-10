// Provenance of tests/fixtures/startup-scan/released-4.4.0 (#4126 round 3).
// Writes two persisted startup-scan verdicts (`too-many-source-files` and
// `too-many-entries`) through the built `clients/startup-scan.js` and
// `clients/project-snapshot.js` of the tree at <root>, and copies each gz body,
// meta sidecar and source JSON to <out>/<reason>/. The committed corpus came
// from `clients/startup-scan.ts` and `clients/project-snapshot.ts` at
// origin/master 551e04e39, byte-identical to the v4.4.0 release (28d4e92a8):
// the last writer that stored no bound on a size verdict.
//
// The walk runs over a real three-file project under PILENS_DATA_DIR; the
// three path fields of each verdict and the snapshot's projectRoot are then
// set to /fixture/project so the corpus carries no host path. The field SET
// is the writer's own.
//
//   HOME=$H/home PI_LENS_HOME=$H/lens PILENS_DATA_DIR=$H/data \
//     PI_LENS_SNAPSHOT_PERSIST_SYNC=1 node generate-released-writer.mjs <root> <out>
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const out = process.argv[3];
const dataDir = process.env.PILENS_DATA_DIR;
const neutralRoot = "/fixture/project";

const scan = await import(
	pathToFileURL(path.join(root, "clients/startup-scan.js")).href
);
const snap = await import(
	pathToFileURL(path.join(root, "clients/project-snapshot.js")).href
);
const { RuntimeCoordinator } = await import(
	pathToFileURL(path.join(root, "clients/runtime-coordinator.js")).href
);

const homeDir = path.join(dataDir, "unrelated-home");
fs.mkdirSync(homeDir, { recursive: true });

const cases = [
	{ reason: "too-many-source-files", options: { maxSourceFiles: 1 } },
	{ reason: "too-many-entries", options: { maxScanEntries: 2 } },
];

for (const { reason, options } of cases) {
	const cwd = path.join(dataDir, `proj-${reason}`);
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	for (let i = 0; i < 3; i++) {
		fs.writeFileSync(path.join(cwd, `file-${i}.ts`), "export const v = 1;\n");
	}
	const verdict = scan.resolveStartupScanContext(cwd, { ...options, homeDir });
	if (verdict.reason !== reason) {
		throw new Error(`expected ${reason}, got ${verdict.reason}`);
	}
	const neutral = {
		...verdict,
		cwd: neutralRoot,
		scanRoot: neutralRoot,
		projectRoot: neutralRoot,
	};
	const runtime = new RuntimeCoordinator();
	runtime.seedProjectSequence(0);
	const snapshot = snap.buildProjectSnapshotFromRuntime({
		cwd: neutralRoot,
		runtime,
		startupScan: neutral,
	});
	snap.saveProjectSnapshot(cwd, snapshot);
	for (let i = 0; i < 500; i++) {
		const st = snap.getProjectSnapshotPersistStateForTests(cwd);
		if (!st.active && !st.queued) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	const cacheDir = path.dirname(snap.getProjectSnapshotPath(cwd));
	const dest = path.join(out, reason);
	fs.mkdirSync(dest, { recursive: true });
	for (const f of fs.readdirSync(cacheDir)) {
		if (f === "project-snapshot.json.gz" || f === "project-snapshot.meta.json")
			fs.copyFileSync(path.join(cacheDir, f), path.join(dest, f));
	}
	fs.writeFileSync(path.join(dest, "snapshot.json"), JSON.stringify(snapshot));
	console.log(reason, JSON.stringify(neutral));
}
process.exit(0);
