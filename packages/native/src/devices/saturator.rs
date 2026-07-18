use crate::dsp::crossfade::equal_power;
use crate::dsp::dc_blocker::DcBlocker;
use crate::dsp::frame::StereoFrame;
use crate::dsp::parameter::{DbRamp, LinearRamp};
use crate::patch::SaturatorSpec;
#[derive(Clone, Copy, Debug)]
pub(crate) struct SaturatorParameters {
    pub enabled: bool,
    pub drive_db: f32,
    pub output_gain_db: f32,
    pub mix: f32,
}
impl From<&SaturatorSpec> for SaturatorParameters {
    fn from(s: &SaturatorSpec) -> Self {
        Self {
            enabled: s.enabled,
            drive_db: s.drive_db,
            output_gain_db: s.output_gain_db,
            mix: s.mix,
        }
    }
}
pub(crate) struct PreparedSaturator {
    sample_rate: f32,
    drive: DbRamp,
    output: DbRamp,
    mix: LinearRamp,
    enabled: LinearRamp,
    left: DcBlocker,
    right: DcBlocker,
}
impl PreparedSaturator {
    pub(crate) fn new(p: SaturatorParameters, sr: f32) -> Self {
        Self {
            sample_rate: sr,
            drive: DbRamp::new(p.drive_db),
            output: DbRamp::new(p.output_gain_db),
            mix: LinearRamp::new(p.mix),
            enabled: LinearRamp::new(if p.enabled { 1.0 } else { 0.0 }),
            left: DcBlocker::default(),
            right: DcBlocker::default(),
        }
    }
    pub(crate) fn update(&mut self, p: SaturatorParameters) {
        self.drive.set_target(p.drive_db, 0.010, self.sample_rate);
        self.output
            .set_target(p.output_gain_db, 0.010, self.sample_rate);
        self.mix.set_target(p.mix, 0.010, self.sample_rate);
        self.enabled
            .set_target(if p.enabled { 1.0 } else { 0.0 }, 0.010, self.sample_rate);
    }
    pub(crate) fn process(&mut self, input: StereoFrame) -> StereoFrame {
        let drive = self.drive.next_gain();
        let output = self.output.next_gain();
        let mix = self.mix.next();
        let l = self.left.process(
            (drive * input.left).tanh() / drive.tanh() * output,
            self.sample_rate,
        );
        let r = self.right.process(
            (drive * input.right).tanh() / drive.tanh() * output,
            self.sample_rate,
        );
        let processed = StereoFrame {
            left: equal_power(input.left, l, mix),
            right: equal_power(input.right, r, mix),
        };
        let en = self.enabled.next();
        StereoFrame {
            left: equal_power(input.left, processed.left, en),
            right: equal_power(input.right, processed.right, en),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints() {
        let mut s = PreparedSaturator::new(
            SaturatorParameters {
                enabled: true,
                drive_db: 0.0,
                output_gain_db: 0.0,
                mix: 0.0,
            },
            1000.0,
        );
        let input = StereoFrame {
            left: 0.25,
            right: -0.25,
        };
        assert_eq!(s.process(input), input);
        s.update(SaturatorParameters {
            enabled: true,
            drive_db: 36.0,
            output_gain_db: 12.0,
            mix: 1.0,
        });
        for _ in 0..20 {
            let o = s.process(input);
            assert!(o.left.is_finite() && o.right.is_finite());
        }
    }
}
