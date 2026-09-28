import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { withRealPi } from "../support/real-pi-harness.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const binaryArms = [
	{
		label: "pi 0.85.1",
		bin: path.join(repoRoot, "node_modules/.bin/pi"),
		binDir: path.join(repoRoot, "node_modules/.bin"),
		expectedVersion: "0.85.1",
		packageJson: path.join(
			repoRoot,
			"node_modules/@earendil-works/pi-coding-agent/package.json",
		),
	},
	{
		label: "pi 0.87.1",
		bin: "/home/akis/.local/bin/pi",
		binDir: "/home/akis/.local/bin",
		expectedVersion: "0.87.1",
		packageJson:
			"/home/akis/.local/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
	},
] as const;

function latestToolNames(pi: {
	providerObservations(): ReadonlyArray<Record<string, unknown>>;
}): string[] {
	const tools = pi.providerObservations().at(-1)?.tools;
	return (Array.isArray(tools) ? tools : []).flatMap((tool) =>
		typeof (tool as { name?: unknown }).name === "string"
			? [(tool as { name: string }).name]
			: [],
	);
}

async function runArm(arm: (typeof binaryArms)[number]): Promise<void> {
	const previousPath = process.env.PATH;
	process.env.PATH = [arm.binDir, "/usr/local/bin", "/usr/bin", "/bin"].join(
		path.delimiter,
	);
	try {
		const resolved = spawnSync("which", ["pi"], { encoding: "utf8" });
		expect(resolved.status, `${arm.label} resolved pi`).toBe(0);
		expect(resolved.stdout.trim(), `${arm.label} resolved path`).toBe(arm.bin);
		expect(
			JSON.parse(readFileSync(arm.packageJson, "utf8")).version,
			`${arm.label} resolved version`,
		).toBe(arm.expectedVersion);

		await withRealPi(
			{ fixture: "scenario-1", script: "script.json", args: ["--no-lazy-tools"] },
			async (pi) => {
				await pi.prompt("report the active tool roster");
				await pi.awaitAssistantTurn();
				const names = latestToolNames(pi);
				expect(names.length, `${arm.label} active roster`).toBeGreaterThan(0);
				expect(names).toContain("lens_diagnostics");
			},
		);

		await withRealPi(
			{
				fixture: "tools-disabled",
				script: "script.json",
				args: ["--no-lazy-tools"],
				env: { PI_LENS_TEST_MODE: "0" },
			},
			async (pi) => {
				await pi.prompt("report the project-disabled roster");
				await pi.awaitAssistantTurn();
				const names = latestToolNames(pi);
				expect(names.length, `${arm.label} project-disabled roster`).toBeGreaterThan(0);
				expect(names).not.toContain("ast_grep_replace");
			},
		);

		await withRealPi(
			{
				fixture: "cli-no-tool",
				script: "script.json",
				args: ["--no-lazy-tools", "--no-tool=lsp_navigation"],
				env: { PI_LENS_TEST_MODE: "0" },
			},
			async (pi) => {
				await pi.prompt("report the CLI-disabled roster");
				await pi.awaitAssistantTurn();
				const names = latestToolNames(pi);
				expect(names.length, `${arm.label} CLI-disabled roster`).toBeGreaterThan(0);
				expect(names).not.toContain("lsp_navigation");
			},
		);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	}
}

async function observeProviderContext(
	contexts: Array<Record<string, unknown>>,
): Promise<
	Record<string, unknown>[]
> {
	const root = mkdtempSync(path.join(repoRoot, ".probe-home", "provider-shape-"));
	const script = path.join(root, "script.json");
	const observation = path.join(root, "provider.jsonl");
	writeFileSync(
		script,
		JSON.stringify(
			contexts.map(() => [{ type: "text", text: "ok" }]),
		),
	);
	const previousScript = process.env.REAL_PI_HARNESS_SCRIPT;
	const previousObservation = process.env.REAL_PI_HARNESS_PROVIDER_LOG;
	process.env.REAL_PI_HARNESS_SCRIPT = script;
	process.env.REAL_PI_HARNESS_PROVIDER_LOG = observation;
	try {
		const providers: Array<Record<string, unknown>> = [];
		// @ts-expect-error -- this host-boundary fixture is intentionally JavaScript.
		const providerModule = await import("../fixtures/real-harness/scripted-provider.mjs");
		providerModule.default({
			registerProvider: (_name: string, provider: Record<string, unknown>) =>
				providers.push(provider),
		});
		const streamSimple = providers[0].streamSimple as (
			model: Record<string, unknown>,
			context: Record<string, unknown>,
			options: Record<string, unknown>,
		) => unknown;
		const model = {
			api: "openai-completions",
			provider: "scripted",
			id: "harness",
		};
		for (const context of contexts) streamSimple(model, context, {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		return readFileSync(observation, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} finally {
		if (previousScript === undefined) delete process.env.REAL_PI_HARNESS_SCRIPT;
		else process.env.REAL_PI_HARNESS_SCRIPT = previousScript;
		if (previousObservation === undefined)
			delete process.env.REAL_PI_HARNESS_PROVIDER_LOG;
		else process.env.REAL_PI_HARNESS_PROVIDER_LOG = previousObservation;
		rmSync(root, { recursive: true, force: true });
	}
}

// #3636 regression: pi 0.86 moved provider tools from Context.tools into transcript system messages.
describe("real pi scripted-provider compatibility", () => {
	it("replays legacy and transcript tool contexts at the provider boundary", async () => {
		const transcriptContext = {
			messages: [
				{
					role: "system",
					toolsAdded: [
						{ name: "removed_tool", description: "", parameters: {} },
						{ name: "current_tool", description: "", parameters: {} },
					],
				},
				{ role: "system", toolsRemoved: [{ name: "removed_tool" }] },
			],
		};
		const rows = await observeProviderContext([
			{ tools: [{ name: "legacy_tool", description: "", parameters: {} }] },
			transcriptContext,
			{},
			{},
		]);
		expect((rows[0].tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
			"legacy_tool",
		]);
		expect(
			(rows[1].tools as Array<{ name: string }>).map(
				(tool) => tool.name,
			),
		).toEqual(["current_tool"]);
		expect(
			rows.filter((row) => row.kind === "scripted-provider-context-shape-unavailable"),
		).toHaveLength(1);
		expect(rows.filter((row) => Array.isArray(row.tools))).toHaveLength(4);
	});

	it.each(binaryArms)(
		"preserves active and disabled rosters for $label",
		async (arm) => {
			await runArm(arm);
		},
		180_000,
	);
});
