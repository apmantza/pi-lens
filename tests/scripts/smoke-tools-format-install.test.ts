import { describe, expect, it, vi } from "vitest";
import {
	FORMAT_FIXTURES,
	FIXTURES,
	runFormatSmoke,
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

		const result = await runFormatSmoke({
			langs: [
				"python-black",
				"cmake",
				"js-oxfmt",
				"lua",
				"clojure",
				"php",
				"java-gjf",
			],
			install: true,
			verbose: false,
			deps: {
				ensureTool,
				getInstallAttempt,
				getFormatService: () => ({
					recordRead: vi.fn(),
					formatFile: vi.fn(async (filePath: string) => ({
						formatters: [
							{
								name: FORMAT_FIXTURES.find((fx) => filePath.endsWith(fx.file))
									?.formatter,
								success: true,
								changed: true,
								outcome: "formatted",
							},
						],
						anyChanged: true,
						allSucceeded: true,
					})),
				}),
				onEnsure: (toolId: string) => requests.push(toolId),
			},
		});

		expect([...new Set(requests)].sort()).toEqual(
			[...MANAGED_FORMATTERS].sort(),
		);
		expect(
			[...new Set(ensureTool.mock.calls.map(([toolId]) => toolId))].sort(),
		).toEqual([...MANAGED_FORMATTERS].sort());
		expect(result).toBe(0);
		const formatterTools = new Set(MANAGED_FORMATTERS);
		const misplaced = FIXTURES.flatMap((fixture) =>
			(fixture.tools ?? [])
				.filter((toolId) => formatterTools.has(toolId))
				.map((toolId) => `${fixture.lang}:${toolId}`),
		);
		expect(
			misplaced,
			"formatter installs belong only to FORMAT_FIXTURES",
		).toEqual([]);
	});
});
