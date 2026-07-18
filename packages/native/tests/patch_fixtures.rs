use std::fs;
use std::path::{Path, PathBuf};

use patchwave_native::patch::{parse_patch, PATCH_JSON_MAX_BYTES};

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/patches")
}

fn fixture_files(kind: &str) -> Vec<PathBuf> {
    let mut paths = fs::read_dir(fixture_root().join(kind))
        .expect("fixture directory")
        .map(|entry| entry.expect("fixture entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

#[test]
fn accepts_all_shared_valid_fixtures() {
    for path in fixture_files("valid") {
        let serialized = fs::read_to_string(&path).expect("read valid fixture");
        parse_patch(&serialized).unwrap_or_else(|error| {
            panic!("{} should be valid: {error}", path.display());
        });
    }
}

#[test]
fn rejects_all_shared_invalid_fixtures() {
    for path in fixture_files("invalid") {
        let serialized = fs::read_to_string(&path).expect("read invalid fixture");
        assert!(
            parse_patch(&serialized).is_err(),
            "{} should be invalid",
            path.display()
        );
    }
}

#[test]
fn rejects_malformed_json() {
    assert!(parse_patch("{\"tempoBpm\":120,").is_err());
}

#[test]
fn enforces_utf8_byte_limit_before_parsing() {
    let base = fs::read_to_string(fixture_root().join("valid/minimal.json"))
        .expect("read minimal fixture");
    let trimmed = base.trim_end();
    let exact = format!(
        "{trimmed}{}",
        " ".repeat(PATCH_JSON_MAX_BYTES - trimmed.len())
    );
    assert_eq!(exact.len(), PATCH_JSON_MAX_BYTES);
    assert!(parse_patch(&exact).is_ok());

    let oversized_ascii = format!("{exact} ");
    assert!(parse_patch(&oversized_ascii).is_err());

    let oversized_multibyte = format!("\"{}\"", "é".repeat(PATCH_JSON_MAX_BYTES / 2));
    assert!(oversized_multibyte.chars().count() < PATCH_JSON_MAX_BYTES);
    assert!(oversized_multibyte.len() > PATCH_JSON_MAX_BYTES);
    assert!(parse_patch(&oversized_multibyte).is_err());
}
