import { describe, expect, it } from "vitest";
import { createWidgetStatusPublisher } from "../../clients/widget-status.js";

function recorder() {
	const statuses = new Map<string, string>();
	const setStatus = (key: string, text: string | undefined) => {
		if (text === undefined) statuses.delete(key);
		else statuses.set(key, text);
	};
	return { statuses, setStatus };
}

describe("widget status publisher", () => {
	it("publishes each non-blank line under an ordered key, trimmed", () => {
		const { statuses, setStatus } = recorder();
		const publisher = createWidgetStatusPublisher(setStatus, () => [
			" pi-lens  ✓ clean",
			"   ",
			" a.ts b.ts",
		]);

		publisher.publish();

		expect([...statuses]).toEqual([
			["pi-lens-widget-00", "pi-lens  ✓ clean"],
			["pi-lens-widget-01", "a.ts b.ts"],
		]);
	});

	it("drops the keys of lines the next render no longer has", () => {
		const { statuses, setStatus } = recorder();
		let lines = ["one", "two", "three"];
		const publisher = createWidgetStatusPublisher(setStatus, () => lines);

		publisher.publish();
		lines = ["only"];
		publisher.publish();

		expect([...statuses]).toEqual([["pi-lens-widget-00", "only"]]);
	});

	it("clears every key it published", () => {
		const { statuses, setStatus } = recorder();
		const publisher = createWidgetStatusPublisher(setStatus, () => [
			"one",
			"two",
		]);

		publisher.publish();
		publisher.clear();

		expect(statuses.size).toBe(0);
	});
});
