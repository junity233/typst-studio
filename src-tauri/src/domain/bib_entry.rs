//! Bibliography entry model + native parsing (Task 4 — Bibliography panel).
//!
//! Parses `.bib` (BibLaTeX) and `.yml`/`.yaml` (Hayagriva YAML) bibliography
//! files into a flat list of [`BibEntry`] payloads using the `hayagriva` crate,
//! which is already a transitive dependency of `typst-library` (declaring it
//! directly here dedupes to the same 0.10.x — no new code compiled).
//!
//! This module is pure (no IO): it takes already-read text + a [`BibFormat`]
//! and returns entries. The IPC layer ([`crate::ipc::bib_commands`]) handles
//! file reading + workspace discovery.
//!
//! Field extraction strategy: the typed getters are used for `key`, `title`,
//! `authors`, and `year` — they avoid the fragility of serde-derived Display
//! impls while giving clean output:
//! - `key`: `Entry::key()` returns `&str` (the field is `#[serde(skip)]`, so it
//!   is NOT reachable via `serde_json::to_value`).
//! - `entry_type`: `EntryType` does not impl `Display`, but it serializes to its
//!   kebab-case name (`#[serde(rename_all = "kebab-case")]`), so we round-trip
//!   it through `serde_json::to_value` → `.as_str()`.
//! - `title`: `FormatString` impl `Display` (the full formatted title).
//! - `authors`: `Person::given_first(false)` yields "Given Family" (the natural
//!   reading order for a reference list). `name_first` would emit "Family, Given".
//! - `year`: `Date.year` is a public `i32` field.

use thiserror::Error;

/// The bibliography file format. Sniffed from the extension by the caller, with
/// a content-heuristic fallback in [`sniff_format`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BibFormat {
    /// BibLaTeX (`.bib`) — `@type{key, field = value, …}` records.
    BibLatex,
    /// Hayagriva YAML (`.yml`/`.yaml`) — `key: {type: …, …}` map.
    HayagrivaYaml,
}

/// One bibliography entry surfaced to the Bibliography panel. CamelCase on the
/// wire to match the frontend TS interface (`{ key, entryType, title?, authors, year? }`).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct BibEntry {
    /// The citation key — what goes inside `#cite(<key>)`.
    pub key: String,
    /// The entry type as a kebab-case string (e.g. "article", "book").
    pub entry_type: String,
    /// The full formatted title, if present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Author display names ("Given Family"), in order. Empty when absent.
    #[serde(default)]
    pub authors: Vec<String>,
    /// The 4-digit publication year, if a date is present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
}

/// A bibliography entry with ALL editable fields, for the edit modal.
///
/// Unlike the lossy 5-field [`BibEntry`] projection (which exists only for the
/// panel list), this carries every set field so the edit form can surface and
/// round-trip them. `extra` holds every field beyond the 5 core ones
/// (journal, volume, pages, url, publisher, ...) as `(field_name, value)`
/// pairs, so the edit form can render them generically without a fixed schema.
///
/// The save path ([`serialize_bibliography`]) re-parses the ORIGINAL file text
/// and applies these entries on top, preserving untouched fields and entries —
/// serializing `BibEntryEditable` directly would NOT be enough because `extra`
/// is a flat string list and would lose typed structure (e.g. a `Date` with a
/// month). See that function's docs for the fidelity strategy.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    feature = "export-types",
    derive(ts_rs::TS),
    ts(export_to = "../../src/lib/types.ts")
)]
pub struct BibEntryEditable {
    /// The citation key — what goes inside `#cite(<key>)`.
    pub key: String,
    /// The entry type as a kebab-case string (e.g. "article", "book"), matching
    /// the [`BibEntry::entry_type`] format.
    pub entry_type: String,
    /// The full formatted title, if present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Author display names ("Given Family"), in order. Empty when absent.
    #[serde(default)]
    pub authors: Vec<String>,
    /// The 4-digit publication year, if a date is present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    /// Remaining fields as `(name, value)` pairs. Names are lowercase BibLaTeX
    /// field names (journal, volume, pages, url, publisher, ...). Values are the
    /// display strings (the `Display` impl of the underlying hayagriva type).
    /// The 5 core fields (title/authors/date/key/type) are NEVER present here —
    /// they live in the dedicated fields above.
    #[serde(default)]
    pub extra: Vec<(String, String)>,
}

/// Errors raised by [`parse_bibliography`] / [`parse_bibliography_editable`] /
/// [`serialize_bibliography`]. The IPC layer maps these into
/// [`AppError`](crate::error::AppError).
#[derive(Debug, Error)]
pub enum BibParseError {
    /// BibLaTeX (`.bib`) parse failure. Carries the joined error messages — the
    /// `hayagriva` BibLaTeX parser returns a `Vec<BibLaTeXError>` (often several
    /// for one malformed file), so we flatten them for a single user-facing line.
    #[error("failed to parse BibLaTeX: {0}")]
    BibLatex(String),

    /// Hayagriva YAML (`.yml`/`.yaml`) parse failure.
    #[error("failed to parse Hayagriva YAML: {0}")]
    Yaml(String),

    /// Serializing back to Hayagriva YAML failed (`to_yaml_str` is serde_yaml
    /// based and can fail on non-string map keys, though our entries are always
    /// string-keyed — included for totality).
    #[error("failed to serialize Hayagriva YAML: {0}")]
    YamlSerialize(String),
}

/// Parse bibliography `content` (already-read file text) into [`BibEntry`]s.
///
/// `format` selects the parser; use [`sniff_format`] to derive it from a
/// filename when the caller does not know it up front.
pub fn parse_bibliography(
    content: &str,
    format: BibFormat,
) -> Result<Vec<BibEntry>, BibParseError> {
    let library = parse_library(content, format)?;
    Ok(library.iter().map(entry_to_bib).collect::<Result<_, _>>()?)
}

/// Parse `content` into a `hayagriva::Library` for the given [`BibFormat`].
/// Shared by [`parse_bibliography`] and [`parse_bibliography_editable`] so the
/// BibLaTeX/YAML parse + error-mapping lives in one place. BibLaTeX errors come
/// back as a `Vec` (often several for one malformed file) and are flattened
/// into a single user-facing line.
fn parse_library(
    content: &str,
    format: BibFormat,
) -> Result<hayagriva::Library, BibParseError> {
    match format {
        BibFormat::BibLatex => hayagriva::io::from_biblatex_str(content).map_err(|errs| {
            BibParseError::BibLatex(
                errs.into_iter()
                    .map(|e| e.to_string())
                    .collect::<Vec<_>>()
                    .join("; "),
            )
        }),
        BibFormat::HayagrivaYaml => {
            hayagriva::io::from_yaml_str(content).map_err(|e| BibParseError::Yaml(e.to_string()))
        }
    }
}

/// Convert a single `hayagriva::Entry` into a [`BibEntry`].
fn entry_to_bib(entry: &hayagriva::Entry) -> Result<BibEntry, BibParseError> {
    let core = core_fields(entry);
    Ok(BibEntry {
        key: core.key,
        entry_type: core.entry_type,
        title: core.title,
        authors: core.authors,
        year: core.year,
    })
}

/// Parse bibliography `content` into the full-field [`BibEntryEditable`] form
/// used by the edit modal. Both formats parse into a `hayagriva::Library`
/// (BibLaTeX via `from_biblatex_str`, YAML via `from_yaml_str`), then each
/// `Entry` is projected into the 5 core fields PLUS every other set field into
/// `extra`.
///
/// `extra` enumeration: hayagriva's `Entry` has no "list all set fields" API,
/// so each known field is probed via its typed getter and, when `Some`,
/// `(field_name, display_string)` is pushed. Field names mirror the BibLaTeX
/// convention (journal→"journal" via the parent, volume→"volume", url→"url",
/// …) so the edit form labels match what users see in `.bib` files. Only the
/// 5 core fields (title/authors/date/key/type) are excluded — they already live
/// in the dedicated fields.
pub fn parse_bibliography_editable(
    content: &str,
    format: BibFormat,
) -> Result<Vec<BibEntryEditable>, BibParseError> {
    let library = parse_library(content, format)?;
    Ok(library.iter().map(entry_to_editable).collect())
}

/// The 5 core fields shared by [`BibEntry`] and [`BibEntryEditable`], extracted
/// once so the panel list and the edit modal always agree on
/// key/type/title/authors/year.
struct CoreFields {
    key: String,
    entry_type: String,
    title: Option<String>,
    authors: Vec<String>,
    year: Option<i32>,
}

/// Extract the 5 core fields from a `hayagriva::Entry`. Shared by
/// [`entry_to_bib`] (the 5-field panel projection) and [`entry_to_editable`]
/// (the full-field edit form) so the two stay in sync.
///
/// `entry_type` does not impl `Display`, but serializes to its kebab-case name
/// (`#[serde(rename_all = "kebab-case")]`); we round-trip it through
/// `serde_json` and fall back to `"misc"` (the round-trip always succeeds for
/// the known enum, so the fallback is defensive).
fn core_fields(entry: &hayagriva::Entry) -> CoreFields {
    let entry_type = serde_json::to_value(entry.entry_type())
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "misc".to_string());

    CoreFields {
        key: entry.key().to_string(),
        entry_type,
        title: entry.title().map(|t| t.to_string()),
        authors: entry
            .authors()
            .map(|persons| persons.iter().map(|p| p.given_first(false)).collect::<Vec<_>>())
            .unwrap_or_default(),
        year: entry.date_any().map(|d| d.year),
    }
}

/// Convert a single `hayagriva::Entry` into a [`BibEntryEditable`], extracting
/// the 5 core fields (via [`core_fields`]) plus every other set field into
/// `extra`.
fn entry_to_editable(entry: &hayagriva::Entry) -> BibEntryEditable {
    let core = core_fields(entry);

    // Extra fields. Each getter returns `Option<&T>`; when `Some` we stringify
    // via the type's `Display` impl. The probe list covers the fields a user is
    // likely to edit in a reference (journal comes from the parent `Periodical`
    // title for `Article` entries — surfaced via `map_parents` so the edit form
    // shows the journal name the user expects). Empty strings are skipped so the
    // edit form doesn't show noise for fields hayagriva reports as set-but-empty.
    let mut extra: Vec<(String, String)> = Vec::new();
    let mut push = |name: &str, value: Option<String>| {
        if let Some(s) = value {
            if !s.is_empty() {
                extra.push((name.to_string(), s));
            }
        }
    };

    // Journal: for an Article, the parent Periodical/Proceedings holds the
    // journal title. Walk parents looking for a title.
    push("journal", entry.map_parents(|e| e.title().map(|t| t.to_string())));

    // `Publisher` has no `Display` impl; surface its name (the part a user
    // edits). Location is a separate `location` field below.
    push("publisher", entry.publisher().and_then(|p| p.name().map(|n| n.to_string())));
    push("location", entry.location().map(|l| l.to_string()));
    push("organization", entry.organization().map(|o| o.to_string()));
    // Volume/issue/edition may live on the parent (e.g. a journal's volume).
    // `map` checks self then parents (BFS), matching how hayagriva resolves
    // inherited fields for citation formatting.
    push("volume", entry.map(|e| e.volume().map(|v| v.to_string())));
    push("issue", entry.map(|e| e.issue().map(|i| i.to_string())));
    push("edition", entry.map(|e| e.edition().map(|e| e.to_string())));
    push("pages", entry.map(|e| e.page_range().map(|pr| pr.to_string())));
    push("url", entry.url_any().map(|u| u.to_string()));
    push("doi", entry.doi().map(|d| d.to_string()));
    push("isbn", entry.isbn().map(|i| i.to_string()));
    push("issn", entry.issn().map(|i| i.to_string()));
    push("language", entry.language().map(|l| l.to_string()));
    push("note", entry.note().map(|n| n.to_string()));
    push("abstract", entry.abstract_().map(|a| a.to_string()));
    push("genre", entry.genre().map(|g| g.to_string()));

    BibEntryEditable {
        key: core.key,
        entry_type: core.entry_type,
        title: core.title,
        authors: core.authors,
        year: core.year,
        extra,
    }
}

/// Serialize edited entries back to bibliography source text, preserving
/// untouched entries and untouched fields.
///
/// **Fidelity strategy (critical):** `BibEntryEditable` is a flat projection —
/// serializing it directly would destroy typed structure (a `Date` with a month,
/// a `PageRanges` set, a parent `Periodical`, …). So this function instead
/// RE-PARSES the `original` file text into the rich structure, then applies the
/// user's edits to the targeted entries only, and re-serializes the WHOLE
/// structure. Untouched entries and untouched fields on edited entries survive
/// verbatim.
///
/// Per format:
/// - **BibLaTeX** (`.bib`): uses `biblatex::Bibliography` directly (NOT
///   hayagriva) because biblatex preserves `.bib` field fidelity far better
///   than hayagriva's lossy `Entry`. Edited core fields are applied via the
///   typed setters; `extra` fields via `Entry::set`. New entries are
///   `Entry::new`-constructed; deleted entries are `bib.remove`-d.
/// - **Hayagriva YAML** (`.yml`): re-parses into a `hayagriva::Library`, and
///   for each edited entry clones the matching original `Entry` then applies
///   only the changed core fields via setters (preserving all other typed
///   fields). New entries are built fresh; deleted entries are `library.remove`-d.
pub fn serialize_bibliography(
    original: &str,
    format: BibFormat,
    entries: &[BibEntryEditable],
) -> Result<String, BibParseError> {
    match format {
        BibFormat::BibLatex => serialize_biblatex(original, entries),
        BibFormat::HayagrivaYaml => serialize_yaml(original, entries),
    }
}

/// Serialize `.bib` via `biblatex::Bibliography` (full fidelity). See
/// [`serialize_bibliography`].
fn serialize_biblatex(
    original: &str,
    entries: &[BibEntryEditable],
) -> Result<String, BibParseError> {
    let mut bib = biblatex::Bibliography::parse(original)
        .map_err(|e| BibParseError::BibLatex(e.to_string()))?;

    // Index the edited entries by key for O(1) lookup.
    let edited_by_key: std::collections::HashMap<&str, &BibEntryEditable> =
        entries.iter().map(|e| (e.key.as_str(), e)).collect();

    // 1. Apply edits to existing entries + collect keys to know the kept set.
    //    We iterate over the bibliography's current keys (collected first to
    //    avoid borrow issues while mutating).
    let existing_keys: Vec<String> = bib.keys().map(str::to_string).collect();
    for key in &existing_keys {
        if let Some(edited) = edited_by_key.get(key.as_str()) {
            // Apply edits to the matching entry in place.
            if let Some(entry) = bib.get_mut(key) {
                apply_biblatex_edits(entry, edited);
            }
        } else {
            // In original but NOT in edited list → user deleted it.
            bib.remove(key);
        }
    }

    // 2. Add new entries (key not in original).
    for edited in entries {
        if !existing_keys.iter().any(|k| k == &edited.key) {
            let entry_type = biblatex::EntryType::new(&edited.entry_type);
            let mut entry = biblatex::Entry::new(edited.key.clone(), entry_type);
            apply_biblatex_edits(&mut entry, edited);
            bib.insert(entry);
        }
    }

    Ok(bib.to_biblatex_string())
}

/// Apply the edited core fields + `extra` to a `biblatex::Entry` in place.
///
/// Core fields use the typed setters (`set_title`, `set_author`, `set_date`).
/// `extra` uses `Entry::set(key, Chunks)` so arbitrary fields (journal, volume,
/// pages, url, …) round-trip as raw chunk strings. The 5 core field names are
/// skipped from `extra` (they can't appear there per `entry_to_editable`, but we
/// guard anyway so a hand-crafted payload can't clobber the typed core fields).
fn apply_biblatex_edits(entry: &mut biblatex::Entry, edited: &BibEntryEditable) {
    use biblatex::{Chunk, Spanned};

    // Title.
    if let Some(title) = &edited.title {
        entry.set_title(vec![Spanned::detached(Chunk::Normal(title.clone()))]);
    } else {
        entry.remove("title");
    }

    // Authors. "Given Family" is split on the last space (the natural reading
    // order produced by `entry_to_editable`). Single-token names (institutions,
    // or "Family" only) go into `name` with an empty given name.
    if edited.authors.is_empty() {
        entry.remove("author");
    } else {
        let persons: Vec<biblatex::Person> = edited
            .authors
            .iter()
            .map(|display| {
                let trimmed = display.trim();
                match trimmed.rfind(' ') {
                    Some(idx) => biblatex::Person {
                        name: trimmed[idx + 1..].to_string(),
                        given_name: trimmed[..idx].trim().to_string(),
                        prefix: String::new(),
                        suffix: String::new(),
                        id: None,
                        prefix_initials: None,
                        given_initials: None,
                        use_prefix: None,
                    },
                    None => biblatex::Person {
                        name: trimmed.to_string(),
                        given_name: String::new(),
                        prefix: String::new(),
                        suffix: String::new(),
                        id: None,
                        prefix_initials: None,
                        given_initials: None,
                        use_prefix: None,
                    },
                }
            })
            .collect();
        entry.set_author(persons);
    }

    // Year → date. `biblatex::Date` has no public year-only constructor, so we
    // set the date as a `PermissiveType::Chunks` year string. `set_date` writes
    // the `date` field AND removes legacy `year`/`month`/`day` fields, keeping
    // the entry consistent. A richer original date (e.g. 2020-05-01) is
    // overwritten with just the year — acceptable since the edit form surfaces
    // only the year as the date proxy.
    if let Some(year) = edited.year {
        let year_chunks: biblatex::Chunks =
            vec![Spanned::detached(Chunk::Normal(year.to_string()))];
        entry.set_date(biblatex::PermissiveType::Chunks(year_chunks));
    } else {
        // No year → drop any date/year fields so we don't leave stale data.
        entry.remove("date");
        entry.remove("year");
    }

    // Extra fields. Skip the 5 core names (defensive — they never appear here
    // from `entry_to_editable`, but a hand-crafted payload might include them).
    const CORE_FIELDS: &[&str] = &["title", "author", "date", "year", "type"];
    for (name, value) in &edited.extra {
        let lower = name.to_lowercase();
        if CORE_FIELDS.contains(&lower.as_str()) {
            continue;
        }
        // `journal` in the editable maps to `journaltitle` in .bib (biblatex's
        // canonical name); `journal` is an alias but we write the canonical key
        // so re-parsing yields the same field. `set` lowercases the key.
        let key = match lower.as_str() {
            "journal" => "journaltitle",
            "address" => "location",
            "school" => "institution",
            other => other,
        };
        let chunks: biblatex::Chunks = vec![Spanned::detached(Chunk::Normal(value.clone()))];
        entry.set(key, chunks);
    }
}

/// Serialize `.yml` via `hayagriva::Library` (re-parse original, apply edits to
/// clones, preserve untouched fields). See [`serialize_bibliography`].
fn serialize_yaml(
    original: &str,
    entries: &[BibEntryEditable],
) -> Result<String, BibParseError> {
    let mut library = hayagriva::io::from_yaml_str(original)
        .map_err(|e| BibParseError::Yaml(e.to_string()))?;

    let edited_by_key: std::collections::HashMap<&str, &BibEntryEditable> =
        entries.iter().map(|e| (e.key.as_str(), e)).collect();

    // 1. Remove deleted entries (in original but not in edited list).
    let original_keys: Vec<String> = library.keys().map(str::to_string).collect();
    for key in &original_keys {
        if !edited_by_key.contains_key(key.as_str()) {
            library.remove(key);
        }
    }

    // 2. Apply edits: for entries that existed, clone the original (preserving
    //    all typed fields) and overwrite only the changed core fields. For new
    //    entries, build a fresh `Entry` and set core + extra.
    for edited in entries {
        let new_entry_type = parse_entry_type(&edited.entry_type);
        if let Some(original_entry) = library.get(&edited.key).cloned() {
            // Did the entry TYPE change? `entry_type` is a private field with no
            // public setter, so a type change requires rebuilding via
            // `Entry::new` (which loses the typed non-core fields — an
            // acceptable trade-off since changing an entry's type is rare and
            // the user is re-keying the fields anyway). When the type is
            // UNCHANGED we clone-and-patch, preserving every typed field.
            let type_changed = *original_entry.entry_type() != new_entry_type;
            let mut updated = if type_changed {
                hayagriva::Entry::new(&edited.key, new_entry_type)
            } else {
                original_entry
            };
            apply_hayagriva_core_edits(&mut updated, edited);
            if type_changed {
                // A rebuild dropped the typed fields; re-apply the known extras.
                apply_hayagriva_extra(&mut updated, edited);
            }
            library.push(&updated);
        } else {
            // New entry: build fresh. Extra fields are best-effort (hayagriva's
            // typed setters can't cover every field without a fixed schema, so
            // only the well-known ones are mapped; the rest are dropped, which
            // is acceptable for a freshly-created entry).
            let mut fresh = hayagriva::Entry::new(&edited.key, new_entry_type);
            apply_hayagriva_core_edits(&mut fresh, edited);
            apply_hayagriva_extra(&mut fresh, edited);
            library.push(&fresh);
        }
    }

    hayagriva::io::to_yaml_str(&library).map_err(|e| BibParseError::YamlSerialize(e.to_string()))
}

/// Parse a kebab-case entry-type string back into a `hayagriva::types::EntryType`.
/// `EntryType` deserializes from its kebab-case name (with PascalCase aliases),
/// so we round-trip through serde. Falls back to `Misc` for unknown types
/// (matching the `entry_to_bib` fallback) rather than erroring, so an exotic
/// type string never blocks a save.
fn parse_entry_type(s: &str) -> hayagriva::types::EntryType {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .unwrap_or(hayagriva::types::EntryType::Misc)
}

/// Apply the 5 core field edits to a `hayagriva::Entry` in place. Only the
/// core fields are touched — every other typed field (journal, volume, pages,
/// parents, …) on a cloned original is preserved untouched. The `entry_type`
/// is NOT handled here (it's a private field with no setter); the caller
/// rebuilds via `Entry::new` when the type changed.
fn apply_hayagriva_core_edits(entry: &mut hayagriva::Entry, edited: &BibEntryEditable) {
    if let Some(title) = &edited.title {
        entry.set_title(hayagriva::types::FormatString::with_value(title.clone()));
    }
    // Note: there is no `clear_title`; setting is the only option. When the user
    // clears the title we can't null it through the public API, so we leave the
    // previous title. This is an acceptable limitation for the edit modal
    // (clearing a title is uncommon and the field stays editable).

    if !edited.authors.is_empty() {
        let persons: Vec<hayagriva::types::Person> = edited
            .authors
            .iter()
            .filter_map(|display| display.parse().ok())
            .collect();
        entry.set_authors(persons);
    }

    if let Some(year) = edited.year {
        entry.set_date(hayagriva::types::Date::from_year(year));
    }
}

/// Best-effort application of `extra` fields to a fresh `hayagriva::Entry`.
/// Only the well-known fields with dedicated setters are mapped; unknown names
/// are dropped (a freshly-created entry has no prior fields to lose). This is
/// intentionally conservative — hayagriva's typed setters can't cover arbitrary
/// fields without a fixed schema.
fn apply_hayagriva_extra(entry: &mut hayagriva::Entry, edited: &BibEntryEditable) {
    for (name, value) in &edited.extra {
        match name.to_lowercase().as_str() {
            "url" => {
                if let Ok(url) = value.parse() {
                    entry.set_url(hayagriva::types::QualifiedUrl::new(url, None));
                }
            }
            "publisher" => {
                if let Ok(p) = value.parse() {
                    entry.set_publisher(p);
                }
            }
            "location" => {
                if let Ok(l) = value.parse() {
                    entry.set_location(l);
                }
            }
            "organization" => {
                if let Ok(o) = value.parse() {
                    entry.set_organization(o);
                }
            }
            // `MaybeTyped` (Numeric / PageRanges) impls `FromStr` with
            // `Err = Infallible`, so these never fail — values that don't fit
            // the typed shape fall back to the `String` variant.
            "volume" => entry.set_volume(parse_infallible(value)),
            "issue" => entry.set_issue(parse_infallible(value)),
            "edition" => entry.set_edition(parse_infallible(value)),
            "pages" => entry.set_page_range(parse_infallible(value)),
            "note" => {
                if let Ok(n) = value.parse() {
                    entry.set_note(n);
                }
            }
            "abstract" => {
                if let Ok(a) = value.parse() {
                    entry.set_abstract_(a);
                }
            }
            "genre" => {
                if let Ok(g) = value.parse() {
                    entry.set_genre(g);
                }
            }
            "doi" => entry.set_doi(value.clone()),
            "isbn" => entry.set_isbn(value.clone()),
            "issn" => entry.set_issn(value.clone()),
            // journal/language/etc. would need a parent entry (Periodical) or a
            // language identifier parse; left out of the best-effort fresh path.
            _ => {}
        }
    }
}

/// Parse a value whose `FromStr` impl is infallible (`Err = Infallible`).
/// hayagriva's `MaybeTyped` numeric/page-range types always parse (falling back
/// to a `String` variant), so we collapse the unreachable error here rather than
/// repeating the `unwrap_or_else(|e| match e {})` boilerplate at each call site.
fn parse_infallible<T: std::str::FromStr<Err = std::convert::Infallible>>(s: &str) -> T {
    s.parse().unwrap_or_else(|e| match e {})
}

/// Sniff the format from a file extension, falling back to a content heuristic
/// mirroring typst-library's `bibliography.rs` decode logic. The heuristic
/// counts BibLaTeX record openings (`{`) vs. YAML mapping markers (`:` at line
/// starts / `- ` list dashes): BibLaTeX files are brace-heavy, YAML files are
/// not.
///
/// Returns `None` when the extension is unrecognized AND the content is
/// ambiguous/empty — the caller treats this as "not a bibliography file".
pub fn sniff_format(extension: &str, content: &str) -> Option<BibFormat> {
    let ext = extension.trim_start_matches('.').to_ascii_lowercase();
    match ext.as_str() {
        "bib" => Some(BibFormat::BibLatex),
        "yaml" | "yml" => Some(BibFormat::HayagrivaYaml),
        _ => sniff_from_content(content),
    }
}

/// Content-only heuristic: a BibLaTeX file has at least one `@`-record with a
/// `{`, while YAML bibliography uses a top-level `key:` mapping. This mirrors
/// typst-library's fallback (prefer BibLaTeX when brace-heavy, else YAML).
fn sniff_from_content(content: &str) -> Option<BibFormat> {
    let braces = content.matches('{').count();
    // A YAML bibliography is a map of `key: {...}`; it still contains braces
    // (one pair per entry), but BibLaTeX has many more (one per field). Use the
    // presence of an `@type{` record as a strong BibLaTeX signal; otherwise
    // default to YAML for anything map-shaped.
    let has_at_record = content.lines().any(|line| {
        let t = line.trim_start();
        t.starts_with('@') && t.contains('{')
    });
    if has_at_record && braces > 0 {
        Some(BibFormat::BibLatex)
    } else if content.contains(':') {
        Some(BibFormat::HayagrivaYaml)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two-entry BibLaTeX fixture covering the common fields we extract.

    #[test]
    #[cfg(feature = "export-types")]
    fn export_types() {
        use ts_rs::TS;
        let cfg = ts_rs::Config::default();
        BibEntry::export(&cfg).unwrap();
        BibEntryEditable::export(&cfg).unwrap();
    }

    /// Two-entry BibLaTeX fixture covering the common fields we extract.
    const BIB_FIXTURE: &str = r#"
@article{einstein1905,
  author = {Albert Einstein},
  title = {On the Electrodynamics of Moving Bodies},
  year = {1905}
}

@book{knuth1984,
  author = {Donald E. Knuth},
  title = {The TeXbook},
  year = {1984}
}
"#;

    /// Minimal Hayagriva YAML fixture (two entries).
    const YAML_FIXTURE: &str = r#"
einstein1905:
  type: Article
  title: On the Electrodynamics of Moving Bodies
  author:
    - Albert Einstein
  date: 1905
knuth1984:
  type: Book
  title: The TeXbook
  author: Donald E. Knuth
  date: 1984
"#;

    #[test]
    fn parses_biblatex_entries() {
        let entries = parse_bibliography(BIB_FIXTURE, BibFormat::BibLatex).expect("bib parses");
        assert_eq!(entries.len(), 2, "expected 2 entries, got {entries:?}");

        let einstein = entries
            .iter()
            .find(|e| e.key == "einstein1905")
            .expect("einstein1905 entry present");
        assert_eq!(einstein.entry_type, "article");
        assert_eq!(
            einstein.title.as_deref(),
            Some("On the Electrodynamics of Moving Bodies")
        );
        assert_eq!(einstein.authors, vec!["Albert Einstein".to_string()]);
        assert_eq!(einstein.year, Some(1905));

        let knuth = entries
            .iter()
            .find(|e| e.key == "knuth1984")
            .expect("knuth1984 entry present");
        assert_eq!(knuth.entry_type, "book");
        assert_eq!(knuth.year, Some(1984));
    }

    #[test]
    fn parses_hayagriva_yaml_entries() {
        let entries =
            parse_bibliography(YAML_FIXTURE, BibFormat::HayagrivaYaml).expect("yaml parses");
        assert_eq!(entries.len(), 2, "expected 2 entries, got {entries:?}");

        let einstein = entries
            .iter()
            .find(|e| e.key == "einstein1905")
            .expect("einstein1905 entry present");
        assert_eq!(einstein.entry_type, "article");
        assert_eq!(
            einstein.title.as_deref(),
            Some("On the Electrodynamics of Moving Bodies")
        );
        assert_eq!(einstein.authors, vec!["Albert Einstein".to_string()]);
        assert_eq!(einstein.year, Some(1905));
    }

    #[test]
    fn biblatex_parse_error_is_typed() {
        let bad = "@article{bad, title = {Unclosed";
        let err = parse_bibliography(bad, BibFormat::BibLatex).unwrap_err();
        assert!(matches!(err, BibParseError::BibLatex(_)), "got {err:?}");
    }

    #[test]
    fn yaml_parse_error_is_typed() {
        let bad = "this: is: not: valid: yaml: {";
        let err = parse_bibliography(bad, BibFormat::HayagrivaYaml).unwrap_err();
        assert!(matches!(err, BibParseError::Yaml(_)), "got {err:?}");
    }

    #[test]
    fn sniff_format_by_extension() {
        assert_eq!(sniff_format("bib", ""), Some(BibFormat::BibLatex));
        assert_eq!(sniff_format(".BIB", ""), Some(BibFormat::BibLatex));
        assert_eq!(sniff_format("yml", ""), Some(BibFormat::HayagrivaYaml));
        assert_eq!(sniff_format("yaml", ""), Some(BibFormat::HayagrivaYaml));
    }

    #[test]
    fn sniff_format_falls_back_to_content() {
        assert_eq!(
            sniff_format("txt", "@article{x, title={T}}"),
            Some(BibFormat::BibLatex)
        );
        assert_eq!(
            sniff_format("txt", "key:\n  type: Article"),
            Some(BibFormat::HayagrivaYaml)
        );
        assert_eq!(sniff_format("txt", "no markers here"), None);
    }

    #[test]
    fn entries_serialize_camel_case() {
        let entries = parse_bibliography(BIB_FIXTURE, BibFormat::BibLatex).unwrap();
        let json = serde_json::to_value(&entries).unwrap();
        let first = json.as_array().unwrap()[0].as_object().unwrap();
        assert!(first.contains_key("entryType"));
        assert!(first.contains_key("key"));
        assert!(first.contains_key("title"));
        assert!(first.contains_key("authors"));
        assert!(first.contains_key("year"));
    }

    // --- Full-field editable parse + serialize ------------------------------

    /// BibLaTeX fixture with rich fields (journal, volume, pages, publisher)
    /// so the field-preservation assertions below are meaningful.
    const BIB_EDITABLE_FIXTURE: &str = r#"
@article{einstein1905,
  author  = {Albert Einstein},
  title   = {On the Electrodynamics of Moving Bodies},
  year    = {1905},
  journal = {Annalen der Physik},
  volume  = {322},
  number  = {10},
  pages   = {891--921}
}

@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The TeXbook},
  year      = {1984},
  publisher = {Addison-Wesley},
  address   = {Reading, MA}
}
"#;

    /// YAML fixture with rich fields (parent journal + volume, publisher).
    const YAML_EDITABLE_FIXTURE: &str = r#"
einstein1905:
  type: Article
  title: On the Electrodynamics of Moving Bodies
  author: Albert Einstein
  date: 1905
  parent:
    type: Periodical
    title: Annalen der Physik
    volume: 322
knuth1984:
  type: Book
  title: The TeXbook
  author: Donald E. Knuth
  date: 1984
  publisher: Addison-Wesley
"#;

    /// Helper: find an editable entry by key, panicking if absent.
    fn find_editable<'a>(entries: &'a [BibEntryEditable], key: &str) -> &'a BibEntryEditable {
        entries
            .iter()
            .find(|e| e.key == key)
            .unwrap_or_else(|| panic!("entry `{key}` present in {entries:?}"))
    }

    /// Helper: get the value of an `extra` field by name.
    fn extra_value<'a>(entry: &'a BibEntryEditable, name: &str) -> Option<&'a str> {
        entry
            .extra
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn parse_editable_biblatex_extracts_extra_fields() {
        let entries = parse_bibliography_editable(BIB_EDITABLE_FIXTURE, BibFormat::BibLatex)
            .expect("bib parses");
        assert_eq!(entries.len(), 2);

        let einstein = find_editable(&entries, "einstein1905");
        assert_eq!(einstein.entry_type, "article");
        assert_eq!(
            einstein.title.as_deref(),
            Some("On the Electrodynamics of Moving Bodies")
        );
        assert_eq!(einstein.authors, vec!["Albert Einstein".to_string()]);
        assert_eq!(einstein.year, Some(1905));
        // Extra fields surface the journal/volume/pages the edit form needs.
        assert_eq!(extra_value(einstein, "journal"), Some("Annalen der Physik"));
        assert_eq!(extra_value(einstein, "volume"), Some("322"));
        // PageRanges Display joins a range with a plain hyphen (891-921).
        assert_eq!(extra_value(einstein, "pages"), Some("891-921"));

        let knuth = find_editable(&entries, "knuth1984");
        assert_eq!(extra_value(knuth, "publisher"), Some("Addison-Wesley"));
    }

    #[test]
    fn parse_editable_yaml_extracts_extra_fields() {
        let entries =
            parse_bibliography_editable(YAML_EDITABLE_FIXTURE, BibFormat::HayagrivaYaml)
                .expect("yaml parses");
        assert_eq!(entries.len(), 2);

        let einstein = find_editable(&entries, "einstein1905");
        assert_eq!(einstein.entry_type, "article");
        assert_eq!(einstein.year, Some(1905));
        // The journal lives on the parent Periodical — surfaced via parents.
        assert_eq!(extra_value(einstein, "journal"), Some("Annalen der Physik"));
        assert_eq!(extra_value(einstein, "volume"), Some("322"));

        let knuth = find_editable(&entries, "knuth1984");
        assert_eq!(extra_value(knuth, "publisher"), Some("Addison-Wesley"));
    }

    #[test]
    fn roundtrip_biblatex_preserves_core_fields() {
        // Parse → serialize → re-parse, asserting no core-field loss.
        let entries =
            parse_bibliography_editable(BIB_EDITABLE_FIXTURE, BibFormat::BibLatex).unwrap();
        let serialized =
            serialize_bibliography(BIB_EDITABLE_FIXTURE, BibFormat::BibLatex, &entries)
                .expect("serialize");
        let reparsed =
            parse_bibliography_editable(&serialized, BibFormat::BibLatex).expect("reparse");

        assert_eq!(reparsed.len(), entries.len(), "entry count must match");
        for original in &entries {
            let back = find_editable(&reparsed, &original.key);
            assert_eq!(back.entry_type, original.entry_type, "type for {}", original.key);
            assert_eq!(back.title, original.title, "title for {}", original.key);
            assert_eq!(back.authors, original.authors, "authors for {}", original.key);
            assert_eq!(back.year, original.year, "year for {}", original.key);
        }
    }

    #[test]
    fn roundtrip_yaml_preserves_core_fields() {
        let entries = parse_bibliography_editable(YAML_EDITABLE_FIXTURE, BibFormat::HayagrivaYaml)
            .unwrap();
        let serialized =
            serialize_bibliography(YAML_EDITABLE_FIXTURE, BibFormat::HayagrivaYaml, &entries)
                .expect("serialize");
        let reparsed =
            parse_bibliography_editable(&serialized, BibFormat::HayagrivaYaml).expect("reparse");

        assert_eq!(reparsed.len(), entries.len());
        for original in &entries {
            let back = find_editable(&reparsed, &original.key);
            assert_eq!(back.entry_type, original.entry_type, "type for {}", original.key);
            assert_eq!(back.title, original.title, "title for {}", original.key);
            assert_eq!(back.authors, original.authors, "authors for {}", original.key);
            assert_eq!(back.year, original.year, "year for {}", original.key);
        }
    }

    #[test]
    fn edit_biblatex_preserves_other_fields() {
        // Edit ONLY the title of one entry; journal/volume/pages must survive
        // because serialize re-parses the original and patches the single entry.
        let mut entries =
            parse_bibliography_editable(BIB_EDITABLE_FIXTURE, BibFormat::BibLatex).unwrap();
        let einstein = entries
            .iter_mut()
            .find(|e| e.key == "einstein1905")
            .expect("einstein1905");
        einstein.title = Some("A New Title".to_string());

        let serialized =
            serialize_bibliography(BIB_EDITABLE_FIXTURE, BibFormat::BibLatex, &entries).unwrap();
        let reparsed =
            parse_bibliography_editable(&serialized, BibFormat::BibLatex).expect("reparse");

        let back = find_editable(&reparsed, "einstein1905");
        assert_eq!(back.title.as_deref(), Some("A New Title"), "title was edited");
        // Untouched fields preserved (the fidelity contract).
        assert_eq!(extra_value(back, "journal"), Some("Annalen der Physik"));
        assert_eq!(extra_value(back, "volume"), Some("322"));
        assert_eq!(extra_value(back, "pages"), Some("891-921"));
        assert_eq!(back.year, Some(1905));
        assert_eq!(back.authors, vec!["Albert Einstein".to_string()]);
    }

    #[test]
    fn edit_yaml_preserves_other_fields() {
        let mut entries =
            parse_bibliography_editable(YAML_EDITABLE_FIXTURE, BibFormat::HayagrivaYaml).unwrap();
        let einstein = entries
            .iter_mut()
            .find(|e| e.key == "einstein1905")
            .expect("einstein1905");
        einstein.title = Some("A New Title".to_string());

        let serialized =
            serialize_bibliography(YAML_EDITABLE_FIXTURE, BibFormat::HayagrivaYaml, &entries)
                .unwrap();
        let reparsed =
            parse_bibliography_editable(&serialized, BibFormat::HayagrivaYaml).expect("reparse");

        let back = find_editable(&reparsed, "einstein1905");
        assert_eq!(back.title.as_deref(), Some("A New Title"));
        // The parent journal/volume survive (cloned from the original).
        assert_eq!(extra_value(back, "journal"), Some("Annalen der Physik"));
        assert_eq!(extra_value(back, "volume"), Some("322"));
        assert_eq!(back.year, Some(1905));
    }

    #[test]
    fn add_entry_biblatex() {
        let mut entries =
            parse_bibliography_editable(BIB_EDITABLE_FIXTURE, BibFormat::BibLatex).unwrap();
        entries.push(BibEntryEditable {
            key: "new2024".to_string(),
            entry_type: "misc".to_string(),
            title: Some("A Fresh Entry".to_string()),
            authors: vec!["Jane Doe".to_string()],
            year: Some(2024),
            extra: vec![("note".to_string(), "added by test".to_string())],
        });

        let serialized =
            serialize_bibliography(BIB_EDITABLE_FIXTURE, BibFormat::BibLatex, &entries).unwrap();
        let reparsed =
            parse_bibliography_editable(&serialized, BibFormat::BibLatex).expect("reparse");

        assert_eq!(reparsed.len(), 3, "new entry added");
        let new = find_editable(&reparsed, "new2024");
        assert_eq!(new.entry_type, "misc");
        assert_eq!(new.title.as_deref(), Some("A Fresh Entry"));
        assert_eq!(new.authors, vec!["Jane Doe".to_string()]);
        assert_eq!(new.year, Some(2024));
        assert_eq!(extra_value(new, "note"), Some("added by test"));
    }

    #[test]
    fn delete_entry_biblatex() {
        let entries: Vec<BibEntryEditable> =
            parse_bibliography_editable(BIB_EDITABLE_FIXTURE, BibFormat::BibLatex)
                .unwrap()
                .into_iter()
                .filter(|e| e.key != "knuth1984")
                .collect();
        assert_eq!(entries.len(), 1);

        let serialized =
            serialize_bibliography(BIB_EDITABLE_FIXTURE, BibFormat::BibLatex, &entries).unwrap();
        let reparsed =
            parse_bibliography_editable(&serialized, BibFormat::BibLatex).expect("reparse");

        assert_eq!(reparsed.len(), 1, "entry deleted");
        assert!(reparsed.iter().all(|e| e.key != "knuth1984"));
        // The kept entry is untouched.
        let einstein = find_editable(&reparsed, "einstein1905");
        assert_eq!(extra_value(einstein, "journal"), Some("Annalen der Physik"));
    }

    #[test]
    fn add_entry_yaml() {
        let mut entries =
            parse_bibliography_editable(YAML_EDITABLE_FIXTURE, BibFormat::HayagrivaYaml).unwrap();
        entries.push(BibEntryEditable {
            key: "new2024".to_string(),
            entry_type: "misc".to_string(),
            title: Some("A Fresh Entry".to_string()),
            authors: vec!["Jane Doe".to_string()],
            year: Some(2024),
            extra: Vec::new(),
        });

        let serialized =
            serialize_bibliography(YAML_EDITABLE_FIXTURE, BibFormat::HayagrivaYaml, &entries)
                .unwrap();
        let reparsed =
            parse_bibliography_editable(&serialized, BibFormat::HayagrivaYaml).expect("reparse");

        assert_eq!(reparsed.len(), 3, "new entry added");
        let new = find_editable(&reparsed, "new2024");
        assert_eq!(new.entry_type, "misc");
        assert_eq!(new.title.as_deref(), Some("A Fresh Entry"));
        assert_eq!(new.authors, vec!["Jane Doe".to_string()]);
        assert_eq!(new.year, Some(2024));
    }
}
