use std::f32::consts::FRAC_PI_2;

pub(crate) fn equal_power(dry: f32, wet: f32, mix: f32) -> f32 {
    if mix <= 0.0 {
        dry
    } else if mix >= 1.0 {
        wet
    } else {
        dry * (mix * FRAC_PI_2).cos() + wet * (mix * FRAC_PI_2).sin()
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DiscreteCrossfade<T: Copy + Eq> {
    current: T,
    from: T,
    to: T,
    pending: Option<T>,
    position: u32,
    length: u32,
}

impl<T: Copy + Eq> DiscreteCrossfade<T> {
    pub(crate) fn new(value: T) -> Self {
        Self {
            current: value,
            from: value,
            to: value,
            pending: None,
            position: 0,
            length: 0,
        }
    }
    pub(crate) fn request(&mut self, value: T, seconds: f32, sample_rate: f32) {
        let length = (seconds * sample_rate).ceil().max(1.0) as u32;
        if self.active() {
            self.pending = (value != self.to).then_some(value);
        } else if value != self.current {
            self.start(value, length);
        }
    }
    fn start(&mut self, value: T, length: u32) {
        self.from = self.current;
        self.to = value;
        self.position = 0;
        self.length = length;
    }
    pub(crate) fn next(&mut self) -> (T, T, f32) {
        if !self.active() {
            return (self.current, self.current, 0.0);
        }
        self.position += 1;
        let mix = self.position as f32 / self.length as f32;
        let result = (self.from, self.to, mix.min(1.0));
        if self.position >= self.length {
            let completed_length = self.length;
            self.current = self.to;
            self.position = 0;
            self.length = 0;
            if let Some(next) = self.pending.take() {
                self.start(next, completed_length);
            }
        }
        result
    }
    pub(crate) fn active(&self) -> bool {
        self.length > 0
    }
    #[cfg(test)]
    pub(crate) fn current(&self) -> T {
        if self.active() {
            self.to
        } else {
            self.current
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{equal_power, DiscreteCrossfade};

    #[test]
    fn endpoints_are_exact() {
        assert_eq!(equal_power(0.25, 0.75, 0.0), 0.25);
        assert_eq!(equal_power(0.25, 0.75, 1.0), 0.75);
    }

    #[test]
    fn latest_pending_request_wins_and_destination_clears_it() {
        let mut fade = DiscreteCrossfade::new(0_u8);
        fade.request(1, 0.004, 1_000.0);
        assert_eq!(fade.next(), (0, 1, 0.25));
        fade.request(2, 0.004, 1_000.0);
        fade.request(3, 0.004, 1_000.0);
        fade.request(1, 0.004, 1_000.0);
        assert_eq!(fade.next().2, 0.5);
        assert_eq!(fade.next().2, 0.75);
        assert_eq!(fade.next().2, 1.0);
        assert!(!fade.active());
        assert_eq!(fade.current(), 1);

        fade.request(2, 0.004, 1_000.0);
        fade.next();
        fade.request(0, 0.004, 1_000.0);
        for _ in 0..3 {
            fade.next();
        }
        assert!(fade.active());
        let (from, to, mix) = fade.next();
        assert_eq!((from, to, mix), (2, 0, 0.25));
    }
}
