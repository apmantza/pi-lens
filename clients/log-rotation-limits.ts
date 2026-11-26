/**
 * The log rotation threshold, in its own leaf (#5702).
 *
 * This module deliberately imports NOTHING: every `*-logger.ts` module reads
 * this value at module load, and those modules are imported from everywhere —
 * including by `clients/log-cleanup.ts`'s own graph (its retention sweep
 * reaches `file-utils.ts`, `mcp/ipc.ts` and `session-state-store.ts`, whose
 * graphs reach the loggers back). Keeping the threshold here breaks the
 * `loggers -> log-cleanup -> owners -> loggers` cycle at its thinnest edge,
 * the same shape `clients/bounded-cache.ts` and the other declared leaves
 * exist for (#2504): a heavyweight importer reaches a small shared primitive
 * without dragging the primitive's owner's graph along.
 */

export const UNLIMITED = Number.POSITIVE_INFINITY;

export interface LimitReading {
	/** The effective limit; `UNLIMITED` when the variable says so. */
	value: number;
	/** Set when the variable held something unusable and the default applied. */
	invalid?: string;
}

/**
 * Read a numeric limit from the environment. Unset or empty is the default;
 * `0` (however many zeros), `off` or `unlimited` is no limit; a positive
 * integer is itself. Anything else, including an integer too long to be
 * finite, falls back to the default and says so in `invalid`, so the caller
 * can report it instead of silently running with a number the user did not
 * write.
 */
export function readLimitFromEnv(
	name: string,
	defaultValue: number,
): LimitReading {
	const raw = process.env[name]?.trim();
	if (raw === undefined || raw === "") return { value: defaultValue };
	const word = raw.toLowerCase();
	if (word === "off" || word === "unlimited") return { value: UNLIMITED };
	if (/^\d+$/.test(raw)) {
		const parsed = Number.parseInt(raw, 10);
		// A 400-digit integer parses to Infinity: unusable, not "no limit".
		if (Number.isFinite(parsed)) {
			// `000` is zero too: every spelling of zero means no limit.
			return { value: parsed === 0 ? UNLIMITED : parsed };
		}
	}
	return { value: defaultValue, invalid: `${name}=${raw}` };
}

/** Every environment variable that bounds a log's age or size, with its default. */
export const LOG_LIMIT_ENVS = {
	retentionDays: { name: "PI_LENS_LOG_RETENTION_DAYS", default: 7 },
	maxSizeMB: { name: "PI_LENS_MAX_LOG_SIZE_MB", default: 10 },
	readGuardMaxBytes: { name: "PI_LENS_READ_GUARD_MAX_BYTES", default: 1048576 },
	actionableWarningsMaxBytes: {
		name: "PI_LENS_AW_LOG_MAX_BYTES",
		default: 1048576,
	},
	astGrepMaxBytes: {
		name: "PI_LENS_AST_GREP_LOG_MAX_BYTES",
		default: 1048576,
	},
	dispositionMaxBytes: {
		name: "PI_LENS_DISPOSITION_LOG_MAX_BYTES",
		default: 1048576,
	},
	deadCodeMaxBytes: {
		name: "PI_LENS_DEAD_CODE_LOG_MAX_BYTES",
		default: 1048576,
	},
} as const;

/** The effective value of one log limit; `UNLIMITED` when the variable says so. */
export function getLogLimit(key: keyof typeof LOG_LIMIT_ENVS): number {
	const { name, default: defaultValue } = LOG_LIMIT_ENVS[key];
	return readLimitFromEnv(name, defaultValue).value;
}

/** Each log-limit variable that holds an unusable value, as `NAME=value`. */
export function unusableLogLimitEnv(): string[] {
	return Object.values(LOG_LIMIT_ENVS).flatMap(
		({ name, default: defaultValue }) => {
			const { invalid } = readLimitFromEnv(name, defaultValue);
			return invalid === undefined ? [] : [invalid];
		},
	);
}

/** Rotation threshold for every active `~/.pi-lens/*.log`, in MB. */
export function getMaxLogSizeMB(): number {
	return getLogLimit("maxSizeMB");
}
