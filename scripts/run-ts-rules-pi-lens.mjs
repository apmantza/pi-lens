import * as fs from "node:fs";
import { queryLoader, isDisabledQueryFilePath } from "../clients/tree-sitter-query-loader.js";
import { TreeSitterClient } from "../clients/tree-sitter-client.js";
import { execSync } from "node:child_process";

const PI_LENS = "C:/Users/R3LiC/Desktop/pi-lens";

const tsFiles = execSync(
  `find "${PI_LENS}" -name "*.ts" -type f -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.pi-lens/*"`,
  { encoding: "utf-8" }
).trim().split("\n").filter(Boolean);

console.log(`Found ${tsFiles.length} TS files in pi-lens`);

const client = new TreeSitterClient();
if (!client.isAvailable()) {
  console.log("Tree-sitter NOT AVAILABLE");
  process.exit(1);
}
await client.init();

await queryLoader.loadQueries();
const allQueries = queryLoader.getAllQueries();
const tsQueries = allQueries.filter(q => 
  !isDisabledQueryFilePath(q.filePath) &&
  (q.language === "typescript" || q.language === "tsx" || q.language === "javascript")
);
console.log(`Loaded ${tsQueries.length} TS/JS rules (excluding disabled)`);

const findings = {};
for (const q of tsQueries) findings[q.id] = [];

let processed = 0;
const startTime = Date.now();
for (let i = 0; i < tsFiles.length; i++) {
  const file = tsFiles[i];
  if (i % 200 === 0) console.log(`  ${i}/${tsFiles.length} (${Math.round((Date.now() - startTime) / 1000)}s)...`);
  for (const q of tsQueries) {
    try {
      const r = await client.runQueryOnFile(q, file, "typescript");
      for (const f of r) {
        findings[q.id].push({
          file: file.replace(PI_LENS + "/", ""),
          line: f.line,
          text: f.text?.slice(0, 120) ?? "",
        });
      }
    } catch (e) {}
  }
  processed++;
}

console.log(`\nDone: ${tsFiles.length} files, ${Math.round((Date.now() - startTime) / 1000)}s`);
const sorted = Object.entries(findings).sort((a, b) => b[1].length - a[1].length);
for (const [ruleId, ruleFindings] of sorted) {
  if (!ruleFindings.length) continue;
  console.log(`${ruleFindings.length.toString().padStart(5)} ${ruleId}`);
  const fileCounts = {};
  for (const f of ruleFindings) fileCounts[f.file] = (fileCounts[f.file] ?? 0) + 1;
  const topFiles = Object.entries(fileCounts).sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [file, count] of topFiles) {
    console.log(`  ${count.toString().padStart(5)} ${file}`);
  }
}

fs.writeFileSync("C:/WINDOWS/TEMP/pi_lens_ts_findings.json", JSON.stringify(findings, null, 2));
