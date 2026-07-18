use std::f32::consts::TAU;
#[derive(Default)]
pub(crate) struct OnePole {
    state: f32,
}
impl OnePole {
    pub(crate) fn process(&mut self, input: f32, damping: f32, sample_rate: f32) -> f32 {
        let cutoff = 20_000.0 * (1_000.0_f32 / 20_000.0).powf(damping);
        let alpha = 1.0 - (-TAU * cutoff.min(0.45 * sample_rate) / sample_rate).exp();
        self.state += alpha * (input - self.state);
        if !self.state.is_finite() || self.state.abs() < 1e-20 {
            self.state = 0.0;
        }
        self.state
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finite_and_flushes() {
        let mut p = OnePole::default();
        assert!(p.process(1.0, 1.0, 48_000.0).is_finite());
        assert_eq!(OnePole::default().process(1e-30, 0.0, 48_000.0), 0.0);
    }
}
