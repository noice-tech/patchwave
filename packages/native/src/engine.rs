use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, FromSample, SampleFormat, SizedSample, Stream, StreamConfig, I24, U24};
use napi::{Error, Result, Status};
use napi_derive::napi;
use rtrb::{Consumer, Producer, PushError};

use crate::dsp::frame::write_frame;
use crate::patch::{
    parse_patch, DeviceSpec, EnvelopeSpec, FilterMode, FilterV2Spec, OscillatorSpec,
    OscillatorV2Spec, PatchSpec, SendsSpec, StructuralSignature, SubtractiveSynthV2Spec, Waveform,
};
use crate::realtime::{
    create_transport, pack_structural, unpack_structural, Command, DataCallbackLease,
    ErrorCallbackLease, RetiredChain, RuntimeStatus, StructuralTag, MAX_GENERATION,
};

const DEFAULT_FREQUENCY: f32 = 440.0;
const DEFAULT_GAIN: f32 = 0.1;
const CALLBACK_RELEASE_TIMEOUT: Duration = Duration::from_secs(1);

struct ControlState {
    stream: Option<Stream>,
    command_producer: Producer<Command>,
    retirement_consumer: Consumer<RetiredChain>,
    accepted: PatchSpec,
    signature: StructuralSignature,
    accepted_generation: u64,
    sample_rate: f32,
    closed: bool,
    _core: Arc<crate::realtime::RealtimeCell>,
    status: Arc<RuntimeStatus>,
    data_released: Arc<AtomicBool>,
    error_released: Arc<AtomicBool>,
}

impl ControlState {
    fn service_retirement(&mut self) -> Result<()> {
        let word = self.status.structural.load(Ordering::Acquire);
        let (tag, generation) = unpack_structural(word);
        if tag != StructuralTag::Retired {
            return Ok(());
        }
        let retired = match self.retirement_consumer.pop() {
            Ok(retired) => retired,
            Err(_) => {
                self.status.enter_fatal(generation);
                return Err(native_error(
                    "Structural retirement acknowledgment is missing",
                ));
            }
        };
        let retired_generation = retired.generation;
        drop(retired);
        if retired_generation != generation {
            self.status.enter_fatal(generation);
            return Err(native_error("Structural retirement generation mismatch"));
        }
        if self
            .status
            .structural
            .compare_exchange(
                word,
                pack_structural(StructuralTag::Idle, 0),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            self.status.enter_fatal(generation);
            return Err(native_error(
                "Structural retirement state changed unexpectedly",
            ));
        }
        Ok(())
    }

    fn ensure_patch_available(&mut self) -> Result<()> {
        if self.closed {
            return Err(native_error("Audio engine is closed"));
        }
        if self.status.cpal_error.load(Ordering::Acquire) {
            return Err(native_error(
                "The audio stream has reported a runtime error",
            ));
        }
        self.service_retirement()?;
        let (tag, _) = self.status.structural();
        if tag == StructuralTag::Fatal || self.status.fatal.load(Ordering::Acquire) {
            return Err(native_error("Audio engine realtime state is fatal"));
        }
        if tag != StructuralTag::Idle {
            return Err(native_error("A structural patch transition is busy"));
        }
        Ok(())
    }

    fn next_generation(&self) -> Result<u64> {
        if self.accepted_generation < MAX_GENERATION {
            return Ok(self.accepted_generation + 1);
        }
        let (tag, _) = self.status.structural();
        if tag == StructuralTag::Idle
            && self.status.applied_generation.load(Ordering::Acquire) == self.accepted_generation
        {
            Ok(1)
        } else {
            Err(native_error(
                "Patch generation is exhausted while work is pending",
            ))
        }
    }

    fn enqueue_candidate(&mut self, candidate: PatchSpec) -> Result<()> {
        self.ensure_patch_available()?;
        if candidate == self.accepted {
            return Ok(());
        }

        let generation = self.next_generation()?;
        let signature = candidate.structural_signature();
        if signature == self.signature {
            let snapshot = candidate
                .parameter_snapshot(generation)
                .map_err(|error| native_error(error.to_string()))?;
            match self.command_producer.push(Command::Parameter(snapshot)) {
                Ok(()) => {}
                Err(PushError::Full(_)) => {
                    return Err(native_error("Realtime command queue is full"));
                }
            }
        } else {
            let chain = Box::new(
                candidate
                    .prepare_chain(self.sample_rate)
                    .map_err(|error| native_error(error.to_string()))?,
            );
            let idle = pack_structural(StructuralTag::Idle, 0);
            let reserved = pack_structural(StructuralTag::Reserved, generation);
            self.status
                .structural
                .compare_exchange(idle, reserved, Ordering::AcqRel, Ordering::Acquire)
                .map_err(|_| native_error("A structural patch transition is busy"))?;
            match self
                .command_producer
                .push(Command::Replace { generation, chain })
            {
                Ok(()) => {}
                Err(PushError::Full(command)) => {
                    self.status.structural.store(idle, Ordering::Release);
                    drop(command);
                    return Err(native_error("Realtime command queue is full"));
                }
            }
        }

        self.accepted = candidate;
        self.signature = signature;
        self.accepted_generation = generation;
        Ok(())
    }
}

#[napi]
pub struct AudioEngine {
    control: Mutex<Option<ControlState>>,
    status: Option<Arc<RuntimeStatus>>,
}

#[napi]
impl AudioEngine {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| native_error("No default output device available"))?;
        let supported_config = device.default_output_config().map_err(|error| {
            native_error(format!(
                "Failed to read the default output configuration: {error}"
            ))
        })?;
        let sample_format = supported_config.sample_format();
        let config = supported_config.config();
        let sample_rate = config.sample_rate as f32;
        if !sample_rate.is_finite() || !(100.0..=768_000.0).contains(&sample_rate) {
            return Err(native_error("Default output sample rate is unsupported"));
        }
        if config.channels == 0 {
            return Err(native_error(
                "The default output configuration has no channels",
            ));
        }

        let accepted = default_patch();
        let active = Box::new(
            accepted
                .prepare_chain(sample_rate)
                .map_err(|error| native_error(error.to_string()))?,
        );
        let mut transport = create_transport(active, sample_rate);
        let status = Arc::new(RuntimeStatus::new());
        let data_released = Arc::new(AtomicBool::new(false));
        let error_released = Arc::new(AtomicBool::new(false));
        let retained_core = transport.retained_core();
        let data_lease = transport
            .issue_data_lease(Arc::clone(&status), Arc::clone(&data_released))
            .map_err(native_error)?;
        let error_lease = ErrorCallbackLease::new(Arc::clone(&status), Arc::clone(&error_released));

        let stream = match sample_format {
            SampleFormat::I8 => build_stream::<i8>(&device, config, data_lease, error_lease),
            SampleFormat::I16 => build_stream::<i16>(&device, config, data_lease, error_lease),
            SampleFormat::I24 => build_stream::<I24>(&device, config, data_lease, error_lease),
            SampleFormat::I32 => build_stream::<i32>(&device, config, data_lease, error_lease),
            SampleFormat::I64 => build_stream::<i64>(&device, config, data_lease, error_lease),
            SampleFormat::U8 => build_stream::<u8>(&device, config, data_lease, error_lease),
            SampleFormat::U16 => build_stream::<u16>(&device, config, data_lease, error_lease),
            SampleFormat::U24 => build_stream::<U24>(&device, config, data_lease, error_lease),
            SampleFormat::U32 => build_stream::<u32>(&device, config, data_lease, error_lease),
            SampleFormat::U64 => build_stream::<u64>(&device, config, data_lease, error_lease),
            SampleFormat::F32 => build_stream::<f32>(&device, config, data_lease, error_lease),
            SampleFormat::F64 => build_stream::<f64>(&device, config, data_lease, error_lease),
            unsupported => Err(native_error(format!(
                "Unsupported default output sample format: {unsupported}"
            ))),
        }?;

        let signature = accepted.structural_signature();
        Ok(Self {
            control: Mutex::new(Some(ControlState {
                stream: Some(stream),
                command_producer: transport.command_producer,
                retirement_consumer: transport.retirement_consumer,
                accepted,
                signature,
                accepted_generation: 0,
                sample_rate,
                closed: false,
                _core: retained_core,
                status: Arc::clone(&status),
                data_released,
                error_released,
            })),
            status: Some(status),
        })
    }

    #[napi]
    pub fn start(&self) -> Result<()> {
        let control = self.control()?;
        control
            .as_ref()
            .ok_or_else(|| native_error("Audio engine is closed"))?
            .stream
            .as_ref()
            .ok_or_else(|| native_error("Audio stream is closed"))?
            .play()
            .map_err(|error| native_error(format!("Failed to start the audio stream: {error}")))
    }

    #[napi]
    pub fn stop(&self) -> Result<()> {
        let control = self.control()?;
        control
            .as_ref()
            .ok_or_else(|| native_error("Audio engine is closed"))?
            .stream
            .as_ref()
            .ok_or_else(|| native_error("Audio stream is closed"))?
            .pause()
            .map_err(|error| native_error(format!("Failed to stop the audio stream: {error}")))
    }

    #[napi]
    pub fn set_gate(&self, enabled: bool) {
        if let Some(status) = &self.status {
            status.gate.store(enabled, Ordering::Relaxed);
        }
    }

    #[napi]
    pub fn apply_patch(&self, serialized_patch: String) -> Result<()> {
        let candidate = parse_patch(&serialized_patch)
            .map_err(|error| native_error(format!("Invalid patch: {error}")))?;
        let mut control = self.control()?;
        control
            .as_mut()
            .ok_or_else(|| native_error("Audio engine is closed"))?
            .enqueue_candidate(candidate)
    }

    #[napi]
    pub fn take_runtime_error(&self) -> bool {
        let Some(status) = &self.status else {
            return true;
        };
        let Ok(mut guard) = self.control.lock() else {
            return true;
        };
        if let Some(control) = guard.as_mut() {
            let _ = control.service_retirement();
        }
        status.cpal_error.swap(false, Ordering::AcqRel) || status.fatal.load(Ordering::Acquire)
    }
}

impl AudioEngine {
    fn control(&self) -> Result<MutexGuard<'_, Option<ControlState>>> {
        self.control
            .lock()
            .map_err(|_| native_error("Audio engine control state is poisoned"))
    }
}

impl Drop for AudioEngine {
    fn drop(&mut self) {
        let slot = match self.control.get_mut() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(control) = slot.take() else {
            return;
        };
        finish_teardown(control, self.status.take(), CALLBACK_RELEASE_TIMEOUT);
    }
}

fn finish_teardown(
    mut control: ControlState,
    status: Option<Arc<RuntimeStatus>>,
    timeout: Duration,
) -> bool {
    control.closed = true;
    if let Some(stream) = control.stream.take() {
        let _ = stream.pause();
        drop(stream);
    }

    let deadline = Instant::now() + timeout;
    let mut yielded = false;
    while !(control.data_released.load(Ordering::Acquire)
        && control.error_released.load(Ordering::Acquire))
        && Instant::now() < deadline
    {
        if !yielded {
            yielded = true;
            std::thread::yield_now();
        } else {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    if control.data_released.load(Ordering::Acquire)
        && control.error_released.load(Ordering::Acquire)
    {
        drop(control);
        drop(status);
        true
    } else {
        eprintln!("Audio callback release timed out; quarantining realtime resources");
        std::mem::forget(control);
        std::mem::forget(status);
        false
    }
}

fn build_stream<T>(
    device: &Device,
    config: StreamConfig,
    mut data: DataCallbackLease,
    error: ErrorCallbackLease,
) -> Result<Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels);
    device
        .build_output_stream(
            config,
            move |output: &mut [T], _| {
                data.process(output, channels, write_frame);
            },
            move |_| error.report(),
            None,
        )
        .map_err(|error| native_error(format!("Failed to open the default output stream: {error}")))
}

fn default_patch() -> PatchSpec {
    PatchSpec {
        tempo_bpm: 120.0,
        modulators: Vec::new(),
        modulation_routes: Vec::new(),
        devices: vec![DeviceSpec::SubtractiveSynthV2(SubtractiveSynthV2Spec {
            id: "voice".to_owned(),
            enabled: true,
            base_frequency_hz: DEFAULT_FREQUENCY,
            output_gain: DEFAULT_GAIN,
            oscillators: vec![OscillatorV2Spec {
                id: "osc".to_owned(),
                oscillator: OscillatorSpec {
                    waveform: Waveform::Sine,
                    octave: 0,
                    semitone: 0,
                    detune_cents: 0.0,
                    pulse_width: 0.5,
                    level: 1.0,
                },
                sends: SendsSpec {
                    filter: 1.0,
                    insert: 0.0,
                    direct: 0.0,
                },
            }],
            amp_envelope: EnvelopeSpec {
                attack_seconds: 0.0,
                decay_seconds: 0.0,
                sustain: 1.0,
                release_seconds: 0.0,
            },
            filter: FilterV2Spec {
                enabled: false,
                mode: FilterMode::Lowpass,
                cutoff_hz: 20_000.0,
                resonance: 0.0,
                insert_send: 1.0,
                direct_send: 0.0,
            },
            audio_rate_route: None,
        })],
    }
}

fn native_error(reason: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, reason.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control() -> ControlState {
        let accepted = default_patch();
        let status = Arc::new(RuntimeStatus::new());
        let transport =
            create_transport(Box::new(accepted.prepare_chain(1_000.0).unwrap()), 1_000.0);
        let retained_core = transport.retained_core();
        ControlState {
            stream: None,
            command_producer: transport.command_producer,
            retirement_consumer: transport.retirement_consumer,
            signature: accepted.structural_signature(),
            accepted,
            accepted_generation: 0,
            sample_rate: 1_000.0,
            closed: false,
            _core: retained_core,
            status,
            data_released: Arc::new(AtomicBool::new(true)),
            error_released: Arc::new(AtomicBool::new(true)),
        }
    }

    fn with_frequency(control: &ControlState, frequency: f32) -> PatchSpec {
        let mut candidate = control.accepted.clone();
        let DeviceSpec::SubtractiveSynthV2(synth) = &mut candidate.devices[0] else {
            panic!("synth source");
        };
        synth.base_frequency_hz = frequency;
        candidate
    }

    fn accepted_frequency(control: &ControlState) -> f32 {
        let DeviceSpec::SubtractiveSynthV2(synth) = &control.accepted.devices[0] else {
            panic!("synth source");
        };
        synth.base_frequency_hz
    }

    #[test]
    fn queue_full_does_not_commit_the_candidate_mirror() {
        let mut control = control();
        for generation in 1..=8 {
            let candidate = with_frequency(&control, 440.0 + generation as f32);
            control.enqueue_candidate(candidate).unwrap();
        }
        assert_eq!(control.accepted_generation, 8);
        assert_eq!(accepted_frequency(&control), 448.0);
        let rejected = with_frequency(&control, 900.0);
        assert!(control.enqueue_candidate(rejected).is_err());
        assert_eq!(control.accepted_generation, 8);
        assert_eq!(accepted_frequency(&control), 448.0);
    }

    #[test]
    fn identical_patch_is_a_noop_and_structural_credit_is_exclusive() {
        let mut control = control();
        control.enqueue_candidate(control.accepted.clone()).unwrap();
        assert_eq!(control.accepted_generation, 0);

        let mut structural = control.accepted.clone();
        let DeviceSpec::SubtractiveSynthV2(synth) = &mut structural.devices[0] else {
            panic!("synth source");
        };
        synth.id = "replacement".to_owned();
        control.enqueue_candidate(structural).unwrap();
        assert_eq!(control.status.structural().0, StructuralTag::Reserved);
        let parameter = with_frequency(&control, 880.0);
        assert!(control.enqueue_candidate(parameter).is_err());
        assert_eq!(control.accepted_generation, 1);
    }

    #[test]
    fn fake_lifecycle_acknowledges_or_quarantines_without_cpal() {
        use crate::devices::chain::DropProbe;

        let acknowledged = control();
        let acknowledged_status = Some(Arc::clone(&acknowledged.status));
        assert!(finish_teardown(
            acknowledged,
            acknowledged_status,
            Duration::ZERO
        ));

        let accepted = default_patch();
        let status = Arc::new(RuntimeStatus::new());
        let data_released = Arc::new(AtomicBool::new(false));
        let error_released = Arc::new(AtomicBool::new(false));
        let active = accepted.prepare_chain(1_000.0).unwrap();
        let mut transport = create_transport(Box::new(active), 1_000.0);
        let retained_core = transport.retained_core();
        let data = transport
            .issue_data_lease(Arc::clone(&status), Arc::clone(&data_released))
            .unwrap();
        let error = ErrorCallbackLease::new(Arc::clone(&status), Arc::clone(&error_released));
        let control = ControlState {
            stream: None,
            command_producer: transport.command_producer,
            retirement_consumer: transport.retirement_consumer,
            signature: accepted.structural_signature(),
            accepted,
            accepted_generation: 0,
            sample_rate: 1_000.0,
            closed: false,
            _core: retained_core,
            status: Arc::clone(&status),
            data_released,
            error_released,
        };
        let release_thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            drop(data);
            drop(error);
        });
        assert!(finish_teardown(
            control,
            Some(status),
            Duration::from_millis(100)
        ));
        release_thread.join().unwrap();

        let accepted = default_patch();
        let status = Arc::new(RuntimeStatus::new());
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut active = accepted.prepare_chain(1_000.0).unwrap();
        active.set_drop_probe(DropProbe::new(Arc::clone(&log)));
        let transport = create_transport(Box::new(active), 1_000.0);
        let retained_core = transport.retained_core();
        let timed_out = ControlState {
            stream: None,
            command_producer: transport.command_producer,
            retirement_consumer: transport.retirement_consumer,
            signature: accepted.structural_signature(),
            accepted,
            accepted_generation: 0,
            sample_rate: 1_000.0,
            closed: false,
            _core: retained_core,
            status: Arc::clone(&status),
            data_released: Arc::new(AtomicBool::new(false)),
            error_released: Arc::new(AtomicBool::new(false)),
        };
        assert!(!finish_teardown(timed_out, Some(status), Duration::ZERO));
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn runtime_error_rejects_updates_without_committing_state() {
        let mut control = control();
        control.status.cpal_error.store(true, Ordering::Release);
        let candidate = with_frequency(&control, 880.0);
        assert!(control.enqueue_candidate(candidate).is_err());
        assert_eq!(control.accepted_generation, 0);
        assert_eq!(accepted_frequency(&control), DEFAULT_FREQUENCY);
    }

    #[test]
    fn missing_retirement_acknowledgment_enters_fatal_state() {
        let mut control = control();
        control.status.structural.store(
            pack_structural(StructuralTag::Retired, 7),
            Ordering::Release,
        );
        assert!(control.service_retirement().is_err());
        assert!(control.status.fatal.load(Ordering::Acquire));
        assert_eq!(control.status.structural().0, StructuralTag::Fatal);
    }

    #[test]
    fn generation_wrap_requires_idle_and_fully_applied_state() {
        let mut control = control();
        control.accepted_generation = MAX_GENERATION;
        control
            .status
            .applied_generation
            .store(MAX_GENERATION - 1, Ordering::Release);
        assert!(control.next_generation().is_err());
        control
            .status
            .applied_generation
            .store(MAX_GENERATION, Ordering::Release);
        assert_eq!(control.next_generation().unwrap(), 1);
    }
}
