//! `CompileWorker` — single-threaded compile loop per tab.
//!
//! ## Why a single worker instead of spawning a thread per compile?
//!
//! Rust has no safe way to kill a running thread, and `typst::compile` is an
//! opaque blocking call with no cancellation hook. Once a compile starts it
//! **must** run to completion. But we can avoid the waste of parallel compiles:
//!
//! - **Before**: each debounce window spawned a fresh 128 MB-stack thread. If
//!   the user typed during a 500 ms compile, a second thread would start and
//!   both would compete for CPU — the first thread's result was discarded.
//! - **After**: one long-lived worker thread per tab. When the user edits, we
//!   set the world's text immediately (zero latency) and notify the worker.
//!   If the worker is busy, the signal queues; when the current compile
//!   finishes, the worker drains all pending signals and recompiles with the
//!   **latest** text. No parallel threads, no wasted CPU, no debounce delay.
//!
//! ## Message coalescing
//!
//! The worker uses a bounded-capacity channel. While the worker is compiling,
//! any number of `Recompile` messages may queue up. After the compile, the
//! worker drains them all in a single pass — effectively coalescing N keystrokes
//! into one recompile. Only the latest text (already written to the world by
//! the editor thread) is compiled.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;

/// Messages the worker thread accepts.
enum Msg {
    /// Request a recompile. The text is already written to the world by the
    /// editor thread; this just signals "please run the compile closure again".
    Recompile,
    /// Shut down the worker loop and exit the thread.
    Shutdown,
}

/// Stack size for the compile thread. typst's recursive evaluator can recurse
/// 1000+ levels, overflowing the default 2 MB stack.
const COMPILE_STACK_SIZE: usize = 128 * 1024 * 1024;

/// A long-lived compile worker bound to one tab. Owns a single OS thread with
/// a large stack that loops: wait → compile → drain → repeat.
pub struct CompileWorker {
    tx: Sender<Msg>,
    handle: Option<JoinHandle<()>>,
}

impl CompileWorker {
    /// Spawn a worker thread that runs `compile_fn` whenever signalled.
    ///
    /// `compile_fn` takes no arguments — it compiles whatever the world
    /// currently holds. The editor thread is responsible for updating the
    /// world's text **before** calling [`recompile`](Self::recompile).
    pub fn spawn(compile_fn: Arc<dyn Fn() + Send + Sync>) -> Self {
        let (tx, rx) = mpsc::channel::<Msg>();

        let handle = std::thread::Builder::new()
            .stack_size(COMPILE_STACK_SIZE)
            .name("typst-compile".into())
            .spawn(move || Self::run(rx, compile_fn))
            .expect("failed to spawn compile worker thread");

        Self {
            tx,
            handle: Some(handle),
        }
    }

    /// The worker loop: block on the channel, coalesce pending signals, then
    /// run the compile closure. Repeats until `Shutdown` is received.
    fn run(rx: Receiver<Msg>, compile_fn: Arc<dyn Fn() + Send + Sync>) {
        while let Ok(Msg::Recompile) = rx.recv() {
            // Coalesce: drain any additional Recompile signals that queued
            // during the previous compile. They all want the same thing
            // (recompile with the latest text), so one run suffices.
            while rx.try_recv().is_ok() {}

            // Run the compile. Panics are caught by the caller's
            // `catch_unwind` inside the closure.
            compile_fn();
        }
        // `recv()` returned `Err` (sender dropped) or received `Shutdown`.
    }

    /// Signal the worker to recompile. Non-blocking — if the worker is busy,
    /// the message queues and is processed when the current compile finishes.
    pub fn recompile(&self) {
        // `try_send` equivalent — mpsc channels are unbounded, so this never
        // blocks. A full channel would indicate a bug (worker dead-locked).
        let _ = self.tx.send(Msg::Recompile);
    }

    /// Shut down the worker and wait for the thread to exit. The current
    /// compile (if any) runs to completion before the thread exits.
    pub fn shutdown(mut self) {
        let _ = self.tx.send(Msg::Shutdown);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for CompileWorker {
    fn drop(&mut self) {
        // If `shutdown` wasn't called explicitly (e.g. on panic), at least
        // signal the thread to stop so it doesn't leak.
        let _ = self.tx.send(Msg::Shutdown);
        // Don't join in Drop — the compile might still be running, and
        // blocking in Drop is bad practice. The thread will see the Shutdown
        // message and exit on its own.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[test]
    fn worker_compiles_on_signal() {
        let count = Arc::new(AtomicUsize::new(0));
        let cf = {
            let count = count.clone();
            Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
            }) as Arc<dyn Fn() + Send + Sync>
        };
        let worker = CompileWorker::spawn(cf);
        worker.recompile();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        worker.shutdown();
    }

    #[test]
    fn rapid_signals_coalesce_into_one_compile() {
        let count = Arc::new(AtomicUsize::new(0));
        let cf = {
            let count = count.clone();
            Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                // Simulate a slow compile so signals queue up.
                std::thread::sleep(Duration::from_millis(50));
            }) as Arc<dyn Fn() + Send + Sync>
        };
        let worker = CompileWorker::spawn(cf);

        // First compile (slow).
        worker.recompile();
        std::thread::sleep(Duration::from_millis(10));

        // Burst of signals while the first compile is running.
        for _ in 0..10 {
            worker.recompile();
        }

        // Wait for the first compile + one coalesced recompile.
        std::thread::sleep(Duration::from_millis(200));
        let total = count.load(Ordering::SeqCst);
        assert_eq!(
            total, 2,
            "10 rapid signals during a slow compile should coalesce into exactly 1 extra run (total 2), got {total}"
        );
        worker.shutdown();
    }

    #[test]
    fn shutdown_stops_the_worker() {
        let count = Arc::new(AtomicUsize::new(0));
        let cf = {
            let count = count.clone();
            Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
            }) as Arc<dyn Fn() + Send + Sync>
        };
        let worker = CompileWorker::spawn(cf);
        worker.recompile();
        std::thread::sleep(Duration::from_millis(50));
        let before = count.load(Ordering::SeqCst);
        worker.shutdown();
        // After shutdown, sending more signals should have no effect.
        // (The sender is consumed by `shutdown`, so this would panic if we
        // tried — which is correct behaviour.)
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(count.load(Ordering::SeqCst), before);
    }
}
