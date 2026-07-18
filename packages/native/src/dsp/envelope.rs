use crate::patch::EnvelopeSpec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EnvelopeStage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Envelope {
    sample_rate: f32,
    params: EnvelopeSpec,
    stage: EnvelopeStage,
    value: f32,
    target: f32,
    step: f32,
    remaining: u32,
}

impl Envelope {
    pub(crate) fn new(params: EnvelopeSpec, sample_rate: f32) -> Self {
        Self {
            sample_rate,
            params,
            stage: EnvelopeStage::Idle,
            value: 0.0,
            target: 0.0,
            step: 0.0,
            remaining: 0,
        }
    }
    pub(crate) fn gate(&mut self, on: bool) {
        if on {
            self.enter(EnvelopeStage::Attack);
        } else {
            self.enter(EnvelopeStage::Release);
        }
        self.skip_zero_stages();
    }
    pub(crate) fn update(&mut self, params: EnvelopeSpec) {
        let old = self.params;
        self.params = params;
        match self.stage {
            EnvelopeStage::Attack if old.attack_seconds != params.attack_seconds => {
                self.enter(EnvelopeStage::Attack)
            }
            EnvelopeStage::Decay
                if old.decay_seconds != params.decay_seconds || old.sustain != params.sustain =>
            {
                self.enter(EnvelopeStage::Decay)
            }
            EnvelopeStage::Release if old.release_seconds != params.release_seconds => {
                self.enter(EnvelopeStage::Release)
            }
            EnvelopeStage::Sustain if old.sustain != params.sustain => {
                self.start_segment(params.sustain, 0.01)
            }
            _ => {}
        }
        self.skip_zero_stages();
    }
    fn duration(&self, stage: EnvelopeStage) -> f32 {
        match stage {
            EnvelopeStage::Attack => self.params.attack_seconds,
            EnvelopeStage::Decay => self.params.decay_seconds,
            EnvelopeStage::Release => self.params.release_seconds,
            _ => 0.0,
        }
    }
    fn enter(&mut self, stage: EnvelopeStage) {
        self.stage = stage;
        match stage {
            EnvelopeStage::Attack => self.start_segment(1.0, self.params.attack_seconds),
            EnvelopeStage::Decay => {
                self.start_segment(self.params.sustain, self.params.decay_seconds)
            }
            EnvelopeStage::Sustain => {
                self.value = self.params.sustain;
                self.target = self.value;
                self.remaining = 0;
                self.step = 0.0;
            }
            EnvelopeStage::Release => self.start_segment(0.0, self.params.release_seconds),
            EnvelopeStage::Idle => {
                self.value = 0.0;
                self.target = 0.0;
                self.remaining = 0;
                self.step = 0.0;
            }
        }
    }
    fn start_segment(&mut self, target: f32, seconds: f32) {
        self.target = target;
        if seconds <= 0.0 {
            self.value = target;
            self.remaining = 0;
            self.step = 0.0;
            return;
        }
        self.remaining = (seconds * self.sample_rate).ceil().max(1.0) as u32;
        self.step = (target - self.value) / self.remaining as f32;
    }
    fn skip_zero_stages(&mut self) {
        for _ in 0..4 {
            if self.remaining > 0 {
                break;
            }
            match self.stage {
                EnvelopeStage::Attack if self.duration(EnvelopeStage::Attack) == 0.0 => {
                    self.enter(EnvelopeStage::Decay)
                }
                EnvelopeStage::Decay if self.duration(EnvelopeStage::Decay) == 0.0 => {
                    self.enter(EnvelopeStage::Sustain)
                }
                EnvelopeStage::Release if self.duration(EnvelopeStage::Release) == 0.0 => {
                    self.enter(EnvelopeStage::Idle)
                }
                _ => break,
            }
        }
    }
    pub(crate) fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.value += self.step;
            self.remaining -= 1;
            if self.remaining == 0 {
                self.value = self.target;
                match self.stage {
                    EnvelopeStage::Attack => self.enter(EnvelopeStage::Decay),
                    EnvelopeStage::Decay => self.enter(EnvelopeStage::Sustain),
                    EnvelopeStage::Release => self.enter(EnvelopeStage::Idle),
                    _ => {}
                }
                self.skip_zero_stages();
            }
        }
        self.value
    }
    #[cfg(test)]
    pub(crate) fn stage(&self) -> EnvelopeStage {
        self.stage
    }
}

#[cfg(test)]
mod tests {
    use super::{Envelope, EnvelopeStage};
    use crate::patch::EnvelopeSpec;
    fn spec(a: f32, d: f32, s: f32, r: f32) -> EnvelopeSpec {
        EnvelopeSpec {
            attack_seconds: a,
            decay_seconds: d,
            sustain: s,
            release_seconds: r,
        }
    }
    #[test]
    fn exact_stages_and_release() {
        let mut e = Envelope::new(spec(0.002, 0.002, 0.5, 0.002), 1000.0);
        e.gate(true);
        assert_eq!(e.next(), 0.5);
        assert_eq!(e.next(), 1.0);
        assert_eq!(e.stage(), EnvelopeStage::Decay);
        assert_eq!(e.next(), 0.75);
        assert_eq!(e.next(), 0.5);
        e.gate(false);
        assert_eq!(e.next(), 0.25);
        assert_eq!(e.next(), 0.0);
        assert_eq!(e.stage(), EnvelopeStage::Idle);
    }
    #[test]
    fn retrigger_and_duration_retarget_start_from_current_level() {
        let mut envelope = Envelope::new(spec(0.004, 0.004, 0.5, 0.004), 1_000.0);
        envelope.gate(true);
        assert_eq!(envelope.next(), 0.25);
        assert_eq!(envelope.next(), 0.5);
        envelope.gate(true);
        assert_eq!(envelope.next(), 0.625);
        envelope.update(spec(0.002, 0.004, 0.5, 0.004));
        assert_eq!(envelope.next(), 0.8125);
        assert_eq!(envelope.next(), 1.0);
        envelope.gate(false);
        assert_eq!(envelope.next(), 0.75);
        envelope.update(spec(0.002, 0.004, 0.5, 0.002));
        assert_eq!(envelope.next(), 0.375);
        assert_eq!(envelope.next(), 0.0);
    }

    #[test]
    fn sample_counts_scale_with_rate_and_sustain_retargets() {
        for sample_rate in [1_000.0, 2_000.0] {
            let mut envelope = Envelope::new(spec(0.001, 0.0, 0.25, 0.0), sample_rate);
            envelope.gate(true);
            let count = (0.001_f32 * sample_rate).ceil() as usize;
            for _ in 0..count {
                envelope.next();
            }
            assert_eq!(envelope.stage(), EnvelopeStage::Sustain);
            envelope.update(spec(0.001, 0.0, 0.75, 0.0));
            assert!(envelope.next() > 0.25);
            for _ in 1..(0.010_f32 * sample_rate).ceil() as usize {
                envelope.next();
            }
            assert!((envelope.next() - 0.75).abs() < 1e-6);
        }
    }

    #[test]
    fn zero_stages_and_retarget() {
        let mut e = Envelope::new(spec(0.0, 0.0, 0.4, 0.0), 48_000.0);
        e.gate(true);
        assert_eq!(e.stage(), EnvelopeStage::Sustain);
        assert_eq!(e.next(), 0.4);
        e.update(spec(0.0, 0.0, 0.8, 0.0));
        assert!(e.next() > 0.4);
        e.gate(false);
        assert_eq!(e.stage(), EnvelopeStage::Idle);
    }
}
