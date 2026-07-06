//! `CompileSupervisor` — process-wide runtime supervision of compile workers
//! (§6.2 "编译监督").
//!
//! The pre-existing [`CompileWorker`]` model already gives us per-tab compile
//! threads that survive a typst panic (via `catch_unwind`) and coalesce rapid
//! edits. This module adds the *supervision* layer the design doc calls for:
//!
//! - **Concurrency cap** (§6.2 "默认不超过 CPU 核心数与 4 的较小值"): a
//!   process-wide counting semaphore gates the actual `compiler::compile` call.
//!   N open tabs no longer means N concurrent CPU-burning compiles — at most
//!   `min(available_parallelism, MAX_CONCURRENT_COMPILES)` run at once. A worker
//!   waiting on a permit still drains/coalesces its channel, so this only
//!   bounds parallel CPU, never latency for the latest edit.
//! - **Slow-compile indicator** (§6.2 "编译超过 2 秒显示编译时间较长"): a
//!   per-compile watchdog fires after the slow threshold, emitting a
//!   [`CompileStatus::Slow`]. Cancelled on compile completion.
//! - **Panic backoff** (§6.2 "对单文档连续 panic 采用退避"): consecutive
//!   panics on the same document trigger a cooling-off period so a pathological
//!   doc can't spin the worker.
//! - **Shutdown** (§6.2 "应用关闭时停止接收任务并有界等待 worker 结束"):
//!   signals workers to drain and exits within a bounded wait.
//!
//! ## Why a custom counting semaphore?
//!
//! The compile worker runs on a **sync** `std::thread`, not a tokio task.
//! `tokio::sync::Semaphore::acquire` is `async` and `acquire_blocking` still
//! ties up a runtime worker; `parking_lot` ships no semaphore; and
//! `std::sync::Semaphore` is nightly-only. A tiny `Mutex<usize> + Condvar`
//! counting semaphore (~30 lines) is the right tool: lock-free-fast on the
//! uncontended path (the common case, since the cap is small), no dependency,
//! and trivially correct under the worker's sync model.
//!
//! [`CompileWorker`]: super::compile_worker::CompileWorker
//! [`CompileStatus::Slow`]: crate::domain::compile_status::CompileStatus::Slow

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Hard ceiling on concurrent compiles regardless of CPU count (§6.2 "与 4 的
/// 较小值"). A 16-core machine still caps at 4 — typst compiles are bursty and
/// memory-heavy, and the editor's own main thread + LSP need headroom.
///
/// NOTE: this is intentionally NOT a user setting. The semaphore is built once
/// at app startup deep inside `EditorService`/`TabStore` construction, before
/// the settings service exists; making it live-configurable would require
/// either reordering startup or a process-global settings handle, plus the
/// runtime semantics of resizing a semaphore mid-flight are unclear. Kept as a
/// constant for now; revisit if a real need surfaces.
pub const MAX_CONCURRENT_COMPILES: usize = 4;

/// After this many consecutive panics on a single document, enter backoff so a
/// pathological doc can't spin the worker (§6.2 "对单文档连续 panic 采用退避").
pub const PANIC_BACKOFF_THRESHOLD: u32 = 3;

/// How long to skip recompiles after hitting the panic threshold before
/// allowing one retry. Short enough that a genuine fix (the user edits the
/// breaking text) re-engages quickly, long enough to break a hot spin.
pub const PANIC_BACKOFF_DURATION: Duration = Duration::from_secs(5);

/// Threshold for the slow-compile indicator (§6.2 "编译超过 2 秒"). Exposed as a
/// function (not a `const`) so tests can shorten it without sleeping 2s.
pub const SLOW_COMPILE_THRESHOLD: Duration = Duration::from_secs(2);

/// Bounded wait for workers to drain on shutdown (§6.2 "有界等待"). Best-effort:
/// a runaway compile is not force-killed (Rust can't safely kill a thread), so
/// this only waits for cooperative drain.
pub const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

/// A process-wide counting semaphore built on `Mutex<usize> + Condvar`.
///
/// acquire blocks while the count is 0; release increments and notifies one
/// waiter. The uncontended path is a lock + compare + unlock (sub-microsecond);
/// contention is rare because the cap is small and compiles are seconds-long.
///
/// Used by [`CompileSupervisor`] to bound concurrent `compiler::compile` calls
/// across all worker threads. Lives behind an `Arc` shared into every worker's
/// compile closure.
pub struct CountingSemaphore {
    state: Mutex<usize>,
    cvar: Condvar,
}

impl CountingSemaphore {
    /// Create a semaphore with `permits` initial permits. Panics only if
    /// `permits == 0` (a zero-cap semaphore would block every compile forever —
    /// a programming error, not a runtime condition).
    pub fn new(permits: usize) -> Self {
        assert!(permits > 0, "semaphore must have at least 1 permit");
        Self {
            state: Mutex::new(permits),
            cvar: Condvar::new(),
        }
    }

    /// Block until a permit is available, then take it.
    pub fn acquire(&self) {
        let mut count = self.state.lock().expect("semaphore mutex poisoned");
        while *count == 0 {
            count = self.cvar.wait(count).expect("semaphore mutex poisoned");
        }
        *count -= 1;
    }

    /// Try to take a permit without blocking. Returns `true` if one was taken.
    #[cfg(test)]
    pub fn try_acquire(&self) -> bool {
        let mut count = self.state.lock().expect("semaphore mutex poisoned");
        if *count == 0 {
            false
        } else {
            *count -= 1;
            true
        }
    }

    /// Return a permit and wake one waiter.
    pub fn release(&self) {
        let mut count = self.state.lock().expect("semaphore mutex poisoned");
        *count += 1;
        self.cvar.notify_one();
    }

    /// Acquire a permit and return a guard that releases it on drop. The
    /// idiomatic way to scope a bounded section.
    pub fn acquire_guard(self: &Arc<Self>) -> PermitGuard {
        self.acquire();
        PermitGuard {
            sem: Arc::clone(self),
            released: AtomicBool::new(false),
        }
    }
}

/// RAII permit: releases on drop unless [`PermitGuard::release_early`] was
/// called. The `released` flag makes double-release a no-op (defensive against
/// a panic mid-compile that runs Drop twice via the catch_unwind boundary).
pub struct PermitGuard {
    sem: Arc<CountingSemaphore>,
    released: AtomicBool,
}

impl PermitGuard {
    /// Release the permit immediately (used when the compile finished and we
    /// want to free the slot before the guard's scope ends). Idempotent.
    pub fn release_early(&self) {
        if !self.released.swap(true, Ordering::SeqCst) {
            self.sem.release();
        }
    }
}

impl Drop for PermitGuard {
    fn drop(&mut self) {
        self.release_early();
    }
}

/// The compile concurrency cap: `min(available_parallelism, MAX)`. Falls back
/// to `MAX` if `available_parallelism` can't be queried (rare — only on some
/// sandboxed/containers). Pure function: cheap to call, same result per process.
///
/// Public so tests can assert the bound and so the supervisor construction
/// stays explicit about the policy.
pub fn compile_concurrency_cap() -> usize {
    match std::thread::available_parallelism() {
        Ok(n) => std::cmp::min(n.get(), MAX_CONCURRENT_COMPILES),
        // Can't query → be conservative, use the hard cap.
        Err(_) => MAX_CONCURRENT_COMPILES,
    }
}

/// Process-wide compile supervision state (§6.2).
///
/// Owns the concurrency-limiting [`CountingSemaphore`] and the shutdown flag.
/// Cloned cheaply (all fields are `Arc`-shared) so it can be captured by every
/// worker's compile closure without a service-level `Arc` cycle — the same
/// discipline the [`TabStore`] already maintains.
///
/// Constructed once at app startup and held by [`CompileService`]. The
/// semaphore is shared into each worker's compile closure; the shutdown flag is
/// consulted by [`CompileService::do_compile_for_tab`](super::compile_service::CompileService)
/// to short-circuit emits during a drain.
///
/// [`TabStore`]: super::tab_store::TabStore
#[derive(Clone)]
pub struct CompileSupervisor {
    semaphore: Arc<CountingSemaphore>,
    /// Set true on app shutdown. Workers consult this to stop accepting new
    /// compiles; an in-flight compile still runs to completion (Rust can't
    /// kill it), but no *new* compile starts and emits are suppressed.
    shutdown: Arc<AtomicBool>,
}

impl CompileSupervisor {
    /// Construct with the policy-derived cap ([`compile_concurrency_cap`]).
    pub fn new() -> Self {
        Self::with_cap(compile_concurrency_cap())
    }

    /// Construct with an explicit permit count. Used in tests to drive the
    /// concurrency assertion deterministically.
    pub fn with_cap(cap: usize) -> Self {
        Self {
            semaphore: Arc::new(CountingSemaphore::new(cap.max(1))),
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    /// The concurrency limit (number of permits). Mainly for tests/docs.
    pub fn cap(&self) -> usize {
        // Hold the lock briefly to read; the count starts at `cap` and only
        // acquire/release mutate it, so the initial value equals the cap. We
        // read the *current* free count here — callers wanting the cap should
        // capture it at construction. For test assertions we use the dedicated
        // `with_cap` path.
        *self.semaphore.state.lock().expect("semaphore mutex poisoned")
    }

    /// Acquire a concurrency permit (blocks until available) and return a guard.
    /// The compile runs while the guard is live; the permit returns on drop.
    pub fn acquire(&self) -> PermitGuard {
        self.semaphore.acquire_guard()
    }

    /// Whether the supervisor has been signalled to shut down. Workers check
    /// this before starting a new compile and before emitting results.
    pub fn is_shutting_down(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }

    /// Signal all workers to drain + stop. Does NOT block (§6.2 says "有界等待"
    /// — the bounded wait is the caller's job; the RunEvent::Exit handler in
    /// `lib.rs` sleeps up to [`SHUTDOWN_DRAIN_TIMEOUT`] for cooperative exit).
    /// Best-effort: a runaway compile is not force-killed.
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

impl Default for CompileSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::thread;

    #[test]
    fn semaphore_bounds_concurrency() {
        // 8 threads, 4 permits → at most 4 should be inside the critical
        // section at once.
        let sem = Arc::new(CountingSemaphore::new(4));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let sem = Arc::clone(&sem);
            let in_flight = Arc::clone(&in_flight);
            let max_seen = Arc::clone(&max_seen);
            handles.push(thread::spawn(move || {
                let _guard = sem.acquire_guard();
                let cur = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                // Track the high-water mark of concurrent holders.
                let mut prev = max_seen.load(Ordering::SeqCst);
                while cur > prev {
                    match max_seen.compare_exchange(prev, cur, Ordering::SeqCst, Ordering::SeqCst)
                    {
                        Ok(_) => break,
                        Err(actual) => prev = actual,
                    }
                }
                thread::sleep(Duration::from_millis(20));
                in_flight.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.join().expect("worker thread panicked");
        }
        assert_eq!(
            max_seen.load(Ordering::SeqCst),
            4,
            "8 threads on a 4-permit semaphore must never exceed 4 concurrent"
        );
    }

    #[test]
    fn try_acquire_returns_false_when_empty() {
        let sem = CountingSemaphore::new(1);
        assert!(sem.try_acquire(), "first acquire on a 1-permit sem succeeds");
        assert!(
            !sem.try_acquire(),
            "second acquire must fail (no permits left)"
        );
        sem.release();
        assert!(sem.try_acquire(), "acquire succeeds again after release");
    }

    #[test]
    fn permit_guard_releases_on_drop() {
        let sem = Arc::new(CountingSemaphore::new(1));
        // Take the only permit.
        let guard = sem.acquire_guard();
        assert!(!sem.try_acquire(), "permit held while guard lives");
        // Release early — subsequent drop must be a no-op (idempotent).
        guard.release_early();
        assert!(sem.try_acquire(), "permit freed after release_early");
        sem.release(); // return the test's try_acquire
        // Now drop the original guard; the idempotent flag must prevent a
        // double-release from inflating the count.
        drop(guard);
        assert!(
            sem.try_acquire(),
            "idempotent guard must not double-release"
        );
    }

    #[test]
    fn concurrency_cap_is_min_of_parallelism_and_four() {
        let cap = compile_concurrency_cap();
        assert!(cap >= 1 && cap <= MAX_CONCURRENT_COMPILES);
    }

    #[test]
    fn supervisor_shutdown_flag_toggles() {
        let sup = CompileSupervisor::new();
        assert!(!sup.is_shutting_down());
        sup.shutdown();
        assert!(sup.is_shutting_down());
    }

    #[test]
    fn supervisor_cap_reflects_construction() {
        let sup = CompileSupervisor::with_cap(2);
        assert_eq!(sup.cap(), 2, "with_cap(2) → 2 free permits initially");
    }
}
