// Type declarations for lsp-idle-eviction-promote.mjs (#3989).

import type { IdleEvictionRow } from "./lsp-idle-eviction-doc.mjs";
import type { IdleEvictionNight } from "./md-matrix.mjs";

export type NightState = Record<string, { nights: IdleEvictionNight[] }>;

export const PROMOTE_NIGHTS: number;
export const IDLE_EVICTION_MIN_RSS_BYTES: number;
export const COLD_START_MAX_MS: number;
export function holdList(registrySource: string): Map<string, string> | null;

export function moveClassId(
	registrySource: string,
	serverId: string,
): { ok: true; text: string } | { ok: false; reason: string };

export function parseRejectedServers(
	text: string | null | undefined,
): Set<string>;

export function isSettledPair(
	entry: { nights?: readonly IdleEvictionNight[] } | null | undefined,
): boolean;

export function advanceNights(
	prior: NightState | undefined,
	rows: readonly IdleEvictionRow[],
	today: string,
): NightState;

export interface Promotion {
	serverId: string;
	nights: IdleEvictionNight[];
	minRssMb: number;
	worstColdMs: number;
}

export interface Skipped {
	serverId: string;
	reason: string;
}

export function selectPromotions(
	state: NightState,
	hold: ReadonlyMap<string, string>,
	rows: readonly IdleEvictionRow[],
): {
	promote: Promotion[];
	skipped: Skipped[];
};

export function promoteDeclaration(
	source: string,
	serverId: string,
): { ok: true; text: string } | { ok: false; reason: string };

export function addReasons(
	text: string,
	reasons: Record<string, string>,
): { ok: true; text: string } | { ok: false; reason: string };

export function planPromotions(input: {
	rows: readonly IdleEvictionRow[];
	prior: NightState | undefined;
	today: string;
	serverSource: string;
	reasonsText: string;
	registrySource: string;
	/** null = the closed-PR list could not be read. */
	rejected?: ReadonlySet<string> | null;
	runUrl?: string | null;
}): {
	state: NightState;
	promoted: Promotion[];
	skipped: Skipped[];
	serverSource: string;
	reasonsText: string;
	registrySource: string;
	body: string | null;
};

export function renderPromotionBody(
	promoted: readonly Promotion[],
	skipped: readonly Skipped[],
	runUrl?: string | null,
): string;
