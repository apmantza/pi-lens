// Tool-smoke fixture for #209 — zig flags the unused local constant.
pub fn main() void {
    const x: u32 = 5;
}
