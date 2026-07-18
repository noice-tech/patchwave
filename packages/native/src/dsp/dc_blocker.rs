use std::f32::consts::TAU;
#[derive(Default)]
pub(crate) struct DcBlocker {
    previous_input: f32,
    previous_output: f32,
}
impl DcBlocker {
    pub(crate) fn process(&mut self, input: f32, sample_rate: f32) -> f32 {
        let input = if input.is_finite() { input } else { 0.0 };
        let r = (-TAU * 10.0 / sample_rate).exp();
        let mut output = input - self.previous_input + r * self.previous_output;
        if !output.is_finite() || output.abs() < 1e-20 {
            output = 0.0;
        }
        self.previous_input = input;
        self.previous_output = output;
        output
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recurrence_and_nonfinite() {
        let mut d = DcBlocker::default();
        assert_eq!(d.process(1.0, 48_000.0), 1.0);
        assert!(d.process(1.0, 48_000.0) < 1.0);
        assert!(d.process(f32::NAN, 48_000.0).is_finite());
    }
}
