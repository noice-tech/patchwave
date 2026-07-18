use std::fs;
use std::path::{Path, PathBuf};

use patchwave_native::patch::{
    parse_patch, EffectSpec, FilterMode, LfoShape, Waveform, PATCH_JSON_MAX_BYTES,
};

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
fn canonical_wobble_preserves_values_and_effect_order() {
    let serialized =
        fs::read_to_string(fixture_root().join("valid/wobble.json")).expect("read wobble fixture");
    let patch = parse_patch(&serialized).expect("parse wobble fixture");

    assert_eq!(patch.source.frequency_hz, 55.0);
    assert_eq!(patch.source.gain_db, -14.0);
    assert_eq!(patch.source.oscillators.len(), 3);
    assert_eq!(patch.source.oscillators[0].waveform, Waveform::Saw);
    assert_eq!(patch.source.oscillators[0].transpose_semitones, 12);
    assert_eq!(patch.source.oscillators[1].detune_cents, 7.0);
    assert_eq!(patch.source.oscillators[2].waveform, Waveform::Sine);

    let filter = patch.source.filter.expect("source filter");
    assert_eq!(filter.mode, FilterMode::Lowpass);
    assert_eq!(filter.cutoff_hz, 220.0);
    assert_eq!(filter.resonance, 0.7);
    let lfo = filter.cutoff_lfo.expect("cutoff LFO");
    assert_eq!(lfo.shape, LfoShape::Sine);
    assert_eq!(lfo.rate_hz, 2.5);
    assert_eq!(lfo.amount_octaves, 2.5);

    assert!(matches!(patch.effects[0], EffectSpec::Saturator(_)));
    assert!(matches!(patch.effects[1], EffectSpec::StereoDelay(_)));
    let EffectSpec::StereoDelay(delay) = patch.effects[1] else {
        unreachable!()
    };
    assert_eq!(delay.time_seconds, 0.095);
    assert_eq!(delay.feedback, 0.2);
    assert!(delay.ping_pong);
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
    assert!(parse_patch("{\"source\":").is_err());
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
