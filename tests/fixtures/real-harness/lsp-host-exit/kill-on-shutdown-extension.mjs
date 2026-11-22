// #5699: the host dies after pi-lens's session_shutdown handler ran and before
// the process reaches its `exit` listeners, the way a pi killed during its
// shutdown drain dies. pi runs extension handlers in load order and pi-lens
// loads first, so its whole synchronous teardown has run when this fires.
export default function killOnShutdown(pi) {
	pi.on("session_shutdown", () => {
		process.kill(process.pid, "SIGKILL");
	});
}
