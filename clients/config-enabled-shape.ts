/**
 * Shared parser for the `{ enabled?: boolean }` shape used by BOTH the global
 * config (`clients/lens-config.ts`, `~/.pi-lens/config.json`) and the project
 * config (`clients/project-lens-config.ts`, `.pi-lens.json`) for their
 * mutation-control keys (`format`, `autofix`, `actionableWarnings.autoFix`).
 *
 * Extracted (#792) so both loaders parse and warn on the identical shape
 * identically instead of two independent hand-rolled implementations that had
 * diverged in strictness — project warned on invalid `enabled` values via its
 * own `warnInvalidConfigOnce`, global silently dropped them. This module has
 * no dependency on either config module (avoids an import cycle) — callers
 * supply their own `warnInvalid` callback so each config keeps its own
 * warn-once plumbing (keyed by its own config path).
 */

export interface EnabledConfigShape {
	/** Whether this mutation path is enabled. */
	enabled?: boolean;
}

/**
 * Parse a raw `{ enabled?: boolean }` value.
 *
 * - `undefined` input → `undefined` (key absent from the config).
 * - Non-object (or array) input → `warnInvalid` is called, returns `undefined`.
 * - Object with no `enabled` key → `{}` (present but nothing to say).
 * - `enabled` present but not a boolean → `warnInvalid` is called, returns `{}`.
 * - `enabled` a boolean → `{ enabled }`.
 */
export function parseEnabledShape(
	value: unknown,
	fieldPath: string,
	warnInvalid: (reason: string) => void,
): EnabledConfigShape | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnInvalid(`${fieldPath} must be an object`);
		return undefined;
	}

	const raw = value as Record<string, unknown>;
	if (!("enabled" in raw)) return {};
	if (typeof raw.enabled !== "boolean") {
		warnInvalid(`${fieldPath}.enabled must be a boolean`);
		return {};
	}
	return { enabled: raw.enabled };
}
