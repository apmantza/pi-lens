/**
 * #3539 review round 1 — how an owner tag is read and parsed.
 *
 * The POSIX orphan backstop reaps a process whose owner tag
 * (`PI_LENS_OWNER=<pid>:<start>`) names a dead incarnation. Three ways a
 * read could make a live owner look dead, each pinned here through the seam
 * the tag read goes through (`scripts/lib/process-scan.mjs`, and the spawn
 * collector for macOS), so every platform's branch runs on every host:
 *
 * - F1: a process in another pid namespace carries a pid that names some
 *   other process here. It must read as untagged, never as a dead owner.
 * - a tag of a longer shape than this code writes (say a later
 *   `pid:start:namespace`) must not parse as a tag whose start never
 *   matches.
 * - F5: macOS `ps -E -p` exits non-zero when a requested pid is gone; that
 *   is a clean answer for that pid, not a failed read of the rest.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	namespaces: new Map<number, string | undefined>(),
	environ: new Map<number, string>(),
	collected: { stdout: "", status: "ok" as string },
}));

vi.mock("../../scripts/lib/process-scan.mjs", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../scripts/lib/process-scan.mjs")
	>()),
	readLinuxPidNamespace: (pid: number) =>
		pid === process.pid ? "pid:[own]" : h.namespaces.get(pid),
	readLinuxProcessEnvironmentVariable: (pid: number) => h.environ.get(pid),
}));

vi.mock("../../clients/child-unref.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/child-unref.js")>()),
	spawnCollectStdoutResult: async () => ({ ...h.collected }),
}));

const { parseOwnerTag, readOwnerTags } =
	await import("../../clients/process-snapshot.js");

const realPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

afterEach(() => {
	setPlatform(realPlatform);
	h.namespaces.clear();
	h.environ.clear();
	h.collected = { stdout: "", status: "ok" };
});

describe("parseOwnerTag", () => {
	it("reads the two start shapes this code writes", () => {
		expect(parseOwnerTag("12:34567")).toEqual({ pid: 12, start: "34567" });
		expect(parseOwnerTag("12:2026-09-26T09:26:02.000Z")).toEqual({
			pid: 12,
			start: "2026-09-26T09:26:02.000Z",
		});
	});

	it("reads a longer tag as no tag, never as a tag whose start cannot match", () => {
		expect(parseOwnerTag("12:34567:pid:[4026531836]")).toBeUndefined();
		expect(parseOwnerTag("12:not-a-start")).toBeUndefined();
	});

	it("reads pid 0 as no owner", () => {
		expect(parseOwnerTag("0:34567")).toBeUndefined();
	});
});

describe("readOwnerTags on Linux: the pid namespace (F1)", () => {
	it("returns the tag of a process in this pid namespace", async () => {
		setPlatform("linux");
		h.namespaces.set(7, "pid:[own]");
		h.environ.set(7, "5:100");

		const { tags } = await readOwnerTags([7], { timeoutMs: 1_000 });

		expect(tags.get(7)).toEqual({ pid: 5, start: "100" });
	});

	it("returns no tag for a process in another pid namespace", async () => {
		setPlatform("linux");
		h.namespaces.set(7, "pid:[container]");
		h.environ.set(7, "1:100");

		const { tags } = await readOwnerTags([7], { timeoutMs: 1_000 });

		expect(tags.has(7)).toBe(false);
	});

	it("returns no tag when the namespace cannot be read", async () => {
		setPlatform("linux");
		h.environ.set(7, "5:100");

		const { tags } = await readOwnerTags([7], { timeoutMs: 1_000 });

		expect(tags.has(7)).toBe(false);
	});
});

describe("readOwnerTags on macOS: ps -E (F5)", () => {
	const row = "  7 /usr/bin/node x.js PI_LENS_OWNER=5:2026-09-26T09:26:02.000Z";

	it("a pid that vanished (ps exits non-zero) is a clean answer, not a failed read", async () => {
		setPlatform("darwin");
		h.collected = { stdout: `${row}\n`, status: "exit-error" };

		const result = await readOwnerTags([7, 8], { timeoutMs: 1_000 });

		expect(result.status).toBe("ok");
		expect(result.tags.get(7)).toEqual({
			pid: 5,
			start: "2026-09-26T09:26:02.000Z",
		});
	});

	it("a timed-out query is still reported as one", async () => {
		setPlatform("darwin");
		h.collected = { stdout: "", status: "timeout" };

		const result = await readOwnerTags([7], { timeoutMs: 1_000 });

		expect(result.status).toBe("timeout");
	});
});
