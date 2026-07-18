#[derive(Clone, Copy, Debug)]
pub(crate) struct LinearRamp {
    current: f32,
    target: f32,
    step: f32,
    remaining: u32,
}

impl LinearRamp {
    pub(crate) fn new(value: f32) -> Self {
        Self {
            current: value,
            target: value,
            step: 0.0,
            remaining: 0,
        }
    }

    pub(crate) fn set_target(&mut self, target: f32, seconds: f32, sample_rate: f32) {
        if seconds <= 0.0 || target == self.current {
            self.target = target;
            self.current = target;
            self.step = 0.0;
            self.remaining = 0;
            return;
        }
        if self.remaining > 0 && target == self.target {
            return;
        }
        self.target = target;
        let samples = (seconds * sample_rate).ceil().max(1.0) as u32;
        self.step = (target - self.current) / samples as f32;
        self.remaining = samples;
    }

    pub(crate) fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.current += self.step;
            self.remaining -= 1;
            if self.remaining == 0 {
                self.current = self.target;
            }
        }
        self.current
    }

    #[cfg(test)]
    pub(crate) fn value(&self) -> f32 {
        self.current
    }
    pub(crate) fn active(&self) -> bool {
        self.remaining > 0
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct LogRamp {
    logarithm: LinearRamp,
    exact_target: f32,
}
impl LogRamp {
    pub(crate) fn new(value: f32) -> Self {
        Self {
            logarithm: LinearRamp::new(value.ln()),
            exact_target: value,
        }
    }
    pub(crate) fn set_target(&mut self, value: f32, seconds: f32, sample_rate: f32) {
        self.exact_target = value;
        self.logarithm.set_target(value.ln(), seconds, sample_rate);
    }
    #[cfg(test)]
    pub(crate) fn next(&mut self) -> f32 {
        self.logarithm.next().exp()
    }
    // Clocked parameters use the authored endpoint exactly when no ramp is active.
    pub(crate) fn next_exact(&mut self) -> f32 {
        let value = self.logarithm.next();
        if self.logarithm.active() {
            value.exp()
        } else {
            self.exact_target
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DbRamp(LinearRamp);
impl DbRamp {
    pub(crate) fn new(db: f32) -> Self {
        Self(LinearRamp::new(db))
    }
    pub(crate) fn set_target(&mut self, db: f32, seconds: f32, sample_rate: f32) {
        self.0.set_target(db, seconds, sample_rate);
    }
    pub(crate) fn next_db(&mut self) -> f32 {
        self.0.next()
    }
    pub(crate) fn next_gain(&mut self) -> f32 {
        10.0_f32.powf(self.next_db() / 20.0)
    }
}

#[cfg(test)]
mod tests {
    use super::{DbRamp, LinearRamp, LogRamp};
    #[test]
    fn exact_counts_retarget_and_zero_duration() {
        let mut ramp = LinearRamp::new(0.0);
        ramp.set_target(1.0, 0.25, 4.0);
        assert_eq!(ramp.next(), 1.0);
        ramp.set_target(0.0, 0.5, 4.0);
        assert_eq!(ramp.next(), 0.5);
        ramp.set_target(1.0, 0.5, 4.0);
        assert_eq!(ramp.next(), 0.75);
        ramp.set_target(1.0, 0.5, 4.0);
        assert_eq!(ramp.next(), 1.0);
        assert!(!ramp.active());
        ramp.set_target(0.25, 0.0, 4.0);
        assert_eq!(ramp.value(), 0.25);
        assert!(!ramp.active());
    }
    #[test]
    fn log_and_db_domains_converge() {
        let mut log = LogRamp::new(100.0);
        log.set_target(400.0, 0.002, 1_000.0);
        assert!((log.next() - 200.0).abs() < 0.001);
        assert!((log.next() - 400.0).abs() < 0.001);
        let mut db = DbRamp::new(0.0);
        db.set_target(6.0, 0.001, 1_000.0);
        assert!((db.next_db() - 6.0).abs() < 1e-6);
    }
}
