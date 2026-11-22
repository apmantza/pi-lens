// #5703: use the production safeSpawnAsync seam from a real pi extension.
import { safeSpawnAsync } from "../../../clients/safe-spawn.js";
import "../../../clients/instance-registry.js";
import { provideOwnedChildLedger } from "../../../clients/held-children.js";

export default function runnerHostExit5703(pi) {
	if (process.env.REAL_HARNESS_REJECT_LEDGER) {
		provideOwnedChildLedger({
			write: async () => {
				throw new Error("REGISTRY_WRITE_FAILED");
			},
			remove: async () => {
				throw new Error("REGISTRY_REMOVE_FAILED");
			},
		});
	}
	pi.registerCommand("real-harness-runner-5703", {
		description: "Start a stubborn safeSpawnAsync child",
		handler: async () => {
			const pidFile = process.env.REAL_HARNESS_RUNNER_PID_FILE;
			const ownerFile = process.env.REAL_HARNESS_RUNNER_OWNER_FILE;
			if (!pidFile) throw new Error("missing runner pid file");
			const script =
				'const fs=require("node:fs");fs.writeFileSync(process.argv[1],String(process.pid));fs.writeFileSync(process.argv[2],process.env.PI_LENS_OWNER||"");if(process.env.REAL_HARNESS_RUNNER_EXIT) setTimeout(()=>process.exit(0),50); else setInterval(()=>{},1000);';
			if (!ownerFile) throw new Error("missing runner owner file");
			void safeSpawnAsync(process.execPath, ["-e", script, pidFile, ownerFile], {
				timeout: 600_000,
				resourceLabel: "real-harness-runner-5703",
			});
		},
	});
}
