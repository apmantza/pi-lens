/**
 * Shared "read a JSON cache file off disk" boilerplate (#676).
 *
 * At least 7 sites across the codebase hand-duplicated the same shape:
 * `JSON.parse(fs.readFileSync(path, "utf-8"))` → structural/version guard →
 * return the parsed value, or `undefined`/`null` on ANY throw (missing file,
 * unreadable, corrupt JSON, or a `validate` callback itself throwing). This
 * module extracts only that read/parse/try-catch mechanics; every call
 * site's own "is this actually a valid, current-version cache?" logic stays
 * put, as the `validate` callback — consolidation is only meant to remove
 * the duplicated plumbing, not to unify subtly different validation rules
 * that call sites had for good reason (e.g. a second `ruleHash` field check
 * alongside the version check).
 *
 * `validate` returning `undefined` means "treat this like a parse failure" —
 * the same fail-open posture every existing site already had for a
 * wrong-version/wrong-shape cache.
 */

import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";

/**
 * Synchronous read: `JSON.parse(fs.readFileSync(path, "utf-8"))`, run through
 * `validate`, with any failure (missing file, unreadable, corrupt JSON,
 * `validate` throwing) swallowed to `undefined`.
 *
 * `onError`, when provided, is invoked with the caught error BEFORE
 * `undefined` is returned — for sites that log a read failure today (e.g.
 * `CacheManager`'s verbose `this.log(...)`) rather than silently swallowing
 * it. `onError` itself is never allowed to throw the failure back out.
 */
export function readJsonCache<T>(
	path: string,
	validate: (parsed: unknown) => T | undefined,
	onError?: (err: unknown) => void,
): T | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path, "utf-8")) as unknown;
		return validate(parsed);
	} catch (err) {
		try {
			onError?.(err);
		} catch {
			/* onError must never mask the original fail-open behavior */
		}
		return undefined;
	}
}

/**
 * Async sibling of {@link readJsonCache}, for call sites already on the
 * `fs.promises` API (e.g. `session-state-store.ts`). Same fail-open contract.
 */
export async function readJsonCacheAsync<T>(
	path: string,
	validate: (parsed: unknown) => T | undefined,
	onError?: (err: unknown) => void,
): Promise<T | undefined> {
	try {
		const raw = await fsPromises.readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		return validate(parsed);
	} catch (err) {
		try {
			onError?.(err);
		} catch {
			/* onError must never mask the original fail-open behavior */
		}
		return undefined;
	}
}
