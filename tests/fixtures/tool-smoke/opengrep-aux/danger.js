// Fixture for the auxiliary-LSP harness layer: the sibling `.opengrep.yml` rule
// flags this `eval(userInput)` (code injection) — a hermetic local rule, so the
// scan needs no network `auto` ruleset. The harness drives this through the
// with-auxiliary touchFile path and asserts the opengrep (source "Semgrep")
// diagnostic comes back.
function run(userInput) {
	return eval(userInput);
}

module.exports = { run };
