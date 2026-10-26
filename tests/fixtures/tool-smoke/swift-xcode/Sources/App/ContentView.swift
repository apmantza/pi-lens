// The cross-file use (#4880). `Greeting` is declared in Greeting.swift, so it
// resolves only when sourcekit-lsp type-checks both files as one module — which
// needs the compiler arguments the build server named in buildServer.json
// serves. With the client rooted at this file's own directory (pre-#4857) the
// project has no marker, the build server is never found, and the fallback
// build settings compile this file alone: "Cannot find 'Greeting' in scope".
let greeting = Greeting.text()

// LSP gate seed (#4880): sourcekit-lsp flags the type mismatch.
let gateSeed: Int = "not a number"
