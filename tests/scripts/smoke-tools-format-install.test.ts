import { describe, expect, it, vi } from "vitest";
import {
	ensureFixtureTools,
	FORMAT_FIXTURES,
} from "../../scripts/smoke-tools.mjs";

const MANAGED_FORMATTERS = [
	"black",
	"cmake-format",
	"stylua",
	"cljfmt",
	"php-cs-fixer",
	"google-java-format",
	"oxfmt",
];

describe("format smoke installer wiring", () => {
	it("requests the managed tool for every selected managed formatter", async () => {
		const ensureTool = vi.fn(async (toolId: string) => `/managed/${toolId}`);
		const getInstallAttempt = vi.fn();
		const requests: string[] = [];

		for (const formatter of MANAGED_FORMATTERS) {
			const fixture = FORMAT_FIXTURES.find((fx) => fx.formatter === formatter);
			expect(fixture, `${formatter} must have a format fixture`).toBeDefined();
			await ensureFixtureTools(
				fixture?.tools ?? [],
				ensureTool,
				getInstallAttempt,
				(toolId) => requests.push(toolId),
			);
		}

		expect(requests).toEqual(MANAGED_FORMATTERS);
		expect(ensureTool.mock.calls.map(([toolId]) => toolId)).toEqual(
			MANAGED_FORMATTERS,
		);
	});
});
