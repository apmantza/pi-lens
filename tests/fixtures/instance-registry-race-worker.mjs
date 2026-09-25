import fs from "node:fs";

// argv: <home> <barrier> <root> [stallMs]
// stallMs > 0 (#3447): the first read of instances.json -- which happens
// INSIDE the registry lock -- parks that long, standing in for a lock holder
// the scheduler descheduled on a loaded CI runner.
const [home, barrier, root, stallArg] = process.argv.slice(2);
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
