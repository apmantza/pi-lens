import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readJsonCache,
	readJsonCacheAsync,
} from "../../clients/json-cache-read.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-json-cache-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
	const filePath = path.join(tmpDir, name);
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("readJsonCache", () => {
	it("returns the validated value on a valid, well-shaped cache", () => {
		const filePath = writeFile("ok.json", JSON.stringify({ version: 1, n: 1 }));
		const result = readJsonCache<{ version: number; n: number }>(
			filePath,
			(parsed) => {
				const v = parsed as { version?: unknown; n?: unknown };
				if (v?.version !== 1 || typeof v.n !== "number") return undefined;
				return { version: v.version, n: v.n };
			},
		);
		expect(result).toEqual({ version: 1, n: 1 });
	});

	it("returns undefined on corrupt JSON", () => {
		const filePath = writeFile("corrupt.json", "{ not: valid json");
		const result = readJsonCache(filePath, (parsed) => parsed);
		expect(result).toBeUndefined();
	});

	it("returns undefined when validate rejects a valid-but-wrong-shape payload", () => {
		const filePath = writeFile(
			"wrong-shape.json",
			JSON.stringify({ version: 999, n: "not-a-number" }),
		);
		const result = readJsonCache<{ version: number; n: number }>(
			filePath,
			(parsed) => {
				const v = parsed as { version?: unknown; n?: unknown };
				if (v?.version !== 1 || typeof v.n !== "number") return undefined;
				return { version: v.version, n: v.n };
			},
		);
		expect(result).toBeUndefined();
	});

	it("returns undefined when the file doesn't exist", () => {
		const filePath = path.join(tmpDir, "missing.json");
		const result = readJsonCache(filePath, (parsed) => parsed);
		expect(result).toBeUndefined();
	});

	it("invokes onError with the caught error before returning undefined", () => {
		const filePath = writeFile("corrupt2.json", "not json at all");
		const errors: unknown[] = [];
		const result = readJsonCache(
			filePath,
			(parsed) => parsed,
			(err) => errors.push(err),
		);
		expect(result).toBeUndefined();
		expect(errors).toHaveLength(1);
	});

	it("swallows an onError callback that itself throws, still returning undefined", () => {
		const filePath = path.join(tmpDir, "missing2.json");
		const result = readJsonCache(
			filePath,
			(parsed) => parsed,
			() => {
				throw new Error("onError blew up");
			},
		);
		expect(result).toBeUndefined();
	});

	it("returns undefined when validate itself throws", () => {
		const filePath = writeFile("throws-in-validate.json", JSON.stringify({}));
		const result = readJsonCache(filePath, () => {
			throw new Error("validate blew up");
		});
		expect(result).toBeUndefined();
	});
});

describe("readJsonCacheAsync", () => {
	it("returns the validated value on a valid, well-shaped cache", async () => {
		const filePath = writeFile("ok-async.json", JSON.stringify({ n: 42 }));
		const result = await readJsonCacheAsync<{ n: number }>(
			filePath,
			(parsed) => {
				const v = parsed as { n?: unknown };
				return typeof v?.n === "number" ? { n: v.n } : undefined;
			},
		);
		expect(result).toEqual({ n: 42 });
	});

	it("returns undefined on corrupt JSON", async () => {
		const filePath = writeFile("corrupt-async.json", "{ nope");
		const result = await readJsonCacheAsync(filePath, (parsed) => parsed);
		expect(result).toBeUndefined();
	});

	it("returns undefined when validate rejects a valid-but-wrong-shape payload", async () => {
		const filePath = writeFile(
			"wrong-shape-async.json",
			JSON.stringify({ n: "nope" }),
		);
		const result = await readJsonCacheAsync<{ n: number }>(
			filePath,
			(parsed) => {
				const v = parsed as { n?: unknown };
				return typeof v?.n === "number" ? { n: v.n } : undefined;
			},
		);
		expect(result).toBeUndefined();
	});

	it("returns undefined when the file doesn't exist", async () => {
		const filePath = path.join(tmpDir, "missing-async.json");
		const result = await readJsonCacheAsync(filePath, (parsed) => parsed);
		expect(result).toBeUndefined();
	});
});
