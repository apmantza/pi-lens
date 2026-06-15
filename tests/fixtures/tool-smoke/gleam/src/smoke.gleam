// Tool-smoke fixture for #209 — gleam check flags the type mismatch
// (String body where the return type is declared Int).
pub fn main() -> Int {
  "not an int"
}
