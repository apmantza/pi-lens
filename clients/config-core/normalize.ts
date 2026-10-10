/**
 * The validate/normalize half of the config pipeline (#2425, scope item 1).
 *
 * `RawConfig` (whatever `JSON.parse` returned) -> `validate(schema)` ->
 * `NormalizedConfig` (only fields the schema claims, each of the declared
 * shape). `merge.ts` then combines normalized configs across tiers, so the
 * merger never has to ask whether a value is the type it looks like.
 *
 * Four rules, the first three from `docs/public-api-stability.md`:
 *
 * 1. NEVER THROW. A user's config file is untrusted input; a schema violation
 *    degrades that field to absent and records why. A throw here would take
 *    down a session over a typo.
 * 2. UNKNOWN FIELDS ARE DROPPED, NOT KEPT. pi-lens's default is closed, unlike
 *    JSON Schema's — a schema opts into openness with `additionalProperties`.
 *    Keeping unknown fields would make every typo a silently-ignored setting,
 *    which is the failure users actually report.
 * 3. EVERY DROP IS RECORDED, with a stable `PILENS_CFG_*` code and a reason
 *    built from structure alone. No value ever reaches a record.
 * 4. THE WALK NEVER STOPS EARLY, and a user subtree is never passed through.
 *    Every node the validator returns was BUILT here, key by key, out of values
 *    this module checked. There is no arm on which a caller's object becomes
 *    part of the result by assertion.
 *
 * Rule 4 is the #2440 review finding, and it is worth stating why the two
 * pass-through arms it replaces were wrong rather than merely untidy. A schema
 * node that declares no `type` used to hand its value straight to the domain
 * type with `as ConfigValue`. That single assertion cost three properties at
 * once: the subtree's keys never met the prototype-key policy, so a
 * `{"__proto__": {...}}` node reached `out[name] = …` in BOTH builders and
 * re-parented the accumulator (serializing as `{}` while answering the
 * attacker's value on every field read); the subtree's depth was never counted,
 * so `MAX_CONFIG_DEPTH` bounded only the paths the schema happened to describe
 * and a 4000-deep blob went to the merger intact and overflowed the stack there;
 * and no record was produced for anything inside it, so the drop the pipeline
 * promises to explain was invisible. An always-walking normalizer fixes all
 * three by construction, which is the reason it is one normalizer and not three
 * patches.
 *
 * An OPAQUE node is still walked OPEN, not closed: a schema that claims nothing
 * about a node keeps that node's children, exactly as the pass-through did. What
 * changes is that they are copied, depth-counted, key-checked, and recorded. A
 * node that DOES name properties keeps its own (closed-by-default) policy.
 *
 * The walk is bounded on both axes that can grow: depth (a hand-written config
 * can nest arbitrarily) and record count (`MigrationRecordCollector`). Objects
 * already visited on the current path are refused, so a caller that hands in a
 * cyclic value gets a record rather than a stack overflow.
 */

import {
	type ConfigObject,
	type ConfigSchemaNode,
	type ConfigValue,
	additionalPropertyPolicy,
	isKnownSchemaType,
	isPlainObject,
	isSchemaNode,
	itemsSchema,
	propertySchema,
	schemaType,
} from "./schema.js";
import {
	isUnsafeConfigKey,
	MAX_CONFIG_DEPTH,
	safeAssign,
	UNSAFE_KEY_REASON,
} from "./safe-object.js";
import {
	boundedKeyLabel,
	jsonTypeName,
	MigrationRecordCollector,
	type MigrationRecord,
	migrationSubject,
} from "./records.js";
import type { SourceTier } from "./provenance.js";
import { errorClassName } from "../error-class.js";

/**
 * A config whose every field is one the schema claims, of the declared type.
 *
 * The "RawConfig" of the pipeline description is deliberately NOT a type alias
 * here: naming `unknown` adds a word and no information, and every consumer
 * would still narrow from scratch. The raw shape lives at exactly one place in
 * the codebase — `validate`'s first parameter — and says `unknown` there.
 */
export interface NormalizedConfig {
	/** `undefined` when the whole document was rejected. */
	readonly value: ConfigValue | undefined;
	readonly records: readonly MigrationRecord[];
	/** Records the bound discarded. Counted, never silently zero. */
	readonly droppedRecordCount: number;
}

/**
 * Re-exported from `safe-object.ts`, which owns it because `merge.ts` enforces
 * the same bound over values `validate()` may never have seen. Importers keep
 * their existing specifier; there is still one constant.
 */
export { MAX_CONFIG_DEPTH };

export interface ValidateOptions {
	/** The file the raw config came from, for the records' `file` field. */
	readonly file?: string;
	/**
	 * The tier this source was read at, for the records' `tier` field (#2426
	 * review round 3, F1) — `reportPiLensConfigRecords` needs it to route a
	 * pi-lens-owned record to the right subsystem.
	 */
	readonly tier?: SourceTier;
	/** Share one collector across several sources so the bound is per resolution. */
	readonly collector?: MigrationRecordCollector;
}

/** Sentinel for "this node produced no value". `undefined` is a legal JSON absence. */
const DROPPED = Symbol("dropped");

type Walked = ConfigValue | typeof DROPPED;

/**
 * The schema an opaque node's children are walked with: it governs nothing and
 * keeps everything. Spelled as a real node rather than `undefined` so the
 * "open" decision is made once, at the one place that decides it, instead of
 * being re-derived from an absent argument at every accessor.
 */
const OPEN_SCHEMA: ConfigSchemaNode = { additionalProperties: true };

export function validate(
	raw: unknown,
	schema: ConfigSchemaNode,
	options: ValidateOptions = {},
): NormalizedConfig {
	const collector = options.collector ?? new MigrationRecordCollector();
	const file = options.file ?? "";
	const context: WalkContext = {
		collector,
		file,
		tier: options.tier,
		path: [],
	};
	let walked: Walked;
	try {
		walked = walk(raw, schema, context, 0, new Set());
	} catch (error) {
		// A throw here is a bug in this module, not in the user's config, but the
		// contract above still holds: a config load never fails a session. The
		// record says the document was dropped and names the error CLASS only,
		// never its message, which could quote the file. `errorClassName` is the
		// ONE implementation of that (#2451) — not `config-warn.ts`'s own
		// `normalizeParseErrorReason`, which this "pure" module must not import:
		// that is a sink (-> the degradation ledger), and importing one back in is
		// exactly the cycle #2426 removed from `config-core/`.
		record(context, {
			code: "PILENS_CFG_0005",
			key: "",
			reason: `config validation failed internally (${errorClassName(error)}); document ignored`,
		});
		walked = DROPPED;
	}
	return {
		value: walked === DROPPED ? undefined : walked,
		records: collector.records,
		droppedRecordCount: collector.droppedCount,
	};
}

interface WalkContext {
	readonly collector: MigrationRecordCollector;
	readonly file: string;
	readonly tier: SourceTier | undefined;
	path: string[];
}

function pointerOf(path: readonly string[]): string {
	return path.length === 0 ? "" : `/${path.join("/")}`;
}

function record(
	context: WalkContext,
	entry: {
		code: MigrationRecord["code"];
		key: string;
		reason: string;
	},
): void {
	const key = boundedKeyLabel(entry.key);
	context.collector.add({
		code: entry.code,
		file: context.file,
		key,
		subject: migrationSubject(context.file, key),
		reason: entry.reason,
		tier: context.tier,
	});
}

function walk(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
	depth: number,
	onPath: Set<object>,
): Walked {
	const pointer = pointerOf(context.path);
	if (depth > MAX_CONFIG_DEPTH) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointer,
			reason: `config nesting exceeds ${MAX_CONFIG_DEPTH} levels; ignored`,
		});
		return DROPPED;
	}
	if (typeof value === "object" && value !== null) {
		if (onPath.has(value)) {
			record(context, {
				code: "PILENS_CFG_0005",
				key: pointer,
				reason: "config value refers to itself; ignored",
			});
			return DROPPED;
		}
	}

	const declared = schemaType(schema);
	if (declared === "object")
		return walkObject(value, schema, context, depth, onPath);
	if (declared === "array")
		return walkArray(value, schema, context, depth, onPath);
	if (isKnownSchemaType(declared)) {
		return walkScalar(value, schema, context, declared as string);
	}

	// No `type` keyword, or one the core does not recognize: the schema is
	// opaque about this node. The walk does not stop — see rule 4 in the module
	// docs — it dispatches on the VALUE's shape instead, so the node is still
	// copied, bounded, key-checked, and recorded. An unrecognized keyword is the
	// schema's problem, not the user's, and `merge.ts` reads it the same way.
	return walkOpaque(value, schema, context, depth, onPath);
}

/**
 * Walk a node the schema says nothing (useful) about.
 *
 * The dispatch is on the value, because that is the only thing left to dispatch
 * on. An object whose schema names no properties is walked OPEN — keeping its
 * children is what the old pass-through did, and dropping them now would turn a
 * defect fix into a silent feature removal. An object whose schema DOES name
 * properties keeps its own policy, which is closed by default.
 */
function walkOpaque(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
	depth: number,
	onPath: Set<object>,
): Walked {
	if (isPlainObject(value)) {
		const effective = claimsChildren(schema) ? schema : OPEN_SCHEMA;
		return walkObject(value, effective, context, depth, onPath);
	}
	if (Array.isArray(value)) {
		return walkArray(value, schema, context, depth, onPath);
	}
	return walkLeaf(value, schema, context);
}

/** True when the node declares something that governs its own children. */
function claimsChildren(schema: ConfigSchemaNode | undefined): boolean {
	if (!schema) return false;
	return (
		isSchemaNode(schema.properties) ||
		isSchemaNode(schema.patternProperties) ||
		schema.additionalProperties !== undefined
	);
}

/**
 * The one place a scalar enters the domain type, and it does so by NARROWING.
 *
 * `isConfigScalar` is a real predicate over the value, so nothing here asserts.
 * A value the JSON domain has no room for — `undefined`, a function, a symbol, a
 * bigint, `NaN`, an infinity — is dropped with a record rather than carried. A
 * parser cannot produce one, but `validate`'s input is `unknown` and a caller
 * handing in a live JS object can; `JSON.stringify` would silently turn `NaN`
 * into `null` several layers downstream, which is exactly the kind of quiet
 * corruption a validator exists to stop.
 */
function walkLeaf(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
): Walked {
	if (!isConfigScalar(value)) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointerOf(context.path),
			reason: `config value is not valid JSON data (${jsonTypeName(
				value,
			)}); ignored`,
		});
		return DROPPED;
	}
	return checkEnum(value, schema, context) ? value : DROPPED;
}

function isConfigScalar(
	value: unknown,
): value is string | number | boolean | null {
	if (value === null) return true;
	const type = typeof value;
	if (type === "string" || type === "boolean") return true;
	return type === "number" && Number.isFinite(value);
}

function walkObject(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
	depth: number,
	onPath: Set<object>,
): Walked {
	if (!isPlainObject(value)) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointerOf(context.path),
			reason: `expected an object, got ${jsonTypeName(value)}; ignored`,
		});
		return DROPPED;
	}
	const nextPath = onPath.add(value);
	const policy = additionalPropertyPolicy(schema);
	const out: ConfigObject = {};
	for (const [name, child] of Object.entries(value)) {
		// The prototype-key check runs BEFORE the schema is consulted. A schema
		// could name `__proto__` as a property, and an open node keeps every key
		// it is given; neither may reach the accumulator.
		if (rejectUnsafeKey(name, context)) continue;
		const childSchema = propertySchema(schema, name);
		let effective: ConfigSchemaNode | undefined = childSchema;
		if (!childSchema) {
			if (policy.kind === "drop") {
				context.path.push(name);
				record(context, {
					code: "PILENS_CFG_0004",
					key: pointerOf(context.path),
					reason: "unknown config field; ignored",
				});
				context.path.pop();
				continue;
			}
			// `keep` walks the child with no schema at all, which `walkOpaque`
			// reads as fully open; `validate` walks it with the declared one.
			effective = policy.kind === "validate" ? policy.schema : undefined;
		}
		context.path.push(name);
		const walked = walk(child, effective, context, depth + 1, nextPath);
		context.path.pop();
		if (walked !== DROPPED) safeAssign(out, name, walked);
	}
	nextPath.delete(value);
	return out;
}

/** Record and refuse a prototype-modifying key. Returns true when refused. */
function rejectUnsafeKey(name: string, context: WalkContext): boolean {
	if (!isUnsafeConfigKey(name)) return false;
	context.path.push(name);
	record(context, {
		code: "PILENS_CFG_0006",
		key: pointerOf(context.path),
		reason: UNSAFE_KEY_REASON,
	});
	context.path.pop();
	return true;
}

function walkArray(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
	depth: number,
	onPath: Set<object>,
): Walked {
	if (!Array.isArray(value)) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointerOf(context.path),
			reason: `expected an array, got ${jsonTypeName(value)}; ignored`,
		});
		return DROPPED;
	}
	const nextPath = onPath.add(value);
	const items = itemsSchema(schema);
	const out: ConfigValue[] = [];
	for (const [index, entry] of value.entries()) {
		context.path.push(String(index));
		const walked = walk(entry, items, context, depth + 1, nextPath);
		context.path.pop();
		if (walked !== DROPPED) out.push(walked);
	}
	nextPath.delete(value);
	return out;
}

/**
 * Type PREDICATES, not plain booleans: a check that only returned `true` would
 * leave the caller re-asserting the very fact it had just proved.
 */
const SCALAR_CHECKS: Readonly<
	Record<string, (value: unknown) => value is ConfigValue>
> = {
	string: (value): value is ConfigValue => typeof value === "string",
	number: (value): value is ConfigValue =>
		typeof value === "number" && Number.isFinite(value),
	integer: (value): value is ConfigValue =>
		typeof value === "number" && Number.isInteger(value),
	boolean: (value): value is ConfigValue => typeof value === "boolean",
	null: (value): value is ConfigValue => value === null,
};

/**
 * Check a node whose declared type is one of the five JSON scalars.
 *
 * `walk` has already established that `declared` is a recognized type and is
 * neither `object` nor `array`, so the lookup always hits. That is why there is
 * no pass-through arm here any more: the `!check` branch that used to return
 * `value as ConfigValue` was the second of the two assertion sites F1 named,
 * and the unrecognized-keyword case it existed for is now routed to
 * `walkOpaque` by the caller.
 */
function walkScalar(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
	declared: string,
): Walked {
	const check = SCALAR_CHECKS[declared];
	if (!check(value)) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointerOf(context.path),
			reason: `expected ${declared}, got ${jsonTypeName(value)}; ignored`,
		});
		return DROPPED;
	}
	const minLength = schema?.minLength;
	if (
		declared === "string" &&
		typeof minLength === "number" &&
		typeof value === "string" &&
		value.length < minLength
	) {
		record(context, {
			code: "PILENS_CFG_0005",
			key: pointerOf(context.path),
			reason: `string must contain at least ${minLength} character${minLength === 1 ? "" : "s"}; ignored`,
		});
		return DROPPED;
	}
	return checkEnum(value, schema, context) ? value : DROPPED;
}

/**
 * Enforce a declared `enum`. The record names the ALLOWED members, which are
 * schema text, and never the rejected value, which is user text.
 */
function checkEnum(
	value: unknown,
	schema: ConfigSchemaNode | undefined,
	context: WalkContext,
): boolean {
	const allowed = schema?.enum;
	if (!Array.isArray(allowed)) return true;
	if (allowed.some((candidate) => Object.is(candidate, value))) return true;
	record(context, {
		code: "PILENS_CFG_0005",
		key: pointerOf(context.path),
		reason: `value is not one of ${allowed
			.map((candidate) => JSON.stringify(candidate))
			.join(", ")}; ignored`,
	});
	return false;
}
