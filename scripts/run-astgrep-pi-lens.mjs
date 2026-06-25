import * as fs from "node:fs";
import { execSync } from "node:child_process";

const PI_LENS = "C:/Users/R3LiC/Desktop/pi-lens";
const PI_LENS_RULES2 = "C:/Users/R3LiC/Desktop/pi-lens-rules2";

console.log("Running ast-grep on pi-lens...");

const cmd = `cd "${PI_LENS_RULES2}" && ast-grep scan -c rules/ast-grep-rules/.sgconfig.yml "${PI_LENS}" --json 2>/dev/null`;

try {
  const output = execSync(cmd, { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 });
  if (!output.trim()) {
    console.log("No output");
    process.exit(0);
  }
  const findings = JSON.parse(output);
  
  const byRule = {};
  for (const f of findings) {
    const ruleId = f.ruleId || "unknown";
    if (!byRule[ruleId]) byRule[ruleId] = [];
    byRule[ruleId].push({
      file: f.file?.replace(PI_LENS + "/", "") || "?",
      line: f.range?.start?.line + 1 || 0,
      text: f.text?.slice(0, 100) || "",
    });
  }
  
  console.log(`Total findings: ${findings.length}, rules firing: ${Object.keys(byRule).length}`);
  const sorted = Object.entries(byRule).sort((a, b) => b[1].length - a[1].length);
  for (const [ruleId, ruleFindings] of sorted) {
    console.log(`${ruleFindings.length.toString().padStart(5)} ${ruleId}`);
    const fileCounts = {};
    for (const f of ruleFindings) fileCounts[f.file] = (fileCounts[f.file] ?? 0) + 1;
    const topFiles = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [file, count] of topFiles) {
      console.log(`  ${count.toString().padStart(5)} ${file}`);
    }
  }
  
  fs.writeFileSync("C:/WINDOWS/TEMP/pi_lens_astgrep.json", JSON.stringify(byRule, null, 2));
} catch (e) {
  console.log("Error:", e.message?.slice(0, 200));
}
