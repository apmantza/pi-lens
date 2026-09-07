export interface MemorySample {
	totalMb: number;
	availableMb: number;
	source: "meminfo" | "os";
}

export declare function readMemory(meminfoPath?: string): MemorySample;

export declare function parseMeminfo(text: string): {
	totalMb: number;
	availableMb: number;
	source: "meminfo";
};

export declare function shouldPrint(
	sample: { availableMb: number },
	state: {
		lastPrintedMb: number | null;
		thresholdMb: number;
		stepMb: number;
	},
): boolean;

export interface MemoryWatchState {
	totalMb: number;
	lowWaterMb: number;
	lowWaterAt: string | null;
	/** The pid the wrapper was watching, to match against the kernel's victim. */
	childPid?: number | null;
	/** Sampling period, so the verdict can state what its cadence cannot see. */
	intervalMs?: number | null;
}

export declare const EXHAUSTION_AVAILABLE_FLOOR_MB: number;

export declare function formatVerdict(
	exit: { code: number | null; signal: string | null },
	watch: MemoryWatchState,
): string;
