/** Read-only rollup facade. The publish seam owns the private NDJSON writer. */
export {
	type BusEventLogEntry,
	getBusEventRollupCounts,
	resetBusEventRollupCounts,
	emitBusEventRollupAtSessionEnd,
} from "./live-bus-emitter.js";
