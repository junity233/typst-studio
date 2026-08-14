//! Integration checks for the bibliography parsers against the checked-in
//! `examples/bib-demo` fixtures.
//!
//! These used to be println-only "tests" that could never fail; they now carry
//! real assertions: parse must succeed, the known fixture keys must all come
//! back, and the core fields (key / entry type / title) must be non-empty. The
//! fixture files are committed alongside the repo (`include_str!` bakes them
//! into the binary, so the test never depends on a working-directory layout).

use typst_studio_lib::domain::bib_entry::{
    parse_bibliography, parse_bibliography_editable, BibFormat,
};

/// The 6 top-level keys of `refs.yml` (single author, multi-author, parent
/// periodical/proceedings, no-date entry — one of every shape the panel must
/// render). Hardcoded so a dropped/renamed fixture key fails the test instead
/// of silently shrinking coverage.
const YML_KEYS: [&str; 6] = [
    "einstein-1905",
    "knuth-texbook",
    "latex-companion",
    "typst-paper",
    "minimal-entry",
    "shannon-info",
];

#[test]
fn check_yml_parse() {
    let content = include_str!("../../examples/bib-demo/refs.yml");
    let entries = parse_bibliography(content, BibFormat::HayagrivaYaml)
        .expect("Hayagriva YAML fixture must parse");
    assert_eq!(entries.len(), YML_KEYS.len(), "every fixture key must parse");
    for key in YML_KEYS {
        assert!(
            entries.iter().any(|e| e.key == key),
            "key {key} missing from parsed entries: {:?}",
            entries.iter().map(|e| e.key.as_str()).collect::<Vec<_>>()
        );
    }
    // Core fields are populated for every entry (the panel renders key/type
    // unconditionally; title drives the row's main label).
    for e in &entries {
        assert!(!e.key.is_empty(), "entry key must be non-empty");
        assert!(!e.entry_type.is_empty(), "entry_type must be non-empty");
        assert!(
            e.title.as_deref().is_some_and(|t| !t.is_empty()),
            "entry {} must carry a title",
            e.key
        );
    }
    // Spot-check one typed field so the projection isn't just empty strings:
    // einstein-1905 is a 1905 article by Albert Einstein.
    let einstein = entries.iter().find(|e| e.key == "einstein-1905").unwrap();
    assert_eq!(einstein.entry_type, "article");
    assert_eq!(einstein.year, Some(1905));
    assert_eq!(einstein.authors, vec!["Albert Einstein".to_string()]);
}

#[test]
fn check_yml_parse_editable() {
    // The editable projection (edit-modal source of truth) must parse the
    // same fixture and expose the same keys, plus non-empty extras for an
    // entry that has fields beyond the 5 core ones (einstein-1905 carries a
    // parent periodical with a volume).
    let content = include_str!("../../examples/bib-demo/refs.yml");
    let entries = parse_bibliography_editable(content, BibFormat::HayagrivaYaml)
        .expect("Hayagriva YAML fixture must parse (editable)");
    assert_eq!(entries.len(), YML_KEYS.len());
    for key in YML_KEYS {
        assert!(
            entries.iter().any(|e| e.key == key),
            "editable key {key} missing"
        );
    }
    for e in &entries {
        assert!(!e.key.is_empty());
        assert!(!e.entry_type.is_empty());
    }
    let einstein = entries.iter().find(|e| e.key == "einstein-1905").unwrap();
    assert!(
        !einstein.extra.is_empty(),
        "einstein-1905 must expose its parent/journal fields as extras"
    );
}

#[test]
fn check_bib_parse() {
    // The BibLaTeX fixture has 7 entries (@article/@book/@online/@misc/
    // @phdthesis, including one without a year). Assert the full key set so a
    // parser regression that silently drops entries fails here.
    let content = include_str!("../../examples/bib-demo/refs.bib");
    let entries = parse_bibliography(content, BibFormat::BibLatex)
        .expect("BibLaTeX fixture must parse");
    let expected = [
        "einstein1905",
        "knuth1984",
        "latex-companion",
        "typst-docs",
        "no-year-entry",
        "shannon1948",
        "turing1938",
    ];
    assert_eq!(entries.len(), expected.len());
    for key in expected {
        assert!(
            entries.iter().any(|e| e.key == key),
            "key {key} missing from parsed entries"
        );
    }
    for e in &entries {
        assert!(!e.key.is_empty());
        assert!(!e.entry_type.is_empty());
    }
}
