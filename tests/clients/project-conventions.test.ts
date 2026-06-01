import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectConventions } from "../../clients/project-conventions.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

function writePkg(
	tmpDir: string,
	pkg: Record<string, unknown>,
): void {
	createTempFile(tmpDir, "package.json", JSON.stringify(pkg, null, 2));
}

describe("detectProjectConventions — Phase 1 detectors", () => {
	it("detects react + vite + vitest from a typical Vite-React project layout", () => {
		const env = setupTestEnvironment("pi-lens-conv-vite-react-");
		try {
			writePkg(env.tmpDir, {
				dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
				devDependencies: { vite: "^5.0.0", vitest: "^1.0.0" },
			});
			createTempFile(env.tmpDir, "vite.config.ts", "export default {};\n");
			createTempFile(env.tmpDir, "vitest.config.ts", "export default {};\n");

			const conv = detectProjectConventions(env.tmpDir);
			const ids = conv.frameworks.map((f) => f.id).sort();
			expect(ids).toEqual(["react", "vite", "vitest"]);

			const react = conv.frameworks.find((f) => f.id === "react")!;
			expect(react.confidence).toBe("high");
			expect(react.signals).toContain("package.json:dependencies.react");
			expect(react.signals).toContain("package.json:dependencies.react-dom");

			const vite = conv.frameworks.find((f) => f.id === "vite")!;
			expect(vite.confidence).toBe("high");
			expect(vite.signals).toContain("vite.config.ts");

			const vitest = conv.frameworks.find((f) => f.id === "vitest")!;
			expect(vitest.confidence).toBe("high");

			expect(conv.testRunners).toEqual(["vitest"]);
			expect(conv.buildTools).toEqual(["vite"]);
		} finally {
			env.cleanup();
		}
	});

	it("detects next.js with high confidence when dep + config are both present", () => {
		const env = setupTestEnvironment("pi-lens-conv-next-");
		try {
			writePkg(env.tmpDir, {
				dependencies: {
					next: "^14.0.0",
					react: "^18.0.0",
					"react-dom": "^18.0.0",
				},
			});
			createTempFile(env.tmpDir, "next.config.js", "module.exports = {};\n");
			fs.mkdirSync(path.join(env.tmpDir, "src", "app"), { recursive: true });

			const conv = detectProjectConventions(env.tmpDir);
			const next = conv.frameworks.find((f) => f.id === "next");
			expect(next).toBeDefined();
			expect(next!.confidence).toBe("high");
			expect(next!.signals).toContain("next.config.js");
			expect(next!.signals).toContain("src/app/");
			expect(conv.buildTools).toContain("next");
		} finally {
			env.cleanup();
		}
	});

	it("treats next without dep but with a marker dir as low-confidence", () => {
		const env = setupTestEnvironment("pi-lens-conv-next-low-");
		try {
			writePkg(env.tmpDir, { dependencies: {} });
			fs.mkdirSync(path.join(env.tmpDir, "pages"), { recursive: true });

			const conv = detectProjectConventions(env.tmpDir);
			const next = conv.frameworks.find((f) => f.id === "next");
			expect(next).toBeDefined();
			expect(next!.confidence).toBe("low");
			expect(next!.signals).toContain("pages/");
		} finally {
			env.cleanup();
		}
	});

	it("returns no frameworks for a plain Node project with no dependencies", () => {
		const env = setupTestEnvironment("pi-lens-conv-plain-");
		try {
			writePkg(env.tmpDir, {
				name: "plain-thing",
				dependencies: { "some-lib": "^1.0.0" },
			});
			const conv = detectProjectConventions(env.tmpDir);
			expect(conv.frameworks).toEqual([]);
			expect(conv.testRunners).toEqual([]);
			expect(conv.buildTools).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("returns an empty conventions object when cwd does not exist", () => {
		const conv = detectProjectConventions(
			path.join(
				"/nonexistent-pi-lens-conventions",
				"this-path-will-not-resolve-XYZZY",
			),
		);
		expect(conv.frameworks).toEqual([]);
		expect(conv.testRunners).toEqual([]);
		expect(conv.buildTools).toEqual([]);
		expect(conv.agentDocs).toEqual([]);
	});

	it("returns an empty conventions object when package.json is missing or malformed", () => {
		const env = setupTestEnvironment("pi-lens-conv-nopkg-");
		try {
			const noPkg = detectProjectConventions(env.tmpDir);
			expect(noPkg.frameworks).toEqual([]);

			createTempFile(env.tmpDir, "package.json", "{not valid json");
			const badPkg = detectProjectConventions(env.tmpDir);
			expect(badPkg.frameworks).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("summarises agent docs that are present", () => {
		const env = setupTestEnvironment("pi-lens-conv-agentdocs-");
		try {
			writePkg(env.tmpDir, {});
			createTempFile(env.tmpDir, "AGENTS.md", "line1\nline2\nline3\n");
			createTempFile(env.tmpDir, "CLAUDE.md", "claude rules\n");
			const conv = detectProjectConventions(env.tmpDir);
			const docPaths = conv.agentDocs.map((d) => d.filePath).sort();
			expect(docPaths).toEqual(["AGENTS.md", "CLAUDE.md"]);
			const agents = conv.agentDocs.find((d) => d.filePath === "AGENTS.md")!;
			expect(agents.lineCount).toBeGreaterThanOrEqual(3);
		} finally {
			env.cleanup();
		}
	});

	it("detects react with medium confidence when react is present but react-dom is not (Native-like setups)", () => {
		const env = setupTestEnvironment("pi-lens-conv-react-only-");
		try {
			writePkg(env.tmpDir, {
				dependencies: { react: "^18.0.0" },
			});
			const conv = detectProjectConventions(env.tmpDir);
			const react = conv.frameworks.find((f) => f.id === "react");
			expect(react).toBeDefined();
			expect(react!.confidence).toBe("medium");
		} finally {
			env.cleanup();
		}
	});
});
