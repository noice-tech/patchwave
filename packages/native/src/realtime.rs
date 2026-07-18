use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use rtrb::{Consumer, Producer, PushError, RingBuffer};

use crate::devices::chain::{ParameterSnapshot, PreparedChain};
use crate::dsp::frame::StereoFrame;

pub(crate) const COMMAND_CAPACITY: usize = 8;
const MAX_COMMANDS_PER_CALLBACK: usize = 8;
const RETIREMENT_CAPACITY: usize = 1;
pub(crate) const MAX_GENERATION: u64 = (1_u64 << 61) - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u64)]
pub(crate) enum StructuralTag {
    Idle = 0,
    Reserved = 1,
    Transitioning = 2,
    RetirePending = 3,
    Retired = 4,
    Fatal = 5,
}

pub(crate) fn pack_structural(tag: StructuralTag, generation: u64) -> u64 {
    (generation << 3) | tag as u64
}

pub(crate) fn unpack_structural(value: u64) -> (StructuralTag, u64) {
    let tag = match value & 7 {
        0 => StructuralTag::Idle,
        1 => StructuralTag::Reserved,
        2 => StructuralTag::Transitioning,
        3 => StructuralTag::RetirePending,
        4 => StructuralTag::Retired,
        _ => StructuralTag::Fatal,
    };
    (tag, value >> 3)
}

pub(crate) struct RuntimeStatus {
    pub(crate) gate: AtomicBool,
    pub(crate) structural: AtomicU64,
    pub(crate) applied_generation: AtomicU64,
    pub(crate) cpal_error: AtomicBool,
    pub(crate) fatal: AtomicBool,
}

impl RuntimeStatus {
    pub(crate) fn new() -> Self {
        Self {
            gate: AtomicBool::new(false),
            structural: AtomicU64::new(pack_structural(StructuralTag::Idle, 0)),
            applied_generation: AtomicU64::new(0),
            cpal_error: AtomicBool::new(false),
            fatal: AtomicBool::new(false),
        }
    }

    pub(crate) fn structural(&self) -> (StructuralTag, u64) {
        unpack_structural(self.structural.load(Ordering::Acquire))
    }

    pub(crate) fn enter_fatal(&self, generation: u64) {
        self.fatal.store(true, Ordering::Release);
        self.structural.store(
            pack_structural(StructuralTag::Fatal, generation),
            Ordering::Release,
        );
    }
}

// The fixed-capacity parameter image deliberately stays inline so consuming it
// cannot deallocate on the callback thread.
#[allow(clippy::large_enum_variant)]
pub(crate) enum Command {
    Parameter(ParameterSnapshot),
    Replace {
        generation: u64,
        chain: Box<PreparedChain>,
    },
}
const _: () = {
    assert!(std::mem::size_of::<Command>() <= 2_304);
};

pub(crate) struct RetiredChain {
    pub(crate) generation: u64,
    pub(crate) _chain: Box<PreparedChain>,
}

struct PendingChain {
    generation: u64,
    chain: Box<PreparedChain>,
}

enum Fade {
    Stable,
    Out { remaining: u32, total: u32 },
    In { position: u32, total: u32 },
}

pub(crate) struct RealtimeState {
    active: Box<PreparedChain>,
    pending_incoming: Option<PendingChain>,
    fatal_incoming: Option<PendingChain>,
    deferred_retire: Option<RetiredChain>,
    commands: Consumer<Command>,
    retirements: Producer<RetiredChain>,
    fade: Fade,
    sampled_gate: bool,
    sample_rate: f32,
}

impl RealtimeState {
    fn begin_callback(&mut self, status: &RuntimeStatus) {
        if status.fatal.load(Ordering::Acquire) {
            return;
        }
        self.retry_retirement(status);
        if status.fatal.load(Ordering::Acquire) {
            return;
        }

        for _ in 0..MAX_COMMANDS_PER_CALLBACK {
            let command_kind = match self.commands.peek() {
                Ok(Command::Parameter(_)) => 0_u8,
                Ok(Command::Replace { generation, .. }) => {
                    if !matches!(self.fade, Fade::Stable)
                        || self.pending_incoming.is_some()
                        || self.deferred_retire.is_some()
                    {
                        break;
                    }
                    let (tag, reserved_generation) = status.structural();
                    if tag != StructuralTag::Reserved || *generation != reserved_generation {
                        status.enter_fatal(*generation);
                        return;
                    }
                    1
                }
                Err(_) => break,
            };

            match self.commands.pop() {
                Ok(Command::Parameter(snapshot)) if command_kind == 0 => {
                    let generation = snapshot.generation;
                    if self.active.apply(&snapshot).is_err() {
                        status.enter_fatal(generation);
                        return;
                    }
                    status
                        .applied_generation
                        .store(generation, Ordering::Release);
                }
                Ok(Command::Replace { generation, chain }) if command_kind == 1 => {
                    // The popped Box is moved into persistent realtime storage immediately.
                    if self.pending_incoming.is_some() {
                        self.retain_fatal_incoming(generation, chain);
                        status.enter_fatal(generation);
                        return;
                    }
                    self.pending_incoming = Some(PendingChain { generation, chain });
                    status.structural.store(
                        pack_structural(StructuralTag::Transitioning, generation),
                        Ordering::Release,
                    );
                    let frames = transition_frames(0.005, self.sample_rate);
                    self.fade = Fade::Out {
                        remaining: frames,
                        total: frames,
                    };
                    break;
                }
                Ok(Command::Replace { chain, generation }) => {
                    // A queue value changed between peek/pop, which the SPSC contract forbids.
                    self.retain_fatal_incoming(generation, chain);
                    status.enter_fatal(generation);
                    return;
                }
                Ok(Command::Parameter(snapshot)) => {
                    status.enter_fatal(snapshot.generation);
                    return;
                }
                Err(_) => {
                    status.enter_fatal(status.applied_generation.load(Ordering::Acquire));
                    return;
                }
            }
        }

        let gate = status.gate.load(Ordering::Relaxed);
        if gate != self.sampled_gate {
            self.sampled_gate = gate;
            self.active.set_gate(gate);
        }
    }

    fn retain_fatal_incoming(&mut self, generation: u64, chain: Box<PreparedChain>) {
        if self.fatal_incoming.is_none() {
            self.fatal_incoming = Some(PendingChain { generation, chain });
        } else {
            // Fatal mode stops command draining, so a second value is unreachable. Leaking is
            // still safer than deallocating a graph on the callback thread.
            std::mem::forget(chain);
        }
    }

    fn retry_retirement(&mut self, status: &RuntimeStatus) {
        let Some(retired_ref) = self.deferred_retire.as_ref() else {
            if status.structural().0 == StructuralTag::RetirePending {
                status.enter_fatal(status.structural().1);
            }
            return;
        };
        let (tag, status_generation) = status.structural();
        if tag != StructuralTag::RetirePending || status_generation != retired_ref.generation {
            status.enter_fatal(retired_ref.generation);
            return;
        }

        let Some(retired) = self.deferred_retire.take() else {
            status.enter_fatal(status_generation);
            return;
        };
        let generation = retired.generation;
        match self.retirements.push(retired) {
            Ok(()) => status.structural.store(
                pack_structural(StructuralTag::Retired, generation),
                Ordering::Release,
            ),
            Err(PushError::Full(retired)) => {
                self.deferred_retire = Some(retired);
                status.structural.store(
                    pack_structural(StructuralTag::RetirePending, generation),
                    Ordering::Release,
                );
            }
        }
    }

    fn process_frame(&mut self, status: &RuntimeStatus) -> StereoFrame {
        if status.fatal.load(Ordering::Acquire) {
            return StereoFrame::default();
        }

        let frame = self.active.process();
        match self.fade {
            Fade::Stable => frame,
            Fade::Out {
                ref mut remaining,
                total,
            } => {
                *remaining -= 1;
                let gain = *remaining as f32 / total as f32;
                let output = scale(frame, gain);
                if *remaining == 0 {
                    self.install_pending(status, total);
                }
                output
            }
            Fade::In {
                ref mut position,
                total,
            } => {
                *position += 1;
                let gain = (*position as f32 / total as f32).min(1.0);
                if *position >= total {
                    self.fade = Fade::Stable;
                }
                scale(frame, gain)
            }
        }
    }

    fn install_pending(&mut self, status: &RuntimeStatus, fade_frames: u32) {
        let (tag, generation) = status.structural();
        let Some(pending) = self.pending_incoming.as_ref() else {
            status.enter_fatal(generation);
            return;
        };
        if tag != StructuralTag::Transitioning || pending.generation != generation {
            status.enter_fatal(pending.generation);
            return;
        }
        let Some(mut pending) = self.pending_incoming.take() else {
            status.enter_fatal(generation);
            return;
        };
        pending.chain.set_gate(self.sampled_gate);
        let old = std::mem::replace(&mut self.active, pending.chain);
        status
            .applied_generation
            .store(generation, Ordering::Release);
        let retired = RetiredChain {
            generation,
            _chain: old,
        };
        match self.retirements.push(retired) {
            Ok(()) => status.structural.store(
                pack_structural(StructuralTag::Retired, generation),
                Ordering::Release,
            ),
            Err(PushError::Full(retired)) => {
                self.deferred_retire = Some(retired);
                status.structural.store(
                    pack_structural(StructuralTag::RetirePending, generation),
                    Ordering::Release,
                );
            }
        }
        self.fade = Fade::In {
            position: 0,
            total: fade_frames,
        };
    }
}

fn scale(frame: StereoFrame, gain: f32) -> StereoFrame {
    StereoFrame {
        left: frame.left * gain,
        right: frame.right * gain,
    }
}

fn transition_frames(seconds: f32, sample_rate: f32) -> u32 {
    (seconds * sample_rate).ceil().max(1.0) as u32
}

pub(crate) struct RealtimeCell(UnsafeCell<RealtimeState>);

// SAFETY: the engine never accesses the cell while a data callback lease exists.
// CPAL owns one serialized `FnMut` data callback, and that lease is the only code
// path which creates `&mut RealtimeState`.
unsafe impl Sync for RealtimeCell {}

pub(crate) struct Transport {
    core: Arc<RealtimeCell>,
    data_lease_issued: bool,
    pub(crate) command_producer: Producer<Command>,
    pub(crate) retirement_consumer: Consumer<RetiredChain>,
}

impl Transport {
    pub(crate) fn retained_core(&self) -> Arc<RealtimeCell> {
        Arc::clone(&self.core)
    }

    pub(crate) fn issue_data_lease(
        &mut self,
        status: Arc<RuntimeStatus>,
        released: Arc<AtomicBool>,
    ) -> Result<DataCallbackLease, &'static str> {
        if self.data_lease_issued {
            return Err("data callback lease was already issued");
        }
        self.data_lease_issued = true;
        Ok(DataCallbackLease::new(
            Arc::clone(&self.core),
            status,
            released,
        ))
    }
}

pub(crate) fn create_transport(active: Box<PreparedChain>, sample_rate: f32) -> Transport {
    let (command_producer, commands) = RingBuffer::new(COMMAND_CAPACITY);
    let (retirements, retirement_consumer) = RingBuffer::new(RETIREMENT_CAPACITY);
    Transport {
        core: Arc::new(RealtimeCell(UnsafeCell::new(RealtimeState {
            active,
            pending_incoming: None,
            fatal_incoming: None,
            deferred_retire: None,
            commands,
            retirements,
            fade: Fade::Stable,
            sampled_gate: false,
            sample_rate,
        }))),
        data_lease_issued: false,
        command_producer,
        retirement_consumer,
    }
}

pub(crate) struct DataCallbackLease {
    core: Option<Arc<RealtimeCell>>,
    status: Option<Arc<RuntimeStatus>>,
    released: Arc<AtomicBool>,
}

impl DataCallbackLease {
    fn new(core: Arc<RealtimeCell>, status: Arc<RuntimeStatus>, released: Arc<AtomicBool>) -> Self {
        Self {
            core: Some(core),
            status: Some(status),
            released,
        }
    }

    pub(crate) fn process<T, F>(&mut self, output: &mut [T], channels: usize, mut write: F)
    where
        F: FnMut(&mut [T], StereoFrame),
    {
        if channels == 0 {
            return;
        }
        let (Some(status), Some(core)) = (self.status.as_deref(), self.core.as_ref()) else {
            for output_frame in output.chunks_mut(channels) {
                write(output_frame, StereoFrame::default());
            }
            return;
        };
        // SAFETY: this private method is called only by the sole serialized CPAL
        // `FnMut` data callback (or an exclusive unit-test driver).
        let state = unsafe { &mut *core.0.get() };
        state.begin_callback(status);
        for output_frame in output.chunks_mut(channels) {
            write(output_frame, state.process_frame(status));
        }
    }
}

impl Drop for DataCallbackLease {
    fn drop(&mut self) {
        drop(self.core.take());
        drop(self.status.take());
        self.released.store(true, Ordering::Release);
    }
}

pub(crate) struct ErrorCallbackLease {
    status: Option<Arc<RuntimeStatus>>,
    released: Arc<AtomicBool>,
}

impl ErrorCallbackLease {
    pub(crate) fn new(status: Arc<RuntimeStatus>, released: Arc<AtomicBool>) -> Self {
        Self {
            status: Some(status),
            released,
        }
    }

    pub(crate) fn report(&self) {
        if let Some(status) = &self.status {
            status.cpal_error.store(true, Ordering::Release);
        }
    }
}

impl Drop for ErrorCallbackLease {
    fn drop(&mut self) {
        drop(self.status.take());
        self.released.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patch::{parse_patch, DeviceSpec};

    fn spec(frequency: f32) -> crate::patch::PatchSpec {
        let mut patch = parse_patch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/minimal.json"
        )))
        .unwrap();
        let DeviceSpec::SubtractiveSynthV2(synth) = &mut patch.devices[0] else {
            panic!("synth source")
        };
        synth.base_frequency_hz = frequency;
        patch
    }

    struct Driver {
        lease: DataCallbackLease,
    }
    impl Driver {
        fn callback(&mut self, frames: usize) -> Vec<StereoFrame> {
            let mut output = vec![StereoFrame::default(); frames];
            self.lease
                .process(&mut output, 1, |slot, frame| slot[0] = frame);
            output
        }
    }

    fn setup(sample_rate: f32) -> (Transport, Arc<RuntimeStatus>, Driver) {
        let active = Box::new(spec(100.0).prepare_chain(sample_rate).unwrap());
        let mut transport = create_transport(active, sample_rate);
        let status = Arc::new(RuntimeStatus::new());
        let released = Arc::new(AtomicBool::new(false));
        let driver = Driver {
            lease: transport
                .issue_data_lease(Arc::clone(&status), released)
                .expect("first data lease"),
        };
        assert!(transport
            .issue_data_lease(Arc::clone(&status), Arc::new(AtomicBool::new(false)),)
            .is_err());
        (transport, status, driver)
    }

    #[test]
    fn parameter_commands_apply_wholly_at_boundaries_and_saturate() {
        let (mut transport, status, mut driver) = setup(1_000.0);
        for generation in 1..=COMMAND_CAPACITY as u64 {
            let snapshot = spec(100.0 + generation as f32)
                .parameter_snapshot(generation)
                .unwrap();
            transport
                .command_producer
                .push(Command::Parameter(snapshot))
                .unwrap();
        }
        let rejected = spec(300.0).parameter_snapshot(99).unwrap();
        assert!(transport
            .command_producer
            .push(Command::Parameter(rejected))
            .is_err());
        driver.callback(1);
        assert_eq!(status.applied_generation.load(Ordering::Acquire), 8);
    }

    #[test]
    fn structural_fade_is_frame_counted_and_retires_once() {
        let (mut transport, status, mut driver) = setup(1_000.0);
        let generation = 1;
        status.structural.store(
            pack_structural(StructuralTag::Reserved, generation),
            Ordering::Release,
        );
        transport
            .command_producer
            .push(Command::Replace {
                generation,
                chain: Box::new(spec(200.0).prepare_chain(1_000.0).unwrap()),
            })
            .unwrap();
        driver.callback(4);
        assert_eq!(status.applied_generation.load(Ordering::Acquire), 0);
        driver.callback(1);
        assert_eq!(status.applied_generation.load(Ordering::Acquire), 1);
        let retired = transport.retirement_consumer.pop().unwrap();
        assert_eq!(retired.generation, 1);
        drop(retired);
        assert!(transport.retirement_consumer.pop().is_err());
        driver.callback(5);
    }

    #[test]
    fn mismatch_enters_persistent_fatal_silence() {
        let (mut transport, status, mut driver) = setup(1_000.0);
        let mut snapshot = spec(200.0).parameter_snapshot(1).unwrap();
        snapshot.signature.device_count = 0;
        transport
            .command_producer
            .push(Command::Parameter(snapshot))
            .unwrap();
        let output = driver.callback(8);
        assert!(status.fatal.load(Ordering::Acquire));
        assert!(output.iter().all(|frame| *frame == StereoFrame::default()));
    }

    #[test]
    fn closure_leases_release_after_captured_arcs() {
        let (transport, status, driver) = setup(1_000.0);
        let core_before = Arc::strong_count(&transport.core);
        let released = Arc::clone(&driver.lease.released);
        assert_eq!(core_before, 2);
        drop(driver);
        assert!(released.load(Ordering::Acquire));
        assert_eq!(Arc::strong_count(&transport.core), 1);

        let error_released = Arc::new(AtomicBool::new(false));
        let error = ErrorCallbackLease::new(Arc::clone(&status), Arc::clone(&error_released));
        error.report();
        drop(error);
        assert!(error_released.load(Ordering::Acquire));
        assert!(status.cpal_error.load(Ordering::Acquire));
    }

    #[test]
    fn accepted_while_paused_waits_for_a_callback_and_before_first_callback_releases() {
        let (mut transport, status, driver) = setup(1_000.0);
        transport
            .command_producer
            .push(Command::Parameter(
                spec(250.0).parameter_snapshot(1).unwrap(),
            ))
            .unwrap_or_else(|_| panic!("command push"));
        assert_eq!(status.applied_generation.load(Ordering::Acquire), 0);
        let released = Arc::clone(&driver.lease.released);
        drop(driver);
        assert!(released.load(Ordering::Acquire));
        assert_eq!(status.applied_generation.load(Ordering::Acquire), 0);
        drop(transport);
    }

    #[test]
    fn full_return_queue_uses_deferred_storage_then_retries() {
        use crate::devices::chain::DropProbe;

        let (command_producer, commands) = RingBuffer::new(COMMAND_CAPACITY);
        let (mut retirements, mut retirement_consumer) = RingBuffer::new(RETIREMENT_CAPACITY);
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut active = spec(100.0).prepare_chain(1_000.0).unwrap();
        active.set_drop_probe(DropProbe::new(Arc::clone(&log)));
        let blocker = RetiredChain {
            generation: 99,
            _chain: Box::new(spec(90.0).prepare_chain(1_000.0).unwrap()),
        };
        retirements
            .push(blocker)
            .unwrap_or_else(|_| panic!("retirement prefill"));
        let core = Arc::new(RealtimeCell(UnsafeCell::new(RealtimeState {
            active: Box::new(active),
            pending_incoming: None,
            fatal_incoming: None,
            deferred_retire: None,
            commands,
            retirements,
            fade: Fade::Stable,
            sampled_gate: false,
            sample_rate: 1_000.0,
        })));
        let status = Arc::new(RuntimeStatus::new());
        let released = Arc::new(AtomicBool::new(false));
        let mut driver = Driver {
            lease: DataCallbackLease::new(Arc::clone(&core), Arc::clone(&status), released),
        };
        status.structural.store(
            pack_structural(StructuralTag::Reserved, 1),
            Ordering::Release,
        );
        let mut producer = command_producer;
        producer
            .push(Command::Replace {
                generation: 1,
                chain: Box::new(spec(200.0).prepare_chain(1_000.0).unwrap()),
            })
            .unwrap_or_else(|_| panic!("replace push"));
        driver.callback(5);
        assert_eq!(status.structural().0, StructuralTag::RetirePending);
        assert!(log.lock().unwrap().is_empty());
        drop(retirement_consumer.pop().unwrap());
        driver.callback(1);
        assert_eq!(status.structural().0, StructuralTag::Retired);
        let retired = retirement_consumer.pop().unwrap();
        assert_eq!(retired.generation, 1);
        let control_thread = std::thread::current().id();
        drop(retired);
        assert_eq!(log.lock().unwrap().as_slice(), &[control_thread]);
        drop(driver);
        drop(core);
        drop(producer);
        drop(retirement_consumer);
    }

    #[test]
    fn deferred_retirement_generation_mismatch_retains_owner_and_enters_fatal() {
        use crate::devices::chain::DropProbe;

        let (_command_producer, commands) = RingBuffer::new(COMMAND_CAPACITY);
        let (retirements, _retirement_consumer) = RingBuffer::new(RETIREMENT_CAPACITY);
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let active = Box::new(spec(100.0).prepare_chain(1_000.0).unwrap());
        let mut retired = spec(90.0).prepare_chain(1_000.0).unwrap();
        retired.set_drop_probe(DropProbe::new(Arc::clone(&log)));
        let mut state = RealtimeState {
            active,
            pending_incoming: None,
            fatal_incoming: None,
            deferred_retire: Some(RetiredChain {
                generation: 1,
                _chain: Box::new(retired),
            }),
            commands,
            retirements,
            fade: Fade::Stable,
            sampled_gate: false,
            sample_rate: 1_000.0,
        };
        let status = RuntimeStatus::new();
        status.structural.store(
            pack_structural(StructuralTag::RetirePending, 2),
            Ordering::Release,
        );
        state.retry_retirement(&status);
        assert!(status.fatal.load(Ordering::Acquire));
        assert!(state.deferred_retire.is_some());
        assert!(log.lock().unwrap().is_empty());
        drop(state);
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[test]
    fn pending_generation_mismatch_enters_fatal_without_retiring_owner() {
        let (mut transport, status, mut driver) = setup(1_000.0);
        status.structural.store(
            pack_structural(StructuralTag::Reserved, 1),
            Ordering::Release,
        );
        transport
            .command_producer
            .push(Command::Replace {
                generation: 1,
                chain: Box::new(spec(200.0).prepare_chain(1_000.0).unwrap()),
            })
            .unwrap_or_else(|_| panic!("replace push"));
        driver.callback(1);
        assert_eq!(status.structural(), (StructuralTag::Transitioning, 1));
        status.structural.store(
            pack_structural(StructuralTag::Transitioning, 2),
            Ordering::Release,
        );
        driver.callback(5);
        assert!(status.fatal.load(Ordering::Acquire));
        assert!(transport.retirement_consumer.pop().is_err());
    }

    #[test]
    fn active_queued_and_pending_graphs_drop_only_after_lease_release() {
        use crate::devices::chain::DropProbe;

        let control_thread = std::thread::current().id();
        for move_to_pending in [false, true] {
            let log = Arc::new(std::sync::Mutex::new(Vec::new()));
            let mut active = spec(100.0).prepare_chain(1_000.0).unwrap();
            active.set_drop_probe(DropProbe::new(Arc::clone(&log)));
            let mut incoming = spec(200.0).prepare_chain(1_000.0).unwrap();
            incoming.set_drop_probe(DropProbe::new(Arc::clone(&log)));
            let mut transport = create_transport(Box::new(active), 1_000.0);
            let status = Arc::new(RuntimeStatus::new());
            let released = Arc::new(AtomicBool::new(false));
            let mut lease = transport
                .issue_data_lease(Arc::clone(&status), Arc::clone(&released))
                .expect("data lease");
            status.structural.store(
                pack_structural(StructuralTag::Reserved, 1),
                Ordering::Release,
            );
            transport
                .command_producer
                .push(Command::Replace {
                    generation: 1,
                    chain: Box::new(incoming),
                })
                .unwrap_or_else(|_| panic!("replace push"));
            if move_to_pending {
                let mut output = [StereoFrame::default(); 1];
                lease.process(&mut output, 1, |slot, frame| slot[0] = frame);
                assert_eq!(status.structural().0, StructuralTag::Transitioning);
            }
            assert!(log.lock().unwrap().is_empty());
            drop(lease);
            assert!(released.load(Ordering::Acquire));
            drop(transport);
            let entries = log.lock().unwrap();
            assert_eq!(entries.len(), 2);
            assert!(entries.iter().all(|thread| *thread == control_thread));
        }
    }

    #[test]
    fn generation_pack_round_trip_and_wrap_limit() {
        for tag in [
            StructuralTag::Idle,
            StructuralTag::Reserved,
            StructuralTag::Transitioning,
            StructuralTag::RetirePending,
            StructuralTag::Retired,
            StructuralTag::Fatal,
        ] {
            assert_eq!(
                unpack_structural(pack_structural(tag, MAX_GENERATION)),
                (tag, MAX_GENERATION)
            );
        }
    }

    fn maximum_v2() -> crate::patch::PatchSpec {
        use crate::patch::{
            EnvelopeSpec, ModulationRouteSpec, ModulatorSpec, RouteTarget, SaturatorSpec,
        };
        let mut patch = parse_patch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/all-routes.json"
        )))
        .unwrap();
        let envelope = EnvelopeSpec {
            attack_seconds: 0.0,
            decay_seconds: 0.1,
            sustain: 0.5,
            release_seconds: 0.1,
        };
        patch.modulators.push(ModulatorSpec::Envelope {
            id: "extraA".to_owned(),
            enabled: true,
            envelope,
        });
        patch.modulators.push(ModulatorSpec::Envelope {
            id: "extraB".to_owned(),
            enabled: true,
            envelope,
        });
        patch.modulation_routes.push(ModulationRouteSpec {
            source: 2,
            target: RouteTarget::OscillatorLevel(0),
            amount: 0.2,
        });
        patch.modulation_routes.push(ModulationRouteSpec {
            source: 3,
            target: RouteTarget::OscillatorPitch(1),
            amount: 7.0,
        });
        patch.modulation_routes.push(ModulationRouteSpec {
            source: 3,
            target: RouteTarget::SourceGain,
            amount: -6.0,
        });
        for index in 0..6 {
            patch.devices.push(DeviceSpec::Saturator(SaturatorSpec {
                id: format!("bench{index}"),
                enabled: true,
                drive_db: 12.0,
                output_gain_db: -6.0,
                mix: 0.5,
            }));
        }
        patch
    }

    #[derive(Clone, Copy)]
    struct BenchmarkSample {
        wall: std::time::Duration,
        execution: std::time::Duration,
    }

    #[cfg(target_os = "macos")]
    fn execution_time_ns() -> u64 {
        unsafe extern "C" {
            fn clock_gettime_nsec_np(clock_id: u32) -> u64;
        }
        const CLOCK_THREAD_CPUTIME_ID: u32 = 16;
        // SAFETY: CLOCK_THREAD_CPUTIME_ID is a valid Darwin clock ID and the
        // function has no pointers or caller-owned storage.
        unsafe { clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) }
    }

    #[cfg(not(target_os = "macos"))]
    fn execution_time_ns() -> u64 {
        static EPOCH: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        EPOCH
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64
    }

    #[cfg(target_os = "macos")]
    fn configure_benchmark_thread() {
        unsafe extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        // SAFETY: Apple documents this call for the current thread; 0x21 is
        // QOS_CLASS_USER_INTERACTIVE and relative priority zero is valid.
        assert_eq!(unsafe { pthread_set_qos_class_self_np(0x21, 0) }, 0);
    }

    #[cfg(not(target_os = "macos"))]
    fn configure_benchmark_thread() {
        println!(
            "non-macOS benchmark: monotonic wall time is the non-normative execution-time fallback"
        );
    }

    fn measure_callback(callback: &mut impl FnMut()) -> BenchmarkSample {
        let wall_start = std::time::Instant::now();
        let execution_start = execution_time_ns();
        callback();
        let execution_end = execution_time_ns();
        let wall = wall_start.elapsed();
        BenchmarkSample {
            wall,
            execution: std::time::Duration::from_nanos(
                execution_end.saturating_sub(execution_start),
            ),
        }
    }

    fn percentile(sorted: &[std::time::Duration], numerator: usize) -> std::time::Duration {
        sorted[sorted.len() * numerator / 100]
    }

    fn report_and_gate_work_budget(
        label: &str,
        samples: &[BenchmarkSample],
        period: std::time::Duration,
        p99_fraction: f64,
    ) {
        let mut wall: Vec<_> = samples.iter().map(|sample| sample.wall).collect();
        let mut execution: Vec<_> = samples.iter().map(|sample| sample.execution).collect();
        let mut scheduler_delay: Vec<_> = samples
            .iter()
            .map(|sample| sample.wall.saturating_sub(sample.execution))
            .collect();
        let deadline_misses = wall.iter().filter(|duration| **duration > period).count();
        wall.sort_unstable();
        execution.sort_unstable();
        scheduler_delay.sort_unstable();
        let wall_p99 = percentile(&wall, 99);
        let wall_max = *wall.last().unwrap();
        let execution_p99 = percentile(&execution, 99);
        let execution_max = *execution.last().unwrap();
        let delay_p99 = percentile(&scheduler_delay, 99);
        let delay_max = *scheduler_delay.last().unwrap();
        println!(
            "{label}: cpu_p99={execution_p99:?} cpu_max={execution_max:?} wall_p99={wall_p99:?} wall_max={wall_max:?} scheduler_delay_p99={delay_p99:?} scheduler_delay_max={delay_max:?} deadline_misses={deadline_misses}/{} period={period:?}",
            samples.len()
        );
        assert!(
            execution_p99.as_secs_f64() < period.as_secs_f64() * p99_fraction,
            "{label}: execution p99 {execution_p99:?}, period {period:?}"
        );
        assert!(
            execution_max.as_secs_f64() < period.as_secs_f64() * 0.75,
            "{label}: execution max {execution_max:?}, period {period:?}"
        );
    }

    #[test]
    #[ignore = "release-only callback execution/work budget benchmark"]
    fn maximum_v2_callback_budget_matrix() {
        assert!(
            !std::hint::black_box(cfg!(debug_assertions)),
            "callback work budget must run in release mode"
        );
        configure_benchmark_thread();
        const WARMUP: usize = 1_000;
        const MEASURE: usize = 10_000;
        let mut clock_overhead = Vec::with_capacity(MEASURE);
        for _ in 0..MEASURE {
            let start = execution_time_ns();
            let end = execution_time_ns();
            clock_overhead.push(std::time::Duration::from_nanos(end.saturating_sub(start)));
        }
        clock_overhead.sort_unstable();
        println!(
            "paired execution-clock read overhead (not subtracted): p99={:?} max={:?}",
            percentile(&clock_overhead, 99),
            clock_overhead.last().unwrap()
        );
        let spec = maximum_v2();
        for sample_rate in [48_000.0f32, 96_000.0] {
            for frames in [32usize, 64, 128] {
                let active = Box::new(spec.prepare_chain(sample_rate).unwrap());
                let mut transport = create_transport(active, sample_rate);
                let status = Arc::new(RuntimeStatus::new());
                status.gate.store(true, Ordering::Relaxed);
                let mut lease = transport
                    .issue_data_lease(Arc::clone(&status), Arc::new(AtomicBool::new(false)))
                    .unwrap();
                let mut output = vec![StereoFrame::default(); frames];
                let mut callback = || lease.process(&mut output, 1, |slot, frame| slot[0] = frame);
                for _ in 0..WARMUP {
                    callback();
                }
                let steady: Vec<_> = (0..MEASURE)
                    .map(|_| measure_callback(&mut callback))
                    .collect();
                let period =
                    std::time::Duration::from_secs_f64(frames as f64 / f64::from(sample_rate));
                report_and_gate_work_budget(
                    &format!("steady {sample_rate:.0}Hz/{frames}"),
                    &steady,
                    period,
                    0.25,
                );

                let mut updates = Vec::with_capacity(MEASURE);
                for iteration in 0..MEASURE {
                    for offset in 0..8 {
                        let generation = 1 + (iteration * 8 + offset) as u64;
                        transport
                            .command_producer
                            .push(Command::Parameter(
                                spec.parameter_snapshot(generation).unwrap(),
                            ))
                            .unwrap_or_else(|_| panic!("benchmark queue"));
                    }
                    updates.push(measure_callback(&mut callback));
                }
                report_and_gate_work_budget(
                    &format!("updates {sample_rate:.0}Hz/{frames}"),
                    &updates,
                    period,
                    0.5,
                );
            }
        }
    }
}
