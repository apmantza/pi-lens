/**
 * Fixtures for the #2425 config-core suites.
 *
 * A PLACEHOLDER envelope, not a catalog. #2416 ships the real LSP schema and
 * asserts it with the same `assertSchemaStabilityTiers` harness; the shape here
 * exists only so the core's behavior can be pinned before that schema does. It
 * deliberately exercises one node of every kind the merger can meet: a
 * `boolean-false` deny, an `array-union` deny, all three merge strategies, an
 * `enum`, an open sub-object, and a nested object.
 */

import {
	CONFIG_SCHEMA_ANCHOR_KEY,
	CONFIG_SCHEMA_ID,
	STABILITY_TIER_KEY as TIER,
} from "../../clients/config-diagnostic-codes.js";
import {
	DENY_KEY,
	MERGE_STRATEGY_KEY,
} from "../../clients/config-core/schema.js";
import type { ConfigSchemaNode } from "../../clients/config-core/schema.js";
import type { ConfigSource } from "../../clients/config-core/merge.js";

export const DEMO_CONFIG_SCHEMA: ConfigSchemaNode = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: CONFIG_SCHEMA_ID,
	type: "object",
	properties: {
		[CONFIG_SCHEMA_ANCHOR_KEY]: {
			type: "string",
			description: "Identity anchor naming the schema this config follows.",
			[TIER]: "stable",
		},
		lsp: {
			type: "object",
			[TIER]: "experimental",
			properties: {
				enabled: {
					type: "boolean",
					[TIER]: "stable",
					[DENY_KEY]: "boolean-false",
				},
				disabledServers: {
					type: "array",
					items: { type: "string" },
					[TIER]: "stable",
					[DENY_KEY]: "array-union",
					[MERGE_STRATEGY_KEY]: "replace",
				},
				warmFiles: {
					type: "array",
					items: { type: "string" },
					[TIER]: "experimental",
					[MERGE_STRATEGY_KEY]: "replace",
				},
				probes: {
					type: "array",
					items: { type: "string" },
					[TIER]: "experimental",
					[MERGE_STRATEGY_KEY]: "append",
				},
				servers: {
					type: "array",
					[TIER]: "experimental",
					[MERGE_STRATEGY_KEY]: "keyed:id",
					items: {
						type: "object",
						properties: {
							id: { type: "string", [TIER]: "stable" },
							command: { type: "string", [TIER]: "stable" },
							role: {
								type: "string",
								enum: ["language", "auxiliary"],
								[TIER]: "experimental",
							},
							enabled: {
								type: "boolean",
								[TIER]: "stable",
								[DENY_KEY]: "boolean-false",
							},
							initializationOptions: {
								type: "object",
								additionalProperties: true,
								[TIER]: "experimental",
							},
						},
					},
				},
				timeouts: {
					type: "object",
					[TIER]: "experimental",
					properties: {
						initializeMs: { type: "integer", [TIER]: "experimental" },
						clientWaitMs: { type: "integer", [TIER]: "experimental" },
					},
				},
			},
		},
	},
};

/** A second placeholder: the smallest schema carrying a `boolean-false` deny. */
export const DENY_ONLY_SCHEMA: ConfigSchemaNode = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: CONFIG_SCHEMA_ID,
	type: "object",
	properties: {
		[CONFIG_SCHEMA_ANCHOR_KEY]: { type: "string", [TIER]: "stable" },
		enabled: {
			type: "boolean",
			[TIER]: "stable",
			[DENY_KEY]: "boolean-false",
		},
		blocked: {
			type: "array",
			items: { type: "string" },
			[TIER]: "stable",
			[DENY_KEY]: "array-union",
		},
	},
};

/**
 * The golden four-tier resolution input: a built-in default, a machine-global
 * file, a project file, and a nested project file. Deliberately overlapping, so
 * every merge rule has something to decide.
 */
export const GOLDEN_SOURCES: readonly ConfigSource[] = [
	{
		tier: "builtin",
		value: {
			lsp: {
				enabled: true,
				disabledServers: [],
				warmFiles: ["builtin.ts"],
				probes: ["builtin-probe"],
				timeouts: { initializeMs: 5000, clientWaitMs: 2500 },
				servers: [
					{ id: "pyright", command: "pyright-langserver", role: "language" },
				],
			},
		},
	},
	{
		tier: "global",
		file: "~/.pi-lens/config.json",
		value: {
			lsp: {
				disabledServers: ["gopls"],
				warmFiles: ["global.ts"],
				probes: ["global-probe"],
				timeouts: { clientWaitMs: 4000 },
				servers: [{ id: "pyright", command: "basedpyright-langserver" }],
			},
		},
	},
	{
		tier: "project",
		file: ".pi-lens.json",
		trust: "trusted",
		value: {
			lsp: {
				warmFiles: ["project.ts"],
				probes: ["project-probe"],
				servers: [
					{ id: "pyright", role: "auxiliary" },
					{ id: "tailwind", command: "tailwindcss-language-server" },
				],
			},
		},
	},
	{
		tier: "nested-project",
		file: "packages/app/.pi-lens.json",
		trust: "trusted",
		value: {
			lsp: {
				timeouts: { initializeMs: 9000 },
				servers: [{ id: "tailwind", role: "auxiliary" }],
			},
		},
	},
];
