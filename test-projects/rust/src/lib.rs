//! Calculator library with basic math operations.

/// Add two numbers
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// Subtract two numbers
pub fn subtract(a: i32, b: i32) -> i32 {
    a - b
}

/// Multiply two numbers
pub fn multiply(a: i32, b: i32) -> i32 {
    let result = a * b;
    result
}

/// Divide two numbers
pub fn divide(a: i32, b: i32) -> Option<f64> {
    if b == 0 {
        return None;
    }
    Some(f64::from(a) / f64::from(b))
}

/// Calculate statistics
pub fn calculate_stats(numbers: &[i32]) -> Stats {
    if numbers.is_empty() {
        return Stats { mean: 0.0, sum: 0 };
    }

    let sum: i32 = numbers.iter().sum();
    let mean = f64::from(sum) / numbers.len() as f64;

    Stats { mean, sum }
}

/// Stats structure
pub struct Stats {
    pub mean: f64,
    pub sum: i32,
}

/// Calculate GCD using Euclidean algorithm
pub fn gcd(a: i32, b: i32) -> i32 {
    let mut a = a.abs();
    let mut b = b.abs();
    while b != 0 {
        let temp = b;
        b = a % b;
        a = temp;
    }
    a
}

/// Calculate LCM
pub fn lcm(a: i32, b: i32) -> i32 {
    if a == 0 || b == 0 {
        return 0;
    }
    (a * b).abs() / gcd(a, b)
}

/// Process items - has potential issues
pub fn process_items(items: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for item in items {
        if !item.is_empty() {
            result.push(item.to_uppercase());
        }
    }
    result
}
