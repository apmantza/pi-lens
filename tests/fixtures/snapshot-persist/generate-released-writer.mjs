// Provenance of tests/fixtures/snapshot-persist/released-4.3.0 (#3789).
// Writes a small snapshot through the built `clients/project-snapshot.js` of
// the tree at <root> and copies the resulting gz body, meta sidecar and the
// source JSON to <out>. The committed corpus came from 846fe4446 (4.3.0, before
// the byte-transfer change), once with the worker writer and once with
// PI_LENS_SNAPSHOT_PERSIST_SYNC=1; the two gz bodies were byte-identical.
//
//   HOME=$H/home PI_LENS_HOME=$H/lens PILENS_DATA_DIR=$H/data \
//     node generate-released-writer.mjs <root> <out>
//
// Needs scripts/bench-snapshot-persist.mjs only for its deterministic builder.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const out = process.argv[3];
const { buildSyntheticSnapshot } = await import(pathToFileURL(path.join(root, "scripts/bench-snapshot-persist.mjs")).href);
const snap = await import(pathToFileURL(path.join(root, "clients/project-snapshot.js")).href);
const cwd = path.join(process.env.PILENS_DATA_DIR, "proj");
fs.mkdirSync(cwd, { recursive: true });
const s = buildSyntheticSnapshot(6, "/fixture/project");
s.files["/fixture/project/src/日本語/é \"quoted\" {brace}.ts"] = { path: "/fixture/project/src/日本語/é \"quoted\" {brace}.ts", mtimeMs: 1, size: 2, lastSeq: 3 };
s.symbols["/fixture/project/src/日本語/é \"quoted\" {brace}.ts"] = [{ name: "généré ", kind: "function", filePath: "/fixture/project/src/日本語/é \"quoted\" {brace}.ts", startLine: 1, endLine: 2 }];
s.wordIndex.files = s.wordIndex.files.slice(0, 3);
s.wordIndex.postings = s.wordIndex.postings.slice(0, 20);
s.wordIndex.docLengths = s.wordIndex.docLengths.slice(0, 3);
s.wordIndex.fileMtimes = s.wordIndex.fileMtimes.slice(0, 3);
s.wordIndex.fileSizes = s.wordIndex.fileSizes.slice(0, 3);
s.wordIndex.forward = s.wordIndex.forward.slice(0, 3).map(([i, p]) => [i, p.slice(0, 4)]);
s.wordIndex.indexedFileCount = 3;
s.seq = 7;
snap.saveProjectSnapshot(cwd, s);
for (let i = 0; i < 500; i++) { const st = snap.getProjectSnapshotPersistStateForTests(cwd); if (!st.active && !st.queued) break; await new Promise(r => setTimeout(r, 20)); }
const cacheDir = path.dirname(snap.getProjectSnapshotPath(cwd));
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(cacheDir)) {
  if (f === "project-snapshot.json.gz" || f === "project-snapshot.meta.json") fs.copyFileSync(path.join(cacheDir, f), path.join(out, f));
}
fs.writeFileSync(path.join(out, "snapshot.json"), JSON.stringify(s));
process.exit(0);
