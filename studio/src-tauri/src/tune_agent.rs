// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present Ainfera Inc. See /studio/LICENSE.AGPL-3.0.

//! Tune Agent — desktop-host IPC bridge.
//!
//! Tune Agent lives in a separate repository (studiotune-ai/tune-agent). This
//! module owns the wire protocol the StudioTune Desktop shell uses to talk to
//! it locally, and the admit-runtime policy the desktop enforces on the
//! machine before any Agent-mode work is allowed to run.
//!
//! Contract, deliberately narrow:
//!
//!  * The Rust host spawns Tune Agent as a sidecar process at a caller-
//!    supplied absolute path (`~/.studiotune/tune-agent` by default). It never
//!    downloads Tune Agent, never resolves it through `$PATH`, and never
//!    fetches from Hub.
//!  * Communication is newline-delimited JSON over the sidecar's stdin /
//!    stdout. Each request carries an `id` and a `method`. Each reply carries
//!    the same `id` and either `ok: true, result: {...}` or `ok: false,
//!    error: "..."`. Unknown methods MUST fail-closed on the sidecar; unknown
//!    replies are dropped by the host.
//!  * The bridge is single-instance per app lifetime. A second call to
//!    `tune_agent_start` returns the existing bridge status rather than
//!    respawning.
//!  * Every Agent-mode invocation MUST run
//!    `tune_agent_admit_runtime` first. Admission checks that the python
//!    binary is a **regular file** (not a symlink) at the exact expected
//!    absolute path, that the MLX snapshot directory is one of the
//!    explicitly allow-listed paths, and that no Hugging Face Hub id ever
//!    reaches launch args. `HF_HUB_OFFLINE=1` is written into the sidecar's
//!    environment so a bug that later reaches for Hub returns a 404 instead
//!    of touching the network.
//!
//! This module compiles on every OS but the launch path only makes sense on
//! macOS (MLX is Apple Silicon). Non-macOS callers get a policy-refuse from
//! admission with a clear reason, so the bridge fail-closes rather than
//! spawning nonsense.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The methods the desktop host will send to Tune Agent. Kept as a small,
/// stable enum so a driveby that adds a fifth mode has to touch the guard
/// tests too. Exposed via `pub(crate)` and locked by a unit test rather
/// than referenced elsewhere yet — the follow-up hop that lands
/// `tune_agent_request_plan` on the Rust side is what will consume it.
#[allow(dead_code)]
pub(crate) const TUNE_AGENT_METHODS: &[&str] = &[
    "ping",
    "set_mode",
    "request_plan",
    "grant",
    "train",
    "shutdown",
];

/// Fixed absolute path the admit policy accepts for the host python binary
/// on macOS. The regular framework build, never the symlink `python3` shim
/// beside it — see `admit_python_is_regular_file` below.
pub(crate) const ADMITTED_HOST_PYTHON: &str =
    "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13";

/// Allow-list of MLX snapshot directories the admit policy accepts. Passing
/// anything else — including a Hub id — returns AdmitError. Kept as a fixed
/// list rather than a prefix match so a follow-up that adds a second model
/// has to be an explicit code change reviewed on its own.
pub(crate) const ADMITTED_MLX_SNAPSHOTS: &[&str] = &[
    "~/.cache/huggingface/hub/models--mlx-community--Qwen2.5-0.5B-Instruct-4bit/snapshots/a5339a4131f135d0fdc6a5c8b5bbed2753bbe0f3",
];

/// Environment variable the sidecar sees at launch. Prevents `huggingface_hub`
/// or `datasets` from reaching for the network if some later code path
/// accidentally asks it to. Also part of the admit receipt.
pub(crate) const HF_HUB_OFFLINE_KEY: &str = "HF_HUB_OFFLINE";
pub(crate) const HF_HUB_OFFLINE_VALUE: &str = "1";

/// State the Tauri app manages for the bridge.
#[derive(Default)]
pub(crate) struct TuneAgentState {
    inner: Mutex<TuneAgentInner>,
}

pub(crate) fn new_tune_agent_state() -> TuneAgentState {
    TuneAgentState::default()
}

#[derive(Default)]
struct TuneAgentInner {
    /// Absolute path to the tune-agent sidecar binary, resolved at
    /// `tune_agent_start` and remembered so `admit` can echo it back.
    binary: Option<PathBuf>,
    /// Whether the spawn attempted so far returned a live process. Kept
    /// pessimistic: any failure resets to false so the rail draws HOLD.
    connected: bool,
    /// Latest admit outcome. `None` means admit has not been attempted yet;
    /// admit MUST run before Agent-mode work can begin.
    admit: Option<AdmitOutcome>,
    /// Human-readable last error, exposed to the frontend so the honest HOLD
    /// state names what failed instead of a vague "not connected".
    last_error: Option<String>,
}

/// The snapshot the frontend reads on `tune_agent_status`. Serializes to
/// camelCase to match the rest of the desktop's IPC.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TuneAgentStatus {
    pub connected: bool,
    pub binary: Option<String>,
    pub admit: Option<AdmitOutcome>,
    pub last_error: Option<String>,
}

/// The admit-runtime receipt. Serialized straight into the frontend so the
/// Tune Agent rail can show the exact python and snapshot the host trusts,
/// and the receipt writer can include the same object verbatim.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdmitOutcome {
    pub admitted: bool,
    pub python: String,
    pub snapshot: String,
    pub reason: Option<String>,
    /// Always "1" on a successful admit. Kept in the receipt so an auditor
    /// can confirm the sidecar was told to stay offline.
    pub hf_hub_offline: String,
}

/// Explicit error taxonomy so tests can assert on cause, not string match.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AdmitError {
    /// The host python path is not the regular framework file the policy
    /// accepts. `path` records what was asked for so the reason can quote it.
    NotRegularFile { path: String },
    /// Wrong absolute path (e.g., `/usr/bin/python3`, or a Homebrew python).
    WrongPythonPath { got: String, expected: String },
    /// The MLX snapshot is not in the allow-list. Rejects Hub ids too.
    SnapshotNotAllowed { got: String },
    /// The snapshot directory does not exist on disk.
    SnapshotMissing { path: String },
    /// A `mlx-lm` argument looks like a Hugging Face Hub id (owner/name).
    HubIdInArgs { arg: String },
    /// Non-macOS host: the framework path cannot exist here.
    UnsupportedHost,
}

impl std::fmt::Display for AdmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdmitError::NotRegularFile { path } => write!(
                f,
                "admit refused: host python at {path} is not a regular file. The policy requires the framework build, not the python3 symlink."
            ),
            AdmitError::WrongPythonPath { got, expected } => write!(
                f,
                "admit refused: host python was {got}; policy admits only {expected}."
            ),
            AdmitError::SnapshotNotAllowed { got } => write!(
                f,
                "admit refused: MLX snapshot {got} is not on the allow-list. StudioTune never passes a Hub id to mlx-lm."
            ),
            AdmitError::SnapshotMissing { path } => write!(
                f,
                "admit refused: MLX snapshot {path} does not exist on disk. Fetch it before admitting."
            ),
            AdmitError::HubIdInArgs { arg } => write!(
                f,
                "admit refused: argument {arg} looks like a Hub id (owner/name). StudioTune passes only local snapshot paths."
            ),
            AdmitError::UnsupportedHost => write!(
                f,
                "admit refused: this host is not macOS. Tune Agent's MLX runtime requires Apple Silicon."
            ),
        }
    }
}

/// Small filesystem view so tests can substitute a fake instead of touching
/// the real filesystem. `AdmitFs::real()` reads the host; tests build an
/// `AdmitFs` with the fake read paths and metadata answers they want.
pub(crate) trait AdmitFs {
    fn is_regular_file(&self, path: &Path) -> bool;
    fn exists(&self, path: &Path) -> bool;
}

pub(crate) struct RealAdmitFs;

impl AdmitFs for RealAdmitFs {
    fn is_regular_file(&self, path: &Path) -> bool {
        match std::fs::symlink_metadata(path) {
            Ok(meta) => meta.file_type().is_file(),
            Err(_) => false,
        }
    }

    fn exists(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok()
    }
}

/// Expand `~` at the start of a path relative to the caller-supplied home
/// dir. Kept parameterized so tests do not depend on `$HOME`.
pub(crate) fn expand_home(path: &str, home: &Path) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else if path == "~" {
        home.to_path_buf()
    } else {
        PathBuf::from(path)
    }
}

/// The core admit check, isolated so it is straight-forward to unit test.
/// `mlx_args` is the exact argv StudioTune would pass to mlx-lm; any element
/// shaped like `owner/name` is refused.
#[allow(clippy::too_many_arguments)]
pub(crate) fn evaluate_admit<F: AdmitFs>(
    fs: &F,
    home: &Path,
    is_macos: bool,
    python: &str,
    snapshot: &str,
    mlx_args: &[String],
) -> Result<AdmitOutcome, AdmitError> {
    if !is_macos {
        return Err(AdmitError::UnsupportedHost);
    }

    if python != ADMITTED_HOST_PYTHON {
        return Err(AdmitError::WrongPythonPath {
            got: python.to_string(),
            expected: ADMITTED_HOST_PYTHON.to_string(),
        });
    }

    let python_path = PathBuf::from(python);
    if !fs.is_regular_file(&python_path) {
        return Err(AdmitError::NotRegularFile {
            path: python.to_string(),
        });
    }

    if !ADMITTED_MLX_SNAPSHOTS.iter().any(|allowed| allowed == &snapshot) {
        return Err(AdmitError::SnapshotNotAllowed {
            got: snapshot.to_string(),
        });
    }

    let expanded_snapshot = expand_home(snapshot, home);
    if !fs.exists(&expanded_snapshot) {
        return Err(AdmitError::SnapshotMissing {
            path: expanded_snapshot.display().to_string(),
        });
    }

    for arg in mlx_args {
        if looks_like_hub_id(arg) {
            return Err(AdmitError::HubIdInArgs { arg: arg.clone() });
        }
    }

    Ok(AdmitOutcome {
        admitted: true,
        python: python.to_string(),
        snapshot: snapshot.to_string(),
        reason: None,
        hf_hub_offline: HF_HUB_OFFLINE_VALUE.to_string(),
    })
}

/// Naive but tight: an `owner/name` shape with no slash before `owner`, no
/// leading slash, no path separator inside `name`, and both halves nonempty.
/// mlx-lm accepts either a Hub id (rejected) or a local path (kept).
pub(crate) fn looks_like_hub_id(arg: &str) -> bool {
    if arg.starts_with('/') || arg.starts_with('.') || arg.starts_with('~') {
        return false;
    }
    let mut parts = arg.splitn(2, '/');
    let owner = parts.next().unwrap_or("");
    let name = match parts.next() {
        Some(rest) => rest,
        None => return false,
    };
    if owner.is_empty() || name.is_empty() {
        return false;
    }
    if name.contains('/') {
        return false;
    }
    // Bare identifiers only — no spaces, no absolute-path-like segments.
    !owner.contains(char::is_whitespace) && !name.contains(char::is_whitespace)
}

/// Compose the sidecar's launch environment. Currently just enforces
/// HF_HUB_OFFLINE=1 but kept as its own function so a follow-up that adds
/// XET or MLX cache overrides has one place to live.
pub(crate) fn sidecar_env() -> Vec<(String, String)> {
    vec![(
        HF_HUB_OFFLINE_KEY.to_string(),
        HF_HUB_OFFLINE_VALUE.to_string(),
    )]
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Snapshot for the frontend. Never fetches — reads the state the last
/// `start` / `admit` call left behind.
#[tauri::command]
pub(crate) fn tune_agent_status(
    state: tauri::State<'_, TuneAgentState>,
) -> TuneAgentStatus {
    let inner = state.inner.lock().expect("tune-agent state poisoned");
    TuneAgentStatus {
        connected: inner.connected,
        binary: inner
            .binary
            .as_ref()
            .map(|p| p.display().to_string()),
        admit: inner.admit.clone(),
        last_error: inner.last_error.clone(),
    }
}

/// Attempt to spawn the Tune Agent sidecar. Fail-closed: any error resets the
/// bridge to disconnected and records `last_error` for the rail to show.
#[tauri::command]
pub(crate) async fn tune_agent_start(
    state: tauri::State<'_, TuneAgentState>,
    binary: String,
) -> Result<TuneAgentStatus, String> {
    let path = PathBuf::from(&binary);
    if !path.is_absolute() {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.connected = false;
        inner.last_error = Some(format!(
            "tune_agent_start refused: binary {binary} is not an absolute path"
        ));
        return Ok(TuneAgentStatus {
            connected: false,
            binary: Some(binary),
            admit: inner.admit.clone(),
            last_error: inner.last_error.clone(),
        });
    }

    let fs = RealAdmitFs;
    if !fs.exists(&path) {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.binary = Some(path.clone());
        inner.connected = false;
        inner.last_error = Some(format!(
            "tune_agent_start refused: no tune-agent binary at {binary}"
        ));
        return Ok(TuneAgentStatus {
            connected: false,
            binary: Some(binary),
            admit: inner.admit.clone(),
            last_error: inner.last_error.clone(),
        });
    }

    // Ping the sidecar synchronously so a broken binary does not leave the
    // rail thinking it is connected. Uses a short timeout so the UI does not
    // hang if the sidecar is misbehaving.
    let ping_ok = ping_sidecar(&path).await;

    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.binary = Some(path.clone());
    inner.connected = ping_ok.is_ok();
    inner.last_error = ping_ok.err().map(|e| e.to_string());

    Ok(TuneAgentStatus {
        connected: inner.connected,
        binary: Some(path.display().to_string()),
        admit: inner.admit.clone(),
        last_error: inner.last_error.clone(),
    })
}

/// Admit the runtime for Agent mode. Records the outcome in state so the
/// frontend can gate Train off the same value the receipt is built from.
#[tauri::command]
pub(crate) fn tune_agent_admit_runtime(
    state: tauri::State<'_, TuneAgentState>,
    python: String,
    snapshot: String,
    mlx_args: Vec<String>,
) -> Result<AdmitOutcome, String> {
    let home =
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let fs = RealAdmitFs;
    let is_macos = cfg!(target_os = "macos");
    match evaluate_admit(&fs, &home, is_macos, &python, &snapshot, &mlx_args) {
        Ok(outcome) => {
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            inner.admit = Some(outcome.clone());
            inner.last_error = None;
            Ok(outcome)
        }
        Err(err) => {
            let reason = err.to_string();
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            inner.admit = Some(AdmitOutcome {
                admitted: false,
                python: python.clone(),
                snapshot: snapshot.clone(),
                reason: Some(reason.clone()),
                hf_hub_offline: HF_HUB_OFFLINE_VALUE.to_string(),
            });
            inner.last_error = Some(reason.clone());
            Err(reason)
        }
    }
}

/// Ping helper — used by `tune_agent_start` to make sure the sidecar answers.
///
/// Uses a short-lived `std::process::Command` (blocking) inside a
/// `tokio::task::spawn_blocking` so we can bound it with `timeout` without
/// pulling in a heavier async-process crate. If the sidecar does not answer
/// with `{"ok":true}` on the first line within the deadline, the bridge is
/// treated as disconnected.
async fn ping_sidecar(binary: &Path) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let binary = binary.to_path_buf();
    let env = sidecar_env();
    let handle = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut child = Command::new(&binary)
            .arg("--stdio-json")
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn failed: {e}"))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar had no stdin".to_string())?;
        writeln!(
            stdin,
            r#"{{"id":"ping","method":"ping","params":{{}}}}"#
        )
        .map_err(|e| format!("write ping failed: {e}"))?;
        drop(stdin);

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar had no stdout".to_string())?;
        let reader = BufReader::new(stdout);
        let deadline = Instant::now() + Duration::from_secs(3);
        for line in reader.lines() {
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err("sidecar ping timed out".to_string());
            }
            let line = line.map_err(|e| format!("read ping failed: {e}"))?;
            if line.contains("\"ok\":true") && line.contains("\"id\":\"ping\"") {
                let _ = child.kill();
                return Ok(());
            }
        }
        let _ = child.kill();
        Err("sidecar closed stdout before answering ping".to_string())
    })
    .await;
    match handle {
        Ok(inner) => inner,
        Err(join) => Err(format!("ping task join error: {join}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    struct StubFs {
        regular_files: HashSet<PathBuf>,
        existing: HashSet<PathBuf>,
    }

    impl StubFs {
        fn new(regular_files: &[&Path], existing: &[&Path]) -> Self {
            Self {
                regular_files: regular_files.iter().map(|p| p.to_path_buf()).collect(),
                existing: existing.iter().map(|p| p.to_path_buf()).collect(),
            }
        }
    }

    impl AdmitFs for StubFs {
        fn is_regular_file(&self, path: &Path) -> bool {
            self.regular_files.contains(path)
        }
        fn exists(&self, path: &Path) -> bool {
            self.existing.contains(path)
        }
    }

    fn home() -> PathBuf {
        PathBuf::from("/Users/tester")
    }

    fn python_path() -> PathBuf {
        PathBuf::from(ADMITTED_HOST_PYTHON)
    }

    fn snapshot() -> String {
        ADMITTED_MLX_SNAPSHOTS[0].to_string()
    }

    fn snapshot_abs() -> PathBuf {
        expand_home(&snapshot(), &home())
    }

    #[test]
    fn admit_accepts_the_framework_regular_file_and_the_allowlisted_snapshot() {
        let python = python_path();
        let snap = snapshot_abs();
        let fs = StubFs::new(&[python.as_path()], &[python.as_path(), snap.as_path()]);
        let outcome = evaluate_admit(
            &fs,
            &home(),
            true,
            ADMITTED_HOST_PYTHON,
            &snapshot(),
            &[],
        )
        .expect("admit should pass");
        assert!(outcome.admitted);
        assert_eq!(outcome.hf_hub_offline, "1");
        assert_eq!(outcome.python, ADMITTED_HOST_PYTHON);
    }

    #[test]
    fn admit_refuses_the_python3_symlink_beside_the_framework_binary() {
        // The framework path is present but NOT marked as a regular file:
        // that is exactly what a symlink test looks like via symlink_metadata.
        let python = python_path();
        let snap = snapshot_abs();
        let fs = StubFs::new(&[], &[python.as_path(), snap.as_path()]);
        let err = evaluate_admit(
            &fs,
            &home(),
            true,
            ADMITTED_HOST_PYTHON,
            &snapshot(),
            &[],
        )
        .expect_err("symlink python3 must be refused");
        assert_eq!(
            err,
            AdmitError::NotRegularFile {
                path: ADMITTED_HOST_PYTHON.to_string()
            }
        );
    }

    #[test]
    fn admit_refuses_a_python_at_a_different_absolute_path() {
        let python = PathBuf::from("/opt/homebrew/bin/python3.13");
        let snap = snapshot_abs();
        let fs = StubFs::new(&[python.as_path()], &[python.as_path(), snap.as_path()]);
        let err = evaluate_admit(
            &fs,
            &home(),
            true,
            "/opt/homebrew/bin/python3.13",
            &snapshot(),
            &[],
        )
        .expect_err("wrong python path must be refused");
        matches!(err, AdmitError::WrongPythonPath { .. });
    }

    #[test]
    fn admit_refuses_a_snapshot_that_is_not_on_the_allowlist() {
        let python = python_path();
        let bogus = "~/.cache/huggingface/hub/models--other--snapshot";
        let bogus_abs = expand_home(bogus, &home());
        let fs = StubFs::new(&[python.as_path()], &[python.as_path(), bogus_abs.as_path()]);
        let err = evaluate_admit(
            &fs,
            &home(),
            true,
            ADMITTED_HOST_PYTHON,
            bogus,
            &[],
        )
        .expect_err("non-allow-listed snapshot must be refused");
        assert!(matches!(err, AdmitError::SnapshotNotAllowed { .. }));
    }

    #[test]
    fn admit_refuses_a_snapshot_that_does_not_exist() {
        let python = python_path();
        let fs = StubFs::new(&[python.as_path()], &[python.as_path()]);
        let err = evaluate_admit(
            &fs,
            &home(),
            true,
            ADMITTED_HOST_PYTHON,
            &snapshot(),
            &[],
        )
        .expect_err("missing snapshot must be refused");
        assert!(matches!(err, AdmitError::SnapshotMissing { .. }));
    }

    #[test]
    fn admit_refuses_a_hub_id_hidden_in_mlx_args() {
        let python = python_path();
        let snap = snapshot_abs();
        let fs = StubFs::new(&[python.as_path()], &[python.as_path(), snap.as_path()]);
        let err = evaluate_admit(
            &fs,
            &home(),
            true,
            ADMITTED_HOST_PYTHON,
            &snapshot(),
            &["--model".to_string(), "mlx-community/Qwen2.5-0.5B".to_string()],
        )
        .expect_err("hub id must be refused");
        assert!(matches!(err, AdmitError::HubIdInArgs { .. }));
    }

    #[test]
    fn absolute_and_dot_prefixed_paths_are_not_treated_as_hub_ids() {
        assert!(!looks_like_hub_id("/absolute/path"));
        assert!(!looks_like_hub_id("./relative"));
        assert!(!looks_like_hub_id("~/tilde"));
        assert!(!looks_like_hub_id("bare-name-no-slash"));
        assert!(looks_like_hub_id("owner/name"));
        assert!(!looks_like_hub_id("owner/nested/name"));
        assert!(!looks_like_hub_id("owner with space/name"));
    }

    #[test]
    fn admit_refuses_non_macos_hosts_outright() {
        let fs = StubFs::new(&[], &[]);
        let err = evaluate_admit(
            &fs,
            &home(),
            false,
            ADMITTED_HOST_PYTHON,
            &snapshot(),
            &[],
        )
        .expect_err("linux/windows hosts cannot run MLX");
        assert_eq!(err, AdmitError::UnsupportedHost);
    }

    #[test]
    fn sidecar_env_forces_hf_hub_offline() {
        let env = sidecar_env();
        assert!(env.iter().any(|(k, v)| k == "HF_HUB_OFFLINE" && v == "1"));
    }

    #[test]
    fn tune_agent_methods_are_the_documented_five_plus_ping_and_shutdown() {
        // If a new method lands, the frontend test suite has to be updated too;
        // this lock catches a driveby that only touches the Rust side.
        assert_eq!(
            TUNE_AGENT_METHODS,
            &["ping", "set_mode", "request_plan", "grant", "train", "shutdown"]
        );
    }
}
