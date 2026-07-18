#![deny(clippy::all)]

mod devices;
mod dsp;
mod engine;
pub mod patch;
mod patch_wire;
mod realtime;

pub use engine::AudioEngine;
