/**
 * Width-safe line fitting for TUI rendering (shared by the footer widget and
 * the turn-summary message renderer). pi-tui's `TUI.doRender` HARD-CRASHES the
 * whole host on any rendered line wider than the terminal ("Rendered line N
 * exceeds terminal width") — every `Component.render(width)` line MUST be
 * truncated to the given width. Seen live 2026-07-11: an untruncated
 * turn-summary one-liner (133 cols vs 120) took down a pi session (#513).
 *
 * Two incompatible truncateToWidth signatures ship under the
 * "@earendil-works/pi-tui" specifier depending on which runtime resolves it:
 *   - pure-JS pi-tui:        (text, maxWidth, ellipsis: string, pad?)
 *   - native @oh-my-pi >=16: (text, maxWidth, ellipsisKind: Ellipsis enum, pad, tabWidth: i32)
 * Passing a string to the native one throws "Failed to convert napi value into
 * enum `Ellipsis`". Probe the string API once; on napi failure, switch to the
 * native enum signature for good. Ellipsis enum: Unicode=0 ("…"), Ascii=1
 * ("..."), Omit=2.
 */
import { truncateToWidth } from "./deps/pi-tui.js";

const ELLIPSIS_KIND: Record<string, number> = { "…": 0, "...": 1, "": 2 };
let truncateIsNative: boolean | null = null;

/** Test-only: reset the signature probe between test cases. */
export function _resetTruncateProbeForTests(): void {
	truncateIsNative = null;
}

export function fitLine(s: string, maxWidth: number, ellipsis = "..."): string {
	const w = Math.max(0, maxWidth);
	const fn = truncateToWidth as (...a: unknown[]) => string;
	if (truncateIsNative === true) {
		return fn(s, w, ELLIPSIS_KIND[ellipsis] ?? 1, false, 8);
	}
	if (truncateIsNative === false) {
		return fn(s, w, ellipsis);
	}
	// first call: try the legacy string API; native binding rejects the string arg.
	try {
		const out = fn(s, w, ellipsis);
		truncateIsNative = false;
		return out;
	} catch {
		truncateIsNative = true;
		return fn(s, w, ELLIPSIS_KIND[ellipsis] ?? 1, false, 8);
	}
}

/**
 * Fit every line of a `Component.render(width)` result. `width` can arrive as
 * 0/undefined in exotic hosts — treat non-positive as "don't truncate" rather
 * than emitting empty lines.
 */
export function fitLines(lines: string[], width: number): string[] {
	if (!Number.isFinite(width) || width <= 0) return lines;
	return lines.map((line) => fitLine(line, width));
}
