/**
 * #4403 (split for #3801): columns 13 to 15 of the diagnostics
 * route/switch matrix. Every route runs under each column and shows the state
 * table's row for it. The columns, the fixture and the expected rows live in
 * `tests/support/diagnostics-route-matrix-kit.ts`; the code-derived route scan
 * and the guard that the five files cover every column live in
 * `tests/tools/diagnostics-route-switch-matrix.test.ts`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { getLSPService } from "../../clients/lsp/index.js";
import { cleanupTestEnvironmentsDrained } from "../clients/test-utils.js";
import {
	PREFIX,
	columnsOfFile,
	expectedRow,
	runColumn,
} from "../support/diagnostics-route-matrix-kit.js";
import { useConfigPath } from "../support/global-config.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";

const setConfigPath = useConfigPath();

describe("every diagnostics route under every server-selecting switch (#4403)", () => {
	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await getLSPService().shutdown();
			},
		});
	});

	for (const column of columnsOfFile(5)) {
		it(
			`starts the same servers and gives the same verdict on every route: ${column.id}`,
			async () => {
				const observed = await runColumn(column, {
					setConfigPath,
					newPi: () => createPiMock(),
					newCtx: makeCtx,
				});

				expect(observed).toEqual(expectedRow(column));
			},
			scaledTestTimeout(180_000),
		);
	}
});
