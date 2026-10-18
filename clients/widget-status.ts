/**
 * Publishes the widget's lines as footer statuses instead of a belowEditor
 * component, so a footer that draws statuses can put them beside its own rows.
 */

export const WIDGET_STATUS_KEY = "pi-lens-widget";
export const WIDGET_STATUS_WIDTH = 72;

const KEY_INDEX_DIGITS = 2;

type SetStatus = (key: string, text: string | undefined) => void;

export type WidgetStatusPublisher = { publish: () => void; clear: () => void };

function statusKey(index: number): string {
	return `${WIDGET_STATUS_KEY}-${String(index).padStart(KEY_INDEX_DIGITS, "0")}`;
}

export function createWidgetStatusPublisher(
	setStatus: SetStatus,
	render: () => string[],
): WidgetStatusPublisher {
	let shown = 0;

	function clearFrom(index: number): void {
		for (let i = index; i < shown; i++) setStatus(statusKey(i), undefined);
	}

	return {
		publish() {
			const lines = render().flatMap((line) => {
				const trimmed = line.trim();
				return trimmed === "" ? [] : [trimmed];
			});
			lines.forEach((line, i) => setStatus(statusKey(i), line));
			clearFrom(lines.length);
			shown = lines.length;
		},
		clear() {
			clearFrom(0);
			shown = 0;
		},
	};
}
