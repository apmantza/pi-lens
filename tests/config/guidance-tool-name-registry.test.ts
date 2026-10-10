/**
 * #2967 R4. The session-start renderer spells each tool name as a string
 * literal and gates it against `disabledToolNames`. A registry rename would
 * leave those literals naming the old tool, so `disabled.has` never matches
 * and gating silently stops. Runtime observation cannot see the intent (the
 * renderer would simply print the stale name), so the reference set is the
 * literals themselves; this scan ties that set to the registry identity owner,
 * `TOOL_REGISTRY` (`clients/tool-config.ts`), which is the one source of truth
 * for the model-facing roster (#2800).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";

const REGISTRY_PI_NAMES = new Set<string>(
	TOOL_REGISTRY.flatMap((tool) => (tool.piName ? [tool.piName] : [])),
);

describe("session-start orientation tool names are registry identities (#2967)", () => {
	it("references only TOOL_REGISTRY piNames", () => {
		const source = readFileSync(
			path.join(process.cwd(), "clients/runtime-session.ts"),
			"utf8",
		);
		const start = source.indexOf(
			"export interface SessionStartGuidanceOptions",
		);
		const end = source.indexOf("export async function handleSessionStart");
		expect(start, "renderer region start").toBeGreaterThan(-1);
		expect(end, "renderer region end").toBeGreaterThan(start);
		const region = source.slice(start, end);
		// A bare identifier double-quoted literal is a tool name; role phrases
		// ("ranked identifier search") and arg spellings ("source=session")
		// contain characters this shape excludes.
		const referenced = [
			...new Set(
				[...region.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]),
			),
		];
		// A broken extraction must not pass silently.
		expect(referenced.length).toBeGreaterThan(0);
		expect(referenced.filter((name) => !REGISTRY_PI_NAMES.has(name))).toEqual(
			[],
		);
	});
});
