-- Seeded defect for the nightly --lsp handshake fixture and a future
-- lsp_diagnostics gate row: `"not a natural number"` is a String where a Nat
-- is required. Kept literal so the gate marker is removable.
def wrong : Nat := "not a natural number"
