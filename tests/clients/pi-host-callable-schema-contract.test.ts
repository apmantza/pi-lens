/**
 * Host contract: a CALLABLE tool-parameter schema survives registration
 * (#3195).
 *
 * The recurrence this file prevents: `withConsoleCaptureWindows`'s
 * `wrapFunctionsInPlace` replaced EVERY function-valued own property of a
 * register argument with `inCaptureWindow(fn)`. pi-lens's schema builder is
 * host-provided (`clients/deps/typebox.ts` — the host resolves the bare
 * `typebox` specifier), and on a host whose builders are ArkType-style the
 * schema IS a function, so `tool.parameters` was swapped for an anonymous
 * rest wrapper carrying neither `toJsonSchema` nor `assert`. Every xd://
 * device then rendered `type Args = unknown;` and rejected every call with
 * `root: schema must be an object or boolean` (13 of 13 registered tools,
 * reproduced through this same activation path).
 *
 * The upstream contract, read out of the reporter's host rather than
 * paraphrased from the report:
 *   - `@oh-my-pi/pi-coding-agent@18.2.4`
 *     `src/extensibility/plugins/legacy-pi-compat.ts:1135` rewrites an
 *     extension's `typebox` import to `src/extensibility/legacy-typebox.ts`,
 *     which re-exports `@oh-my-pi/omptype`'s builders ("omptype's builders
 *     return callable schema values", legacy-typebox.ts:44-58).
 *   - `@oh-my-pi/pi-ai@18.2.4` `src/utils/schema/wire.ts:21-27` defines
 *     `isArkSchema` — `typeof value === "function"` AND a `toJsonSchema`
 *     method AND an `assert` method — and `toolWireSchema`
 *     (wire.ts:602-604) takes its ark branch only when that holds.
 *   - `@oh-my-pi/pi-coding-agent@18.2.4` `src/extensibility/tool-proxy.ts:26`
 *     leaves a value passing that predicate untouched for the same reason a
 *     `bind()` would break it: the derived function "drops the schema
 *     surface (`toJsonSchema`/`assert`/own keys)".
 *
 * `ARK_SCHEMA_VECTOR` records what a real `@oh-my-pi/omptype@18.2.4`
 * `Type.Object({...})` measured on 2026-09-17, so `arkStyleTypeBuilder`'s
 * fixture cannot quietly drift into a shape no host produces. omptype is the
 * HOST's package, not a pi-lens dependency, so the shape is mirrored here
 * rather than imported; nothing in this repo re-reads the live upstream
 * predicate, so a change to it upstream reaches us through a report, not a
 * red test.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../../index.js";
import { createPiMock } from "../support/pi-mock.js";

/**
 * Verbatim from `@oh-my-pi/pi-ai@18.2.4` `src/utils/schema/wire.ts:21-27`.
 * The test asserts against the HOST's predicate, not against pi-lens's copy
 * of it, so a fix that only satisfies our own spelling still fails here.
 */
function isArkSchema(value: unknown): boolean {
	return (
		typeof value === "function" &&
		typeof (value as { toJsonSchema?: unknown }).toJsonSchema === "function" &&
		typeof (value as { assert?: unknown }).assert === "function"
	);
}

/**
 * Measured from a real `@oh-my-pi/omptype@18.2.4` `Type.Object({ file:
 * Type.Optional(Type.String({ description: "x" })) })` (2026-09-17):
 * `typeof` is "function"; `toJsonSchema`/`assert` are INHERITED (own keys are
 * omptype internals — `ir`, `run`, `$`, `__validator`, `safeParse`, …, plus
 * four omptype symbols); `JSON.stringify` of the schema is `undefined`, which
 * is why a wrapped schema degrades to `unknown` on the wire.
 */
const ARK_SCHEMA_VECTOR = {
	typeOf: "function",
	markersAreOwnProperties: false,
	jsonStringify: undefined,
	isArkSchema: true,
} as const;

/** The plain JSON-Schema document a callable fixture was built from. */
function plainSchemaKey(): symbol {
	return Symbol.for("pi-lens.test.plainSchema");
}

/**
 * An ArkType-style callable schema over a plain JSON-Schema document, shaped
 * like omptype's: a callable whose PROTOTYPE (not own properties) carries
 * `toJsonSchema` and `assert`, per ARK_SCHEMA_VECTOR.
 */
function callableSchema(plain: Record<string, unknown>): unknown {
	const proto = Object.create(Function.prototype) as Record<string, unknown>;
	proto.toJsonSchema = () => plain;
	proto.assert = (data: unknown) => data;
	const schema = (data: unknown) => data;
	Object.setPrototypeOf(schema, proto);
	Object.defineProperty(schema, plainSchemaKey(), { value: plain });
	return schema;
}

/** Recover the plain document a callable fixture wraps, at any depth. */
function toPlain(value: unknown): unknown {
	if (typeof value === "function") {
		return plainSchemaKey() in value
			? (value as unknown as Record<symbol, unknown>)[plainSchemaKey()]
			: (value as unknown);
	}
	if (Array.isArray(value)) return value.map(toPlain);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, toPlain(inner)]),
		);
	}
	return value;
}

/**
 * Wrap the REAL typebox builders so each one returns a callable schema over
 * the document typebox itself produced: the schema CONTENT stays the host-
 * independent truth (real `Type.Object`/`Type.Optional` composition, so a
 * mis-modelled builder cannot pass), and only the callable-ness — the axis
 * under test — comes from the reporter's host.
 */
function arkStyleTypeBuilder(actualType: Record<string, unknown>): unknown {
	return new Proxy(actualType, {
		get(target, prop) {
			const builder = Reflect.get(target, prop);
			if (typeof builder !== "function") return builder;
			return (...args: unknown[]) => {
				const plain = (builder as (...a: unknown[]) => unknown)(
					...(args.map(toPlain) as unknown[]),
				);
				return callableSchema(plain as Record<string, unknown>);
			};
		},
	});
}

vi.mock("../../clients/deps/typebox.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/deps/typebox.js")>();
	return {
		Type: arkStyleTypeBuilder(
			actual.Type as unknown as Record<string, unknown>,
		),
	};
});

describe("#3195 — a callable parameters schema survives tool registration", () => {
	it("pins the callable-schema shape this fixture mirrors", () => {
		const schema = callableSchema({
			type: "object",
			properties: { file: { type: "string" } },
		}) as {
			toJsonSchema: () => Record<string, unknown>;
			assert: (value: unknown) => unknown;
		};
		expect(typeof schema).toBe(ARK_SCHEMA_VECTOR.typeOf);
		expect(
			Object.hasOwn(schema, "toJsonSchema") || Object.hasOwn(schema, "assert"),
		).toBe(ARK_SCHEMA_VECTOR.markersAreOwnProperties);
		expect(JSON.stringify(schema)).toBe(ARK_SCHEMA_VECTOR.jsonStringify);
		expect(isArkSchema(schema)).toBe(ARK_SCHEMA_VECTOR.isArkSchema);
		expect(schema.toJsonSchema().type).toBe("object");
		expect(schema.assert({ file: "a.ts" })).toEqual({ file: "a.ts" });
	});

	it("keeps every registered tool's schema readable by the host", () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		const tools = [...pi.tools.values()] as Array<{
			name: string;
			parameters?: unknown;
		}>;
		expect(tools.length).toBeGreaterThan(0);
		const withSchema = tools.filter((tool) => tool.parameters !== undefined);
		// Guards the mock itself: on the stock host these are plain objects, so
		// a fixture that failed to apply makes this fail rather than pass
		// vacuously.
		expect(withSchema.map((tool) => typeof tool.parameters)).toEqual(
			withSchema.map(() => "function"),
		);
		expect(withSchema.length).toBe(tools.length);

		const degraded = withSchema.filter((tool) => !isArkSchema(tool.parameters));
		expect(degraded.map((tool) => tool.name)).toEqual([]);

		// The host reads the wire schema through `toJsonSchema()`; every tool's
		// must still carry its real field set (not `unknown`).
		for (const tool of withSchema) {
			const schema = tool.parameters as {
				toJsonSchema: () => Record<string, unknown>;
			};
			const wire = schema.toJsonSchema();
			expect(wire.type, `${tool.name} wire schema`).toBe("object");
			expect(typeof wire.properties, `${tool.name} wire properties`).toBe(
				"object",
			);
		}
	});
});

describe("#3195 — the console-capture seam, directly", () => {
	let tempHome: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3195-"));
		for (const key of [
			"PI_LENS_TEST_MODE",
			"PI_LENS_HOME",
			"PI_LENS_CONSOLE_GUARD",
		]) {
			savedEnv[key] = process.env[key];
		}
		// The guard never installs in test mode, and `inCaptureWindow`'s window
		// is a no-op until it has (#1434 S1b) — so the capture assertion below
		// needs the guard really installed, against a throwaway home.
		process.env.PI_LENS_TEST_MODE = "0";
		process.env.PI_LENS_HOME = tempHome;
		delete process.env.PI_LENS_CONSOLE_GUARD;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	async function loadSink(): Promise<
		typeof import("../../clients/extension-log.js")
	> {
		vi.resetModules();
		return await import("../../clients/extension-log.js");
	}

	it("hands a callable schema to registerTool untouched", async () => {
		const sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(true);
		try {
			let registered: Record<string, unknown> | undefined;
			const proxy = sink.withConsoleCaptureWindows({
				registerTool(tool: Record<string, unknown>) {
					registered = tool;
				},
			});
			const schema = callableSchema({
				type: "object",
				properties: { file: { type: "string" } },
			});
			proxy.registerTool({
				name: "lens_diagnostics",
				parameters: schema,
				execute: () => "tool-result",
			});
			expect(registered?.parameters).toBe(schema);
			expect(isArkSchema(registered?.parameters)).toBe(true);
		} finally {
			sink.uninstallConsoleGuard();
		}
	});

	/**
	 * The loosening direction. `isCallableSchema` requires BOTH markers
	 * because upstream's `isArkSchema` does; relaxing it to either one
	 * (`toJsonSchema || assert`) is a one-character edit that reds nothing
	 * else — and it would drop the capture window from any handler that
	 * carries one of those names, which is the #1333 shape this seam exists
	 * to prevent (a pi-lens callback writing straight to pi's terminal).
	 * A validator callback carrying `assert` is the realistic member: it is
	 * callable, host-invoked, and NOT a schema by the host's own test.
	 */
	it("still wraps a handler that carries assert but no toJsonSchema", async () => {
		const sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(true);
		try {
			let registered: Record<string, unknown> | undefined;
			const proxy = sink.withConsoleCaptureWindows({
				registerTool(tool: Record<string, unknown>) {
					registered = tool;
				},
			});
			let sawWindow: boolean | undefined;
			const execute = Object.assign(
				() => {
					sawWindow = sink.isConsoleCaptureActive();
					return "tool-result";
				},
				{ assert: (value: unknown) => value },
			);
			// The host would not read this as a schema, so pi-lens must not
			// treat it as one either.
			expect(isArkSchema(execute)).toBe(false);
			proxy.registerTool({
				name: "lens_diagnostics",
				parameters: callableSchema({ type: "object", properties: {} }),
				execute,
			});
			expect(registered?.execute).not.toBe(execute);
			expect(registered?.execute).toBeDefined();
			expect((registered!.execute as () => unknown)()).toBe("tool-result");
			expect(sawWindow).toBe(true);
		} finally {
			sink.uninstallConsoleGuard();
		}
	});

	it("still opens a capture window around execute and renderResult beside a callable schema", async () => {
		const sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(true);
		try {
			let registered:
				| { execute?: () => unknown; renderResult?: () => unknown }
				| undefined;
			const proxy = sink.withConsoleCaptureWindows({
				registerTool(tool: Record<string, unknown>) {
					registered = tool as {
						execute?: () => unknown;
						renderResult?: () => unknown;
					};
				},
			});
			let executeSawWindow: boolean | undefined;
			let renderSawWindow: boolean | undefined;
			proxy.registerTool({
				name: "lens_diagnostics",
				parameters: callableSchema({ type: "object", properties: {} }),
				execute: () => {
					executeSawWindow = sink.isConsoleCaptureActive();
					return "tool-result";
				},
				renderResult: () => {
					renderSawWindow = sink.isConsoleCaptureActive();
					return "rendered";
				},
			});
			expect(sink.isConsoleCaptureActive()).toBe(false);
			expect(registered?.execute?.()).toBe("tool-result");
			expect(registered?.renderResult?.()).toBe("rendered");
			expect(executeSawWindow).toBe(true);
			expect(renderSawWindow).toBe(true);
		} finally {
			sink.uninstallConsoleGuard();
		}
	});
});
