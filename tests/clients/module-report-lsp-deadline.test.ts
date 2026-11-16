/**
 * The live-LSP tier of module_report stays inside its wall budget (#256).
 *
 * Recurrence this guards: the sweep's shared deadline is the only bound on a
 * `references` or `implementation` probe of a server that accepts the request
 * and never answers. #5550 moved that deadline from `withinRemaining` onto
 * `withDeadline`; a move that dropped it would hold the module_report call for
 * as long as the server stays silent, the #256 shape the module's header names.
 * The module is parked (#1090), so this is its only bound check.
 */
import { afterEach, describe, expect, it } from "vitest";
import { _setServersForFileForTests } from "../../clients/lsp/config.js";
import { enrichModuleReportWithLsp } from "../../clients/module-report-lsp.js";
import type { Symbol as ExtractedSymbol } from "../../clients/symbol-types.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";

const held: Array<(value: never[]) => void> = [];

/** A probe the server accepted and has not answered; settled in `afterEach`. */
const silent = () =>
	new Promise<never[]>((resolve) => {
		held.push(resolve);
	});

afterEach(() => {
	for (const resolve of held.splice(0)) resolve([]);
	_setServersForFileForTests(undefined);
});

describe("module_report live-LSP enrichment", () => {
	it("answers with no LSP data at its deadline when the server never answers a probe", async () => {
		_setServersForFileForTests(() => [{ id: "fake" }] as never);
		await installLspServiceDouble({
			references: silent,
			implementation: silent,
		});
		const target: ExtractedSymbol = {
			id: "/w/a.ts:Greeter:interface",
			name: "Greeter",
			kind: "interface",
			filePath: "/w/a.ts",
			line: 1,
			column: 1,
		};
		const result = await enrichModuleReportWithLsp(
			"/w/a.ts",
			["export interface Greeter {}"],
			[target],
			10,
			50,
		);
		expect(result.source).toBe("none");
		expect(result.byName.size).toBe(0);
		expect(held.length).toBe(2);
	}, 3000);
});
