/**
 * THE canonical pi-lens config schema (#2426).
 *
 * A plain JSON-Schema-shaped object, per `config-core/schema.ts`: the same
 * value the validator runs on is the value #2416 publishes as
 * `docs/schema/pi-lens-config-v1.json`, so there is no compiler between the two
 * for drift to hide in. It is the FIRST real schema through the #2418 harness —
 * `tests/config/pi-lens-config-schema.test.ts` runs `assertSchemaStabilityTiers`
 * and `assertSchemaIdentityAnchor` over this object rather than over the
 * placeholder fixture, which is what makes those two assertions load-bearing
 * instead of self-referential.
 *
 * Three deliberate shapes:
 *
 * 1. THE ROOT IS OPEN (`additionalProperties: true`). pi-lens's default is
 *    closed (`docs/public-api-stability.md`), and this is the one place that
 *    default is overridden on purpose. Both loaders already have their OWN,
 *    richer unknown-key diagnostics — the global loader names the typo, and the
 *    project loader distinguishes "typo" from "that is a global-only setting"
 *    (#533/#883). Letting `validate()` drop an unknown root key first would
 *    replace both messages with a generic `PILENS_CFG_0004`, which is strictly
 *    less information for the user. Closing the root belongs to the slice that
 *    moves those diagnostics into the schema, not to this one.
 *
 * 2. THE NAMESPACE LIST IS DERIVED, NEVER RESTATED. Every top-level section
 *    comes from `lens-flag-registry.ts`'s registries; adding a flag or a
 *    section needs no edit here. A hand-copied mirror of a registry is the
 *    defect AGENTS.md's single-source-of-truth rule names, and it is the exact
 *    thing #883 already removed from the two loaders' unknown-key scans.
 *
 * 3. ONLY `lsp` DECLARES A TYPE, and only one level deep. #2416 owns the
 *    `lsp.servers.<id>` shape; this slice RESERVES the namespace and moves the
 *    loader. Everything else stays schema-opaque, which `config-core` walks
 *    open — the node is still depth-bounded, prototype-key-checked and
 *    recorded, but no field's accepted values change in a slice whose
 *    acceptance criterion is that they do not.
 */

import {
	CONFIG_SCHEMA_ANCHOR_KEY,
	CONFIG_SCHEMA_ID,
	STABILITY_TIER_KEY,
	type StabilityTier,
} from "./config-diagnostic-codes.js";
import { LEGACY_ROOT_LSP_KEYS, LSP_NAMESPACE_KEY } from "./config-locations.js";
// From the owning module, not the barrel — same reason as `config-resolve.ts`:
// the barrel's width would drag `process-spec.js` -> `project-trust.js` into
// every config loader's import graph for one type alias.
import {
	type ConfigSchemaNode,
	DENY_KEY,
	type DenyPolicy,
} from "./config-core/schema.js";
import {
	flagConfigSectionKeys,
	GLOBAL_NON_FLAG_CONFIG_SECTIONS,
	LENS_FLAGS,
	PROJECT_FOREIGN_CONFIG_NAMESPACES,
	PROJECT_NON_FLAG_CONFIG_SECTIONS,
} from "./lens-flag-registry.js";
import { LENS_TOOL_NAMES } from "./tool-config.js";

/** The JSON Schema dialect the published artifact declares. */
const CONFIG_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * A node the schema says nothing else about. `config-core` treats a node with
 * no `type` as opaque and walks its children OPEN, so an undeclared section
 * keeps exactly the values it kept before this schema existed.
 */
function opaque(tier: StabilityTier): ConfigSchemaNode {
	return { [STABILITY_TIER_KEY]: tier };
}

/**
 * The `lsp` namespace: reserved here, shaped by #2416.
 *
 * `enabled` is the pre-existing `--no-lsp` toggle and keeps living here, which
 * is why `lsp` is a NAMESPACE rather than a new sibling of the toggle: a config
 * key that already means "is the LSP on" and a key that means "which servers"
 * belong under one heading, and splitting them would have been a second name
 * for the same subsystem.
 *
 * The four catalog keys are `experimental` on purpose. They are the canonical
 * home of the four legacy ROOT keys deprecated by this PR, and #2416 replaces
 * the bare-command server form with the trust-gated `ProcessSpec` — promising
 * stability on a shape that is already scheduled to change would be a promise
 * made only to be broken.
 */
/**
 * The JSON type each canonical `lsp.*` key carries. Spelled out rather than
 * inferred from the key's name: this is the ONE piece of validation the slice
 * adds, and it earns its place — pre-#2426 a `disabledServers` that was a
 * STRING reached `new Set(config.disabledServers)` and disabled one server per
 * CHARACTER. `tests/config/pi-lens-config-schema.test.ts` asserts every
 * `LEGACY_ROOT_LSP_KEYS` member has an entry here, so a new registry row cannot
 * land untyped.
 */
const LSP_KEY_TYPES: Readonly<Record<string, "object" | "array">> = {
	servers: "object",
	serverOverrides: "object",
	disabledServers: "array",
	warmFiles: "array",
};

export { LSP_KEY_TYPES };

/**
 * The canonical `lsp.*` keys that carry a DENIAL rather than an ordinary value
 * (#2427).
 *
 * `config-core/deny.ts` has shipped monotonic deny precedence since #2440 and
 * `merge()` has consulted it since — but it only fires for a node the SCHEMA
 * annotates, and no production node did. The consequence was live and
 * measurable: with `~/.pi-lens/config.json` saying
 * `lsp.disabledServers: ["typos"]` and a repository's `.pi-lens.json` saying
 * `lsp.disabledServers: []`, the resolution returned `[]` attributed to the
 * `project` tier and `loadLSPConfig` handed `initLSPConfig` an empty disable
 * set — repository content silently re-enabling a server the operator turned
 * off, which is the exact scenario `deny.ts`'s module doc says it exists to
 * prevent and #2415 AC 3 forbids. One annotation is the whole fix: the union
 * of every tier's members, attributed to the tier that first denied.
 *
 * `enabled` is deliberately NOT annotated here. `boolean-false` pins an
 * operator denial against every higher tier including `cli`, and `env`/`cli`
 * are still unpopulated (`docs/configuration.md`), so annotating it now would
 * decide what `--lsp` means against a global `lsp.enabled: false` in a slice
 * that cannot test the tiers involved. That belongs to the slice that
 * populates them.
 */
const LSP_KEY_DENY: Readonly<Record<string, DenyPolicy>> = {
	disabledServers: "array-union",
};

/** The `x-deny` annotation for a key, or nothing when it carries no denial. */
function denyAnnotation(key: string): { [DENY_KEY]?: DenyPolicy } {
	const policy = LSP_KEY_DENY[key];
	return policy === undefined ? {} : { [DENY_KEY]: policy };
}

function lspNamespace(): ConfigSchemaNode {
	const properties: Record<string, ConfigSchemaNode> = {
		// Reserved but deliberately UNTYPED. `lens-config.ts` already rejects a
		// non-boolean here with `lsp.enabled must be a boolean` — a message that
		// names the key and the expected type — and it is the one every flag in
		// the registry shares. Declaring `type: "boolean"` would make `validate()`
		// drop the value first and replace that message with the core's generic
		// `expected boolean, got string`, which is strictly less useful. The flag
		// sections move into the schema when their diagnostics do, not before.
		enabled: { [STABILITY_TIER_KEY]: "stable" },
	};
	for (const key of LEGACY_ROOT_LSP_KEYS) {
		const declared = LSP_KEY_TYPES[key];
		properties[key] = {
			...(declared ? { type: declared } : {}),
			[STABILITY_TIER_KEY]: "experimental",
			...(declared === "object" ? { additionalProperties: true } : {}),
			...denyAnnotation(key),
		};
	}
	return {
		type: "object",
		additionalProperties: true,
		[STABILITY_TIER_KEY]: "stable",
		properties,
	};
}

function buildConfigSchema(): ConfigSchemaNode {
	const properties: Record<string, ConfigSchemaNode> = {};

	// Every top-level section pi-lens recognizes today, derived from the
	// registries rather than listed. These have shipped and are documented, so
	// they are `stable`; declaring long-published fields experimental would
	// understate a guarantee users already rely on.
	for (const key of [
		...flagConfigSectionKeys(LENS_FLAGS),
		...GLOBAL_NON_FLAG_CONFIG_SECTIONS,
		...PROJECT_NON_FLAG_CONFIG_SECTIONS,
	]) {
		properties[key] = opaque("stable");
	}
	properties.tools = {
		type: "object",
		additionalProperties: true,
		properties: Object.fromEntries(
			LENS_TOOL_NAMES.map((name) => [
				name,
				{
					type: "object",
					additionalProperties: true,
					properties: {
						enabled: { type: "boolean", [STABILITY_TIER_KEY]: "experimental" },
					},
					[STABILITY_TIER_KEY]: "experimental",
				},
			]),
		),
		[STABILITY_TIER_KEY]: "stable",
	};

	// Namespaces owned by another tool that ride in the same file (`trivy`,
	// `helm`). Reserved so they survive validation, `experimental` because their
	// shape belongs to those runners, not to this schema.
	for (const key of PROJECT_FOREIGN_CONFIG_NAMESPACES) {
		properties[key] ??= opaque("experimental");
	}

	for (const key of [
		"knip",
		"jscpd",
		"madge",
		"gitleaks",
		"govulncheck",
		"deadCode",
		"complexity",
	]) {
		properties[key] = {
			type: "object",
			additionalProperties: true,
			properties: {
				enabled: { type: "boolean", [STABILITY_TIER_KEY]: "experimental" },
			},
			[STABILITY_TIER_KEY]: "stable",
		};
	}
	properties.startup = {
		type: "object",
		additionalProperties: true,
		properties: {
			mode: {
				type: "string",
				enum: ["quick", "full", "minimal"],
				[STABILITY_TIER_KEY]: "experimental",
			},
			scans: {
				type: "object",
				additionalProperties: true,
				properties: {
					enabled: { type: "boolean", [STABILITY_TIER_KEY]: "experimental" },
				},
				[STABILITY_TIER_KEY]: "experimental",
			},
		},
		[STABILITY_TIER_KEY]: "stable",
	};

	// The four legacy ROOT LSP keys. Still accepted for their deprecation window
	// (#2418 registry), and `experimental` because they are scheduled for
	// removal — a `stable` tier on a key with a `removeNotBefore` would be two
	// registries contradicting each other.
	//
	// NO deny annotation, unlike round 1 of #2427 (review round 2, F1). Round 1
	// annotated BOTH spellings and got two independent deny unions for one
	// setting, neither seeing the other tiers. Both resolution entry points now
	// normalize a document legacy root LSP keys into the `lsp` namespace before
	// merging, so this node never receives a contribution at all and a policy on
	// it could not fire. The denial is resolved once, at the canonical node,
	// over every tier and every spelling — which is what the second annotation
	// was trying to achieve and structurally could not.
	for (const key of LEGACY_ROOT_LSP_KEYS) {
		properties[key] = opaque("experimental");
	}

	properties[LSP_NAMESPACE_KEY] = lspNamespace();

	properties[CONFIG_SCHEMA_ANCHOR_KEY] = {
		type: "string",
		description:
			"Identity anchor naming the schema version this config was written against.",
		[STABILITY_TIER_KEY]: "stable",
	};

	return {
		$schema: CONFIG_SCHEMA_DIALECT,
		$id: CONFIG_SCHEMA_ID,
		type: "object",
		// See shape 1 in the module doc: deliberately open, so the loaders keep
		// their own richer unknown-key diagnostics.
		additionalProperties: true,
		properties,
	};
}

/** The canonical schema both canonical files are validated against. */
export const PI_LENS_CONFIG_SCHEMA: ConfigSchemaNode = buildConfigSchema();
