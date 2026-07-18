pub(crate) struct DelayLine {
    buffer: Vec<f32>,
    write: usize,
}
impl DelayLine {
    pub(crate) fn new(sample_rate: f32) -> Result<Self, &'static str> {
        if !sample_rate.is_finite() || sample_rate < 10.0 {
            return Err("sample rate must be finite and at least 10 Hz");
        }
        let length = (2.0_f64 * f64::from(sample_rate)).ceil();
        if length > usize::MAX as f64 - 2.0 {
            return Err("delay allocation is too large");
        }
        let length = length as usize + 2;
        let mut buffer = Vec::new();
        buffer
            .try_reserve_exact(length)
            .map_err(|_| "delay allocation failed")?;
        buffer.resize(length, 0.0);
        Ok(Self { buffer, write: 0 })
    }
    pub(crate) fn read(&self, delay_samples: f32) -> f32 {
        let len = self.buffer.len() as f32;
        let pos = (self.write as f32 - delay_samples).rem_euclid(len);
        let i0 = pos.floor() as usize;
        let i1 = (i0 + 1) % self.buffer.len();
        let frac = pos - i0 as f32;
        self.buffer[i0] + (self.buffer[i1] - self.buffer[i0]) * frac
    }
    pub(crate) fn write(&mut self, value: f32) {
        self.buffer[self.write] = value;
    }
    pub(crate) fn advance(&mut self) {
        self.write += 1;
        if self.write == self.buffer.len() {
            self.write = 0;
        }
    }
    #[cfg(test)]
    pub(crate) fn index(&self) -> usize {
        self.write
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_integer_and_fractional() {
        let mut d = DelayLine::new(10.0).unwrap();
        d.write(1.0);
        d.advance();
        assert_eq!(d.read(1.0), 1.0);
        assert_eq!(d.read(1.5), 0.5);
        assert_eq!(d.index(), 1);
    }
    #[test]
    fn wraps_and_reads_the_two_second_boundary() {
        let mut delay = DelayLine::new(10.0).unwrap();
        delay.write(1.0);
        delay.advance();
        for _ in 0..19 {
            delay.write(0.0);
            delay.advance();
        }
        assert_eq!(delay.read(20.0), 1.0);
        assert_eq!(delay.index(), 20);
    }

    #[test]
    fn rejects_rates() {
        assert!(DelayLine::new(f32::NAN).is_err());
        assert!(DelayLine::new(0.0).is_err());
    }
}
