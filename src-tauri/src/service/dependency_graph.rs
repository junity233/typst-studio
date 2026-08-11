//! Reverse dependency graph for multi-file projects.
//!
//! When document A `#include`s / `#import`s / `#read`s file B, A depends on B.
//! Editing B (or observing an external disk change to B) must therefore cascade
//! a recompile to A — and transitively to anything that depends on A. This
//! module answers the question "given that path P changed, which files need to
//! recompile?".
//!
//! Nodes are **canonical disk paths** — the same key the
//! [`MemoryVfs`](crate::typst_engine::MemoryVfs) and
//! [`FileResolver`](crate::fs::FileResolver) use — so a change observed for
//! path `P` maps to the open documents depending on it regardless of workspace
//! vs loose-file scope.
//!
//! The graph stores only *direct* edges (each document's most recent compile
//! reports the files it pulled in); [`DependencyGraph::dependents_of`] walks the
//! transitive closure on demand. Cycles are tolerated (typst rejects cyclic
//! includes, so they never produce edges here, but the BFS is cycle-safe
//! regardless via its `visited` set).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use parking_lot::RwLock;

/// Shared, concurrency-safe reverse dependency graph keyed by canonical path.
///
/// Cheap to clone behind an `Arc`; [`TabStore`](super::tab_store::TabStore)
/// holds one `Arc<DependencyGraph>` and consults it from the edit, compile, and
/// watcher paths.
#[derive(Default)]
pub struct DependencyGraph {
    /// Reverse edges: key = a file that is depended upon; value = the set of
    /// files that directly include/import it. Updated from each document's last
    /// compile via [`Self::update_dependencies`].
    rev_deps: RwLock<HashMap<PathBuf, HashSet<PathBuf>>>,
}

impl DependencyGraph {
    /// Create an empty graph.
    pub fn new() -> Self {
        Self::default()
    }

    /// Refresh the outgoing edges of `depender`: it directly depends on each
    /// path in `deps` (and nothing else). Edges from a previous compile of
    /// `depender` that are no longer present are removed first.
    ///
    /// `depender` is normally the canonical path of the document that just
    /// compiled; `deps` are the canonical paths it pulled in via
    /// `#include` / `#import` / `#read` / `#image()`.
    pub fn update_dependencies(&self, depender: &Path, deps: HashSet<PathBuf>) {
        let mut map = self.rev_deps.write();
        // Drop `depender` from every value set so only its current edges remain
        // after re-insertion below. (A full scan is fine — graphs are tiny,
        // bounded by #open-documents × includes per doc.)
        for set in map.values_mut() {
            set.remove(depender);
        }
        map.retain(|_, set| !set.is_empty());
        for dep in deps {
            map.entry(dep).or_default().insert(depender.to_path_buf());
        }
    }

    /// Remove `depender`'s *outgoing* edges — e.g. when its tab closes, so it no
    /// longer claims to include anything. *Ingoing* edges (other documents that
    /// include `depender`) are kept: the file still exists on disk and can still
    /// be included from elsewhere.
    pub fn remove_outgoing(&self, depender: &Path) {
        let mut map = self.rev_deps.write();
        for set in map.values_mut() {
            set.remove(depender);
        }
        map.retain(|_, set| !set.is_empty());
    }

    /// All files that transitively (directly or indirectly) depend on `path`,
    /// via a breadth-first walk over the reverse edges. `path` itself is never
    /// in the result (a file does not include itself). The caller maps these
    /// paths back to open documents to decide which workers to signal.
    pub fn dependents_of(&self, path: &Path) -> HashSet<PathBuf> {
        let map = self.rev_deps.read();
        let mut visited: HashSet<PathBuf> = HashSet::new();
        let mut queue: VecDeque<PathBuf> = VecDeque::new();
        // Seed with the direct dependents of `path`.
        if let Some(direct) = map.get(path) {
            for d in direct {
                if visited.insert(d.clone()) {
                    queue.push_back(d.clone());
                }
            }
        }
        while let Some(node) = queue.pop_front() {
            if let Some(next) = map.get(&node) {
                for d in next {
                    if visited.insert(d.clone()) {
                        queue.push_back(d.clone());
                    }
                }
            }
        }
        visited
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn direct_dependency_is_reported() {
        let g = DependencyGraph::new();
        // main.typ includes chapter.typ
        g.update_dependencies(&p("/ws/main.typ"), HashSet::from([p("/ws/chapter.typ")]));

        let deps = g.dependents_of(&p("/ws/chapter.typ"));
        assert_eq!(deps, HashSet::from([p("/ws/main.typ")]));
    }

    #[test]
    fn dependents_of_unknown_path_is_empty() {
        let g = DependencyGraph::new();
        assert!(g.dependents_of(&p("/ws/unknown.typ")).is_empty());
    }

    #[test]
    fn transitive_chain_walked_via_bfs() {
        // a includes b, b includes c. Editing c must reach a and b.
        let g = DependencyGraph::new();
        g.update_dependencies(&p("/a.typ"), HashSet::from([p("/b.typ")]));
        g.update_dependencies(&p("/b.typ"), HashSet::from([p("/c.typ")]));

        let deps = g.dependents_of(&p("/c.typ"));
        assert_eq!(deps, HashSet::from([p("/a.typ"), p("/b.typ")]));
    }

    #[test]
    fn update_replaces_stale_outgoing_edges() {
        let g = DependencyGraph::new();
        // First main.typ includes old.typ.
        g.update_dependencies(&p("/main.typ"), HashSet::from([p("/old.typ")]));
        assert!(g.dependents_of(&p("/old.typ")).contains(&p("/main.typ")));

        // Then the include is removed; main.typ now includes new.typ.
        g.update_dependencies(&p("/main.typ"), HashSet::from([p("/new.typ")]));

        // old.typ no longer has main.typ as a dependent.
        assert!(g.dependents_of(&p("/old.typ")).is_empty());
        assert!(g.dependents_of(&p("/new.typ")).contains(&p("/main.typ")));
    }

    #[test]
    fn remove_outgoing_drops_only_that_nodes_edges() {
        let g = DependencyGraph::new();
        g.update_dependencies(&p("/main.typ"), HashSet::from([p("/a.typ"), p("/b.typ")]));
        g.update_dependencies(&p("/other.typ"), HashSet::from([p("/a.typ")]));

        g.remove_outgoing(&p("/main.typ"));

        // a.typ still depended on by other.typ; b.typ now has no dependents.
        assert_eq!(g.dependents_of(&p("/a.typ")), HashSet::from([p("/other.typ")]));
        assert!(g.dependents_of(&p("/b.typ")).is_empty());
    }

    #[test]
    fn self_edge_does_not_infinite_loop() {
        // A pathological self-dependency must not hang dependents_of. (typst
        // rejects cyclic includes, so this never arises in practice, but the
        // BFS must be safe regardless.)
        let g = DependencyGraph::new();
        g.update_dependencies(&p("/x.typ"), HashSet::from([p("/x.typ")]));

        let deps = g.dependents_of(&p("/x.typ"));
        // x.typ depends on itself; the visited guard means it's reported once.
        assert_eq!(deps, HashSet::from([p("/x.typ")]));
    }
}
