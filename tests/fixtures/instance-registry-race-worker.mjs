import fs from "node:fs";

// argv: <home> <barrier> <root> [stallMs] [release]
// stallMs > 0 (#3447): the first read of instances.json -- which happens
// INSIDE the registry lock -- parks that long, standing in for a lock holder
// the scheduler descheduled on a loaded CI runner.
// release (#5733): stay alive after the report until this file exists. An
// exiting process removes its own row (the registry's exit hook, #5699), so
// only a live writer's row can show whether the lock lost an update.
const [home, barrier, root, stallArg, release] = process.argv.slice(2);
const stallMs = Number(stallArg) || 0;
if (stallMs > 0) {
	const readFile = fs.promises.readFile;
	let stalled = false;
	fs.promises.readFile = async (file, ...rest) => {
		if (!stalled && String(file).endsWith("instances.json")) {
			stalled = true;
			await new Promise((resolve) => setTimeout(resolve, stallMs));
		}
		return readFile(file, ...rest);
	};
}
while (!fs.existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 1));
const { registerInstance } = await import("../../clients/instance-registry.js");
const { getDegradationSummary } = await import("../../clients/degradation-ledger.js");
await registerInstance(root);
// A bounded lock wait that ran out drops this registration by design and
// records it; the parent needs both facts to tell that apart from a lost
// update under the lock.
const lockTimedOut = getDegradationSummary().some(
	(group) => group.kind === "instance-registry-lock-timeout",
);
process.stdout.write(`${JSON.stringify({ home, pid: process.pid, lockTimedOut })}\n`);
// Bounded so a parent that died before releasing leaves no writer behind.
const holdUntil = Date.now() + 60_000;
while (release && !fs.existsSync(release) && Date.now() < holdUntil)
	await new Promise((resolve) => setTimeout(resolve, 5));
