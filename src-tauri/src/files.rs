// Dropped files are copied into %LOCALAPPDATA%\Coucou\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// The shelf is meant to be worked from, so it keeps things longer than the inbox.
const SHELF_KEEP_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    storage_root().join("inbox")
}

pub fn shelf_dir() -> PathBuf {
    storage_root().join("shelf")
}

/// Where the inbox and the shelf live.
///
/// A test overrides this so the suite never writes into the real
/// %LOCALAPPDATA%\Coucou — three tests sharing one directory clobbered each
/// other (two of them call `clear_shelf`), which showed up as a test that passed
/// alone and failed in the module run.
fn storage_root() -> PathBuf {
    #[cfg(test)]
    {
        static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        ROOT.get_or_init(|| {
            std::env::temp_dir().join(format!("coucou-storage-{}", std::process::id()))
        })
        .clone()
    }
    #[cfg(not(test))]
    {
        crate::settings::local_dir()
    }
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    ingest_into(&inbox_dir(), source)
}

fn ingest_into(dir: &Path, source: &str) -> Result<DroppedFile, String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("cannot read {source}: {e}"))?;
    if meta.is_dir() {
        return Err("Folders can't be dropped yet.".into());
    }

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let mut dest = dir.join(&name);
    if dest.exists() {
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        // Unbounded, and a hard error if a name is somehow still taken: the
        // bounded loop used to fall out of the range having assigned nothing,
        // leaving `dest` on the file that already existed — so the 999th drop of
        // the same name silently overwrote the first.
        let mut i = 2;
        while dest.exists() {
            dest = dir.join(format!("{stem} ({i}){ext}"));
            i += 1;
        }
    }

    std::fs::copy(src, &dest).map_err(|e| format!("cannot copy: {e}"))?;
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(dir, KEEP_FOR);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

// ── File shelf ─────────────────────────────────────────────────────────────────

/// A file the user parked on the shelf. Unlike the inbox these are meant to be
/// dragged back out into another app, so each one keeps the name, the extension
/// and a real path on disk.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShelfItem {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// Unix seconds, when it was added.
    pub at: u64,
    /// True once the copy behind it has gone (swept, or deleted by hand).
    pub missing: bool,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Copies a file into the shelf. The original is never touched, so the item
/// outlives whatever it was dragged from — including a temp file or a download
/// folder the user cleans up an hour later.
pub fn add_to_shelf(source: &str) -> Result<ShelfItem, String> {
    shelve_into(&shelf_dir(), source)
}

fn shelve_into(dir: &Path, source: &str) -> Result<ShelfItem, String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("cannot read {source}: {e}"))?;
    if meta.is_dir() {
        return Err("Folders can't be shelved yet.".into());
    }

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    // Same no-clobber rule as the inbox, for the same reason: two files with one
    // name must both survive.
    let mut dest = dir.join(&name);
    if dest.exists() {
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = src.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
        let mut i = 2;
        while dest.exists() {
            dest = dir.join(format!("{stem} ({i}){ext}"));
            i += 1;
        }
    }

    std::fs::copy(src, &dest).map_err(|e| format!("cannot copy: {e}"))?;
    // Same reason as `ingest`: CopyFileEx carries the source's timestamps, so an
    // old file would arrive already past the sweep window.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(dir, SHELF_KEEP_FOR);

    Ok(ShelfItem {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
        at: now_secs(),
        missing: false,
    })
}

/// The shelf, newest first. The shelf is a flat directory, so the order comes from
/// the copy time `add_to_shelf` stamps rather than from any bookkeeping file.
pub fn list_shelf() -> Vec<ShelfItem> {
    list_shelf_in(&shelf_dir())
}

fn list_shelf_in(dir: &Path) -> Vec<ShelfItem> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    sweep(dir, SHELF_KEEP_FOR);

    let mut items: Vec<ShelfItem> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let at = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Some(ShelfItem {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                size: meta.len(),
                at,
                missing: false,
            })
        })
        .collect();
    items.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.name.cmp(&b.name)));
    items
}

pub fn remove_from_shelf(path: &str) -> Result<(), String> {
    remove_shelf_file(&shelf_dir(), path)
}

fn remove_shelf_file(dir: &Path, path: &str) -> Result<(), String> {
    let target = Path::new(path);
    // Only ever delete inside the shelf: the path comes from the front end, and a
    // bug there must not be able to delete something else.
    if target.parent() != Some(dir) {
        return Err("that file is not on the shelf".into());
    }
    std::fs::remove_file(target).map_err(|e| e.to_string())
}

pub fn clear_shelf() {
    clear_shelf_in(&shelf_dir());
}

fn clear_shelf_in(dir: &Path) {
    for item in list_shelf_in(dir) {
        let _ = std::fs::remove_file(&item.path);
    }
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path, keep_for: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > keep_for).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A source file plus its own destination directory, so tests never share one
    /// and never touch the real inbox or shelf.
    fn sandbox(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("coucou-file-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src_dir = base.join("src");
        let dest_dir = base.join("dest");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        (src_dir, dest_dir)
    }

    /// Removes the sandbox. Every one of these tests writes real files, and
    /// leaving them in %TEMP% on each run is its own kind of mess.
    fn cleanup(base: &Path) {
        if let Some(root) = base.parent() {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let (tmp, dest) = sandbox("ingest");
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let first = ingest_into(&dest, source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        let second = ingest_into(&dest, source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Far past the old 2..1000 loop: the bounded loop used to run out of
        // names without assigning one, leaving `dest` on an existing file and
        // overwriting it. This drops the same name 1_200 times.
        let mut paths = vec![first.path.clone(), second.path.clone()];
        for round in 0..1_200 {
            std::fs::write(&source, format!("drop {round}")).unwrap();
            paths.push(ingest_into(&dest, source.to_str().unwrap()).unwrap().path);
        }
        let mut unique = paths.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), paths.len(), "a drop overwrote an earlier one");
        // The very first copy is still intact after all of that.
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // Folders are refused rather than silently ignored.
        assert!(ingest_into(&dest, tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let aged = ingest_into(&dest, old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        cleanup(&tmp);
    }

    #[test]
    fn the_shelf_copies_keeps_both_and_lists_newest_first() {
        let (tmp, shelf) = sandbox("shelf");

        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let first = shelve_into(&shelf, source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert!(!first.missing);

        // Same name again: the shelf must keep both, like the inbox does.
        std::fs::write(&source, b"second").unwrap();
        let second = shelve_into(&shelf, source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        let listed = list_shelf_in(&shelf);
        assert!(listed.iter().any(|i| i.path == first.path));
        assert!(listed.iter().any(|i| i.path == second.path));
        // Newest first.
        assert!(listed[0].at >= listed[listed.len() - 1].at);

        // Folders are refused rather than silently ignored.
        assert!(shelve_into(&shelf, tmp.to_str().unwrap()).is_err());

        clear_shelf_in(&shelf);
        assert!(list_shelf_in(&shelf).is_empty());
        cleanup(&tmp);
    }

    #[test]
    fn removing_from_the_shelf_refuses_a_path_outside_it() {
        // The path arrives from the front end, so a bug there must not be able to
        // delete an arbitrary file.
        let (tmp, shelf) = sandbox("refuse");
        let outside = std::env::temp_dir().join("coucou-should-never-be-deleted.txt");
        std::fs::write(&outside, b"keep me").unwrap();
        assert!(remove_shelf_file(&shelf, outside.to_str().unwrap()).is_err());
        assert!(outside.exists(), "a path outside the shelf was deleted");
        let _ = std::fs::remove_file(&outside);
        cleanup(&tmp);
    }

    #[test]
    fn an_ancient_source_arrives_in_the_shelf_as_new() {
        let (tmp, shelf) = sandbox("ancient");
        let old_source = tmp.join("ancient.bin");
        std::fs::write(&old_source, b"old").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(SystemTime::now() - SHELF_KEEP_FOR - Duration::from_secs(3600))
            .unwrap();

        let item = shelve_into(&shelf, old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&item.path).exists(),
            "a file copied just now was swept as if it were a month old"
        );
        clear_shelf_in(&shelf);
        cleanup(&tmp);
    }
}
