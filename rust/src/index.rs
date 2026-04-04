//! Project index: Parallel function indexing

use crate::IndexData;

/// Build project index from source files
pub fn build_project_index(_project_root: &str, _files: &[String]) -> anyhow::Result<IndexData> {
    Ok(IndexData {
        entry_count: 0,
        functions: Vec::new(),
    })
}

/// Find similar functions in the index
pub fn find_similar_to(_index: &IndexData, _function_id: &str, _threshold: f32) -> Vec<crate::SimilarityMatch> {
    Vec::new()
}
