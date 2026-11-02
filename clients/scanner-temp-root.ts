/**
 * The one temp-root seam for every scanner whose report directory is created
 * with `mkdtempSync` and removed in a `finally` (#4133).
 *
 * jscpd, gitleaks, opengrep, trivy, and the ast-grep temp-rule scan
 * (`SgRunner`, reached unawaited by session_start's exports scan, #4347), the
 * helm render pass, and the ast-grep snippet directories of `dumpAst`,
 * `validatePattern` and `validateRule` all create their directory with
 * `mkdtempSync` under `os.tmpdir()` and delete it in a `finally`. The
 * SpotBugs `-output` file, the PSScriptAnalyzer `-File` script and the ast-grep
 * baseline scratch directory (`clients/sgconfig.ts`) do the same job without
 * the `mkdtempSync`: a path joined onto this parent. A process killed before
 * that `finally` (the MCP
 * harness `dispose()` SIGKILLs its child tree, which runs `mode=full`
 * scanners) strands a `pi-lens-<scanner>-*` directory in the shared tmpdir. A harness that owns a
 * root and sweeps it sets `PI_LENS_TEST_SCANNER_TMPDIR`, so the orphan lands
 * inside the root the harness removes; production is unchanged because the
 * default stays `os.tmpdir()`.
 *
 * One env var and one function, shared by every such scanner: a per-scanner
 * copy is the drift this seam exists to prevent (#4133 round 3). Read at call
 * time like the other lazy env seams; an empty value falls back to the
 * tmpdir.
 *
 * Test workers and explicitly marked scanner harness children may use the
 * override. The scanner-only harness marker is independent of logging test
 * mode: real-pi needs live logs and clears VITEST (#4292 round 5).
 */

import * as os from "node:os";
import { isTestMode } from "./env-utils.js";

export function scannerReportParentDir(): string {
	if (!isTestMode() && process.env.PI_LENS_TEST_SCANNER_HARNESS !== "1")
		return os.tmpdir();
	const override = process.env.PI_LENS_TEST_SCANNER_TMPDIR?.trim();
	return override && override.length > 0 ? override : os.tmpdir();
}
