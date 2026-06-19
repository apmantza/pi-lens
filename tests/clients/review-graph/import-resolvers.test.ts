/**
 * Internal-import resolution-to-file (#249 follow-up) — per-language resolvers.
 *
 * Each resolver turns a raw import source into in-project file path(s), confined
 * to cwd and existence-checked. An unresolvable source (stdlib / third-party /
 * outside cwd) must return [] so the caller keeps the honest external node.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveImportToFiles } from "../../../clients/review-graph/import-resolvers.js";
import { setupTestEnvironment } from "../test-utils.js";

let root: string;
let cleanup: () => void;

beforeEach(() => {
	const env = setupTestEnvironment("pi-lens-import-resolve-");
	root = env.tmpDir;
	cleanup = env.cleanup;
});
afterEach(() => cleanup());

function write(rel: string, content = "x\n"): string {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

/** Resolve and return paths relative to root, unix-slashed, for stable asserts. */
function resolveRel(lang: string, fileRel: string, source: string): string[] {
	return resolveImportToFiles(
		root,
		path.join(root, fileRel),
		lang,
		source,
	).map((p) => path.relative(root, p).replace(/\\/g, "/"));
}

describe("relative-path resolvers (ruby/zig/bash/dart)", () => {
	it("ruby require_relative resolves to a sibling .rb; gem stays unresolved", () => {
		write("lib/a.rb");
		write("lib/b.rb");
		expect(resolveRel("ruby", "lib/a.rb", "./b")).toEqual(["lib/b.rb"]);
		expect(resolveRel("ruby", "lib/a.rb", "json")).toEqual([]);
	});

	it("zig @import resolves a relative .zig; std stays unresolved", () => {
		write("src/main.zig");
		write("src/util.zig");
		expect(resolveRel("zig", "src/main.zig", "util.zig")).toEqual([
			"src/util.zig",
		]);
		expect(resolveRel("zig", "src/main.zig", "std")).toEqual([]);
	});

	it("bash source resolves ./lib.sh", () => {
		write("scripts/run.sh");
		write("scripts/lib.sh");
		expect(resolveRel("bash", "scripts/run.sh", "./lib.sh")).toEqual([
			"scripts/lib.sh",
		]);
	});

	it("dart resolves a relative import; package:/dart: stay unresolved", () => {
		write("lib/sub/a.dart");
		write("lib/b.dart");
		expect(resolveRel("dart", "lib/sub/a.dart", "../b.dart")).toEqual([
			"lib/b.dart",
		]);
		expect(resolveRel("dart", "lib/sub/a.dart", "package:foo/x.dart")).toEqual(
			[],
		);
		expect(resolveRel("dart", "lib/sub/a.dart", "dart:io")).toEqual([]);
	});

	it("never resolves outside cwd", () => {
		write("lib/a.rb");
		expect(resolveRel("ruby", "lib/a.rb", "../../../../etc/passwd")).toEqual([]);
	});
});

describe("python resolver", () => {
	it("resolves an absolute dotted module to a package file", () => {
		write("pkg/__init__.py");
		write("pkg/a.py");
		write("pkg/b.py");
		expect(resolveRel("python", "pkg/a.py", "pkg.b")).toEqual(["pkg/b.py"]);
	});

	it("resolves a relative `from .sib import x`", () => {
		write("pkg/__init__.py");
		write("pkg/mod.py");
		write("pkg/sib.py");
		expect(resolveRel("python", "pkg/mod.py", ".sib")).toEqual(["pkg/sib.py"]);
	});

	it("resolves a dotted module to a package __init__.py", () => {
		write("pkg/__init__.py");
		write("pkg/a.py");
		write("pkg/sub/__init__.py");
		expect(resolveRel("python", "pkg/a.py", "pkg.sub")).toEqual([
			"pkg/sub/__init__.py",
		]);
	});

	it("leaves stdlib imports unresolved", () => {
		write("pkg/__init__.py");
		write("pkg/a.py");
		expect(resolveRel("python", "pkg/a.py", "os.path")).toEqual([]);
	});
});

describe("go resolver", () => {
	beforeEach(() => {
		write("go.mod", "module example.com/m\n\ngo 1.21\n");
		write("pkg/a.go", "package pkg\n");
		write("pkg/b.go", "package pkg\n");
		write("cmd/main.go", "package main\n");
	});

	it("resolves a same-module import path to the package's .go files", () => {
		expect(resolveRel("go", "cmd/main.go", "example.com/m/pkg")).toEqual([
			"pkg/a.go",
			"pkg/b.go",
		]);
	});

	it("leaves stdlib / third-party paths unresolved", () => {
		expect(resolveRel("go", "cmd/main.go", "fmt")).toEqual([]);
		expect(resolveRel("go", "cmd/main.go", "github.com/x/y")).toEqual([]);
	});
});

describe("java resolver", () => {
	it("resolves a package class under a maven source root", () => {
		write("src/main/java/com/ex/A.java");
		write("src/main/java/com/ex/B.java");
		expect(
			resolveRel("java", "src/main/java/com/ex/A.java", "com.ex.B"),
		).toEqual(["src/main/java/com/ex/B.java"]);
	});

	it("resolves a wildcard package import to every .java in the dir", () => {
		write("src/main/java/com/ex/A.java");
		write("src/main/java/com/ex/B.java");
		write("src/main/java/com/ex/C.java");
		// `import com.ex.*` is captured as the package path "com.ex".
		const got = resolveRel("java", "src/main/java/com/ex/A.java", "com.ex");
		expect(got).toContain("src/main/java/com/ex/B.java");
		expect(got).toContain("src/main/java/com/ex/C.java");
	});

	it("leaves JDK imports unresolved", () => {
		write("src/main/java/com/ex/A.java");
		expect(
			resolveRel("java", "src/main/java/com/ex/A.java", "java.util.List"),
		).toEqual([]);
	});
});

describe("unsupported languages stay unresolved", () => {
	it("returns [] for rust/csharp/elixir (not file-1:1)", () => {
		write("a.rs");
		expect(resolveRel("rust", "a.rs", "crate::foo")).toEqual([]);
		expect(resolveRel("csharp", "a.rs", "System.Collections")).toEqual([]);
		expect(resolveRel("elixir", "a.rs", "Foo.Bar")).toEqual([]);
	});
});
