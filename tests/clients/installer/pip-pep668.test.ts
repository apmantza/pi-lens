// flake-shape: real-process-spawn — the regression must run the real installer against executable fake package-manager boundaries.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { pipScriptsDir } from "../../../clients/installer/index.js";

const execFileAsync = promisify(execFile);
const scratchDirs: string[] = [];

function scratchDir(): string {
	const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pip-pep668-"));
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
