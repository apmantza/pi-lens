// flake-shape: real-process-spawn — the regression must run the real installer against executable fake package-manager boundaries.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { pipScriptsDir } from "../../../clients/installer/index.js";

const execFileAsync = promisify(execFile);
const scratchDirs: string[] = [];

function scratchDir(): string {
	// Outside the checkout (#4530): the fakes stand in for global tools, and
	// the installer ignores PATH dirs inside an untrusted session project.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pip-pep668-"));
	scratchDirs.push(dir);
	return dir;
}

function writeExecutable(file: string, source: string): void {
	fs.writeFileSync(file, source, { mode: 0o750 });
}

function writeFakePip(
	binDir: string,
	mode:
		| "pep668"
		| "pep668-long"
		| "private"
		| "private-long"
		| "genuine"
		| "long-genuine",
): string {
	const log = path.join(path.dirname(binDir), "pip.log");
	const pep668Body =
		'printf "error: externally-managed-environment\\n\\n× This environment is externally managed\\n╰─> To install Python packages system-wide, try apt install\\n    python3-xyz, where xyz is the package you are trying to install.\\n" >&2';
	const behavior =
		mode === "pep668"
			? `${pep668Body}; exit 1`
			: mode === "pep668-long"
				? // PEP 668 literal first, then ~900 chars of retry preamble so the
					// flattened reason exceeds the 1,000-char bound (N1 exercises it).
					`${pep668Body}; printf "WARNING: Retrying (Retry(total=4)) %850s\\n" x >&2; exit 1`
				: mode === "genuine"
					? 'echo "No matching distribution found" >&2; exit 1'
					: mode === "long-genuine"
						? 'printf "No matching distribution found %1000s\\n" x >&2; exit 1'
						: mode === "private-long"
							? // User rung refuses with PEP 668 so the ladder reaches the
								// private-prefix rung, which then fails long (N2 pins :5462).
								[
									'case " $* " in *" --break-system-packages "*)',
									'printf "No matching distribution found %600s\\n" x >&2',
									"exit 1;;",
									'*) echo "error: externally-managed-environment" >&2; exit 1;; esac',
								].join("\n")
							: [
									'case " $* " in *" --break-system-packages "*)',
									'/bin/mkdir -p "$PYTHONUSERBASE/bin"',
									'printf "#!/bin/sh\\necho ruff 1.0\\n" > "$PYTHONUSERBASE/bin/ruff"',
									'/bin/chmod 750 "$PYTHONUSERBASE/bin/ruff"',
									"exit 0;;",
									'*) echo "error: externally-managed-environment" >&2; exit 1;; esac',
								].join("\n");
	writeExecutable(
		path.join(binDir, "pip3"),
		`#!/bin/sh\necho "$*" >> "$FAKE_PIP_LOG"\n${behavior}\n`,
	);
	return log;
}

function writeFakePythonWithVenv(binDir: string): void {
	writeExecutable(
		path.join(binDir, "python3"),
		`#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  root="$3"
  /bin/mkdir -p "$root/bin"
  printf '#!/bin/sh\necho venv-pip\n' > "$root/bin/pip"
  /bin/chmod 750 "$root/bin/pip"
  printf '#!/bin/sh\necho ruff 2.0\n' > "$root/bin/ruff"
  /bin/chmod 750 "$root/bin/ruff"
  exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "site" ]; then
  echo "$FAKE_USER_BASE"
  exit 0
fi
exit 1
`,
	);
}

function writeFakePythonWithoutVenv(
	binDir: string,
	mode: "pep668" | "genuine" | "private" | "long-genuine" = "pep668",
): void {
	const pipFailure =
		mode === "genuine"
			? 'echo "No matching distribution found" >&2'
			: mode === "long-genuine"
				? 'printf "No matching distribution found %1000s" x >&2'
				: 'echo "error: externally-managed-environment" >&2';
	writeExecutable(
		path.join(binDir, "python3"),
		`#!/bin/sh
if [ "$2" = "pip" ]; then
  ${pipFailure}
else
  echo "No module named venv" >&2
fi
exit 1
`,
	);
}

function writeFakePythonUserInstall(binDir: string): void {
	writeExecutable(
		path.join(binDir, "python3"),
		`#!/bin/sh
if [ "$2" = "venv" ]; then
  echo venv >> "$FAKE_PYTHON_LOG"
  echo "No module named venv" >&2
  exit 1
fi
if [ "$2" = "pip" ] && [ "$4" = "--user" ]; then
  /bin/mkdir -p "$FAKE_USER_BASE/bin"
  printf '#!/bin/sh\necho ruff user\n' > "$FAKE_USER_BASE/bin/ruff"
  /bin/chmod 750 "$FAKE_USER_BASE/bin/ruff"
  exit 0
fi
if [ "$2" = "site" ]; then
  echo "$FAKE_USER_BASE"
  exit 0
fi
exit 1
`,
	);
}

function writeFakePip3UserInstall(binDir: string): void {
	writeExecutable(
		path.join(binDir, "pip3"),
		`#!/bin/sh
if [ "$1" = "install" ] && [ "$2" = "--user" ]; then
  /bin/mkdir -p "$FAKE_USER_BASE/bin"
  printf '#!/bin/sh\necho ruff pip3\n' > "$FAKE_USER_BASE/bin/ruff"
  /bin/chmod 750 "$FAKE_USER_BASE/bin/ruff"
  exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "site" ]; then
  echo "$FAKE_USER_BASE"
  exit 0
fi
exit 1
`,
	);
}

async function runInstaller(
	home: string,
	binDir: string,
	tool = "ruff",
	extraEnv: NodeJS.ProcessEnv = {},
	repeat = false,
) {
	const program = `import(${JSON.stringify(path.resolve("clients/installer/index.js"))}).then(async m => {
  const installed = await m.installTool(${JSON.stringify(tool)});
  ${repeat ? `await m.installTool(${JSON.stringify(tool)});` : ""}
  const resolved = await m.getToolPath(${JSON.stringify(tool)});
  const summary = (await import(${JSON.stringify(path.resolve("clients/degradation-ledger.js"))})).getDegradationSummary();
  console.log(JSON.stringify({ installed, resolved, path: process.env.PATH, reason: m.getInstallFailureReason(${JSON.stringify(tool)}), summary }));
}).catch(error => { console.error(error); process.exitCode = 1; });`;
	const { stdout, stderr } = await execFileAsync(
		process.execPath,
		["-e", program],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				PI_LENS_HOME: home,
				PATH: binDir,
				PI_LENS_DISABLE_TOOL_INSTALL: "0",
				PI_LENS_DEBUG: "1",
				...extraEnv,
			},
		},
	);
	return { result: JSON.parse(stdout.trim()), stderr };
}

afterEach(() => {
	for (const dir of scratchDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("real pip installer PEP 668 strategy selection (#2916)", () => {
	it("uses pipx before other pip strategies", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		const pipxBin = path.join(root, "pipx-bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(pipxBin, { recursive: true });
		writeExecutable(
			path.join(bin, "pipx"),
			`#!/bin/sh
if [ "$1" = "install" ]; then
  /bin/mkdir -p "$FAKE_PIPX_BIN"
  printf '#!/bin/sh\\necho ruff 3.0\\n' > "$FAKE_PIPX_BIN/ruff"
  /bin/chmod 750 "$FAKE_PIPX_BIN/ruff"
elif [ "$1" = "environment" ]; then
  echo "$FAKE_PIPX_BIN"
fi
`,
		);
		const program = await runInstaller(root, bin, "ruff", {
			FAKE_PIPX_BIN: pipxBin,
		});
		expect(program.result.installed).toBe(true);
		expect(program.result.path).toContain("pipx-bin");
	});

	it("falls through a missing pip3 to python3 -m pip", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		writeFakePythonUserInstall(bin);
		const result = await runInstaller(root, bin, "ruff", {
			FAKE_USER_BASE: path.join(root, "user-base"),
		});
		expect(result.result.installed).toBe(true);
		expect(result.result.path).toContain(path.join("user-base", "bin"));
	});

	it("uses pip3 after a non-PEP-668 pipx refusal", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		writeExecutable(
			path.join(bin, "pipx"),
			'#!/bin/sh\necho "ruff already seems to be installed" >&2\nexit 1\n',
		);
		writeFakePip3UserInstall(bin);
		const result = await runInstaller(root, bin, "ruff", {
			FAKE_USER_BASE: path.join(root, "user-base"),
		});
		expect(result.result.installed).toBe(true);
		expect(result.result.path).toContain(path.join("user-base", "bin"));
	});

	it("creates and resolves the pi-lens venv", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "pep668");
		writeFakePythonWithVenv(bin);
		const result = await runInstaller(root, bin, "ruff", {
			FAKE_PIP_LOG: log,
			FAKE_USER_BASE: path.join(root, "user-base"),
		});
		expect(result.result.installed).toBe(true);
		expect(result.result.path).toContain(path.join("pip-tools", "bin"));
		expect(fs.existsSync(path.join(root, "pip-tools", "bin", "pip"))).toBe(
			true,
		);
		const success = result.result.summary.find(
			(entry: { kind: string }) =>
				entry.kind === "pip-install-strategy-succeeded",
		);
		expect(success?.latestReasons?.[0]?.subject).toBe("ruff:venv");
		expect(fs.existsSync(log)).toBe(false);
	});

	it("does not treat a PEP 668 refusal as a normal user success", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "pep668");
		writeFakePythonWithoutVenv(bin, "pep668");
		const result = await runInstaller(root, bin, "ruff", { FAKE_PIP_LOG: log });
		expect(result.result.installed).toBe(false);
		expect(result.result.reason).toContain("externally-managed-environment");
	});

	it("uses break-system-packages only with PYTHONUSERBASE under PI_LENS_HOME", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "private");
		writeFakePythonWithoutVenv(bin, "private");
		const result = await runInstaller(root, bin, "ruff", { FAKE_PIP_LOG: log });
		expect(result.result.installed).toBe(true);
		expect(result.result.path).toContain(path.join("pip-user", "bin"));
		const attempts = fs.readFileSync(log, "utf8").trim().split("\n");
		expect(attempts[0]).not.toContain("--break-system-packages");
		expect(
			attempts.some((attempt) => attempt.includes("--break-system-packages")),
		).toBe(true);
	});

	it("classifies externally-managed-environment refusals", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "pep668-long");
		writeFakePythonWithoutVenv(bin, "pep668");
		const result = await runInstaller(root, bin, "ruff", {
			FAKE_PIP_LOG: log,
			PI_LENS_TEST_MODE: "0",
		});
		expect(result.result.reason).toMatch(/externally-managed-environment/);
		const sessionLog = fs.readFileSync(
			path.join(root, "sessionstart.log"),
			"utf8",
		);
		const refusalLines = sessionLog
			.split("\n")
			.filter((line) => line.includes("refused by PEP 668"));
		expect(refusalLines).toHaveLength(1);
		// The 1,000-char bound applies to the reason inside the line, not to
		// the whole line: the timestamp plus the "refused by PEP 668" prefix
		// ride on top, so a bound-exercising refusal line reads ~1,076 chars.
		const loggedReason =
			refusalLines[0]?.match(/refused by PEP 668 \((.*)\)$/)?.[1] ?? "";
		expect(loggedReason.length).toBe(1000);
		expect(refusalLines[0]?.length).toBeGreaterThan(1000);
		expect(
			sessionLog
				.trimEnd()
				.split("\n")
				.every((line) => line.startsWith("[")),
		).toBe(true);
	});

	it("resolves Windows Scripts binaries", () => {
		expect(pipScriptsDir("C:\\Users\\user\\AppData\\Python", "win32")).toBe(
			path.join("C:\\Users\\user\\AppData\\Python", "Scripts"),
		);
	});

	it("records one refusal per tool and strategy", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "pep668");
		writeFakePythonWithoutVenv(bin, "pep668");
		const result = await runInstaller(
			root,
			bin,
			"ruff",
			{ FAKE_PIP_LOG: log },
			true,
		);
		const row = result.result.summary.find(
			(entry: { kind: string }) => entry.kind === "pip-pep668-strategy-refused",
		);
		expect(row?.count).toBe(1);
	});

	it("preserves genuine nonexistent-package failures", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePip(bin, "genuine");
		writeFakePythonWithoutVenv(bin, "genuine");
		const result = await runInstaller(root, bin, "ruff", { FAKE_PIP_LOG: log });
		expect(result.result.installed).toBe(false);
		expect(result.result.reason).toContain("No matching distribution");
		expect(fs.readFileSync(log, "utf8")).not.toContain(
			"--break-system-packages",
		);
	});

	it("preserves the first pip diagnostic across two failing candidates", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		writeFakePip(bin, "genuine");
		writeFakePythonWithoutVenv(bin, "genuine");
		const result = await runInstaller(root, bin, "ruff", {
			FAKE_PIP_LOG: path.join(root, "pip.log"),
		});
		expect(result.result.installed).toBe(false);
		expect(result.result.reason).toContain("pip3 install --user");
		expect(result.result.reason).toContain("No matching distribution found");
		expect(result.result.reason).toContain("python3 -m pip install --user");
		expect(result.result.reason.length).toBeLessThan(500);
	});

	it("bounds a long diagnostic for every pip candidate", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		writeFakePip(bin, "long-genuine");
		writeFakePythonWithoutVenv(bin, "long-genuine");
		const result = await runInstaller(root, bin, "ruff", {
			FAKE_PIP_LOG: path.join(root, "pip.log"),
		});
		const reason = result.result.reason as string;
		const firstCandidate = reason.split(" | ")[0] ?? "";
		const diagnostic = firstCandidate.replace(
			/^pip install failed: [^:]+: /,
			"",
		);
		expect(diagnostic.length).toBeLessThanOrEqual(200);
		expect(reason.length).toBeLessThanOrEqual(1000);
	});

	it("bounds a long diagnostic on the private-prefix rung", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		writeFakePip(bin, "private-long");
		writeFakePythonWithoutVenv(bin, "private");
		const result = await runInstaller(root, bin, "ruff", {
			FAKE_PIP_LOG: path.join(root, "pip.log"),
		});
		expect(result.result.installed).toBe(false);
		const reason = result.result.reason as string;
		const privateEntries = reason
			.split(" | ")
			.filter((entry) => entry.includes("--break-system-packages"));
		// The user rung refuses with PEP 668, so the ladder reaches the
		// private-prefix rung: at least pip3's long failure must be present.
		expect(privateEntries.length).toBeGreaterThan(0);
		for (const entry of privateEntries) {
			const diagnostic = entry.replace(/^(pip install failed: )?[^:]+: /, "");
			expect(diagnostic.length).toBeLessThanOrEqual(200);
		}
	});
});

/**
 * The install SPEC, not just the strategy (#3312).
 *
 * cmake-format's console script answers `--version` from a bare `cmakelang`
 * install and then dies on the first `.cmake-format.yaml` with
 * `ModuleNotFoundError: No module named 'yaml'`: upstream ships PyYAML behind an
 * extra (`pyyaml (>=5.3) ; extra == 'yaml'` in cmakelang 0.6.13's metadata). The
 * nightly's cmake row was that failure.
 *
 * The fake pipx below is production-faithful on the axis under test — measured
 * against pipx 1.17.6 in a scratch PIPX_HOME:
 *
 *   $ pipx install "cmakelang[yaml]"      # over an existing bare venv
 *   modifying existing installation … Pass '--force' to force installation
 *   $ echo $?
 *   0
 *   $ cmake-format --dump-config yaml     # still broken
 *   ModuleNotFoundError: No module named 'yaml'  (exit 1)
 *
 * so a double that quietly re-installed on every call would turn an inert fix
 * green.
 */
function writeFakePipx(binDir: string, root: string): string {
	const log = path.join(root, "pipx.log");
	const venvs = path.join(root, "pipx-venvs");
	const pipxBin = path.join(root, "pipx-bin");
	writeExecutable(
		path.join(binDir, "pipx"),
		`#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = "environment" ]; then echo "${pipxBin}"; exit 0; fi
[ "$1" = "install" ] || exit 1
force=no
spec=""
shift
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then force=yes; else spec="$arg"; fi
done
if [ -d "${venvs}/cmakelang" ] && [ "$force" = no ]; then
  echo "'cmakelang' already seems to be installed. Not modifying existing installation in '${venvs}/cmakelang'. Pass '--force' to force installation"
  exit 0
fi
/bin/mkdir -p "${venvs}/cmakelang" "${pipxBin}"
case "$spec" in
  *"[yaml]"*) echo ok > "${venvs}/cmakelang/yaml-state" ;;
  *) echo missing > "${venvs}/cmakelang/yaml-state" ;;
esac
printf '#!/bin/sh\\nif [ "$1" = "--version" ]; then echo 0.6.13; exit 0; fi\\nif [ "$(/bin/cat "${venvs}/cmakelang/yaml-state")" = ok ]; then echo yaml-ok; exit 0; fi\\necho "ModuleNotFoundError: No module named yaml" >&2; exit 1\\n' > "${pipxBin}/cmake-format"
/bin/chmod 750 "${pipxBin}/cmake-format"
exit 0
`,
	);
	return log;
}

/**
 * Run the launcher the installer resolved, through the PATH the installer
 * exported — production resolves a pipx console script by name, so the resolved
 * value is bare (`cmake-format`), not a path the test could invent.
 */
async function runResolved(result: {
	resolved: string;
	path: string;
}): Promise<string> {
	const { stdout } = await execFileAsync(result.resolved, ["--dump-config"], {
		env: { ...process.env, PATH: result.path },
	});
	return stdout.trim();
}

describe("pip install spec carries the extra the tool actually needs (#3312)", () => {
	it("installs cmakelang with its yaml extra through pipx", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeFakePipx(bin, root);

		const program = await runInstaller(root, bin, "cmake-format");

		expect(program.result.installed).toBe(true);
		expect(fs.readFileSync(log, "utf-8").split("\n")[0]).toBe(
			"install --force cmakelang[yaml]",
		);
		// The independent effect: the launcher the installer resolved can run the
		// YAML path, not merely `--version`.
		expect(await runResolved(program.result)).toBe("yaml-ok");
	});

	it("repairs a cmakelang venv that predates the extra instead of reporting a no-op install", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		writeFakePipx(bin, root);
		// A venv from before the extra was added to the registry entry — the state
		// a dev box reaches after any earlier `pipx install cmakelang`. Plain
		// `pipx install` exits 0 here and changes nothing.
		fs.mkdirSync(path.join(root, "pipx-venvs", "cmakelang"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(root, "pipx-venvs", "cmakelang", "yaml-state"),
			"missing\n",
		);

		const program = await runInstaller(root, bin, "cmake-format");

		expect(program.result.installed).toBe(true);
		expect(await runResolved(program.result)).toBe("yaml-ok");
	});

	it("keeps the extra on the pip --user rung when pipx is absent", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		const userBase = path.join(root, "user-base");
		fs.mkdirSync(bin, { recursive: true });
		const log = path.join(root, "pip.log");
		writeExecutable(
			path.join(bin, "pip3"),
			`#!/bin/sh
echo "$*" >> "$FAKE_PIP_LOG"
if [ "$1" = "install" ] && [ "$2" = "--user" ]; then
  /bin/mkdir -p "$FAKE_USER_BASE/bin"
  printf '#!/bin/sh\\necho 0.6.13\\n' > "$FAKE_USER_BASE/bin/cmake-format"
  /bin/chmod 750 "$FAKE_USER_BASE/bin/cmake-format"
  exit 0
fi
exit 1
`,
		);
		writeFakePythonWithoutVenv(bin, "pep668");

		const program = await runInstaller(root, bin, "cmake-format", {
			FAKE_PIP_LOG: log,
			FAKE_USER_BASE: userBase,
		});

		expect(program.result.installed).toBe(true);
		expect(fs.readFileSync(log, "utf-8")).toContain(
			"install --user cmakelang[yaml]",
		);
	});
});

/**
 * A resolution is a command that RUNS (#3311).
 *
 * The nightly census reported `⚠ cmake cmake-language-server 0 no client ready
 * in 30000ms (server missing/slow; try --install)` on every run while
 * `ensureTool(cmake-language-server) → cmake-language-server` said the tool was
 * there. Both statements came from the same rung: `pipx install` exits 0 and
 * puts a launcher on PATH, the ladder's PATH rung returned that launcher without
 * probing it, and the launcher could not start — cmake-language-server 0.1.11
 * declares only `pygls>=1.1.1` and pip resolved pygls 2.1.1, which removed
 * `pygls.server.LanguageServer`.
 *
 * The fake pipx below is production-faithful on the axis under test, measured
 * against the real packages for the nightly's interpreter:
 *
 *   $ pip download --python-version 3.12 --only-binary=:all: cmake-language-server
 *   cmake_language_server-0.1.11-py3-none-any.whl  pygls-2.1.1-py3-none-any.whl
 *   $ cmake-language-server --version
 *   ImportError: cannot import name 'LanguageServer' from 'pygls.server'   (exit 1)
 *
 *   $ PIP_CONSTRAINT=<file with pygls<2> pip download --python-version 3.12 …
 *   cmake_language_server-0.1.11-py3-none-any.whl  pygls-1.3.1-py3-none-any.whl
 *   $ cmake-language-server --version
 *   cmake-language-server 0.1.11                                           (exit 0)
 *
 * so the double's launcher works exactly when the constraint reached pip, and a
 * double that ignored `PIP_CONSTRAINT` would turn an inert fix green.
 */
function writeConstraintAwarePipx(binDir: string, root: string): string {
	const log = path.join(root, "pipx.log");
	writeExecutable(
		path.join(binDir, "pipx"),
		`#!/bin/sh
echo "argv: $*" >> "${log}"
echo "PIP_CONSTRAINT=\${PIP_CONSTRAINT:-}" >> "${log}"
echo "UV_CONSTRAINT=\${UV_CONSTRAINT:-}" >> "${log}"
# Which variable this "backend" reads. Real pipx 1.17.6 picks uv whenever uv is
# on PATH and that backend ignores PIP_CONSTRAINT entirely (measured), so a
# double that read either one would hide exactly the round-1 defect.
backend_constraint=""
case "\${FAKE_BACKEND:-pip}" in
  uv) backend_constraint="\${UV_CONSTRAINT:-}" ;;
  pip) backend_constraint="\${PIP_CONSTRAINT:-}" ;;
  *) backend_constraint="" ;;
esac
if [ -n "$backend_constraint" ]; then /bin/cat "$backend_constraint" >> "${log}"; fi
if [ "$1" = "environment" ]; then echo "$FAKE_PIPX_BIN"; exit 0; fi
[ "$1" = "install" ] || exit 1
/bin/mkdir -p "$FAKE_PIPX_BIN"
broken=no
if [ -n "\${FAKE_STALE_VENV:-}" ]; then
  broken=yes
elif [ -n "\${FAKE_REQUIRE_CONSTRAINT:-}" ]; then
  if [ -z "$backend_constraint" ] || ! /bin/grep -q "pygls<2" "$backend_constraint"; then
    broken=yes
  fi
fi
if [ "$broken" = yes ]; then
  printf '#!/bin/sh\\necho "ImportError: cannot import name LanguageServer from pygls.server" >&2\\nexit 1\\n' > "$FAKE_PIPX_BIN/$FAKE_APP"
else
  printf '#!/bin/sh\\necho "%s 0.1.11"\\n' "$FAKE_APP" > "$FAKE_PIPX_BIN/$FAKE_APP"
fi
/bin/chmod 750 "$FAKE_PIPX_BIN/$FAKE_APP"
exit 0
`,
	);
	return log;
}

describe("a PATH candidate that cannot run is not a resolution (#3311)", () => {
	it("does not resolve a pipx launcher that fails its own check", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		writeConstraintAwarePipx(bin, root);

		const program = await runInstaller(root, bin, "cmake-language-server", {
			FAKE_PIPX_BIN: path.join(root, "pipx-bin"),
			FAKE_APP: "cmake-language-server",
			// The state a box reaches when the venv predates the constraint — or
			// when the next pygls major breaks the import again.
			FAKE_STALE_VENV: "1",
		});

		// pipx reported success and put the launcher on PATH…
		expect(program.result.installed).toBe(true);
		expect(program.result.path).toContain("pipx-bin");
		// …and the ladder still refuses to call that a resolved tool.
		expect(program.result.resolved).toBeUndefined();
		const row = program.result.summary.find(
			(entry: { kind: string }) =>
				entry.kind === "installer-path-candidate-unrunnable",
		);
		expect(row?.count).toBe(1);
		expect(row?.latestReasons?.[0]?.subject).toBe("cmake-language-server");
	});

	it("keeps a PATH candidate whose probe never ran (a stall is not a verdict)", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		// A real file on PATH that cannot be spawned at all: the probe fails at
		// the spawn boundary, which says nothing about the binary (#1569).
		fs.writeFileSync(path.join(bin, "ruff"), "#!/bin/sh\necho ruff 1.0\n", {
			mode: 0o600,
		});

		const program = await runInstaller(root, bin, "ruff");

		expect(program.result.resolved).toBe("ruff");
	});
});

describe("pip resolution is bounded by the entry's own constraints (#3311)", () => {
	it("hands PIP_CONSTRAINT to pipx for an entry that declares pipConstraints", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeConstraintAwarePipx(bin, root);

		const program = await runInstaller(root, bin, "cmake-language-server", {
			FAKE_PIPX_BIN: path.join(root, "pipx-bin"),
			FAKE_APP: "cmake-language-server",
			FAKE_REQUIRE_CONSTRAINT: "1",
		});

		const transcript = fs.readFileSync(log, "utf-8");
		expect(transcript).toContain("argv: install --force cmake-language-server");
		expect(transcript).toMatch(/PIP_CONSTRAINT=(\S+)/);
		// Both resolvers, one file: pipx picks its own backend, so the constraint
		// has to be readable by whichever it picked (#3396 round 2).
		const pipPath = transcript.match(/PIP_CONSTRAINT=(\S+)/)?.[1];
		const uvPath = transcript.match(/UV_CONSTRAINT=(\S+)/)?.[1];
		expect(uvPath).toBe(pipPath);
		expect(transcript).toContain("pygls<2");
		// The independent effect: the launcher the constrained install produced is
		// the one the ladder resolved, and it runs.
		expect(program.result.resolved).toBeTruthy();
		// Through the PATH the installer exported, never the ambient one: this
		// box has a real pipx-installed cmake-language-server whose venv resolved
		// pygls 2 — the very defect — and a bare name would find that instead.
		const { stdout } = await execFileAsync(
			program.result.resolved,
			["--version"],
			{ env: { ...process.env, PATH: program.result.path } },
		);
		expect(stdout.trim()).toBe("cmake-language-server 0.1.11");
	});

	it("leaves PIP_CONSTRAINT unset for an entry that declares none", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeConstraintAwarePipx(bin, root);

		const program = await runInstaller(root, bin, "ruff", {
			FAKE_PIPX_BIN: path.join(root, "pipx-bin"),
			FAKE_APP: "ruff",
		});

		expect(program.result.installed).toBe(true);
		expect(fs.readFileSync(log, "utf-8")).toContain("PIP_CONSTRAINT=\n");
	});
});

/**
 * The BACKEND axis (#3396 round 2).
 *
 * pipx does not have one resolver. pipx 1.17.6's `--backend {pip,uv}` "Defaults
 * to PIPX_DEFAULT_BACKEND when set, else 'uv' when uv is available (via the
 * `pipx[uv]` extra or on PATH), else 'pip'" (`pipx install --help`), and the uv
 * backend never reads `PIP_CONSTRAINT`. Measured with real pipx 1.17.6 + uv
 * 0.12.10 in isolated `PIPX_HOME`/`PIPX_BIN_DIR`, the full transcripts in the PR
 * body:
 *
 *   PIP_CONSTRAINT=<pygls<2> pipx install --force cmake-language-server
 *     → pygls-2.1.1.dist-info   → launcher: ImportError (round 1's shape)
 *   PIP_CONSTRAINT=… UV_CONSTRAINT=… pipx install --force cmake-language-server
 *     → pygls-1.3.1.dist-info   → launcher: cmake-language-server 0.1.11
 *   PIP_CONSTRAINT=… pipx install --force --backend pip cmake-language-server
 *     → pygls-1.3.1.dist-info   → launcher: cmake-language-server 0.1.11
 *
 * so `FAKE_BACKEND=uv` below is the production-faithful double for the default
 * backend on a current box, and a double that read either variable would let the
 * round-1 mechanism pass.
 */
describe("both pip and uv backends are constrained (#3396 round 2)", () => {
	it("constrains a uv-backend pipx through UV_CONSTRAINT", async () => {
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const log = writeConstraintAwarePipx(bin, root);

		const program = await runInstaller(root, bin, "cmake-language-server", {
			FAKE_PIPX_BIN: path.join(root, "pipx-bin"),
			FAKE_APP: "cmake-language-server",
			FAKE_BACKEND: "uv",
			FAKE_REQUIRE_CONSTRAINT: "1",
		});

		expect(program.result.installed).toBe(true);
		expect(fs.readFileSync(log, "utf-8")).toMatch(/UV_CONSTRAINT=\S+/);
		expect(program.result.resolved).toBeTruthy();
		const { stdout } = await execFileAsync(
			program.result.resolved,
			["--version"],
			{ env: { ...process.env, PATH: program.result.path } },
		);
		expect(stdout.trim()).toBe("cmake-language-server 0.1.11");
	});

	it("refuses the launcher a backend that ignored the constraint produced", async () => {
		// The other half of "either way": whatever the resolver did, a launcher
		// that cannot run is not a resolution. This is the state round 1 shipped
		// on a uv box — installed, on PATH, and unusable.
		const root = scratchDir();
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		writeConstraintAwarePipx(bin, root);

		const program = await runInstaller(root, bin, "cmake-language-server", {
			FAKE_PIPX_BIN: path.join(root, "pipx-bin"),
			FAKE_APP: "cmake-language-server",
			// A backend that reads neither variable: the constraint is handed over
			// and ignored.
			FAKE_BACKEND: "neither",
			FAKE_REQUIRE_CONSTRAINT: "1",
		});

		expect(program.result.installed).toBe(true);
		expect(program.result.resolved).toBeUndefined();
		expect(
			program.result.summary.map((entry: { kind: string }) => entry.kind),
		).toContain("installer-path-candidate-unrunnable");
	});

	it("does not hand either resolver a constraints path with whitespace in it", async () => {
		// Both variables carry a whitespace-SEPARATED LIST, so a spaced path is
		// not a path: measured on uv 0.12.10, the install dies with
		// `error: File not found: …/space`. Worse than the bug, so the file moves
		// to a whitespace-free directory and, with none available, the install
		// runs unconstrained and says so.
		const root = scratchDir();
		const spacedHome = path.join(root, "home with space");
		const spacedTmp = path.join(root, "tmp with space");
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(spacedHome, { recursive: true });
		fs.mkdirSync(spacedTmp, { recursive: true });
		const log = writeConstraintAwarePipx(bin, root);

		const program = await runInstaller(
			spacedHome,
			bin,
			"cmake-language-server",
			{
				FAKE_PIPX_BIN: path.join(root, "pipx-bin"),
				FAKE_APP: "cmake-language-server",
				FAKE_BACKEND: "uv",
				TMPDIR: spacedTmp,
			},
		);

		const transcript = fs.readFileSync(log, "utf-8");
		expect(transcript).toContain("PIP_CONSTRAINT=\n");
		expect(transcript).toContain("UV_CONSTRAINT=\n");
		expect(
			program.result.summary.map((entry: { kind: string }) => entry.kind),
		).toContain("pip-constraint-path-unusable");
	});

	it("falls back to a whitespace-free directory when the home has a space", async () => {
		const root = scratchDir();
		const spacedHome = path.join(root, "home with space");
		const cleanTmp = path.join(root, "tmp-clean");
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(spacedHome, { recursive: true });
		fs.mkdirSync(cleanTmp, { recursive: true });
		const log = writeConstraintAwarePipx(bin, root);

		const program = await runInstaller(
			spacedHome,
			bin,
			"cmake-language-server",
			{
				FAKE_PIPX_BIN: path.join(root, "pipx-bin"),
				FAKE_APP: "cmake-language-server",
				FAKE_BACKEND: "uv",
				FAKE_REQUIRE_CONSTRAINT: "1",
				TMPDIR: cleanTmp,
			},
		);

		const transcript = fs.readFileSync(log, "utf-8");
		expect(transcript).toMatch(
			new RegExp(`UV_CONSTRAINT=${cleanTmp}\\S*cmake-language-server\\.txt`),
		);
		expect(transcript).toContain("pygls<2");
		expect(program.result.resolved).toBeTruthy();
	});
});
