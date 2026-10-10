// Fixture for tests/support/vitest-setup-registry-teardown.test.ts (#3617).
// Queues a root removal that must wait about 2 s for a live peer's lock
// lease, then ends the file. Only the shared setup's afterAll can keep the
// worker alive until it lands; the fork is SIGTERM'd right after.
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	deregisterInstanceRoot,
	registerInstance,
	registerInstanceRoot,
} from "../../../clients/instance-registry.js";

const root = process.env.REGISTRY_TEARDOWN_ROOT;
if (!root) throw new Error("REGISTRY_TEARDOWN_ROOT is not set");
const home = path.join(root, "lease-wait");
fs.mkdirSync(home, { recursive: true });
process.env.PI_LENS_HOME = home;

it("queues a root removal behind a peer's lock lease, then the file ends", async () => {
	await registerInstance(path.join(root, "primary"));
	await registerInstanceRoot(path.join(root, "secondary"), "holder-1");
	// A live peer (this worker's parent) holds the lock, 3 s into its 5 s
	// lease: the removal waits about 2 s, then takes the aged-out lock over.
	const lock = path.join(home, "instances.json.lock");
	fs.writeFileSync(lock, `${process.ppid} ${Date.now()}\n`);
	const agedSeconds = (Date.now() - 3_000) / 1000;
	fs.utimesSync(lock, agedSeconds, agedSeconds);
	void deregisterInstanceRoot(path.join(root, "secondary"), "holder-1");
	expect(fs.existsSync(lock)).toBe(true);
});
