use cpal::{FromSample, SizedSample};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct StereoFrame {
    pub(crate) left: f32,
    pub(crate) right: f32,
}

pub(crate) fn write_frame<T>(output: &mut [T], frame: StereoFrame)
where
    T: SizedSample + FromSample<f32>,
{
    match output.len() {
        0 => {}
        1 => output[0] = T::from_sample((frame.left + frame.right) * 0.5),
        _ => {
            output[0] = T::from_sample(frame.left);
            output[1] = T::from_sample(frame.right);
            for sample in &mut output[2..] {
                *sample = T::from_sample(0.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{write_frame, StereoFrame};

    #[test]
    fn maps_mono_stereo_and_surround_explicitly() {
        let frame = StereoFrame {
            left: 0.75,
            right: -0.25,
        };
        let mut mono = [0.0_f32; 1];
        write_frame(&mut mono, frame);
        assert_eq!(mono, [0.25]);

        let mut stereo = [0.0_f32; 2];
        write_frame(&mut stereo, frame);
        assert_eq!(stereo, [0.75, -0.25]);

        let mut surround = [1.0_f32; 6];
        write_frame(&mut surround, frame);
        assert_eq!(surround, [0.75, -0.25, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn converts_representative_integer_samples() {
        let mut samples = [0_i16; 2];
        write_frame(
            &mut samples,
            StereoFrame {
                left: 0.5,
                right: -0.5,
            },
        );
        assert!(samples[0] > 0);
        assert!(samples[1] < 0);
    }
}
