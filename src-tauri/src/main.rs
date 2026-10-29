// Notepad - a plain-files note pad.
//
// Every note is a real .md or .txt file in one folder. Rust owns the folder:
// it reads every note into memory once at startup (so search is instant),
// writes atomically on autosave, moves deletes into .trash, and watches the
// folder so edits made in another editor show up here.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const TRASH: &str = ".trash";
const EXTS: [&str; 3] = ["md", "txt", "markdown"];

// ---------------------------------------------------------------- model

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Note {
    /// Path relative to the root folder, e.g. "shopping.md" or ".trash/old.md".
    id: String,
    /// File stem, shown as the title.
    name: String,
    ext: String,
    body: String,
    /// Milliseconds since the epoch.
    updated: u64,
    created: u64,
    trashed: bool,
}

#[derive(Serialize)]
struct Loaded {
    root: String,
    notes: Vec<Note>,
    prefs: Prefs,
}

/// What the window remembers between runs. It lives in settings.json beside
/// the app's config, not in webview storage, so clearing a cache or moving the
/// notes folder never loses it.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Prefs {
    theme: String,
    side: String,
    open: Vec<String>,
    last: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme: "auto".into(),
            side: "hidden".into(),   // the pad is the main thing
            open: Vec::new(),
            last: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Settings {
    root: Option<String>,
    prefs: Prefs,
}

struct App {
    root: RwLock<PathBuf>,
    notes: RwLock<HashMap<String, Note>>,
    /// Paths we wrote ourselves, so the watcher can ignore the echo.
    ours: Mutex<HashMap<String, Instant>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    prefs: RwLock<Prefs>,
    config: PathBuf,
}

type R<T> = Result<T, String>;

fn why(what: &str, e: impl std::fmt::Display) -> String {
    format!("Couldn't {what}. {e}")
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now() -> u64 {
    ms(SystemTime::now())
}

// ---------------------------------------------------------------- names

/// Strip what Windows and sanity disallow, and keep it to one line.
fn clean(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    s = s.trim().trim_matches('.').trim().to_string();
    if s.len() > 120 {
        s.truncate(120);
        s = s.trim().to_string();
    }
    if s.is_empty() {
        s = "Untitled".into();
    }
    // Names Windows reserves whatever the extension.
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&s)) {
        s.push('_');
    }
    s
}

/// A name no existing note is using. `keep` is the id allowed to collide
/// (itself), so renaming a note to its own name is not a conflict.
fn unique(app: &App, dir: &str, name: &str, ext: &str, keep: Option<&str>) -> String {
    let notes = app.notes.read().unwrap();
    let taken = |n: &str| -> bool {
        let id = join(dir, &format!("{n}.{ext}"));
        notes
            .keys()
            .any(|k| k.eq_ignore_ascii_case(&id) && keep != Some(k.as_str()))
    };
    if !taken(name) {
        return name.to_string();
    }
    for i in 2..10_000 {
        let candidate = format!("{name} {i}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("{name} {}", now())
}

fn join(dir: &str, file: &str) -> String {
    if dir.is_empty() {
        file.to_string()
    } else {
        format!("{dir}/{file}")
    }
}

fn split(id: &str) -> (String, String) {
    match id.rsplit_once('/') {
        Some((d, f)) => (d.to_string(), f.to_string()),
        None => (String::new(), id.to_string()),
    }
}

/// Resolve a note id to a real path, refusing anything that escapes the root.
fn resolve(root: &Path, id: &str) -> R<PathBuf> {
    if id.is_empty() || id.contains("..") || id.contains('\\') || Path::new(id).is_absolute() {
        return Err("That note name isn't allowed.".into());
    }
    let (dir, file) = split(id);
    if !dir.is_empty() && dir != TRASH {
        return Err("That note name isn't allowed.".into());
    }
    let p = root.join(&dir).join(&file);
    match p.extension().and_then(|e| e.to_str()) {
        Some(e) if EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)) => Ok(p),
        _ => Err("Notes are .md or .txt files.".into()),
    }
}

// ---------------------------------------------------------------- disk

fn note_from(path: &Path, root: &Path) -> Option<Note> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if !EXTS.contains(&ext.as_str()) {
        return None;
    }
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let body = fs::read(path).ok()?;
    // Lossy is deliberate: a note that was saved in some other encoding should
    // still open, rather than vanish from the list.
    // Editors on Windows leave a BOM and CRLF behind; neither belongs in the
    // text the editor or the Markdown parser sees.
    let body = String::from_utf8_lossy(&body).replace("\r\n", "\n");
    let body = body.strip_prefix('\u{feff}').unwrap_or(&body).to_string();
    let name = path.file_stem()?.to_string_lossy().to_string();
    let trashed = path.parent().map(|p| p.ends_with(TRASH)).unwrap_or(false);
    let rel = if trashed {
        join(TRASH, &path.file_name()?.to_string_lossy())
    } else {
        path.file_name()?.to_string_lossy().to_string()
    };
    let _ = root;
    let updated = meta.modified().map(ms).unwrap_or_else(|_| now());
    Some(Note {
        id: rel,
        name,
        ext: if ext == "markdown" { "md".into() } else { ext },
        body,
        updated,
        created: meta.created().map(ms).unwrap_or(updated),
        trashed,
    })
}

fn scan(root: &Path) -> HashMap<String, Note> {
    let mut out = HashMap::new();
    for dir in [root.to_path_buf(), root.join(TRASH)] {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            if let Some(n) = note_from(&e.path(), root) {
                out.insert(n.id.clone(), n);
            }
        }
    }
    out
}

/// Write via a temp file in the same folder, then rename over the target, so a
/// crash mid-save can never leave half a note.
fn write_atomic(path: &Path, body: &str) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp{}",
        path.extension().and_then(|e| e.to_str()).unwrap_or("md"),
        std::process::id()
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

impl App {
    fn root(&self) -> PathBuf {
        self.root.read().unwrap().clone()
    }

    fn mine(&self, id: &str) {
        self.ours
            .lock()
            .unwrap()
            .insert(id.to_ascii_lowercase(), Instant::now());
    }

    fn was_mine(&self, id: &str) -> bool {
        let mut ours = self.ours.lock().unwrap();
        ours.retain(|_, t| t.elapsed() < Duration::from_secs(5));
        ours.get(&id.to_ascii_lowercase())
            .map(|t| t.elapsed() < Duration::from_millis(1500))
            .unwrap_or(false)
    }

    fn save_settings(&self) {
        let s = Settings {
            root: Some(self.root().to_string_lossy().to_string()),
            prefs: self.prefs.read().unwrap().clone(),
        };
        if let Some(parent) = self.config.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&s) {
            let _ = fs::write(&self.config, json);
        }
    }
}

// ---------------------------------------------------------------- watching

fn watch(app: AppHandle) -> R<()> {
    let state = app.state::<App>();
    let root = state.root();
    let handle = app.clone();

    let pending: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let st = handle.state::<App>();
        let root = st.root();
        let touched: Vec<String> = event
            .paths
            .iter()
            .filter_map(|p| {
                let rel = p.strip_prefix(&root).ok()?;
                let rel = rel.to_string_lossy().replace('\\', "/");
                let ext = Path::new(&rel).extension()?.to_str()?.to_ascii_lowercase();
                EXTS.contains(&ext.as_str()).then_some(rel)
            })
            .collect();
        if touched.is_empty() || touched.iter().all(|id| st.was_mine(id)) {
            return;
        }
        // Coalesce: editors write in bursts, and we only ever re-scan the lot.
        let mut queued = pending.lock().unwrap();
        if *queued {
            return;
        }
        *queued = true;
        drop(queued);
        let handle2 = handle.clone();
        let pending2 = pending.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            *pending2.lock().unwrap() = false;
            let st = handle2.state::<App>();
            let fresh = scan(&st.root());
            let mut list: Vec<Note> = fresh.values().cloned().collect();
            list.sort_by(|a, b| b.updated.cmp(&a.updated));
            *st.notes.write().unwrap() = fresh;
            let _ = handle2.emit("notes:changed", list);
        });
    })
    .map_err(|e| why("watch the notes folder", e))?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| why("watch the notes folder", e))?;
    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(())
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn load(state: State<App>) -> Loaded {
    let root = state.root();
    let _ = fs::create_dir_all(&root);
    let found = scan(&root);
    let mut notes: Vec<Note> = found.values().cloned().collect();
    notes.sort_by(|a, b| b.updated.cmp(&a.updated));
    *state.notes.write().unwrap() = found;
    Loaded {
        root: root.to_string_lossy().to_string(),
        notes,
        prefs: state.prefs.read().unwrap().clone(),
    }
}

#[tauri::command]
fn save_prefs(state: State<App>, prefs: Prefs) {
    *state.prefs.write().unwrap() = prefs;
    state.save_settings();
}

/// Open a link in the real browser, never inside this window.
#[tauri::command]
fn open_url(url: String) -> R<()> {
    let ok = (url.starts_with("http://") || url.starts_with("https://"))
        && url.len() < 2048
        && !url.chars().any(|c| c.is_control());
    if !ok {
        return Err("That link isn't a web address.".into());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // rundll32 takes the URL as data, so nothing in it can be read as a flag.
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler").arg(&url);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg("--").arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map_err(|e| why("open that link", e))?;
    Ok(())
}

#[tauri::command]
fn save(state: State<App>, id: String, body: String) -> R<u64> {
    let root = state.root();
    let path = resolve(&root, &id)?;
    state.mine(&id);
    write_atomic(&path, &body).map_err(|e| why("save the note", e))?;
    let updated = now();
    if let Some(n) = state.notes.write().unwrap().get_mut(&id) {
        n.body = body;
        n.updated = updated;
    }
    Ok(updated)
}

#[tauri::command]
fn create(state: State<App>, name: String, ext: String, body: String) -> R<Note> {
    let root = state.root();
    let ext = if ext == "txt" { "txt" } else { "md" };
    let name = unique(&state, "", &clean(&name), ext, None);
    let id = format!("{name}.{ext}");
    let path = resolve(&root, &id)?;
    state.mine(&id);
    write_atomic(&path, &body).map_err(|e| why("create the note", e))?;
    let n = Note {
        id: id.clone(),
        name,
        ext: ext.into(),
        body,
        updated: now(),
        created: now(),
        trashed: false,
    };
    state.notes.write().unwrap().insert(id, n.clone());
    Ok(n)
}

/// Rename and / or change the extension. Returns the note under its new id.
#[tauri::command]
fn rename(state: State<App>, id: String, name: String, ext: String) -> R<Note> {
    let root = state.root();
    let from = resolve(&root, &id)?;
    let mut note = state
        .notes
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("That note is no longer there.")?;
    let (dir, _) = split(&id);
    let ext = if ext == "txt" { "txt" } else { "md" };
    let name = unique(&state, &dir, &clean(&name), ext, Some(&id));
    let new_id = join(&dir, &format!("{name}.{ext}"));
    if new_id == id {
        return Ok(note);
    }
    let to = resolve(&root, &new_id)?;
    state.mine(&id);
    state.mine(&new_id);
    fs::rename(&from, &to).map_err(|e| why("rename the note", e))?;
    let mut notes = state.notes.write().unwrap();
    notes.remove(&id);
    note.id = new_id.clone();
    note.name = name;
    note.ext = ext.into();
    note.updated = now();
    notes.insert(new_id, note.clone());
    Ok(note)
}

fn move_between(state: &State<App>, id: &str, to_trash: bool) -> R<Note> {
    let root = state.root();
    let from = resolve(&root, id)?;
    let mut note = state
        .notes
        .read()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or("That note is no longer there.")?;
    let dir = if to_trash { TRASH } else { "" };
    if to_trash {
        fs::create_dir_all(root.join(TRASH)).map_err(|e| why("open the trash folder", e))?;
    }
    let name = unique(state, dir, &note.name, &note.ext, None);
    let new_id = join(dir, &format!("{name}.{}", note.ext));
    let to = resolve(&root, &new_id)?;
    state.mine(id);
    state.mine(&new_id);
    fs::rename(&from, &to).map_err(|e| {
        why(
            if to_trash {
                "move the note to trash"
            } else {
                "restore the note"
            },
            e,
        )
    })?;
    let mut notes = state.notes.write().unwrap();
    notes.remove(id);
    note.id = new_id.clone();
    note.name = name;
    note.trashed = to_trash;
    note.updated = now();
    notes.insert(new_id, note.clone());
    Ok(note)
}

#[tauri::command]
fn trash(state: State<App>, id: String) -> R<Note> {
    move_between(&state, &id, true)
}

#[tauri::command]
fn restore(state: State<App>, id: String) -> R<Note> {
    move_between(&state, &id, false)
}

#[tauri::command]
fn delete_forever(state: State<App>, id: String) -> R<()> {
    let root = state.root();
    let path = resolve(&root, &id)?;
    state.mine(&id);
    fs::remove_file(&path).map_err(|e| why("delete the note", e))?;
    state.notes.write().unwrap().remove(&id);
    Ok(())
}

#[tauri::command]
fn empty_trash(state: State<App>) -> R<usize> {
    let root = state.root();
    let ids: Vec<String> = state
        .notes
        .read()
        .unwrap()
        .values()
        .filter(|n| n.trashed)
        .map(|n| n.id.clone())
        .collect();
    let mut gone = 0;
    for id in ids {
        if let Ok(p) = resolve(&root, &id) {
            state.mine(&id);
            if fs::remove_file(p).is_ok() {
                state.notes.write().unwrap().remove(&id);
                gone += 1;
            }
        }
    }
    Ok(gone)
}

/// Copy dropped or picked files into the notes folder.
#[tauri::command]
fn import(state: State<App>, paths: Vec<String>) -> R<Vec<Note>> {
    let root = state.root();
    let mut made = Vec::new();
    for p in paths {
        let src = PathBuf::from(&p);
        let Some(ext) = src.extension().and_then(|e| e.to_str()) else { continue };
        let ext = ext.to_ascii_lowercase();
        if !EXTS.contains(&ext.as_str()) {
            continue;
        }
        let ext = if ext == "markdown" { "md" } else { &ext };
        let Ok(bytes) = fs::read(&src) else { continue };
        let body = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
        let body = body.strip_prefix('\u{feff}').unwrap_or(&body).to_string();
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Imported".into());
        let name = unique(&state, "", &clean(&stem), ext, None);
        let id = format!("{name}.{ext}");
        let dest = resolve(&root, &id)?;
        state.mine(&id);
        if write_atomic(&dest, &body).is_err() {
            continue;
        }
        let n = Note {
            id: id.clone(),
            name,
            ext: ext.to_string(),
            body,
            updated: now(),
            created: now(),
            trashed: false,
        };
        state.notes.write().unwrap().insert(id, n.clone());
        made.push(n);
    }
    Ok(made)
}

#[tauri::command]
fn set_root(app: AppHandle, state: State<App>, path: String) -> R<Loaded> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("That folder isn't there.".into());
    }
    fs::create_dir_all(&p).map_err(|e| why("open that folder", e))?;
    *state.root.write().unwrap() = p;
    state.save_settings();
    *state.watcher.lock().unwrap() = None;
    let loaded = load(state);
    let _ = watch(app);
    Ok(loaded)
}

/// Show a note, or the folder itself, in the file manager.
#[tauri::command]
fn reveal(state: State<App>, id: Option<String>) -> R<()> {
    let root = state.root();
    let target = match id {
        Some(id) => resolve(&root, &id)?,
        None => root.clone(),
    };
    #[cfg(target_os = "windows")]
    {
        let arg = if target.is_dir() {
            target.to_string_lossy().to_string()
        } else {
            format!("/select,{}", target.to_string_lossy())
        };
        std::process::Command::new("explorer")
            .arg(arg)
            .spawn()
            .map_err(|e| why("open the folder", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("open");
        if !target.is_dir() {
            c.arg("-R");
        }
        c.arg(target.as_os_str())
            .spawn()
            .map_err(|e| why("open the folder", e))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if target.is_dir() {
            target.clone()
        } else {
            target.parent().unwrap_or(&root).to_path_buf()
        };
        std::process::Command::new("xdg-open")
            .arg(dir.as_os_str())
            .spawn()
            .map_err(|e| why("open the folder", e))?;
    }
    Ok(())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(label: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("notepad-test-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn clean_strips_what_windows_refuses() {
        assert_eq!(clean("a/b:c*d?e\"f<g>h|i"), "a-b-c-d-e-f-g-h-i");
        assert_eq!(clean("  spaced  "), "spaced");
        assert_eq!(clean("..."), "Untitled");
        assert_eq!(clean(""), "Untitled");
        assert_eq!(clean("con"), "con_");
        assert_eq!(clean("COM1"), "COM1_");
        assert_eq!(clean(&"x".repeat(400)).chars().count(), 120);
    }

    #[test]
    fn resolve_refuses_to_leave_the_folder() {
        let root = Path::new("C:/notes");
        assert!(resolve(root, "fine.md").is_ok());
        assert!(resolve(root, ".trash/fine.md").is_ok());
        assert!(resolve(root, "../escape.md").is_err());
        assert!(resolve(root, "sub/../../escape.md").is_err());
        assert!(resolve(root, "C:/windows/system32/evil.md").is_err());
        assert!(resolve(root, "deep/dir/note.md").is_err());
        assert!(resolve(root, "note.exe").is_err());
        assert!(resolve(root, "").is_err());
    }

    #[test]
    fn reading_drops_the_bom_and_crlf() {
        let dir = tmp("bom");
        let path = dir.join("note.md");
        fs::write(&path, b"\xEF\xBB\xBF# Title\r\nbody\r\n").unwrap();
        let n = note_from(&path, &dir).expect("should read");
        assert_eq!(n.body, "# Title\nbody\n");
        assert_eq!(n.name, "note");
        assert_eq!(n.ext, "md");
        assert!(!n.trashed);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_finds_notes_and_the_trash_but_nothing_else() {
        let dir = tmp("scan");
        fs::create_dir_all(dir.join(TRASH)).unwrap();
        fs::write(dir.join("one.md"), "a").unwrap();
        fs::write(dir.join("two.txt"), "b").unwrap();
        fs::write(dir.join("notes.pdf"), "c").unwrap();
        fs::write(dir.join(TRASH).join("old.md"), "d").unwrap();
        let found = scan(&dir);
        assert_eq!(found.len(), 3);
        assert!(found.contains_key("one.md"));
        assert!(found.contains_key("two.txt"));
        assert!(!found.contains_key("notes.pdf"));
        assert!(found[".trash/old.md"].trashed);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_url_takes_web_addresses_only() {
        for bad in [
            "file:///C:/Windows/System32/calc.exe",
            "C:\\Windows\\System32\\calc.exe",
            "javascript:alert(1)",
            "ht tp://example.com",
            "",
            "https://example.com/\u{0}evil",
            "https://example.com/a\nb",
        ] {
            assert!(open_url(bad.into()).is_err(), "should refuse {bad:?}");
        }
        // The long-URL guard, checked without spawning a browser.
        let long = format!("https://example.com/{}", "a".repeat(2100));
        assert!(open_url(long).is_err());
    }

    #[test]
    fn writing_is_atomic_and_leaves_no_temp_behind() {
        let dir = tmp("atomic");
        let path = dir.join("note.md");
        write_atomic(&path, "first").unwrap();
        write_atomic(&path, "second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        let stray: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("tmp"))
            .collect();
        assert!(stray.is_empty(), "left temp files behind: {stray:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}

// ---------------------------------------------------------------- start

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("settings.json");

            let settings: Settings = fs::read_to_string(&config)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let saved = settings
                .root
                .clone()
                .map(PathBuf::from)
                .filter(|p| p.is_dir());

            let root = saved.unwrap_or_else(|| {
                app.path()
                    .document_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join("Notepad")
            });
            let _ = fs::create_dir_all(&root);

            app.manage(App {
                root: RwLock::new(root),
                notes: RwLock::new(HashMap::new()),
                ours: Mutex::new(HashMap::new()),
                watcher: Mutex::new(None),
                prefs: RwLock::new(settings.prefs),
                config,
            });
            app.state::<App>().save_settings();
            let _ = watch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load,
            save,
            create,
            rename,
            trash,
            restore,
            delete_forever,
            empty_trash,
            import,
            set_root,
            reveal,
            save_prefs,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("Notepad couldn't start.");
}
