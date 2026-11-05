// Types for the (plain-JS) package-lock sync guard. Every value export of
// package-lock-sync.mjs is declared here: tests/config/dmts-export-drift.test.ts
// holds the value sets equal in both directions (#2725).

type LibcDrift = { key: string; version: string; libc: string[] };

export declare function validatePackageLockSync(
	pkg: unknown,
	lock: unknown,
): string[];

export declare function findLibcDrift(
	beforeLock: unknown,
	afterLock: unknown,
): LibcDrift[];

export declare function hasPackagesMap(lock: unknown): boolean;

export declare function formatLibcDriftFailure(
	dropped: LibcDrift[],
	pin: { npm?: string; error?: string } | undefined,
	compared: string,
): string;

export declare function formatPackageLockSyncFailure(
	problems: string[],
): string;
