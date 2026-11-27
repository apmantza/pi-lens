// #5733 r4 F2: the host dies of an uncaught exception, the way a pi whose
// extension throws from a timer dies. The throw leaves the command's handler
// first, so nothing between it and the process catches it; in RPC mode pi
// installs no uncaughtException handler, and Node exits with code 1 after its
// `exit` listeners run.
export default function crashOnCommand(pi) {
	pi.registerCommand("real-harness-crash", {
		description: "Throw an uncaught exception from a timer",
		handler: async () => {
			setTimeout(() => {
				throw new Error("real-harness crash fixture");
			}, 0);
		},
	});
}
