import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.js");

const statSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	statSync: statSyncMock,
}));

import {
	isSpawnableCommand,
	resetPathWalkMemo,
} from "../../../clients/installer/index.js";

import {
	setProjectTrustState,
	resetProjectTrust,
} from "../../../clients/project-trust.js";

const savedPath = process.env.PATH;

describe("bare-command PATH availability memo", () => {
	beforeEach(() => {
		setProjectTrustState("trusted");
		process.env.PATH = "memo-path";
		resetPathWalkMemo();
		statSyncMock.mockReset();
		statSyncMock.mockReturnValue({ isFile: () => true, size: 1 });
	});

	afterEach(() => {
		resetProjectTrust();
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		resetPathWalkMemo();
	});

	it("memoizes PATH walk: N hits = 1 statSync call", async () => {
		for (let i = 0; i < 5; i += 1) {
			expect(await isSpawnableCommand("memo-tool")).toBe(true);
		}
		expect(statSyncMock).toHaveBeenCalledOnce();

		resetPathWalkMemo();
		expect(await isSpawnableCommand("memo-tool")).toBe(true);
		expect(statSyncMock).toHaveBeenCalledTimes(2);
	});
});
