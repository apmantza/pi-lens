import { toolAbsentSkip } from "./utils/runner-helpers.js";
import { skipped } from "../types.js";
import * as path from "node:path";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { hasToolConfig } from "../../tool-config-presence.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { PRIORITY } from "../priorities.js";
import { markUnanchored, withOverlayFile } from "./utils/ignore-anchor.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";
import { createCwdCachedProbe } from "./utils/runner-helpers.js";

const CREDO_PROBE_BUDGET_MS = 10_000;

// Per-cwd cached `mix credo --version` probe (#120), governed by the shared
// availability policy (#1494). The probe returns the spawn result so the policy
// can tell a cold-BEAM timeout from a genuinely absent credo: the 10 s budget
// here is the widest in the repo and the most likely to expire on a slow first
// compile, and latching that as "not installed" used to disable credo for the
// rest of the session.
const probeCredo = createCwdCachedProbe(
	(cwd) =>
		safeSpawnAsync("mix", ["credo", "--version"], {
			timeout: CREDO_PROBE_BUDGET_MS,
			cwd,
		}),
	{ tool: "credo", budgetMs: CREDO_PROBE_BUDGET_MS },
);

interface CredoIssue {
	filename: string;
	line_no: number;
	column: number | null;
	message: string;
	category: string;
	check: string;
	priority: number;
}

interface CredoOutput {
	issues: CredoIssue[];
}

// `mix credo <file>` is single-file-scoped today, so blanket attribution would
// be correct — but map issue.filename (resolved against cwd) for robustness so
// this stays correct if the invocation ever widens to a directory (#265 A4).
export function parseCredoJson(
	raw: string,
	fallbackPath: string,
	cwd: string,
): Diagnostic[] {
	try {
		const output: CredoOutput = JSON.parse(raw);
		return (output.issues ?? []).map((issue) => ({
			id: `credo:${issue.check}:${issue.line_no}`,
			message: `[${issue.check}] ${issue.message}`,
			filePath:
				issue.filename && issue.filename.trim()
					? path.isAbsolute(issue.filename)
						? issue.filename
						: path.resolve(cwd, issue.filename)
					: fallbackPath,
			line: issue.line_no,
			column: issue.column ?? 1,
			severity:
				issue.priority <= 10 ? ("error" as const) : ("warning" as const),
			semantic:
				issue.priority <= 10 ? ("blocking" as const) : ("warning" as const),
			tool: "credo",
			rule: issue.check,
			fixable: false,
		}));
	} catch {
		return [];
	}
}

/**
 * #5594: credo tests each regex in `files.excluded` against the file's ABSOLUTE
 * path (`String.match?(path, regex)`), so `~r"/\.claude/"` also matches a project
 * checked out under `<root>/.claude/worktrees/<lane>`, and credo then reports
 * "No files found!" for a file it never read. A glob string is not affected: credo
 * expands it from the working directory.
 *
 * `mix credo --config-file` replaces the config chain credo would have found, so
 * this script, which credo evaluates as that config, rebuilds the chain with
 * credo's own `ConfigFile.read_or_default` (the same function, the same default
 * config, the same ancestor and `config/` search, over a fresh execution so the
 * script is not read twice) and hands the merged result back unchanged, except
 * for `files.excluded`: the regexes there are tested against the file's path
 * from the project root (`/lib/a.ex`), and a regex that matches is replaced by
 * the file's own path, which credo excludes literally. The glob and path
 * entries stay. The project root and the file come from the environment, so the
 * script is one constant and nothing is interpolated into Elixir source.
 *
 * It refuses by raising a message that starts `pi-lens-ignore-unanchored:`
 * (the file lies outside the root, the project's own config did not load, or
 * this credo lacks the API it calls); credo prints it, and the runner then runs
 * credo on the project's own config.
 */
const CREDO_ANCHOR_OVERLAY = `refuse = fn why -> raise "pi-lens-ignore-unanchored: #{why}" end

try do
  root = System.get_env("PI_LENS_ANCHOR_ROOT") || refuse.("no project root")
  target = System.get_env("PI_LENS_ANCHOR_TARGET") || refuse.("no target file")
  prefix = String.trim_trailing(root, "/") <> "/"

  if not String.starts_with?(target, prefix),
    do: refuse.("the file is outside the project root")

  rel = "/" <> binary_part(target, byte_size(prefix), byte_size(target) - byte_size(prefix))
  overlay = Path.expand(__ENV__.file)

  inner =
    exec
    |> Credo.Execution.get_config_files()
    |> Enum.reject(fn {origin, file, _} -> origin == :file and Path.expand(file) == overlay end)
    |> Enum.reduce(Credo.Execution.build([]), &Credo.Execution.append_config_file(&2, &1))

  dir = Credo.CLI.Filename.remove_line_no_and_column(exec.cli_options.path)
  name = exec.cli_options.switches[:config_name]

  config =
    case Credo.ConfigFile.read_or_default(inner, dir, name) do
      {:ok, config} -> config
      {:error, _} -> refuse.("the project's credo config did not load")
    end

  {regexes, others} = Enum.split_with(config.files.excluded, &match?(%Regex{}, &1))

  excluded =
    if Enum.any?(regexes, &Regex.match?(&1, rel)), do: others ++ [target], else: others

  fix_params = fn params ->
    if Keyword.keyword?(params) do
      Enum.map(params, fn
        {key, files} when key in [:files, :__files__] and (is_map(files) or is_list(files)) ->
          case files[:excluded] do
            nil ->
              {key, files}

            listed ->
              kept =
                if Credo.Sources.filename_matches?(rel, List.wrap(listed)), do: [target], else: []

              {key,
               if(is_map(files),
                 do: Map.put(files, :excluded, kept),
                 else: Keyword.put(files, :excluded, kept)
               )}
          end

        other ->
          other
      end)
    else
      params
    end
  end

  fix_check = fn
    {check, params} when is_list(params) -> {check, fix_params.(params)}
    other -> other
  end

  checks =
    case config.checks do
      %{} = grouped ->
        Map.new(grouped, fn
          {group, list} when is_list(list) -> {group, Enum.map(list, fix_check)}
          other -> other
        end)

      list when is_list(list) ->
        Enum.map(list, fix_check)

      other ->
        other
    end

  %{
    configs: [
      %{
        name: name || "default",
        files: %{included: config.files.included, excluded: excluded},
        checks: checks,
        color: config.color,
        parse_timeout: config.parse_timeout,
        plugins: config.plugins,
        requires: config.requires,
        strict: config.strict
      }
    ]
  }
rescue
  error ->
    reason = String.replace_prefix(Exception.message(error), "pi-lens-ignore-unanchored: ", "")
    refuse.(reason)
end`;

/**
 * What credo prints on stderr when the overlay raises, so the runner can tell a
 * refusal from a finding: its own "Execution halted" line carrying the
 * exception struct. The marker is looked for there only, never in stdout or in
 * a line of the edited file's text that a finding message may quote (#5606 F4).
 */
const CREDO_UNANCHORED_REFUSAL =
	/^warning: Execution halted during [^\n]*%RuntimeError\{message: "pi-lens-ignore-unanchored: ((?:[^"\\\n]|\\.)*)"/m;

const credoRunner: RunnerDefinition = {
	id: "credo",
	appliesTo: ["elixir"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,
	// mix never walks up, so the seam answers for `cwd` alone.
	requiresConfig: (cwd) => hasToolConfig("mix", cwd),

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "credo");

		if (!credoRunner.requiresConfig?.(cwd)) {
			return skipped("not-configured");
		}

		// Credo ships as a mix dependency — cached per-cwd probe (see probeCredo).
		if (!(await probeCredo(cwd))) {
			return toolAbsentSkip(cwd, { checker: probeCredo });
		}

		const absPath = path.resolve(cwd, ctx.filePath);
		const spawnCredo = (config: readonly string[], env?: NodeJS.ProcessEnv) =>
			safeSpawnAsync(
				"mix",
				["credo", "--format", "json", "--strict", ...config, absPath],
				{ timeout: 30000, cwd, ...(env ? { env } : {}) },
			);
		// #5594: credo runs on the project's own config with its `files.excluded`
		// regexes read from the project root (`CREDO_ANCHOR_OVERLAY`). When the
		// overlay refuses, credo runs on the config as it stands and `finish`
		// withholds a clean answer.
		const anchoredRun = await withOverlayFile(
			"credo",
			"anchor.exs",
			CREDO_ANCHOR_OVERLAY,
			(file) =>
				spawnCredo(["--config-file", file], {
					PI_LENS_ANCHOR_ROOT: cwd,
					PI_LENS_ANCHOR_TARGET: absPath,
				}),
		);
		const refusal = CREDO_UNANCHORED_REFUSAL.exec(anchoredRun.stderr ?? "");
		const result = refusal ? await spawnCredo([]) : anchoredRun;
		const finish = (verdict: RunnerResult): RunnerResult =>
			refusal
				? markUnanchored("credo", refusal[1] ?? "no reason given", verdict)
				: verdict;

		const parsed = parseToolRun(
			"credo",
			{
				result,
				// EXIT TABLE (Credo 1.7 measured fixture): 0 clean; 1 findings; 2 error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			(raw) => parseCredoJson(raw, ctx.filePath, cwd),
			{ parseStreams: "stdout-else-stderr" },
		);
		if (parsed.skipped) return parsed.skipped;
		return finish(
			finishParsedRun({
				tool: "credo",
				ctx,
				result,
				diagnostics: parsed.diagnostics,
			}),
		);
	},
};

export default credoRunner;
