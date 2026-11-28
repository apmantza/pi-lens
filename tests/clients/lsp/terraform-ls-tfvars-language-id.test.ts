/**
 * terraform-ls opens `.tfvars` as `terraform-vars`, not `terraform`.
 *
 * terraform-ls validates a variables file only when its didOpen/didChange
 * `languageId` is `terraform-vars`; announced as `terraform` the same bytes
 * decode as module code and (with enhanced validation, terraform-ls's default
 * since 0.32) every assignment is reported as "Unexpected attribute"
 * (hashicorp/vscode-terraform#1672). The registry now carries the split
 * (clients/language-registry.ts): `.tf` -> `terraform`, `.tfvars` ->
 * `terraform-vars`, both kind `terraform`.
 *
 * Spawns a real terraform-ls child only when the binary is present (skipped
 * otherwise, like its clangd sibling). Measured server behavior (0.39.0):
 *  - the WRONG id reports "Unexpected attribute" for a declared variable in a
 *    .tfvars after open + didChange (negative control: fails pre-fix);
 *  - the RIGHT id reports nothing for the same edits, and still reports a
 *    genuine error (an invalid expression) in the same file;
 *  - terraform-ls publishes a variables file's diagnostics only for AUTOLOADED
 *    names (`terraform.tfvars`, `*.auto.tfvars`, and their `.json` forms;
 *    `AutoloadedOnly()` in internal/features/variables). Any other basename
 *    (`dev.tfvars`, `test.tfvars`) never gets a file diagnostic under
 *    `terraform-vars`, so every fixture here is `terraform.tfvars`: no
 *    assertion on another name could observe a server answer. That silence
 *    for non-autoloaded names is an accepted residual of the id change.
 *
 * Every wait is gated on the file's own publication counter
 * (`getDiagnosticsVersionForPath`) captured BEFORE the notify, and the counter
 * must have advanced before any assertion. `waitForDiagnostics` resolves on
 * timeout, so a silent server would otherwise satisfy a clean assertion (the
 * #4755 review, F2).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	killProcessTree,
	createLSPClient,
} from "../../../clients/lsp/client.js";
import { launchLSP } from "../../../clients/lsp/launch.js";
import { findCommandAsync } from "../../../clients/safe-spawn.js";
import { setupTestEnvironment } from "../test-utils.js";

// Detect terraform-ls availability at module load time via `findCommandAsync`
// (cached PATH+PATHEXT resolution, same reasoning as clangd-lazy-indexing).
const TERRAFORM_LS: string | null = await findCommandAsync("terraform-ls");

const VARIABLES_TF = ['variable "env" {', "  type    = string", "}", ""].join(
	"\n",
);
const OUTPUTS_TF = [
	'output "o" {',
	"  value = var.does_not_exist",
	"}",
	"",
].join("\n");
const CLEAN_TFVARS = 'env = "x"\n';
/** A genuine vars error: terraform-ls reports "Invalid expression". */
const BROKEN_TFVARS = "env = \n";
const WAIT_MS = 15_000;

describe.skipIf(!TERRAFORM_LS)("terraform-ls .tfvars language id", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let proc: Awaited<ReturnType<typeof launchLSP>> | undefined;
	let client: Awaited<ReturnType<typeof createLSPClient>> | undefined;
	let projectDir: string;
	let moduleDir: string;
	let tfvarsPath: string;

	beforeEach(async () => {
		env = setupTestEnvironment("pi-lens-terraform-ls-");
		projectDir = env.tmpDir;
		moduleDir = path.join(projectDir, "env");
		fs.mkdirSync(moduleDir, { recursive: true });
		fs.writeFileSync(path.join(moduleDir, "variables.tf"), VARIABLES_TF);
		tfvarsPath = path.join(moduleDir, "terraform.tfvars");

		if (TERRAFORM_LS === null) throw new Error("terraform-ls unavailable");

		// Same argv shape the production TerraformServer.spawn uses.
		proc = await launchLSP(TERRAFORM_LS, ["serve"], { cwd: projectDir });
		client = await createLSPClient({
			serverId: "terraform",
			process: proc,
			root: projectDir,
		});
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.shutdown();
			} catch {
				// ignore
			}
			client = undefined;
		}
		if (proc) {
			try {
				await killProcessTree(proc.process, proc.pid);
			} catch {
				// ignore
			}
			proc = undefined;
		}
		env.cleanup();
	});

	function lspClient() {
		if (client === undefined) throw new Error("LSP client not initialized");
		return client;
	}

	function messages(file: string): string[] {
		return lspClient()
			.getDiagnostics(file)
			.map((d) => d.message);
	}

	/**
	 * Open `file` with `languageId`, then send a didChange (terraform-ls can stay
	 * silent after a first didOpen alone, measured on 0.39.0). Returns the
	 * file's publication counter read BEFORE the notify, so `untilPublished`
	 * can require it to advance.
	 */
	async function openFile(
		file: string,
		languageId: string,
		text: string,
	): Promise<number> {
		const c = lspClient();
		const baseline = c.getDiagnosticsVersionForPath(file);
		await c.notify.open(
			file,
			text,
			languageId,
			undefined,
			undefined,
			undefined,
			Date.now(),
		);
		await c.notify.change(file, `${text}# touched\n`);
		return baseline;
	}

	/**
	 * Wait for a publication on `file` newer than `baseline` (the per-path
	 * `minVersion` gate), then REQUIRE that one landed: `waitForDiagnostics`
	 * resolves on timeout, so the explicit counter check is what fails a silent
	 * server. `holds` then reads the file's own diagnostics.
	 */
	async function untilPublished(
		file: string,
		baseline: number,
		holds: (msgs: string[]) => void,
	): Promise<void> {
		await lspClient().waitForDiagnostics(file, WAIT_MS, {
			minVersion: baseline,
		});
		expect(
			lspClient().getDiagnosticsVersionForPath(file),
			`no publication for ${file}`,
		).toBeGreaterThan(baseline);
		holds(messages(file));
	}

	it("reports `Unexpected attribute` when a .tfvars is announced as terraform", async () => {
		// Negative control: the pre-fix id must reproduce the bug on the same
		// autoloaded fixture the fixed-id cases use.
		const baseline = await openFile(tfvarsPath, "terraform", CLEAN_TFVARS);
		await untilPublished(tfvarsPath, baseline, (msgs) =>
			expect(msgs.join("\n")).toContain("Unexpected attribute"),
		);
	}, 60_000);

	it("reports nothing when a .tfvars is announced as terraform-vars and edited clean", async () => {
		// Recurrence: #4755's clean case passed on a server that never answered
		// (waitForDiagnostics resolves on timeout; `[]` is also the no-answer
		// state). Here the file first carries a genuine error, so the server must
		// publish it (proving it answers for THIS path), then the clean edit must
		// publish again past that counter with an empty set. Silence cannot pass.
		await openFile(tfvarsPath, "terraform-vars", BROKEN_TFVARS);
		await untilPublished(tfvarsPath, 0, (msgs) =>
			expect(msgs.join("\n")).toContain("Invalid expression"),
		);
		const baseline = lspClient().getDiagnosticsVersionForPath(tfvarsPath);
		await lspClient().notify.change(tfvarsPath, CLEAN_TFVARS);
		await untilPublished(tfvarsPath, baseline, (msgs) =>
			expect(msgs).toEqual([]),
		);
	}, 60_000);

	it("still reports a genuine vars error under terraform-vars", async () => {
		// The id change must not suppress validation: an invalid expression in
		// the autoloaded file is reported by terraform-ls itself (0.39.0).
		const baseline = await openFile(
			tfvarsPath,
			"terraform-vars",
			BROKEN_TFVARS,
		);
		await untilPublished(tfvarsPath, baseline, (msgs) =>
			expect(msgs.join("\n")).toContain("Invalid expression"),
		);
	}, 60_000);

	it("still validates a .tf module under the terraform id", async () => {
		const outputsPath = path.join(moduleDir, "outputs.tf");
		fs.writeFileSync(outputsPath, OUTPUTS_TF);
		const baseline = await openFile(outputsPath, "terraform", OUTPUTS_TF);
		await untilPublished(outputsPath, baseline, (msgs) =>
			expect(msgs.join("\n")).toContain("var.does_not_exist"),
		);
	}, 60_000);
});
