import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	findLocalTyposConfig,
	LOCAL_TYPOS_CONFIG_NAMES,
} from "../../clients/typos-config.js";

describe("findLocalTyposConfig (#283)", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "typos-cfg-"));
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("finds a root-level typos.toml", () => {
		const cfg = path.join(root, "typos.toml");
		fs.writeFileSync(cfg, "[default]\n");
		expect(findLocalTyposConfig(root)).toBe(cfg);
	});

	it.each([...LOCAL_TYPOS_CONFIG_NAMES])("discovers %s", (name) => {
		const cfg = path.join(root, name);
		fs.writeFileSync(cfg, "[default]\n");
		expect(findLocalTyposConfig(root)).toBe(cfg);
	});

	it("walks up from a nested start dir", () => {
		const cfg = path.join(root, "_typos.toml");
		fs.writeFileSync(cfg, "[default]\n");
		const nested = path.join(root, "a", "b");
		fs.mkdirSync(nested, { recursive: true });
		expect(findLocalTyposConfig(nested)).toBe(cfg);
	});

	it("returns undefined when no config exists", () => {
		expect(findLocalTyposConfig(root)).toBeUndefined();
	});
});
