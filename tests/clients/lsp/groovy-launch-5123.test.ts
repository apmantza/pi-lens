/**
 * #5123: how the built-in Groovy row finds its server. groovy-language-server
 * publishes no release, so nothing is installed: a `groovy-language-server`
 * launcher on PATH wins, else `java -jar $GROOVY_LANGUAGE_SERVER_JAR`, else the
 * row is not installed and the session log says how to build it. Every launch
 * runs under the JVM env overlay jdtls gets (`resolveJavaRuntimeEnv`, JDK 17+).
 *
 * Recurrences this file prevents: a launcher that ignores the env jar (the
 * only way most users have the server, since Mason's launcher is optional); a
 * `java -jar` launch that skips the overlay, which fails on a host where `java`
 * is not on PATH (the Windows #241 shape); a not-installed row that says
 * nothing, so the user cannot tell what to build.
 *
 * Nothing is doubled: the production `GroovyServer.spawn` runs against stub
 * executables in a pinned PATH directory (the host boundary), with HOME,
 * JAVA_HOME and the jar variable pinned under a temp dir. The stubs record the
 * argv and JAVA_HOME they were started with.
 */
import fs from "node:fs";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { _resetJvmRuntimeCacheForTests } from "../../../clients/lsp/jvm-runtime.js";
import {
	GROOVY_LANGUAGE_SERVER_JAR_ENV,
	GroovyServer,
} from "../../../clients/lsp/server.js";
import {
	flushSessionStartLog,
	SESSIONSTART_LOG_FILE,
} from "../../../clients/sessionstart-logger.js";
import { waitFor } from "../interleaving-kit.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

const TMP_PREFIX = "pi-lens-5123-launch-";
const env = setupTestEnvironment(TMP_PREFIX);
const base = env.tmpDir;
const shimDir = path.join(base, "bin");
const home = path.join(base, "home");
const projectDir = path.join(base, "project");
const jdkHome = path.join(home, ".jdks", "jdk-99");
const jar = path.join(base, "groovy-language-server-all.jar");
const STUB_OUT = path.join(base, "stub-out");
/** An executable that records how it was started and then idles like a server. */
function writeStub(dir: string, name: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(
		file,
		[
			`#!${process.execPath}`,
			`import("node:fs").then((fs) => {`,
			`  fs.writeFileSync(process.env.STUB_OUT + "." + ${JSON.stringify(name)}, JSON.stringify({ argv: process.argv.slice(2), javaHome: process.env.JAVA_HOME ?? null }));`,
			`  process.stdin.resume();`,
			`  setInterval(() => {}, 1000);`,
			`});`,
			"",
		].join("\n"),
	);
	fs.chmodSync(file, 0o755);
}

/** A `which` that answers for the stubs in the pinned directory only. */
function writeWhich(): void {
	const file = path.join(shimDir, "which");
	fs.writeFileSync(
		file,
		[
			`#!${process.execPath}`,
			`import("node:fs").then((fs) => {`,
			`  process.exit(fs.existsSync(${JSON.stringify(shimDir)} + "/" + process.argv[2]) ? 0 : 1);`,
			`});`,
			"",
		].join("\n"),
	);
	fs.chmodSync(file, 0o755);
}

async function recorded(
	name: string,
): Promise<{ argv: string[]; javaHome: string | null }> {
	const file = `${STUB_OUT}.${name}`;
	const read = () => {
		try {
			const body = fs.readFileSync(file, "utf8");
			return body ? JSON.parse(body) : undefined;
		} catch {
			return undefined;
		}
	};
	return waitFor(read, (value) => value !== undefined, { timeoutMs: 5_000 });
}

async function spawnRow() {
	const spawned = await GroovyServer.spawn(projectDir, { allowInstall: false });
	if (spawned) {
		const child = spawned.process.process;
		const exited = new Promise((resolve) => child.once("exit", resolve));
		return {
			spawned,
			stop: async () => {
				child.kill("SIGKILL");
				await exited;
			},
		};
	}
	return { spawned, stop: async () => {} };
}

describe.skipIf(process.platform === "win32")(
	"#5123 the Groovy row's launch resolution",
	() => {
		let stop: () => Promise<void> = async () => {};

		beforeEach(() => {
			fs.rmSync(shimDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(jdkHome), { recursive: true, force: true });
			for (const name of fs.readdirSync(base))
				if (name.startsWith("stub-out.")) fs.rmSync(path.join(base, name));
			fs.mkdirSync(shimDir, { recursive: true });
			fs.mkdirSync(projectDir, { recursive: true });
			writeWhich();
			fs.writeFileSync(jar, "");
			vi.stubEnv("PATH", shimDir);
			vi.stubEnv("HOME", home);
			vi.stubEnv("USERPROFILE", home);
			vi.stubEnv("JAVA_HOME", undefined);
			vi.stubEnv("STUB_OUT", STUB_OUT);
			vi.stubEnv("PI_LENS_TEST_MODE", "0");
			vi.stubEnv(GROOVY_LANGUAGE_SERVER_JAR_ENV, undefined);
			_resetJvmRuntimeCacheForTests();
		});
		afterEach(async () => {
			await stop();
			stop = async () => {};
			vi.unstubAllEnvs();
			_resetJvmRuntimeCacheForTests();
		});
		afterAll(async () => {
			await cleanupTestEnvironmentsDrained(TMP_PREFIX);
		});

		it("prefers a groovy-language-server launcher on PATH over the jar", async () => {
			writeStub(shimDir, "groovy-language-server");
			writeStub(shimDir, "java");
			vi.stubEnv(GROOVY_LANGUAGE_SERVER_JAR_ENV, jar);

			const run = await spawnRow();
			stop = run.stop;

			expect(run.spawned?.source).toBe("direct");
			expect(await recorded("groovy-language-server")).toMatchObject({
				argv: [],
			});
			expect(fs.existsSync(`${STUB_OUT}.java`)).toBe(false);
		}, 30_000);

		it("runs java -jar on the env jar when no launcher is on PATH", async () => {
			writeStub(shimDir, "java");
			vi.stubEnv(GROOVY_LANGUAGE_SERVER_JAR_ENV, jar);

			const run = await spawnRow();
			stop = run.stop;

			expect(await recorded("java")).toEqual({
				argv: ["-jar", jar],
				javaHome: null,
			});
		}, 30_000);

		it("runs the jar under the JVM env overlay when java is not on PATH", async () => {
			writeStub(path.join(jdkHome, "bin"), "java");
			vi.stubEnv(GROOVY_LANGUAGE_SERVER_JAR_ENV, jar);

			const run = await spawnRow();
			stop = run.stop;

			expect(await recorded("java")).toEqual({
				argv: ["-jar", jar],
				javaHome: jdkHome,
			});
		}, 30_000);

		it("gives the PATH launcher the same JVM env overlay", async () => {
			writeStub(shimDir, "groovy-language-server");
			writeStub(path.join(jdkHome, "bin"), "java");

			const run = await spawnRow();
			stop = run.stop;

			expect(await recorded("groovy-language-server")).toEqual({
				argv: [],
				javaHome: jdkHome,
			});
		}, 30_000);

		it("is not installed with neither, and the session log says how to build the jar", async () => {
			writeStub(shimDir, "java");

			const run = await spawnRow();

			expect(run.spawned).toBeUndefined();
			await flushSessionStartLog();
			const logged = fs.readFileSync(SESSIONSTART_LOG_FILE, "utf8");
			expect(logged).toContain(
				`lsp launch groovy: not installed (no groovy-language-server on PATH; ${GROOVY_LANGUAGE_SERVER_JAR_ENV}=unset)`,
			);
			expect(logged).toContain("./gradlew build");
			expect(fs.existsSync(`${STUB_OUT}.java`)).toBe(false);
		}, 30_000);

		it("is not installed when the env jar names a file that is not there", async () => {
			writeStub(shimDir, "java");
			const missing = path.join(base, "no-such-groovy.jar");
			vi.stubEnv(GROOVY_LANGUAGE_SERVER_JAR_ENV, missing);

			const run = await spawnRow();

			expect(run.spawned).toBeUndefined();
			await flushSessionStartLog();
			expect(fs.readFileSync(SESSIONSTART_LOG_FILE, "utf8")).toContain(
				`${GROOVY_LANGUAGE_SERVER_JAR_ENV}=${missing} (no such file)`,
			);
			expect(fs.existsSync(`${STUB_OUT}.java`)).toBe(false);
		}, 30_000);
	},
);
