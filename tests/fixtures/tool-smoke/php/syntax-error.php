<?php
// Tool-smoke fixture for #209 — php -l flags the parse error (missing
// concatenation operator between the string and $name).
function greet(string $name): string
{
    return "Hello " $name;
}
