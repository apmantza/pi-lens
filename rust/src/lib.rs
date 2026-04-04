//! pi-lens-core: High-performance analysis engine
//!
//! Provides:
//! - Fast file system scanning with gitignore support
//! - State matrix similarity detection
//! - Parallel project indexing
//! - Tree-sitter query execution

#![allow(missing_docs)] // Temporarily allow during development

pub mod scan;
pub mod similarity;
pub mod index;
pub mod cache;

use serde::{Deserialize, Serialize};

/// Main analysis request from TypeScript
#[derive(Debug, Clone, Deserialize)]
pub struct AnalyzeRequest {
    pub command: Command,
    pub project_root: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Command {
    Scan { extensions: Vec<String> },
    BuildIndex { files: Vec<String> },
    Similarity { file_path: String, threshold: f32 },
    Query { language: String, query: String, file_path: String },
}

/// Analysis response to TypeScript
#[derive(Debug, Clone, Serialize)]
pub struct AnalyzeResponse {
    pub success: bool,
    pub data: ResponseData,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseData {
    Files(Vec<FileEntry>),
    Index(IndexData),
    Similarities(Vec<SimilarityMatch>),
    QueryResults(Vec<QueryMatch>),
    Empty,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexData {
    pub entry_count: usize,
    pub functions: Vec<FunctionEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FunctionEntry {
    pub id: String,
    pub file_path: String,
    pub name: String,
    pub line: usize,
    pub signature: String,
    pub matrix_hash: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SimilarityMatch {
    pub source_id: String,
    pub target_id: String,
    pub similarity: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryMatch {
    pub line: usize,
    pub column: usize,
    pub text: String,
}

/// Analyze a request and return structured response
pub fn analyze(request: &AnalyzeRequest) -> AnalyzeResponse {
    match &request.command {
        Command::Scan { extensions } => {
            match scan::scan_project(&request.project_root, extensions) {
                Ok(files) => AnalyzeResponse {
                    success: true,
                    data: ResponseData::Files(files),
                    error: None,
                },
                Err(e) => AnalyzeResponse {
                    success: false,
                    data: ResponseData::Empty,
                    error: Some(format!("{}", e)),
                },
            }
        }
        _ => AnalyzeResponse {
            success: false,
            data: ResponseData::Empty,
            error: Some("Command not implemented".to_string()),
        },
    }
}
