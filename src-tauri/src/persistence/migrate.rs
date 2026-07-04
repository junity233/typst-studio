//! Versioned schema migration framework (§7.3).
//!
//! Session, settings, and (future) recovery stores each carry a
//! `schemaVersion`. On load, if the on-disk version is older than the current
//! code's version, a sequence of migration steps runs in order to bring the
//! value up to date. §7.3 requires:
//!
//! - explicit, **order-preserving** migration functions per version bump;
//! - the original file preserved (migrations run on a parsed value, not by
//!   overwriting the file in place — the file is only rewritten on the next
//!   successful save, with the bumped version);
//! - "新版本无法识别时进入兼容降级，不覆盖原文件" — an unrecognized/failing
//!   migration must NOT corrupt the file; the caller logs and may continue
//!   with the as-loaded value (see "Failure semantics" below) or fall back to
//!   defaults.
//!
//! ## Failure semantics: clone-then-commit
//!
//! [`Migrator::migrate`] works on a **clone** of the value. Steps mutate the
//! clone; only if *all* steps succeed is the result committed back into the
//! caller's value. On any step failure the caller's original value is left
//! **untouched** (no partial mutation) and the error is returned via `Err`;
//! the caller decides how to degrade (log + keep as-is, or discard and use
//! defaults). This is the cleanest contract — there is no "half-migrated"
//! state to reason about, and a failing migration can never corrupt the
//! in-memory state the rest of the app reads.
//!
//! ## Version model
//!
//! A version of `0` means "the field was absent / unrecognized" (e.g. a file
//! written by a build that predates `schemaVersion`). Migrations run from the
//! file's version up to `current_version` inclusive of each step `n → n+1`.
//! A value already at `current_version` skips migration entirely.

use crate::error::Result;

/// A single migration step: `&mut T -> Result<()>`. Boxed so a `Migrator` can
/// hold a heterogeneous list of closures and live behind a shared reference.
pub type MigrationStep<T> = Box<dyn Fn(&mut T) -> Result<()> + Send + Sync>;

/// A versioned migrator. Register migrations `v(n) → v(n+1)` in order via
/// [`Migrator::step`]; they run sequentially on load if the file's version is
/// below the current. See the module docs for the failure model
/// (clone-then-commit).
pub struct Migrator<T> {
    current_version: u32,
    steps: Vec<MigrationStep<T>>,
}

impl<T> Migrator<T> {
    /// Build a migrator whose target version is `current_version`. Register a
    /// step for each bump `i → i+1` that needs an actual transform; a bump
    /// with no registered step is a *no-op version bump* (shape unchanged,
    /// version advances). A value already at `current_version` runs no steps.
    pub fn new(current_version: u32) -> Self {
        Self {
            current_version,
            steps: Vec::new(),
        }
    }

    /// Register a migration step. Steps are applied in registration order:
    /// step 0 migrates version `0 → 1`, step 1 migrates `1 → 2`, etc. The
    /// closure must be `Send + Sync + 'static` so the migrator can live behind
    /// a static / shared reference if needed.
    pub fn step<F>(mut self, f: F) -> Self
    where
        F: Fn(&mut T) -> Result<()> + Send + Sync + 'static,
    {
        self.steps.push(Box::new(f));
        self
    }

    /// The version this migrator targets.
    pub fn current_version(&self) -> u32 {
        self.current_version
    }

    /// Run registered steps to bring `value` up to [`current_version`](Self::current_version).
    ///
    /// `value.version` (read via the `version` closure) is compared to the
    /// target; if lower, steps `[version..current_version]` are applied in
    /// order to a **clone**. On success the clone is committed back into
    /// `value` and the resulting version is written via `set_version` and
    /// returned. On any step failure, `value` is left untouched (the clone is
    /// discarded), the error is returned, and the caller is responsible for
    /// logging / degrading per §7.3 (the on-disk file is never overwritten by
    /// this call — that happens on the next successful save).
    ///
    /// `version(&T) -> u32` reads the current schema version; `set_version`
    /// writes the post-migration version back into `value`.
    ///
    /// Requires `T: Clone` so the steps can mutate a copy without risking the
    /// caller's value on failure (clone-then-commit; see module docs).
    pub fn migrate(
        &self,
        value: &mut T,
        version: impl Fn(&T) -> u32,
        set_version: impl Fn(&mut T, u32),
    ) -> Result<u32>
    where
        T: Clone,
    {
        let from = version(value);
        if from >= self.current_version {
            // Already current (or somehow ahead — treat as current and don't
            // run forward-only migrations on a newer-than-known value). Return
            // the claimed version so a newer-than-known file is never silently
            // downgraded.
            return Ok(from);
        }

        // Clone-then-commit: run on a clone so a step failure leaves the
        // caller's value byte-identical. The original `value` is mutated only
        // on the success path.
        let mut work = value.clone();
        match self.run_steps(&mut work, from) {
            Ok(()) => {
                set_version(&mut work, self.current_version);
                *value = work;
                Ok(self.current_version)
            }
            Err(e) => {
                // `value` is untouched (the clone is dropped). Caller logs and
                // degrades per §7.3.
                Err(e)
            }
        }
    }

    /// Apply steps `[from..current_version]` to `work` in order. Returns
    /// `Ok(())` on full success or the first error encountered.
    ///
    /// A bump with **no** registered step is a *no-op version bump*: the value
    /// is left unchanged and only the version tag advances. This is the
    /// legitimate "the on-disk shape didn't change, only the version number"
    /// case (e.g. v0 → v1 for Session today — current shape IS v1). Register a
    /// step only when an actual transform is needed.
    fn run_steps(&self, work: &mut T, from: u32) -> Result<()> {
        let mut v = from;
        // Steps are indexed by their source version: step i = i → i+1.
        while v < self.current_version {
            if let Some(step) = self.steps.get(v as usize) {
                step(work)?;
            }
            // No step registered for v → v+1: treat as a no-op bump (shape
            // unchanged; only the version tag will advance, done by the caller).
            v += 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    /// A trivial test value: a versioned counter the steps mutate.
    #[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
    struct Counter {
        version: u32,
        n: u32,
    }

    fn version(c: &Counter) -> u32 {
        c.version
    }
    fn set_version(c: &mut Counter, v: u32) {
        c.version = v;
    }

    #[test]
    fn no_steps_is_noop() {
        // Migrator targeting v0 with no steps: a v0 value is already current.
        let m = Migrator::<Counter>::new(0);
        let mut c = Counter { version: 0, n: 5 };
        let reached = m.migrate(&mut c, version, set_version).unwrap();
        assert_eq!(reached, 0);
        assert_eq!(c.version, 0);
        assert_eq!(c.n, 5, "no steps means no mutation");
    }

    #[test]
    fn steps_run_in_order() {
        // Two steps, each bumping a counter; verify both ran and version is
        // bumped to current (2).
        let m = Migrator::<Counter>::new(2)
            .step(|c| {
                c.n += 1;
                Ok(())
            })
            .step(|c| {
                c.n += 10;
                Ok(())
            });

        let mut c = Counter { version: 0, n: 0 };
        let reached = m.migrate(&mut c, version, set_version).unwrap();
        assert_eq!(reached, 2);
        assert_eq!(c.version, 2, "version must be bumped to current");
        assert_eq!(c.n, 11, "both steps must run in order (1 + 10)");
    }

    #[test]
    fn version_already_current_skips() {
        // Value already at current → no steps run, counter unchanged.
        let m = Migrator::<Counter>::new(2).step(|c| {
            c.n += 1;
            Ok(())
        });

        let mut c = Counter { version: 2, n: 7 };
        let reached = m.migrate(&mut c, version, set_version).unwrap();
        assert_eq!(reached, 2);
        assert_eq!(c.n, 7, "must not run any step when already current");
    }

    #[test]
    fn version_ahead_of_current_is_left_as_is() {
        // A value claiming a HIGHER version than the code knows about (e.g. a
        // file written by a newer build, then downgraded). §7.3: don't run
        // forward migrations; treat as current-known. Don't clobber the higher
        // number either — keep min(known, claimed) is wrong for "ahead"; we
        // return the known current but must NOT downgrade the stored version.
        let m = Migrator::<Counter>::new(2).step(|c| {
            c.n += 1;
            Ok(())
        });

        let mut c = Counter { version: 5, n: 7 };
        let reached = m.migrate(&mut c, version, set_version).unwrap();
        // No steps run.
        assert_eq!(c.n, 7);
        // We return the claimed version when it's ahead (don't silently
        // rewrite a newer file's version downward).
        assert_eq!(reached, 5);
        assert_eq!(c.version, 5, "ahead-of-current version must be preserved");
    }

    #[test]
    fn step_failure_returns_err_and_value_untouched() {
        // Clone-then-commit contract: a failing step must (a) return Err and
        // (b) leave the caller's value byte-identical (no partial mutation).
        let m = Migrator::<Counter>::new(2)
            .step(|c| {
                c.n += 1;
                Ok(())
            })
            .step(|_| {
                Err(crate::error::AppError::Other("boom".into()))
            });

        let mut c = Counter { version: 0, n: 3 };
        let original = c.clone();
        let err = m.migrate(&mut c, version, set_version);
        assert!(err.is_err(), "failing step must surface an error");
        assert_eq!(c, original, "value must be untouched on step failure (clone-then-commit)");
        assert_eq!(c.version, 0, "version must not advance on failure");
    }

    #[test]
    fn unregistered_bump_is_noop_but_advances_version() {
        // A bump with no registered step is a *no-op*: the value is untouched
        // but the version tag advances to current. This is the legitimate
        // "shape didn't change, only the version" case (e.g. Session v0 → v1).
        // Target v2 with only ONE step registered (step 0, v0→v1); the v1→v2
        // bump has no step and must therefore be a no-op.
        let m = Migrator::<Counter>::new(2).step(|c| {
            c.n += 1;
            Ok(())
        });
        let mut c = Counter { version: 0, n: 0 };
        let reached = m.migrate(&mut c, version, set_version).unwrap();
        assert_eq!(reached, 2, "version must reach current");
        assert_eq!(c.version, 2);
        // Only the registered step ran (+1); the v1→v2 no-op bump did nothing.
        assert_eq!(c.n, 1);
    }

    /// Integration with the Session shape: a v0 Session (no `schemaVersion`
    /// field) deserializes to version 0, and a no-op v0→v1 migrator leaves the
    /// data intact while bumping the version to current.
    #[test]
    fn session_v0_migrates_to_current_via_noop() {
        use crate::service::session::Session;

        // A "v0" session: no schemaVersion field at all (what prior batches
        // wrote). Deserializes with schema_version defaulting to 0.
        let json = r#"{"lastWorkspace":"/w","lastFile":"/w/m.typ"}"#;
        let mut s: Session = serde_json::from_str(json).unwrap();
        assert_eq!(s.schema_version, 0, "absent schemaVersion must deserialize as 0");

        let m = crate::service::session::session_migrator();
        let reached = m
            .migrate(
                &mut s,
                |s| s.schema_version,
                |s, v| s.schema_version = v,
            )
            .unwrap();
        assert_eq!(reached, crate::service::session::CURRENT_SCHEMA_VERSION);
        assert_eq!(s.schema_version, crate::service::session::CURRENT_SCHEMA_VERSION);
        // Data preserved (v0→v1 is a no-op — the current shape IS v1).
        assert_eq!(s.last_workspace, "/w");
        assert_eq!(s.last_file, "/w/m.typ");
    }
}
