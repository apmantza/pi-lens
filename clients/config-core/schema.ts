/**
 * The schema representation the config core reads (#2425).
 *
 * A schema here is a PLAIN JSON-Schema-shaped object, not a compiled validator
 * object and not a TypeBox/Zod value. That is a deliberate constraint, not
 * laziness: #2416 publishes the same object as `docs/schema/pi-lens-config-v1.json`
 * and its drift test compares the published artifact against the object the
 * runtime validates with. Two representations would need a compiler between
 * them, and a compiler is exactly the place drift hides.
 *
 * Three pi-lens annotations extend the vocabulary, all `x-`-prefixed so a
 * standard JSON Schema validator ignores them:
 *
 * - `x-stability` — the #2418 tier every published property carries. Owned by
 *   `clients/config-diagnostic-codes.ts`; re-exported here only as the key, so
 *   a schema author has one import.
 * - `x-merge-strategy` — how an ARRAY node combines across tiers. Objects are
 *   always merged field-wise, so the annotation is meaningless on them.
 * - `x-deny` — the node carries a denial, and `deny.ts` gives it monotonic
 *   precedence instead of last-tier-wins.
 *
 * Pure accessors only. Nothing here reads a file, and nothing holds state.
 */

/** A JSON-Schema-shaped node. Open bag on purpose: unknown keywords pass through. */
export type ConfigSchemaNode = Readonly<Record<string, unknown>>;

/**
 * A validated configuration value.
 *
 * The domain type the pipeline works in AFTER `validate()`. Deliberately a real
 * recursive JSON shape rather than `unknown`: past the validator, every value
 * has been checked against a schema, so a consumer that still had to narrow
 * from scratch would be paying for a check that already happened. `unknown`
 * survives only at the raw-input boundary, which is `validate`'s first
 * parameter and nowhere else.
 */
export type ConfigValue =
	| string
	| number
	| boolean
	| null
	| ConfigValue[]
	| { [key: string]: ConfigValue };

/** A validated object value. */
export type ConfigObject = { [key: string]: ConfigValue };

/** Narrows to the recursive domain type, not to `unknown`. */
export function isConfigObject(value: unknown): value is ConfigObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- x-merge-strategy ---

/** The annotation key selecting how an array node combines across tiers. */
export const MERGE_STRATEGY_KEY = "x-merge-strategy";

/**
 * How an array node combines across tiers.
 *
 * - `replace` (the default) — the highest-precedence tier that sets the array
 *   supplies the whole array. This is what `disabledServers` needs.
 * - `append` — every tier's entries are concatenated, lowest precedence first.
 * - `keyed:<field>` — entries are matched across tiers by `<field>` and merged
 *   field-wise, new ids appended in first-seen order. This is what a `servers`
 *   list needs, and it is the reason one merger can replace the two hand-written
 *   ones in `lsp/config.ts` and `lens-config.ts`.
 */
export type MergeStrategy = "replace" | "append" | `keyed:${string}`;

const DEFAULT_MERGE_STRATEGY: MergeStrategy = "replace";

const KEYED_PREFIX = "keyed:";

export function isMergeStrategy(value: unknown): value is MergeStrategy {
	if (typeof value !== "string") return false;
	if (value === "replace" || value === "append") return true;
	return value.startsWith(KEYED_PREFIX) && value.length > KEYED_PREFIX.length;
}

/**
 * The declared strategy for a node, or the default.
 *
 * An UNRECOGNIZED annotation value falls back to `replace` rather than throwing.
 * The default is the conservative one: replace never silently unions entries a
 * nearer tier meant to supersede, so a typo in a schema degrades to the safe
 * shape. Schema typos are caught by the #2416 drift test, not at resolve time.
 */
export function mergeStrategyOf(
	node: ConfigSchemaNode | undefined,
): MergeStrategy {
	const declared = node?.[MERGE_STRATEGY_KEY];
	return isMergeStrategy(declared) ? declared : DEFAULT_MERGE_STRATEGY;
}

/** The field name a `keyed:<field>` strategy matches on, else `undefined`. */
export function keyedField(strategy: MergeStrategy): string | undefined {
	return strategy.startsWith(KEYED_PREFIX)
		? strategy.slice(KEYED_PREFIX.length)
		: undefined;
}

// --- x-deny ---

/** The annotation key marking a node as carrying a denial. */
export const DENY_KEY = "x-deny";

/**
 * How a node expresses a denial.
 *
 * - `boolean-false` — a boolean whose `false` denies. `enabled: false`.
 * - `array-union` — a list whose MEMBERS are denials. `disabledServers`.
 *
 * Annotation-driven rather than name-driven on purpose. A heuristic over field
 * names ("anything called `disabled*`") is defect shape 8: it silently misses
 * the field someone spelled differently, and silently claims one that merely
 * looks the part. A schema says what it means.
 */
const DENY_POLICIES = ["boolean-false", "array-union"] as const;

export type DenyPolicy = (typeof DENY_POLICIES)[number];

export function isDenyPolicy(value: unknown): value is DenyPolicy {
	return (
		typeof value === "string" &&
		(DENY_POLICIES as readonly string[]).includes(value)
	);
}

/** The declared deny policy for a node, or `undefined` when it carries none. */
export function denyPolicyOf(
	node: ConfigSchemaNode | undefined,
): DenyPolicy | undefined {
	const declared = node?.[DENY_KEY];
	return isDenyPolicy(declared) ? declared : undefined;
}

// --- structural accessors ---

export function isSchemaNode(value: unknown): value is ConfigSchemaNode {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The declared `type` keyword, when it is a single string. */
export function schemaType(
	node: ConfigSchemaNode | undefined,
): string | undefined {
	const declared = node?.type;
	return typeof declared === "string" ? declared : undefined;
}

/**
 * The `type` keywords the core knows how to act on.
 *
 * An unrecognized keyword is the SCHEMA's problem, not the user's, and both
 * halves of the pipeline treat it identically: the node is opaque, so the walk
 * dispatches on the value's own shape instead of on a word it cannot read
 * (#2440 review). Asking `schemaType(node) !== undefined` was the older,
 * asymmetric test — it let the validator walk a `type: "widget"` node field by
 * field while the merger replaced it whole, so the same schema typo produced
 * two different merge semantics.
 */
const SCHEMA_TYPES: readonly string[] = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
];

const SCHEMA_TYPE_SET: ReadonlySet<string> = new Set(SCHEMA_TYPES);

/** True when the node declares a `type` keyword the core acts on. */
export function isKnownSchemaType(declared: string | undefined): boolean {
	return declared !== undefined && SCHEMA_TYPE_SET.has(declared);
}

/**
 * The subschema governing property `name`: its `properties` entry, else the
 * first `patternProperties` entry whose regex matches.
 *
 * A malformed pattern is skipped rather than thrown: a schema is data, and one
 * bad regex must not take down every config load that touches the file.
 */
export function propertySchema(
	node: ConfigSchemaNode | undefined,
	name: string,
): ConfigSchemaNode | undefined {
	if (!node) return undefined;
	const properties = node.properties;
	if (isSchemaNode(properties) && Object.hasOwn(properties, name)) {
		const child = properties[name];
		if (isSchemaNode(child)) return child;
	}
	const patterns = node.patternProperties;
	if (isSchemaNode(patterns)) {
		for (const [pattern, child] of Object.entries(patterns)) {
			if (!isSchemaNode(child)) continue;
			let matcher: RegExp;
			try {
				matcher = new RegExp(pattern);
			} catch {
				continue;
			}
			if (matcher.test(name)) return child;
		}
	}
	return undefined;
}

/**
 * What to do with a property no `properties`/`patternProperties` entry claims.
 *
 * `"drop"` is pi-lens's DEFAULT, and it differs from JSON Schema's, where a
 * missing `additionalProperties` means "allow anything". The policy in
 * `docs/public-api-stability.md` is warn-and-drop, so a schema opts INTO
 * openness with `additionalProperties: true` or a subschema instead of getting
 * it for free from an omission.
 */
export type AdditionalPropertyPolicy =
	| { readonly kind: "drop" }
	| { readonly kind: "keep" }
	| { readonly kind: "validate"; readonly schema: ConfigSchemaNode };

export function additionalPropertyPolicy(
	node: ConfigSchemaNode | undefined,
): AdditionalPropertyPolicy {
	const declared = node?.additionalProperties;
	if (declared === true) return { kind: "keep" };
	if (isSchemaNode(declared)) return { kind: "validate", schema: declared };
	return { kind: "drop" };
}

/** The `items` subschema of an array node, when it is a single schema. */
export function itemsSchema(
	node: ConfigSchemaNode | undefined,
): ConfigSchemaNode | undefined {
	const declared = node?.items;
	return isSchemaNode(declared) ? declared : undefined;
}
