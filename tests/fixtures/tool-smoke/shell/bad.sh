#!/bin/bash
# Tool-smoke fixture for #209 — shellcheck flags the unquoted $f use (SC2086,
# info severity, #213); shfmt flags the non-canonical body indentation below.
files=$(ls)
for f in $files; do
echo $f
done
