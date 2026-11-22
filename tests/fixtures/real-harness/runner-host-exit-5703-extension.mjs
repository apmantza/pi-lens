// #5703: use the production safeSpawnAsync seam from a real pi extension.
import { safeSpawnAsync } from "../../../clients/safe-spawn.js";
import "../../../clients/instance-registry.js";
import { provideOwnedChildLedger } from "../../../clients/held-children.js";

let commandCount = 0;

export default function runnerHostExit5703(pi) {
	pi.registerCommand("real-harness-runner-5703", {
		description: "Start a stubborn safeSpawnAsync child",
		handler: async () => {
			commandCount += 1;
			if (
				process.env.REAL_HARNESS_REJECT_AFTER_FIRST &&
				commandCount > 1
			) {
				provideOwnedChildLedger({
					write: async () => {
						throw new Error("REGISTRY_WRITE_FAILED");
					},
					remove: async () => {
						throw new Error("REGISTRY_REMOVE_FAILED");
					},
				});
			}
			const pidFile = process.env.REAL_HARNESS_RUNNER_PID_FILE;
			const ownerFile = process.env.REAL_HARNESS_RUNNER_OWNER_FILE;
			if (!pidFile) throw new Error("missing runner pid file");
			// The runner exits once the release file exists, so the test decides
			// when the child exits; without a release file it runs until killed.
			const script =
				'const fs=require("node:fs");fs.writeFileSync(process.argv[1],String(process.pid));fs.writeFileSync(process.argv[2],process.env.PI_LENS_OWNER||"");const release=process.env.REAL_HARNESS_RUNNER_RELEASE_FILE;setInterval(()=>{if(release&&fs.existsSync(release))process.exit(0)},20);';
			if (!ownerFile) throw new Error("missing runner owner file");
			void safeSpawnAsync(process.execPath, ["-e", script, pidFile, ownerFile], {
				timeout: 600_000,
				resourceLabel: "real-harness-runner-5703",
			});
		},
	});
}
