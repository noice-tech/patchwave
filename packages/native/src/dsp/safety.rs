use crate::dsp::frame::StereoFrame;
fn sample(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-0.98, 0.98)
    } else {
        0.0
    }
}
pub(crate) fn sanitize(frame: StereoFrame) -> StereoFrame {
    StereoFrame {
        left: sample(frame.left),
        right: sample(frame.right),
    }
}
pub(crate) fn feedback(value: f32) -> f32 {
    let value = if value.is_finite() { value } else { 0.0 };
    if value.abs() < 1e-20 {
        0.0
    } else {
        value
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_and_sanitizes() {
        assert_eq!(
            sanitize(StereoFrame {
                left: f32::NAN,
                right: 2.0
            }),
            StereoFrame {
                left: 0.0,
                right: 0.98
            }
        );
        assert_eq!(feedback(f32::INFINITY), 0.0);
    }
}
