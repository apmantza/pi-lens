import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import {
	BASH4_NEEDLES,
	findBash4PortabilityFindings,
	type Workflow,
} from "../support/workflow-shell-portability.js";

const ROOT = resolve(import.meta.dirname, "../..");

function loadWorkflow(source: string): Workflow {
	return yaml.load(source) as Workflow;
}

const MATRIX_FIXTURE = `
jobs:
  portable:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - name: Uses bash 4 builtin
        run: |
          mapfile -t values < input.txt
      - name: Comment only
        run: |
          # mapfile is documented here, not executed
          printf '%s\\n' safe
`;

describe("workflow shell portability governance (#2625)", () => {
	it("lists each bash 4-only needle and its required version", () => {
		expect(BASH4_NEEDLES).toEqual([
			{ name: "mapfile", bashVersion: "4.0" },
			{ name: "readarray", bashVersion: "4.0" },
			{ name: "${var,,}", bashVersion: "4.0" },
			{ name: "${var^^}", bashVersion: "4.0" },
			{ name: "declare -A", bashVersion: "4.0" },
			{ name: "|&", bashVersion: "4.0" },
			{ name: ";;&", bashVersion: "4.0" },
		]);
	});

	it("reports a bash 4 needle in a macOS matrix step with its identity", () => {
		const findings = findBash4PortabilityFindings(
			loadWorkflow(MATRIX_FIXTURE),
			"fixture.yml",
		);

		expect(findings).toEqual([
			{
				workflow: "fixture.yml",
				job: "portable",
				step: "Uses bash 4 builtin",
				needle: "mapfile",
			},
		]);
	});

	it("detects every listed needle in executable bash code", () => {
		const source = `
jobs:
  all-needles:
    runs-on: macos-latest
    steps:
      - name: Bash 4 constructs
        shell: bash
        run: |
          mapfile -t values < input.txt
          readarray -t values < input.txt
          lower=\${VALUE,,}
          upper=\${VALUE^^}
          declare -A lookup
          printf '%s\\n' value |& tee output.txt
          case value in value);;& esac
`;

		expect(
			findBash4PortabilityFindings(loadWorkflow(source), "fixture.yml").map(
				(finding) => finding.needle,
			),
		).toEqual(BASH4_NEEDLES.map((needle) => needle.name));
	});

	it("does not report comments, quoted strings, or ubuntu-only jobs", () => {
		const source = `
jobs:
  ubuntu:
    runs-on: ubuntu-latest
    steps:
      - name: Quoted prose
        run: echo "mapfile readarray \${VALUE,,} declare -A |& ;;&"
  macos:
    runs-on: macos-latest
    steps:
      - name: Comment and quote
        run: |
          # readarray
          echo "declare -A"
      - name: Non-bash shells
        shell: sh
        run: mapfile
      - name: PowerShell
        shell: pwsh
        run: readarray
`;

		expect(
			findBash4PortabilityFindings(loadWorkflow(source), "fixture.yml"),
		).toEqual([]);
	});

	it("follows a macOS reusable-workflow input", () => {
		const source = `
on:
  workflow_call:
    inputs:
      runner:
        type: string
        default: macos-latest
jobs:
  reusable:
    runs-on: \${{ inputs.runner }}
    steps:
      - name: Reusable bash step
        run: mapfile -t values < input.txt
`;

		expect(
			findBash4PortabilityFindings(loadWorkflow(source), "reusable.yml"),
		).toEqual([
			{
				workflow: "reusable.yml",
				job: "reusable",
				step: "Reusable bash step",
				needle: "mapfile",
			},
		]);
	});

	it.each([
		[
			"double-quoted parameter expansions",
			`echo "\${VALUE,,} \${VALUE^^}"`,
			["${var,,}", "${var^^}"],
		],
		[
			"a mapfile command after a continuation",
			"map\\\nfile -t values",
			["mapfile"],
		],
		["readarray with an option", "readarray -t values", ["readarray"]],
		[
			"single-character parameter operators",
			"echo \${VALUE,} \${VALUE^}",
			["${var,,}", "${var^^}"],
		],
		["a quoted heredoc body", "cat <<'EOF'\nmapfile -t values\nEOF", []],
		[
			"an unquoted heredoc substitution",
			"cat <<EOF\n\$(mapfile -t values)\nEOF",
			["mapfile"],
		],
	] as const)("flags $0", (_name, run, needles) => {
		const source = `
jobs:
  macos:
    runs-on: macos-latest
    steps:
      - name: case
        run: |
          ${run.replace(/\n/g, "\n          ")}
`;
		expect(
			findBash4PortabilityFindings(loadWorkflow(source), "fixture.yml").map(
				(finding) => finding.needle,
			),
		).toEqual(needles);
	});

	it("follows a macOS runner introduced by matrix include", () => {
		const source = `
jobs:
  included:
    strategy:
      matrix:
        include:
          - os: macos-latest
    runs-on: \${{ matrix.os }}
    steps:
      - name: included macOS
        run: mapfile -t values
`;
		expect(
			findBash4PortabilityFindings(loadWorkflow(source), "fixture.yml"),
		).toEqual([
			{
				workflow: "fixture.yml",
				job: "included",
				step: "included macOS",
				needle: "mapfile",
			},
		]);
	});

	it("follows a macOS value supplied by a reusable-workflow caller", () => {
		const source = `
on:
  workflow_call:
    inputs:
      runner:
        type: string
        default: ubuntu-latest
jobs:
  reusable:
    runs-on: \${{ inputs.runner }}
    steps:
      - name: caller-selected macOS
        run: mapfile -t values
`;
		expect(
			findBash4PortabilityFindings(loadWorkflow(source), "fixture.yml", {
				runner: "macos-latest",
			}),
		).toEqual([
			{
				workflow: "fixture.yml",
				job: "reusable",
				step: "caller-selected macOS",
				needle: "mapfile",
			},
		]);
	});

	it.each(["runner.os != 'macOS'", "matrix.os != 'macos-latest'"] as const)(
		"does not flag a step excluded by if: %s",
		(condition) => {
			const source = `
jobs:
  macos:
    runs-on: macos-latest
    steps:
      - name: excluded
        if: ${condition}
        run: mapfile -t values
`;
			expect(
				findBash4PortabilityFindings(loadWorkflow(source), "fixture.yml"),
			).toEqual([]);
		},
	);

	it("stops flagging the fixture when matrix expansion is neutered", () => {
		const mutated = MATRIX_FIXTURE.replace(
			"runs-on: \${{ matrix.os }}",
			"runs-on: ubuntu-latest",
		);

		expect(
			findBash4PortabilityFindings(loadWorkflow(mutated), "fixture.yml"),
		).toEqual([]);
	});

	it("keeps the current workflow population clean", () => {
		const workflowFiles = readdirSync(
			resolve(ROOT, ".github/workflows"),
		).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
		// Recurrence: #2588 replaced portable `read` calls with bash 4 builtins.
		// Keep the workflow population guard alive if the directory or extension
		// filter drifts instead of allowing an empty sweep to pass.
		assertNonEmptyScan(
			"workflow shell portability sweep",
			workflowFiles.length,
			10,
		);
		const findings = workflowFiles.flatMap((name) =>
			findBash4PortabilityFindings(
				loadWorkflow(
					readFileSync(resolve(ROOT, ".github/workflows", name), "utf8"),
				),
				`.github/workflows/${name}`,
			),
		);

		expect(findings).toEqual([]);
	});
});
