// Tool-smoke fixture for #209 — clippy flags `len() == 0` (clippy::len_zero);
// rust-analyzer handshakes and loads the cargo project.
fn main() {
    let v: Vec<i32> = Vec::new();
    if v.len() == 0 {
        println!("{}", v.len());
    }
}
