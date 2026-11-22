// Type declarations for resolve-newest-in-range-host.mjs (untyped .mjs
// imported from .ts tests). #2613, #5749.

export function readPeerRange(
	pkg: Record<string, unknown>,
	packageName: string,
): string;

export function readFloorEnv(env: Record<string, string | undefined>): string;

export function isAcceptableLatestHost(
	version: unknown,
	peerRange: string,
	floor: string,
): boolean;
