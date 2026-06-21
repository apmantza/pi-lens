import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetJvmRuntimeCacheForTests,
	discoverJdkHome,
	resolveJavaRuntimeEnv,
} from "../../../clients/lsp/jvm-runtime.js";

const isWin = process.platform === "win32";
const JAVA_EXE = isWin ? "java.exe" : "java";

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	isCommandAvailableAsync: vi.fn(),
}));
import { isCommandAvailableAsync } from "../../../clients/safe-spawn.js";

describe("jvm-runtime — JDK discovery (#241)", () => {
	const dirs: string[] = [];
	let savedJavaHome: string | undefined;

	function tmpDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-jdk-"));
		dirs.push(dir);
		return dir;
	}

	/** Create a fake JDK home `<root>/<name>/bin/java[.exe]` and return its home. */
	function fakeJdk(root: string, name: string): string {
		const home = path.join(root, name);
		fs.mkdirSync(path.join(home, "bin"), { recursive: true });
		fs.writeFileSync(path.join(home, "bin", JAVA_EXE), "");
		return home;
	}

	beforeEach(() => {
		_resetJvmRuntimeCacheForTests();
		vi.mocked(isCommandAvailableAsync).mockReset();
		// Passing `undefined` for the javaHome arg re-activates its
		// `= process.env.JAVA_HOME` default, so a CI runner with JAVA_HOME set
		// (GitHub's Ubuntu image has one) would leak its real JDK into the scan.
		// Clear it so these tests see only the explicit `roots` they pass.
		savedJavaHome = process.env.JAVA_HOME;
		delete process.env.JAVA_HOME;
	});

	afterEach(() => {
		if (savedJavaHome === undefined) delete process.env.JAVA_HOME;
		else process.env.JAVA_HOME = savedJavaHome;
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("finds a JDK under a scanned root", () => {
		const root = tmpDir();
		const home = fakeJdk(root, "jdk-21.0.11.10-hotspot");
		expect(discoverJdkHome([root], undefined)).toBe(home);
	});

	it("picks the highest version among several", () => {
		const root = tmpDir();
		fakeJdk(root, "jdk-17.0.9");
		const newer = fakeJdk(root, "jdk-21.0.11");
		fakeJdk(root, "jdk-18.0.2");
		expect(discoverJdkHome([root], undefined)).toBe(newer);
	});

	it("ignores JDKs below the minimum major (17)", () => {
		const root = tmpDir();
		fakeJdk(root, "jdk1.8.0_402"); // legacy 8 — too old for jdtls
		fakeJdk(root, "jdk-11.0.20"); // 11 — too old
		expect(discoverJdkHome([root], undefined)).toBeUndefined();
	});

	it("honours an explicit JAVA_HOME over scanned roots", () => {
		const root = tmpDir();
		fakeJdk(root, "jdk-21.0.11");
		const javaHomeRoot = tmpDir();
		const javaHome = fakeJdk(javaHomeRoot, "my-jdk-17");
		expect(discoverJdkHome([root], javaHome)).toBe(javaHome);
	});

	it("returns undefined when no JDK exists", () => {
		expect(discoverJdkHome([tmpDir()], undefined)).toBeUndefined();
	});

	it("returns undefined when JAVA_HOME points at a non-JDK", () => {
		const bogus = tmpDir(); // no bin/java
		expect(discoverJdkHome([tmpDir()], bogus)).toBeUndefined();
	});
});

describe("jvm-runtime — resolveJavaRuntimeEnv (#241)", () => {
	const dirs: string[] = [];
	let savedJavaHome: string | undefined;

	function tmpDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-jdkenv-"));
		dirs.push(dir);
		return dir;
	}

	beforeEach(() => {
		_resetJvmRuntimeCacheForTests();
		vi.mocked(isCommandAvailableAsync).mockReset();
		savedJavaHome = process.env.JAVA_HOME;
	});

	afterEach(() => {
		if (savedJavaHome === undefined) delete process.env.JAVA_HOME;
		else process.env.JAVA_HOME = savedJavaHome;
		for (const dir of dirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("injects nothing when java is already on PATH", async () => {
		vi.mocked(isCommandAvailableAsync).mockResolvedValue(true);
		expect(await resolveJavaRuntimeEnv()).toBeUndefined();
	});

	it("injects JAVA_HOME + PATH from a discovered JDK when java is absent", async () => {
		vi.mocked(isCommandAvailableAsync).mockResolvedValue(false);
		const home = path.join(tmpDir(), "jdk-21");
		fs.mkdirSync(path.join(home, "bin"), { recursive: true });
		fs.writeFileSync(
			path.join(home, "bin", process.platform === "win32" ? "java.exe" : "java"),
			"",
		);
		// JAVA_HOME has top discovery priority, so this exercises the env overlay
		// deterministically regardless of the host's real JDK installs.
		process.env.JAVA_HOME = home;

		const env = await resolveJavaRuntimeEnv();
		expect(env?.JAVA_HOME).toBe(home);
		expect(env?.PATH?.startsWith(path.join(home, "bin") + path.delimiter)).toBe(
			true,
		);
	});

	it("memoizes the result across calls", async () => {
		vi.mocked(isCommandAvailableAsync).mockResolvedValue(true);
		await resolveJavaRuntimeEnv();
		await resolveJavaRuntimeEnv();
		expect(vi.mocked(isCommandAvailableAsync)).toHaveBeenCalledTimes(1);
	});
});
