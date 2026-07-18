use crate::patch::{OscillatorSpec, Waveform};

#[derive(Clone, Copy, Debug)]
pub(crate) struct OscillatorParameters {
    pub waveform: Waveform,
    pub frequency_hz: f32,
    pub pulse_width: f32,
    pub level: f32,
}
impl OscillatorParameters {
    pub(crate) fn from_spec(base: f32, spec: OscillatorSpec) -> Self {
        let semitones = spec.transpose_semitones as f32 + spec.detune_cents / 100.0;
        Self {
            waveform: spec.waveform,
            frequency_hz: base * 2.0_f32.powf(semitones / 12.0),
            pulse_width: spec.pulse_width,
            level: spec.level,
        }
    }
    pub(crate) fn silent(base: f32) -> Self {
        Self {
            waveform: Waveform::Sine,
            frequency_hz: base,
            pulse_width: 0.5,
            level: 0.0,
        }
    }
}

pub(crate) fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        2.0 * x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + 2.0 * x + 1.0
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blep_edges() {
        assert_eq!(poly_blep(0.0, 0.1), -1.0);
        assert_eq!(poly_blep(0.1, 0.1), 0.0);
        assert_eq!(poly_blep(0.9, 0.1), 0.0);
    }
}
