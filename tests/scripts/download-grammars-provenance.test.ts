/**
 * #177 — grammar provenance: `needsDownload` re-fetches on drift instead of the
 * old skip-if-exists, so a stale/ABI-mismatched grammar left from a previous
 * tree-sitter-wasms version can't silently persist against the pinned
 * web-tree-sitter. Pure-function tests (no network): they poke the sidecar/wasm
 * state and assert the (re)download decision.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	expectedVersion,
	type GrammarManifest,
	isVendored,
	needsDownload,
	sha256,
	sidecarPathFor,
} from "../../scripts/download-grammars.js";

const FILE = "tree-sitter-example.wasm";
const HASH = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

const manifest: GrammarManifest = {
	package: "tree-sitter-wasms",
	version: "0.1.13",
	grammars: { [FILE]: HASH },
};

const dirs: string[] = [];
function tmpDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-prov-"));
	dirs.push(d);
	return d;
}
function writeSidecar(dir: string, version: string, hash: string): void {
	fs.writeFileSync(
		sidecarPathFor(path.join(dir, FILE)),
		JSON.stringify({ npmPackage: "tree-sitter-wasms", version, sha256: hash }),
	);
}

afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("sha256", () => {
	it("emits the sha256:<hex> manifest format", () => {
		expect(sha256(Buffer.from("hello"))).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe("needsDownload (#177 re-download-on-drift)", () => {
	it("true when the grammar is absent", () => {
		expect(needsDownload(tmpDir(), FILE, manifest)).toBe(true);
	});

	it("true when the wasm exists but its provenance sidecar is missing", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, FILE), "wasm-bytes");
		expect(needsDownload(dir, FILE, manifest)).toBe(true);
	});

	it("false when wasm + sidecar are present and version/hash match the manifest", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, FILE), "wasm-bytes");
		writeSidecar(dir, manifest.version, HASH);
		expect(needsDownload(dir, FILE, manifest)).toBe(false);
	});

	it("true when the sidecar version differs (stale grammar after a bump)", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, FILE), "wasm-bytes");
		writeSidecar(dir, "0.1.12", HASH);
		expect(needsDownload(dir, FILE, manifest)).toBe(true);
	});

	it("true when the sidecar hash differs from the manifest", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, FILE), "wasm-bytes");
		writeSidecar(dir, manifest.version, "sha256:deadbeef");
		expect(needsDownload(dir, FILE, manifest)).toBe(true);
	});

	it("true when the sidecar is unreadable/corrupt JSON", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, FILE), "wasm-bytes");
		fs.writeFileSync(sidecarPathFor(path.join(dir, FILE)), "{ not json");
		expect(needsDownload(dir, FILE, manifest)).toBe(true);
	});
});

describe("VENDORED grammars (#423 — built-from-source, per-grammar provenance)", () => {
	const VFILE = "tree-sitter-swift.wasm";
	const vendoredManifest: GrammarManifest = {
		package: "tree-sitter-wasms",
		version: "0.1.13",
		grammars: { [VFILE]: HASH },
		vendored: { [VFILE]: { npmPackage: "tree-sitter-swift", version: "0.7.1" } },
	};
	function writeVendoredSidecar(dir: string, version: string, hash: string): void {
		fs.writeFileSync(
			sidecarPathFor(path.join(dir, VFILE)),
			JSON.stringify({ npmPackage: "tree-sitter-swift", version, sha256: hash }),
		);
	}

	it("isVendored flags the vendored swift grammar, not others", () => {
		expect(isVendored(VFILE)).toBe(true);
		expect(isVendored("tree-sitter-python.wasm")).toBe(false);
	});

	it("expectedVersion uses the per-grammar vendored version, not the global", () => {
		expect(expectedVersion(VFILE, vendoredManifest)).toBe("0.7.1");
		expect(expectedVersion("tree-sitter-python.wasm", vendoredManifest)).toBe(
			"0.1.13",
		);
	});

	it("needsDownload=false when a vendored sidecar matches its own (0.7.1) version", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, VFILE), "wasm-bytes");
		writeVendoredSidecar(dir, "0.7.1", HASH);
		expect(needsDownload(dir, VFILE, vendoredManifest)).toBe(false);
	});

	it("needsDownload=true when a vendored sidecar records the global version (drift)", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, VFILE), "wasm-bytes");
		writeVendoredSidecar(dir, "0.1.13", HASH);
		expect(needsDownload(dir, VFILE, vendoredManifest)).toBe(true);
	});
});
