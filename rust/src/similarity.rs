//! State matrix similarity detection

use ndarray::Array2;

const NUM_SYNTAX: usize = 57;
const NUM_STATES: usize = 72;

/// Placeholder - will be implemented in Task 3
pub fn build_state_matrix(_source: &str) -> Array2<u8> {
    Array2::<u8>::zeros((NUM_SYNTAX, NUM_STATES))
}

/// Placeholder - will be implemented in Task 3
pub fn calculate_similarity(_m1: &Array2<u8>, _m2: &Array2<u8>) -> f32 {
    0.0
}

/// Placeholder - will be implemented in Task 3
pub fn count_transitions(matrix: &Array2<u8>) -> usize {
    matrix.iter().filter(|&&v| v > 0).count()
}
