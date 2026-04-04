//! Fast file system scanning with gitignore support

/// Scan project for files matching extensions
pub fn scan_project(_root: &str, _extensions: &[String]) -> anyhow::Result<Vec<crate::FileEntry>> {
    Ok(Vec::new())
}
