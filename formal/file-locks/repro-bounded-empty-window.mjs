// Replays BoundedNoFault.cfg against acquireBoundedPidFileLock (the lock behind
// commitDurableStore). A, a child process, opens the lock with "wx" and is
// descheduled for 400 ms before it writes its token (the delay stands in for
// the scheduler; the lock's logic is unchanged). B, this process, contends in
// that window, reads the empty file as a dead owner, and unlinks it.
// Run from the repository root after `npm run build`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const mod = pathToFileURL(
	path.join(process.cwd(), "clients/bounded-pid-file-lock.js"),
).href;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-window-"));
const lock = path.join(dir, "store.json.lock");
const aIn = path.join(dir, "a-in");
const aOut = path.join(dir, "a-out");
const child = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const real = fs.writeFileSync;
fs.writeFileSync = (f, ...rest) => { if (typeof f === "number") sleep(400); return real(f, ...rest); };
syncBuiltinESMExports();
const { acquireBoundedPidFileLock } = await import(${JSON.stringify(mod)});
const release = acquireBoundedPidFileLock(${JSON.stringify(lock)}, { waitMs: 3000, retryMs: 5, timeoutMessage: "A timed out" });
real(${JSON.stringify(aIn)}, "");
sleep(800);
real(${JSON.stringify(aOut)}, "");
release();
`;
const a = spawn(process.execPath, ["--input-type=module", "-e", child], {
	stdio: "inherit",
});
const sleep = (ms) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const until = Date.now() + 5000;
while (!fs.existsSync(lock) && Date.now() < until) sleep(1);
console.log(
	"B: A's lock exists, content:",
	JSON.stringify(fs.readFileSync(lock, "utf8")),
);
const { acquireBoundedPidFileLock } = await import(mod);
const release = acquireBoundedPidFileLock(lock, {
	waitMs: 3000,
	retryMs: 5,
	timeoutMessage: "B timed out",
});
console.log("B: acquired");
let overlap = false;
const end = Date.now() + 1200;
while (Date.now() < end) {
	if (fs.existsSync(aIn) && !fs.existsSync(aOut)) overlap = true;
	sleep(10);
}
release();
console.log(
	overlap
		? "B: A entered while B held the lock: MUTUAL EXCLUSION VIOLATED"
		: "B: exclusive",
);
a.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
