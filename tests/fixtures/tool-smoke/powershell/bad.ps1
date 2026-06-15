# Tool-smoke fixture for #209 — PSScriptAnalyzer flags the assigned-but-never-used
# variable (PSUseDeclaredVarsMoreThanAssignments).
$unused = 'hello'
Write-Output 'done'
