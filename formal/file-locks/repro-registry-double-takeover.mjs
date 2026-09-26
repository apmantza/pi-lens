// Replays RegistryCrash.cfg's pre-#3476 counterexample against the real
// registry lock. Since #3476 there is no rename to hold; the interleaving is
// replayed in tests/clients/instance-registry-lock.test.ts.
// p1: a writer that died holding the lock (dead pid, fresh mtime).
// p3: this process. Its takeover judges p1's lock stale; its renameSync is
//     held until p2 has taken over the same lock and entered the critical section.
// p2: a child process that takes over and holds the lock for 1 s.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

// Run from the repository root after `npm run build`.
const root = process.cwd();
const lockModule = pathToFileURL(
	path.join(root, "clients/instance-registry-lock.js"),
).href;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tla-3447-"));
const target = path.join(dir, "instances.json");
const lock = `${target}.lock`;
const inCs = path.join(dir, "p2-in-cs");
const left = path.join(dir, "p2-left");
fs.writeFileSync(lock, "999999 0\n"); // p1 died holding it

const sleep = (ms) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const realRename = fs.renameSync;
let held = false;
fs.renameSync = (from, to) => {
	if (!held && from === lock) {
		held = true;
		// p2: a real process that takes over p1's lock and stays inside for 1 s.
		const child = `
import fs from "node:fs";
const { withInstanceRegistryLockSync } = await import(${JSON.stringify(lockModule)});
const result = withInstanceRegistryLockSync(${JSON.stringify(target)}, () => {
	fs.writeFileSync(${JSON.stringify(inCs)}, String(process.pid));
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
	fs.writeFileSync(${JSON.stringify(left)}, "");
	return "p2 ran";
});
console.log("p2:", result);
`;
		spawn(process.execPath, ["--input-type=module", "-e", child], {
			stdio: "inherit",
		});
		const until = Date.now() + 5000;
		while (!fs.existsSync(inCs) && Date.now() < until) sleep(5);
		console.log(
			"p3: p2 is in its critical section; lock now reads",
			JSON.stringify(fs.readFileSync(lock, "utf8").trim()),
			"(p2 pid)",
		);
	}
	return realRename(from, to);
};
syncBuiltinESMExports();

const { withInstanceRegistryLockSync } = await import(lockModule);
const result = withInstanceRegistryLockSync(target, () => {
	const both = fs.existsSync(inCs) && !fs.existsSync(left);
	console.log(
		`p3: in critical section (pid ${process.pid}); p2 still inside: ${both}`,
	);
	return both ? "MUTUAL EXCLUSION VIOLATED" : "exclusive";
});
console.log("p3:", result);
sleep(1200);
fs.rmSync(dir, { recursive: true, force: true });
