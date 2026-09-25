/**
 * Coverage enforcement for `withConsoleCaptureWindows` (#1434 S1a review).
 *
 * The proxy wraps every `on`/`register*` member of the host `ExtensionAPI` so
 * a handler or tool body runs inside a console-capture window, regardless of
 * which member registered it. The member LIST here is DERIVED from the
 * host's own shipped `.d.ts` — not hand-maintained — so a `register*` method
 * the host adds later, or one pi-lens does not call yet, is exercised too.
 * Same shape as `tests/clients/managed-tool-seam-coverage.test.ts` (#1290):
 * a structural test over the real source, not a list a human keeps in sync.
 *
 * The earlier allow-list form (only `on` and `registerTool` wrapped) let the
 * 9 `registerCommand` call sites and `registerMessageRenderer` bypass the
 * window, regressing #1333 for those paths — this test would have failed on
 * that code.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchingCloseIndex } from "../support/sweep-kit.js";

const TYPES_FILE = path.resolve(
	"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts",
);

/** Strip `/* */ ` and `; // ...` comments so they cannot confuse brace counting. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The text between the outermost `{` `}` of `export interface ExtensionAPI`. */
function extractInterfaceBody(source: string, interfaceName: string): string {
	const marker = `interface ${interfaceName} {`;
	const markerStart = source.indexOf(marker);
	if (markerStart === -1) {
		throw new Error(
			`could not find "interface ${interfaceName} {" in ${TYPES_FILE}`,
		);
	}
	const openBrace = markerStart + marker.length - 1;
	const close = matchingCloseIndex(source, openBrace, "{", "}");
	if (close === -1)
		throw new Error("unbalanced braces while scanning interface body");
	return source.slice(openBrace + 1, close);
}

/**
 * Every member name declared at the TOP LEVEL of an interface body (not
 * inside a nested object-type-literal parameter, like `registerShortcut`'s
 * `options: { ... }`). A member's name always appears on the line where the
 * running brace depth is 0 — nested-object lines never start with
 * `identifier(` or `identifier<`.
 */
function extractTopLevelMemberNames(body: string): Set<string> {
	const names = new Set<string>();
	let depth = 0;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (depth === 0) {
			const match = line.match(/^(\w+)\s*[(<]/);
			if (match) names.add(match[1]);
		}
		for (const ch of line) {
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
		}
	}
	return names;
}

function deriveCaptureSeamMembers(): string[] {
	const source = stripComments(fs.readFileSync(TYPES_FILE, "utf8"));
	const body = extractInterfaceBody(source, "ExtensionAPI");
	const all = extractTopLevelMemberNames(body);
	return [...all].filter(
		(name) => name === "on" || name.startsWith("register"),
	);
}

describe("withConsoleCaptureWindows member coverage, derived from the host's own type (#1434)", () => {
	it("extracts a non-trivial, sane member list from the shipped .d.ts", () => {
		const members = deriveCaptureSeamMembers();
		// Sanity floor, not a hand-maintained list: prove the extraction actually
		// found the well-known seams, so a parser regression (e.g. the marker
		// string changing) fails loudly here instead of silently emptying the
		// derived set and vacuously "passing" the coverage test below.
		for (const known of [
			"on",
			"registerTool",
			"registerCommand",
			"registerMessageRenderer",
			"registerShortcut",
			"registerFlag",
			"registerMarkdownTransformer",
			"registerEntryRenderer",
			"registerProvider",
		]) {
			expect(members).toContain(known);
		}
		// unregisterProvider does not start with "register" and must stay out.
		expect(members).not.toContain("unregisterProvider");
		expect(members).not.toContain("getFlag");
		expect(members).not.toContain("sendMessage");
	});
});

describe("withConsoleCaptureWindows proxy behavior (#1434)", () => {
	let tempHome: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-1434-coverage-"));
		for (const key of [
			"PI_LENS_TEST_MODE",
			"PI_LENS_HOME",
			"PI_LENS_CONSOLE_GUARD",
		]) {
			savedEnv[key] = process.env[key];
		}
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

	it("wraps a top-level function AND a nested one for every derived member — none exempt", async () => {
		const sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(true);
		try {
			const members = deriveCaptureSeamMembers();
			expect(members.length).toBeGreaterThan(0);

			for (const member of members) {
				const calls: unknown[][] = [];
				const target: Record<string, unknown> = {
					[member](...args: unknown[]) {
						calls.push(args);
						return this === target ? this : undefined;
					},
				};
				const proxy = sink.withConsoleCaptureWindows(target);

				const topLevelFn = () => sink.isConsoleCaptureActive();
				const nestedHandlerFn = () => sink.isConsoleCaptureActive();
				// A large sibling property on the options object, mirroring a real
				// tool's `parameters`/schema -- proves wrapping does not descend
				// into it (the perf fix: only the object's own top-level keys are
				// checked for a function value).
				const bulkyUnrelatedProp = { a: { b: { c: { d: "leaf" } } } };
				const optionsArg = {
					handler: nestedHandlerFn,
					schema: bulkyUnrelatedProp,
				};

				(proxy[member] as (...a: unknown[]) => unknown)(topLevelFn, optionsArg);

				expect(calls).toHaveLength(1);
				const [passedTopFn, passedOptions] = calls[0] as [
					() => boolean,
					{ handler: () => boolean; schema: unknown },
				];

				// Identity must have changed -- the raw function never reaches the
				// host unwrapped, at either of the two positions a real host
				// signature puts one (top-level, one level deep in an options/tool
				// object -- e.g. `options.handler`, `tool.execute`).
				expect(passedTopFn).not.toBe(topLevelFn);
				expect(passedOptions.handler).not.toBe(nestedHandlerFn);
				// The unrelated nested object is untouched (same reference) --
				// confirms wrapping did not walk into it.
				expect(passedOptions.schema).toBe(bulkyUnrelatedProp);

				// And calling the wrapped forms actually opens the window.
				expect(sink.isConsoleCaptureActive()).toBe(false);
				expect(passedTopFn()).toBe(true);
				expect(passedOptions.handler()).toBe(true);
				expect(sink.isConsoleCaptureActive()).toBe(false);
			}
		} finally {
			sink.uninstallConsoleGuard();
		}
	});

	it("does not wrap a non-register/on pass-through member's functions", async () => {
		const sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(true);
		try {
			const original = () => "unwrapped";
			const target = { getFlag: () => original };
			const proxy = sink.withConsoleCaptureWindows(target);
			expect(proxy.getFlag()).toBe(original);
		} finally {
			sink.uninstallConsoleGuard();
		}
	});

	it("proxy.on === proxy.on (memoized wrapper, S3b)", async () => {
		const sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(true);
		try {
			const target = { on() {}, unrelated: () => {} };
			const proxy = sink.withConsoleCaptureWindows(target);
			expect(proxy.on).toBe(proxy.on);
			expect(proxy.unrelated).toBe(proxy.unrelated);
			// Two different proxies over two different targets never share a cache.
			const proxy2 = sink.withConsoleCaptureWindows({ on() {} });
			expect(proxy2.on).not.toBe(proxy.on);
		} finally {
			sink.uninstallConsoleGuard();
		}
	});

	it("binds a pass-through function to target so `this` survives destructuring (S3a)", async () => {
		const sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(true);
		try {
			const target = {
				secret: 42,
				getSecret(): number {
					return (this as { secret: number }).secret;
				},
			};
			const proxy = sink.withConsoleCaptureWindows(target);
			const { getSecret } = proxy;
			expect(getSecret()).toBe(42);
		} finally {
			sink.uninstallConsoleGuard();
		}
	});

	it("degrades to the raw value for a frozen, non-configurable register* member (S2a)", async () => {
		const sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(true);
		try {
			const rawOn = () => "raw-on-result";
			const target: Record<string, unknown> = {};
			Object.defineProperty(target, "on", {
				value: rawOn,
				writable: false,
				configurable: false,
				enumerable: true,
			});
			const proxy = sink.withConsoleCaptureWindows(target);
			// Reading it must not throw the proxy-invariant TypeError, and must
			// hand back the exact original function, unwrapped.
			expect(proxy.on).toBe(rawOn);
		} finally {
			sink.uninstallConsoleGuard();
		}
	});

	it("falls back through defineProperty, then to unwrapped-but-registered, for a resistant tool.execute (S2b)", async () => {
		const sink = await loadSink();
		expect(sink.installConsoleGuard()).toBe(true);
		try {
			let registered: { execute?: () => string } | undefined;
			const target = {
				registerTool(tool: { execute?: () => string }) {
					registered = tool;
				},
			};
			const proxy = sink.withConsoleCaptureWindows(target);

			// A tool object whose `execute` is a non-writable, but CONFIGURABLE,
			// data property: assignment throws, but Object.defineProperty can
			// still redefine it -- the "second rung" of the S2b ladder.
			const originalExecute = () => "tool-ran";
			const tool: { execute?: () => string } = {};
			Object.defineProperty(tool, "execute", {
				value: originalExecute,
				writable: false,
				configurable: true,
				enumerable: true,
			});
			proxy.registerTool(tool);
			expect(registered?.execute).not.toBe(originalExecute);
			expect(registered?.execute?.()).toBe("tool-ran");

			// A tool object whose `execute` resists BOTH assignment and
			// defineProperty (non-writable, non-configurable): total failure
			// degrades to registering the tool with its ORIGINAL function rather
			// than throwing or dropping the registration.
			const frozenExecute = () => "frozen-tool-ran";
			const frozenTool: { execute?: () => string } = {};
			Object.defineProperty(frozenTool, "execute", {
				value: frozenExecute,
				writable: false,
				configurable: false,
				enumerable: true,
			});
			expect(() => proxy.registerTool(frozenTool)).not.toThrow();
			expect(registered?.execute).toBe(frozenExecute);
		} finally {
			sink.uninstallConsoleGuard();
		}
	});
});
