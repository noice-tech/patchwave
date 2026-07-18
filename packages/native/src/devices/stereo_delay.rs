use crate::dsp::crossfade::equal_power;
use crate::dsp::delay_line::DelayLine;
use crate::dsp::frame::StereoFrame;
use crate::dsp::one_pole::OnePole;
use crate::dsp::parameter::LinearRamp;
use crate::dsp::safety::feedback as safe;
use crate::patch::StereoDelaySpec;
#[derive(Clone, Copy, Debug)]
pub(crate) struct StereoDelayParameters {
    pub time_seconds: f32,
    pub feedback: f32,
    pub damping: f32,
    pub ping_pong: bool,
    pub mix: f32,
}
impl From<&StereoDelaySpec> for StereoDelayParameters {
    fn from(s: &StereoDelaySpec) -> Self {
        Self {
            time_seconds: s.time_seconds,
            feedback: s.feedback,
            damping: s.damping,
            ping_pong: s.ping_pong,
            mix: s.mix,
        }
    }
}
struct Tap {
    current: f32,
    from: f32,
    to: f32,
    pending: Option<f32>,
    position: u32,
    length: u32,
}
impl Tap {
    fn new(samples: f32) -> Self {
        Self {
            current: samples,
            from: samples,
            to: samples,
            pending: None,
            position: 0,
            length: 0,
        }
    }
    fn request(&mut self, samples: f32, sr: f32) {
        if self.length > 0 {
            self.pending = (samples != self.to).then_some(samples);
        } else if samples != self.current {
            self.start(samples, (0.020 * sr).ceil().max(1.0) as u32)
        }
    }
    fn start(&mut self, s: f32, n: u32) {
        self.from = self.current;
        self.to = s;
        self.position = 0;
        self.length = n;
    }
    fn read(&mut self, l: &DelayLine, r: &DelayLine) -> (f32, f32) {
        if self.length == 0 {
            return (l.read(self.current), r.read(self.current));
        }
        self.position += 1;
        let mix = self.position as f32 / self.length as f32;
        let out = (
            equal_power(l.read(self.from), l.read(self.to), mix),
            equal_power(r.read(self.from), r.read(self.to), mix),
        );
        if self.position >= self.length {
            let n = self.length;
            self.current = self.to;
            self.position = 0;
            self.length = 0;
            if let Some(p) = self.pending.take() {
                self.start(p, n);
            }
        }
        out
    }
}
pub(crate) struct PreparedStereoDelay {
    sample_rate: f32,
    left: DelayLine,
    right: DelayLine,
    tap: Tap,
    damped_left: OnePole,
    damped_right: OnePole,
    feedback: LinearRamp,
    damping: LinearRamp,
    ping: LinearRamp,
    mix: LinearRamp,
}
impl PreparedStereoDelay {
    pub(crate) fn new(p: StereoDelayParameters, sr: f32) -> Result<Self, &'static str> {
        if !sr.is_finite() || sr < 10.0 {
            return Err("sample rate must be finite and at least 10 Hz");
        }
        let samples = (p.time_seconds * sr).clamp(1.0, 2.0 * sr);
        Ok(Self {
            sample_rate: sr,
            left: DelayLine::new(sr)?,
            right: DelayLine::new(sr)?,
            tap: Tap::new(samples),
            damped_left: OnePole::default(),
            damped_right: OnePole::default(),
            feedback: LinearRamp::new(p.feedback),
            damping: LinearRamp::new(p.damping),
            ping: LinearRamp::new(if p.ping_pong { 1.0 } else { 0.0 }),
            mix: LinearRamp::new(p.mix),
        })
    }
    pub(crate) fn update(&mut self, p: StereoDelayParameters) {
        self.tap.request(
            (p.time_seconds * self.sample_rate).clamp(1.0, 2.0 * self.sample_rate),
            self.sample_rate,
        );
        self.feedback
            .set_target(p.feedback, 0.010, self.sample_rate);
        self.damping.set_target(p.damping, 0.010, self.sample_rate);
        self.ping
            .set_target(if p.ping_pong { 1.0 } else { 0.0 }, 0.010, self.sample_rate);
        self.mix.set_target(p.mix, 0.010, self.sample_rate);
    }
    pub(crate) fn process(&mut self, input: StereoFrame) -> StereoFrame {
        let (del_l, del_r) = self.tap.read(&self.left, &self.right);
        let damping = self.damping.next();
        let dl = self.damped_left.process(del_l, damping, self.sample_rate);
        let dr = self.damped_right.process(del_r, damping, self.sample_rate);
        let p = self.ping.next();
        let feedback = self.feedback.next();
        let fb_l = dl + (dr - dl) * p;
        let fb_r = dr + (dl - dr) * p;
        let mono = 0.5 * (input.left + input.right);
        let inj_l = input.left + (mono - input.left) * p;
        let inj_r = input.right * (1.0 - p);
        self.left.write(safe(inj_l + feedback * fb_l));
        self.right.write(safe(inj_r + feedback * fb_r));
        self.left.advance();
        self.right.advance();
        let mix = self.mix.next();
        StereoFrame {
            left: equal_power(input.left, del_l, mix),
            right: equal_power(input.right, del_r, mix),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn impulse_repeats_alternate_in_ping_pong_mode() {
        let params = StereoDelayParameters {
            time_seconds: 0.010,
            feedback: 0.5,
            damping: 0.0,
            ping_pong: true,
            mix: 1.0,
        };
        let mut delay = PreparedStereoDelay::new(params, 1000.0).unwrap();
        let mut frames = Vec::new();
        for index in 0..31 {
            let output = delay.process(if index == 0 {
                StereoFrame {
                    left: 1.0,
                    right: 1.0,
                }
            } else {
                StereoFrame::default()
            });
            assert!(output.left.is_finite() && output.right.is_finite());
            frames.push(output);
        }
        assert!(frames[10].left.abs() > frames[10].right.abs() + 0.1);
        assert!(frames[20].right.abs() > frames[20].left.abs() + 0.05);
    }

    #[test]
    fn timing_feedback_and_damping_are_deterministic() {
        fn render(damping: f32) -> Vec<StereoFrame> {
            let mut delay = PreparedStereoDelay::new(
                StereoDelayParameters {
                    time_seconds: 0.001,
                    feedback: 0.8,
                    damping,
                    ping_pong: false,
                    mix: 1.0,
                },
                48_000.0,
            )
            .unwrap();
            (0..97)
                .map(|index| {
                    delay.process(if index == 0 {
                        StereoFrame {
                            left: 1.0,
                            right: 0.0,
                        }
                    } else {
                        StereoFrame::default()
                    })
                })
                .collect()
        }
        let bright = render(0.0);
        let dark = render(1.0);
        assert_eq!(bright[47].left, 0.0);
        assert!(bright[48].left > 0.99);
        assert!(bright[96].left > dark[96].left);
        assert!(bright.iter().all(|frame| frame.left.is_finite()));
    }

    #[test]
    fn delay_keeps_advancing_its_tail() {
        let mut delay = PreparedStereoDelay::new(
            StereoDelayParameters {
                time_seconds: 0.010,
                feedback: 0.0,
                damping: 0.0,
                ping_pong: false,
                mix: 1.0,
            },
            1000.0,
        )
        .unwrap();
        delay.process(StereoFrame {
            left: 1.0,
            right: 0.0,
        });
        for _ in 0..9 {
            delay.process(StereoFrame::default());
        }
        let output = delay.process(StereoFrame::default());
        assert!(output.left.abs() > 0.01);
    }
    #[test]
    fn tap_uses_exact_counts_and_latest_pending_request() {
        let mut tap = Tap::new(10.0);
        tap.request(20.0, 200.0);
        assert_eq!(tap.length, 4);
        tap.position = 1;
        tap.request(30.0, 200.0);
        assert_eq!(tap.pending, Some(30.0));
        tap.request(40.0, 200.0);
        assert_eq!(tap.pending, Some(40.0));
        tap.request(20.0, 200.0);
        assert_eq!(tap.pending, None);
        tap.request(10.0, 200.0);
        assert_eq!(tap.pending, Some(10.0));
    }

    #[test]
    fn invalid_rate_rejected() {
        assert!(PreparedStereoDelay::new(
            StereoDelayParameters {
                time_seconds: 0.001,
                feedback: 0.0,
                damping: 0.0,
                ping_pong: false,
                mix: 0.0
            },
            f32::NAN
        )
        .is_err());
    }
}
