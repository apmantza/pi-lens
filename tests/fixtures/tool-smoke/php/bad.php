<?php
// Tool-smoke fixture for #209 — intelephense flags the undefined variable
// $naem (typo of $name).
function greet(string $name): string
{
    return "Hello " . $naem;
}
