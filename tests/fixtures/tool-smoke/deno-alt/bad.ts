// Alternate-primary fixture: the Deno LSP (deno lsp) is the fallback for the
// TypeScript file kind when the default `typescript` server is disabled. The
// sibling deno.json both satisfies DenoServer's root detector (deno.json /
// deno.jsonc, no fallback) and puts the workspace in Deno mode so the server
// type-checks. The type error below yields a TS2322 diagnostic from deno-ts.
const greeting: number = "not a number";
console.log(greeting);
