// Tool-smoke fixture for #209/#2780 — rust-analyzer flags the type mismatch.
fn main() {
    let v: Vec<i32> = "not a vector";
    println!("{}", v.len());
}
