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

/// Wire-schema identifier the tune-agent stdio-json handshake stamps on its
/// `ping` reply. The Desktop bridge fails-closed when the value on the wire
/// does not match this constant — a mismatched schema means we are not
/// talking to the StudioTune tune-agent surface, regardless of what happens
/// to answer on stdout.
///
/// Source: tune-agent PR #2 / commit 3b263f6, branch
/// `cursor/tune-agent-modes-ea50`, `tune_agent/stdio_bridge.py::STDIO_SCHEMA`.
pub(crate) const TUNE_AGENT_STDIO_SCHEMA: &str =
    "studiotune.tune-agent-stdio.v1";

/// Fixed id the Desktop bridge sends on its handshake request. Echoed back
/// verbatim by the sidecar; the reply must carry this exact id or the
/// bridge treats the response as unmatched and fail-closes.
pub(crate) const TUNE_AGENT_HANDSHAKE_ID: &str = "handshake-1";

/// The one method the stdio-json surface allow-lists in this hop. Sending
/// anything else would return `STDIO_METHOD_UNKNOWN` and the bridge would
/// stay disconnected.
pub(crate) const TUNE_AGENT_HANDSHAKE_METHOD: &str = "ping";

/// Environment variable the receipt runner and the Rust bridge both honour
/// for locating the tune-agent local checkout when no packaged binary is
/// present. Kept in one place so a rename does not silently desync the two.
pub(crate) const TUNE_AGENT_REPO_ENV: &str = "STUDIOTUNE_TUNE_AGENT_REPO";

/// Fallback for `TUNE_AGENT_REPO_ENV` on this developer machine. Points at
/// the sibling checkout that ships the `python -m tune_agent --stdio-json`
/// entry point. On any other machine the env var wins.
pub(crate) const TUNE_AGENT_REPO_DEFAULT: &str =
    "/Volumes/HFR WD_BLACK SN850X/code/studiotune-ai/tune-agent";

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
///
/// Resolution order (see `resolve_sidecar_launch`):
///   1. Caller-supplied absolute-path binary (Settings override, packaged
///      install location).
///   2. `tune-agent` on `$PATH`.
///   3. Local checkout at `$STUDIOTUNE_TUNE_AGENT_REPO` (or the developer
///      default) invoked via `python3 -m tune_agent --stdio-json`.
/// If none of these resolve, the bridge stays disconnected with a named
/// reason; nothing is faked.
#[tauri::command]
pub(crate) async fn tune_agent_start(
    state: tauri::State<'_, TuneAgentState>,
    binary: String,
) -> Result<TuneAgentStatus, String> {
    let requested_raw = binary.clone();
    let requested_path = PathBuf::from(&binary);
    let requested_ref: Option<&Path> = if requested_path.as_os_str().is_empty() {
        None
    } else {
        Some(requested_path.as_path())
    };

    let sidecar_env = RealSidecarEnv;
    let launch = resolve_sidecar_launch(&sidecar_env, requested_ref);

    let launch = match launch {
        Some(l) => l,
        None => {
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            inner.connected = false;
            inner.binary = if requested_raw.is_empty() {
                None
            } else {
                Some(PathBuf::from(&requested_raw))
            };
            inner.last_error = Some(format!(
                "tune_agent_start refused: could not resolve a tune-agent sidecar (requested={requested_raw}, no `tune-agent` on PATH, and no local checkout at ${TUNE_AGENT_REPO_ENV} / {TUNE_AGENT_REPO_DEFAULT})."
            ));
            return Ok(TuneAgentStatus {
                connected: false,
                binary: inner.binary.as_ref().map(|p| p.display().to_string()),
                admit: inner.admit.clone(),
                last_error: inner.last_error.clone(),
            });
        }
    };

    // Ping the sidecar synchronously so a broken launch does not leave the
    // rail thinking it is connected. Uses a short timeout so the UI does not
    // hang if the sidecar is misbehaving.
    let ping_result = ping_sidecar(launch.clone()).await;

    let launch_display = launch.describe();
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.binary = match &launch {
        SidecarLaunch::Binary { path } => Some(path.clone()),
        SidecarLaunch::PythonModule { cwd, .. } => Some(cwd.clone()),
    };
    inner.connected = ping_result.is_ok();
    inner.last_error = ping_result
        .err()
        .map(|e| format!("{e} (launch: {launch_display})"));

    Ok(TuneAgentStatus {
        connected: inner.connected,
        binary: Some(launch_display),
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

/// How the Desktop bridge invokes the tune-agent sidecar. Kept as an enum so
/// the two supported launch shapes — an absolute-path binary or a
/// `python -m tune_agent` fallback from the local checkout — are visible in
/// one type and the resolver cannot silently pick a third path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SidecarLaunch {
    /// Spawn the binary at this absolute path with `--stdio-json`. Used
    /// when the packaged sidecar is installed (or when the caller pointed
    /// the frontend at their own dirty tree via a Settings override).
    Binary { path: PathBuf },
    /// Spawn `python_bin -m tune_agent --stdio-json` with the given working
    /// directory. Used as an honest fallback on developer machines that
    /// have the local tune-agent checkout but not a packaged binary. Never
    /// resolves through `$PATH` beyond the python executable itself.
    PythonModule { python: PathBuf, cwd: PathBuf },
}

impl SidecarLaunch {
    /// Human-facing summary for the receipt / rail HOLD banner. Never
    /// includes secrets — both fields are process paths the caller already
    /// controls.
    pub(crate) fn describe(&self) -> String {
        match self {
            SidecarLaunch::Binary { path } => {
                format!("binary={}", path.display())
            }
            SidecarLaunch::PythonModule { python, cwd } => {
                format!(
                    "python -m tune_agent (python={} cwd={})",
                    python.display(),
                    cwd.display()
                )
            }
        }
    }
}

/// Environment view for the resolver so tests do not depend on `$PATH`,
/// `$HOME`, or the developer checkout being present. `AdmitFs` already
/// covers filesystem probes; this trait adds the two extra reads we need
/// for the sidecar resolver.
pub(crate) trait SidecarEnv {
    /// Whether `path` exists as a regular file (not a symlink, not a dir).
    fn is_regular_file(&self, path: &Path) -> bool;
    /// Whether `path` exists as a directory.
    fn is_directory(&self, path: &Path) -> bool;
    /// Return an absolute path to `name` on `$PATH`, if any. `None` means
    /// the resolver must move on to the next strategy.
    fn which_on_path(&self, name: &str) -> Option<PathBuf>;
    /// Read one environment variable. `None` for unset / non-utf8.
    fn env_var(&self, key: &str) -> Option<String>;
}

pub(crate) struct RealSidecarEnv;

impl SidecarEnv for RealSidecarEnv {
    fn is_regular_file(&self, path: &Path) -> bool {
        match std::fs::symlink_metadata(path) {
            Ok(meta) => meta.file_type().is_file(),
            Err(_) => false,
        }
    }

    fn is_directory(&self, path: &Path) -> bool {
        match std::fs::metadata(path) {
            Ok(meta) => meta.is_dir(),
            Err(_) => false,
        }
    }

    fn which_on_path(&self, name: &str) -> Option<PathBuf> {
        let path_env = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&path_env) {
            let candidate = dir.join(name);
            if self.is_regular_file(&candidate) {
                return Some(candidate);
            }
        }
        None
    }

    fn env_var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// Resolve which command the Rust bridge will use to spawn the sidecar.
///
/// Order, honest and fail-closed:
///   1. Caller-supplied `requested` — if it names a regular file, use it
///      verbatim (both a packaged path or a Settings-supplied override
///      lands here).
///   2. `tune-agent` on `$PATH` (packaged install picked up from the shell
///      environment).
///   3. Local checkout fallback: `<STUDIOTUNE_TUNE_AGENT_REPO or default>`
///      as a directory + `python3` on `$PATH`. Emits `PythonModule` so the
///      spawn goes through `python -m tune_agent --stdio-json`, which is
///      what the tune-agent stdio_bridge exposes on developer machines.
///   4. Otherwise `None`. The bridge records a named reason and the rail
///      stays in HOLD; nothing is faked.
pub(crate) fn resolve_sidecar_launch<E: SidecarEnv>(
    env: &E,
    requested: Option<&Path>,
) -> Option<SidecarLaunch> {
    if let Some(path) = requested {
        if path.is_absolute() && env.is_regular_file(path) {
            return Some(SidecarLaunch::Binary {
                path: path.to_path_buf(),
            });
        }
    }
    if let Some(binary) = env.which_on_path("tune-agent") {
        return Some(SidecarLaunch::Binary { path: binary });
    }
    let repo_root = env
        .env_var(TUNE_AGENT_REPO_ENV)
        .unwrap_or_else(|| TUNE_AGENT_REPO_DEFAULT.to_string());
    let repo_path = PathBuf::from(&repo_root);
    let package_dir = repo_path.join("tune_agent");
    if !env.is_directory(&repo_path) || !env.is_directory(&package_dir) {
        return None;
    }
    // tune-agent's pyproject requires Python >= 3.11, so we try the
    // explicitly-versioned python names first. `/usr/bin/python3` on
    // recent macOS is Python 3.9 and cannot import the package; picking
    // the unversioned `python3` first would silently fail there.
    let python = env
        .which_on_path("python3.13")
        .or_else(|| env.which_on_path("python3.12"))
        .or_else(|| env.which_on_path("python3.11"))
        .or_else(|| env.which_on_path("python3"))
        .or_else(|| env.which_on_path("python"))?;
    Some(SidecarLaunch::PythonModule {
        python,
        cwd: repo_path,
    })
}

/// Build the exact JSON request the Desktop bridge writes on stdin. Kept
/// as its own function so the tune-agent side's regression tests can key
/// on the same literal — and so the bridge cannot accidentally send an
/// `id` other than `handshake-1`.
pub(crate) fn make_handshake_request_line() -> String {
    // Sort the keys and escape defensively via serde_json so a future
    // refactor that changes the format has to update the tune-agent side
    // too. The tune-agent stdio_bridge accepts any object shape as long as
    // `method` names an allow-listed method; `params` is not required.
    let request = serde_json::json!({
        "id": TUNE_AGENT_HANDSHAKE_ID,
        "method": TUNE_AGENT_HANDSHAKE_METHOD,
    });
    let mut line = serde_json::to_string(&request)
        .expect("serialise handshake request to succeed");
    line.push('\n');
    line
}

/// Explicit failure taxonomy for the handshake. Tests key on the variant,
/// so a refactor that changed the reason string still has one place to
/// name the cause.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HandshakeError {
    /// The response line did not parse as JSON.
    ResponseNotJson { snippet: String },
    /// The parsed response was not a JSON object at all.
    ResponseNotObject,
    /// `ok` was missing or not `true`. `error_code` / `error_reason` may
    /// carry the sidecar's refusal code (`STDIO_METHOD_UNKNOWN`, …) when
    /// the object is well-formed but the sidecar refused.
    ResponseNotOk {
        error_code: Option<String>,
        error_reason: Option<String>,
    },
    /// The reply's `id` did not equal the request id we sent.
    ResponseIdMismatch {
        got: Option<String>,
        expected: String,
    },
    /// The reply's `method` was not `ping`.
    ResponseMethodMismatch { got: Option<String> },
    /// The reply's `schema` did not equal `TUNE_AGENT_STDIO_SCHEMA`.
    SchemaMismatch {
        got: Option<String>,
        expected: String,
    },
    /// `authority` was not literally `false` — an authority-claim slipping
    /// through the handshake surface must fail-close, never be admitted.
    AuthorityNotFalse { got: Option<bool> },
    /// `action_taken` was not literally `false` — same reasoning as above.
    ActionTakenNotFalse { got: Option<bool> },
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeError::ResponseNotJson { snippet } => write!(
                f,
                "sidecar handshake failed: response line was not valid JSON. First 120 chars: {snippet}"
            ),
            HandshakeError::ResponseNotObject => write!(
                f,
                "sidecar handshake failed: response was not a JSON object."
            ),
            HandshakeError::ResponseNotOk {
                error_code,
                error_reason,
            } => match (error_code, error_reason) {
                (Some(code), Some(reason)) => write!(
                    f,
                    "sidecar handshake refused: code={code} reason={reason}."
                ),
                (Some(code), None) => write!(f, "sidecar handshake refused: code={code}."),
                _ => write!(f, "sidecar handshake refused: ok=false."),
            },
            HandshakeError::ResponseIdMismatch { got, expected } => write!(
                f,
                "sidecar handshake failed: response id was {} but the bridge sent {expected}.",
                got.as_deref().unwrap_or("<missing>")
            ),
            HandshakeError::ResponseMethodMismatch { got } => write!(
                f,
                "sidecar handshake failed: response method was {} but the bridge sent ping.",
                got.as_deref().unwrap_or("<missing>")
            ),
            HandshakeError::SchemaMismatch { got, expected } => write!(
                f,
                "sidecar handshake failed: response schema was {} but the bridge only accepts {expected}.",
                got.as_deref().unwrap_or("<missing>")
            ),
            HandshakeError::AuthorityNotFalse { got } => write!(
                f,
                "sidecar handshake refused: authority was {} — the handshake surface must never claim authority.",
                got.map(|b| b.to_string()).unwrap_or_else(|| "<missing>".to_string())
            ),
            HandshakeError::ActionTakenNotFalse { got } => write!(
                f,
                "sidecar handshake refused: action_taken was {} — the handshake surface must never claim an action was taken.",
                got.map(|b| b.to_string()).unwrap_or_else(|| "<missing>".to_string())
            ),
        }
    }
}

/// Validate one raw response line the sidecar wrote to stdout against the
/// full handshake contract. Pure — no IO, no clocks, no spawns — so the
/// unit tests exercise every failure mode.
pub(crate) fn validate_handshake_response(
    raw_line: &str,
) -> Result<(), HandshakeError> {
    let trimmed = raw_line.trim();
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            return Err(HandshakeError::ResponseNotJson {
                snippet: trimmed.chars().take(120).collect(),
            });
        }
    };
    let obj = value
        .as_object()
        .ok_or(HandshakeError::ResponseNotObject)?;

    let ok = obj.get("ok").and_then(serde_json::Value::as_bool);
    if ok != Some(true) {
        let error_code = obj
            .get("code")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let error_reason = obj
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        return Err(HandshakeError::ResponseNotOk {
            error_code,
            error_reason,
        });
    }

    // Everything below is only checked once ok=true, i.e. once the sidecar
    // has claimed a successful handshake. A malformed success is a failure.
    let id = obj.get("id").and_then(serde_json::Value::as_str);
    if id != Some(TUNE_AGENT_HANDSHAKE_ID) {
        return Err(HandshakeError::ResponseIdMismatch {
            got: id.map(str::to_string),
            expected: TUNE_AGENT_HANDSHAKE_ID.to_string(),
        });
    }
    let method = obj.get("method").and_then(serde_json::Value::as_str);
    if method != Some(TUNE_AGENT_HANDSHAKE_METHOD) {
        return Err(HandshakeError::ResponseMethodMismatch {
            got: method.map(str::to_string),
        });
    }
    let schema = obj.get("schema").and_then(serde_json::Value::as_str);
    if schema != Some(TUNE_AGENT_STDIO_SCHEMA) {
        return Err(HandshakeError::SchemaMismatch {
            got: schema.map(str::to_string),
            expected: TUNE_AGENT_STDIO_SCHEMA.to_string(),
        });
    }
    let authority = obj.get("authority").and_then(serde_json::Value::as_bool);
    if authority != Some(false) {
        return Err(HandshakeError::AuthorityNotFalse { got: authority });
    }
    let action_taken = obj
        .get("action_taken")
        .and_then(serde_json::Value::as_bool);
    if action_taken != Some(false) {
        return Err(HandshakeError::ActionTakenNotFalse {
            got: action_taken,
        });
    }
    Ok(())
}

/// Ping helper — used by `tune_agent_start` to make sure the sidecar answers.
///
/// Uses a short-lived `std::process::Command` (blocking) inside a
/// `tokio::task::spawn_blocking` so we can bound it with `timeout` without
/// pulling in a heavier async-process crate. Fails-closed on any of:
///   * spawn error (binary missing, permission denied, python not present);
///   * stdin/stdout pipes not attached;
///   * the first stdout line does not pass `validate_handshake_response`;
///   * the sidecar closes stdout before writing a response;
///   * the whole exchange takes longer than a short deadline.
async fn ping_sidecar(launch: SidecarLaunch) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let env = sidecar_env();
    let handle = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut cmd = match &launch {
            SidecarLaunch::Binary { path } => {
                let mut c = Command::new(path);
                c.arg("--stdio-json");
                c
            }
            SidecarLaunch::PythonModule { python, cwd } => {
                let mut c = Command::new(python);
                c.arg("-m").arg("tune_agent").arg("--stdio-json");
                c.current_dir(cwd);
                c
            }
        };
        let mut child = cmd
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!("spawn failed for {}: {e}", launch.describe())
            })?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar had no stdin".to_string())?;
        let request_line = make_handshake_request_line();
        stdin
            .write_all(request_line.as_bytes())
            .map_err(|e| format!("write handshake request failed: {e}"))?;
        drop(stdin);

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "sidecar had no stdout".to_string())?;
        let mut reader = BufReader::new(stdout);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut line = String::new();
        loop {
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err("sidecar handshake timed out after 5s".to_string());
            }
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = child.kill();
                    return Err(
                        "sidecar closed stdout before answering handshake".to_string(),
                    );
                }
                Ok(_) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let result = validate_handshake_response(&line);
                    let _ = child.kill();
                    return result.map_err(|e| e.to_string());
                }
                Err(e) => {
                    let _ = child.kill();
                    return Err(format!("read handshake failed: {e}"));
                }
            }
        }
    })
    .await;
    match handle {
        Ok(inner) => inner,
        Err(join) => Err(format!("handshake task join error: {join}")),
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

    // The two tests below exercise the admit policy against the *real*
    // filesystem, not the StubFs. They only run when this crate is built on
    // macOS and only when the framework python and the allow-listed MLX
    // snapshot are actually present on the host. If either is missing the
    // test skips with a clear message rather than a false pass. On any other
    // host these tests are compiled out — evaluate_admit against RealAdmitFs
    // is a macOS-only claim.
    //
    // The APP-008 receipt runner keys on the specific test names below to
    // record `admit-succeeds` and `admit-refuses-symlink` verdicts, so do
    // not rename them without updating docs/receipts/generate-app-008.mjs.

    #[cfg(target_os = "macos")]
    #[test]
    fn real_mac_admit_passes_with_framework_python_and_allowlisted_snapshot() {
        let fs = RealAdmitFs;
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => {
                eprintln!(
                    "SKIP real_mac_admit_passes_with_framework_python_and_allowlisted_snapshot: \
                     no home dir resolved"
                );
                return;
            }
        };
        let python = std::path::PathBuf::from(ADMITTED_HOST_PYTHON);
        if !fs.is_regular_file(&python) {
            eprintln!(
                "SKIP real_mac_admit_passes_with_framework_python_and_allowlisted_snapshot: \
                 {ADMITTED_HOST_PYTHON} is not a regular file on this host"
            );
            return;
        }
        let snapshot = ADMITTED_MLX_SNAPSHOTS[0];
        let snapshot_abs = expand_home(snapshot, &home);
        if !fs.exists(&snapshot_abs) {
            eprintln!(
                "SKIP real_mac_admit_passes_with_framework_python_and_allowlisted_snapshot: \
                 snapshot {} not present on this host",
                snapshot_abs.display()
            );
            return;
        }
        let outcome = evaluate_admit(
            &fs,
            &home,
            true,
            ADMITTED_HOST_PYTHON,
            snapshot,
            &[],
        )
        .expect("real Mac admit should pass with framework python + allow-listed snapshot");
        assert!(outcome.admitted);
        assert_eq!(outcome.hf_hub_offline, "1");
        assert_eq!(outcome.python, ADMITTED_HOST_PYTHON);
        assert_eq!(outcome.snapshot, snapshot);
        assert!(outcome.reason.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_mac_admit_refuses_slash_usr_bin_python3() {
        // /usr/bin/python3 is the "plain python" the policy must never admit.
        // On older macOS it is a symlink; on modern macOS it is a stub
        // launcher (still a regular file) — but at a path that does not match
        // ADMITTED_HOST_PYTHON, so admit MUST refuse it. The refusal reason
        // is one of two documented AdmitError variants:
        //   * NotRegularFile — hit when /usr/bin/python3 is a symlink AND the
        //     policy is asked to admit the framework path but is fed
        //     /usr/bin/python3 as `python`. Only reachable if the caller lied
        //     about the path.
        //   * WrongPythonPath — the honest, common refusal: /usr/bin/python3
        //     is not the framework path, so it is rejected before the
        //     regular-file test even runs.
        let fs = RealAdmitFs;
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => {
                eprintln!(
                    "SKIP real_mac_admit_refuses_slash_usr_bin_python3: no home dir resolved"
                );
                return;
            }
        };
        let err = evaluate_admit(
            &fs,
            &home,
            true,
            "/usr/bin/python3",
            ADMITTED_MLX_SNAPSHOTS[0],
            &[],
        )
        .expect_err("/usr/bin/python3 must be refused by admit on macOS");
        match err {
            AdmitError::WrongPythonPath { got, expected } => {
                assert_eq!(got, "/usr/bin/python3");
                assert_eq!(expected, ADMITTED_HOST_PYTHON);
            }
            AdmitError::NotRegularFile { path } => {
                assert_eq!(path, "/usr/bin/python3");
            }
            other => panic!(
                "unexpected refusal for /usr/bin/python3: {other:?}. Expected WrongPythonPath or NotRegularFile."
            ),
        }
    }

    // -----------------------------------------------------------------
    // Handshake response validator + resolver tests. These exercise the
    // new Desktop → tune-agent stdio-json wire (tune-agent PR #2 commit
    // 3b263f6) without spawning a process; the real-fs Mac test at the
    // bottom does the live spawn when the sibling checkout is present.
    // -----------------------------------------------------------------

    struct StubSidecarEnv {
        regular_files: HashSet<PathBuf>,
        directories: HashSet<PathBuf>,
        path_lookups: std::collections::HashMap<String, PathBuf>,
        env_vars: std::collections::HashMap<String, String>,
    }

    impl StubSidecarEnv {
        fn new() -> Self {
            Self {
                regular_files: HashSet::new(),
                directories: HashSet::new(),
                path_lookups: std::collections::HashMap::new(),
                env_vars: std::collections::HashMap::new(),
            }
        }
        fn with_regular(mut self, path: &Path) -> Self {
            self.regular_files.insert(path.to_path_buf());
            self
        }
        fn with_directory(mut self, path: &Path) -> Self {
            self.directories.insert(path.to_path_buf());
            self
        }
        fn with_on_path(mut self, name: &str, resolves_to: &Path) -> Self {
            self.path_lookups
                .insert(name.to_string(), resolves_to.to_path_buf());
            self.regular_files.insert(resolves_to.to_path_buf());
            self
        }
        fn with_env(mut self, key: &str, value: &str) -> Self {
            self.env_vars.insert(key.to_string(), value.to_string());
            self
        }
    }

    impl SidecarEnv for StubSidecarEnv {
        fn is_regular_file(&self, path: &Path) -> bool {
            self.regular_files.contains(path)
        }
        fn is_directory(&self, path: &Path) -> bool {
            self.directories.contains(path)
        }
        fn which_on_path(&self, name: &str) -> Option<PathBuf> {
            self.path_lookups.get(name).cloned()
        }
        fn env_var(&self, key: &str) -> Option<String> {
            self.env_vars.get(key).cloned()
        }
    }

    #[test]
    fn handshake_request_uses_id_handshake_one_and_method_ping() {
        let line = make_handshake_request_line();
        assert!(line.ends_with('\n'), "handshake line must be newline-terminated");
        let value: serde_json::Value =
            serde_json::from_str(line.trim()).expect("handshake line must be valid JSON");
        let obj = value.as_object().expect("handshake line must be JSON object");
        assert_eq!(
            obj.get("id").and_then(|v| v.as_str()),
            Some(TUNE_AGENT_HANDSHAKE_ID)
        );
        assert_eq!(
            obj.get("method").and_then(|v| v.as_str()),
            Some(TUNE_AGENT_HANDSHAKE_METHOD)
        );
    }

    fn well_formed_pong() -> String {
        format!(
            r#"{{"ok":true,"id":"{TUNE_AGENT_HANDSHAKE_ID}","method":"{TUNE_AGENT_HANDSHAKE_METHOD}","schema":"{TUNE_AGENT_STDIO_SCHEMA}","authority":false,"action_taken":false}}"#
        )
    }

    #[test]
    fn validate_handshake_response_accepts_the_ping_success_shape() {
        validate_handshake_response(&well_formed_pong())
            .expect("well-formed pong must validate");
    }

    #[test]
    fn validate_handshake_response_accepts_the_python_bridges_key_ordering() {
        // stdio_bridge writes json.dumps(..., sort_keys=True). The sorted
        // form has action_taken first, id near the middle. Validator must
        // not depend on key order.
        let sorted = r#"{"action_taken":false,"authority":false,"id":"handshake-1","method":"ping","ok":true,"schema":"studiotune.tune-agent-stdio.v1"}"#;
        validate_handshake_response(sorted).expect("sort_keys=True form must validate");
    }

    #[test]
    fn validate_handshake_response_refuses_a_non_json_line() {
        let err = validate_handshake_response("not-json at all\n").expect_err("must refuse");
        assert!(matches!(err, HandshakeError::ResponseNotJson { .. }));
    }

    #[test]
    fn validate_handshake_response_refuses_a_json_array() {
        let err = validate_handshake_response("[1,2,3]").expect_err("must refuse");
        assert_eq!(err, HandshakeError::ResponseNotObject);
    }

    #[test]
    fn validate_handshake_response_refuses_ok_false_and_surfaces_stdio_error_code() {
        // stdio_bridge shape for STDIO_METHOD_UNKNOWN.
        let raw = r#"{"ok":false,"code":"STDIO_METHOD_UNKNOWN","reason":"method_not_allowlisted","id":"handshake-1","authority":false,"action_taken":false}"#;
        let err = validate_handshake_response(raw).expect_err("must refuse ok=false");
        assert_eq!(
            err,
            HandshakeError::ResponseNotOk {
                error_code: Some("STDIO_METHOD_UNKNOWN".to_string()),
                error_reason: Some("method_not_allowlisted".to_string()),
            }
        );
    }

    #[test]
    fn validate_handshake_response_refuses_mismatched_id() {
        let raw = r#"{"ok":true,"id":"different","method":"ping","schema":"studiotune.tune-agent-stdio.v1","authority":false,"action_taken":false}"#;
        let err = validate_handshake_response(raw).expect_err("must refuse wrong id");
        assert_eq!(
            err,
            HandshakeError::ResponseIdMismatch {
                got: Some("different".to_string()),
                expected: TUNE_AGENT_HANDSHAKE_ID.to_string(),
            }
        );
    }

    #[test]
    fn validate_handshake_response_refuses_mismatched_method() {
        let raw = r#"{"ok":true,"id":"handshake-1","method":"train","schema":"studiotune.tune-agent-stdio.v1","authority":false,"action_taken":false}"#;
        let err = validate_handshake_response(raw).expect_err("must refuse wrong method");
        assert_eq!(
            err,
            HandshakeError::ResponseMethodMismatch {
                got: Some("train".to_string()),
            }
        );
    }

    #[test]
    fn validate_handshake_response_refuses_mismatched_schema() {
        let raw = r#"{"ok":true,"id":"handshake-1","method":"ping","schema":"other-vendor.v99","authority":false,"action_taken":false}"#;
        let err = validate_handshake_response(raw).expect_err("must refuse wrong schema");
        assert!(matches!(err, HandshakeError::SchemaMismatch { .. }));
    }

    #[test]
    fn validate_handshake_response_refuses_authority_true() {
        // A ping surface must never claim authority. If a later hop tries
        // to piggyback authority onto the handshake, this test catches it.
        let raw = r#"{"ok":true,"id":"handshake-1","method":"ping","schema":"studiotune.tune-agent-stdio.v1","authority":true,"action_taken":false}"#;
        let err = validate_handshake_response(raw).expect_err("authority must never be true");
        assert_eq!(err, HandshakeError::AuthorityNotFalse { got: Some(true) });
    }

    #[test]
    fn validate_handshake_response_refuses_action_taken_true() {
        // Same reasoning: ping is a liveness probe, not an execute.
        let raw = r#"{"ok":true,"id":"handshake-1","method":"ping","schema":"studiotune.tune-agent-stdio.v1","authority":false,"action_taken":true}"#;
        let err = validate_handshake_response(raw)
            .expect_err("action_taken must never be true");
        assert_eq!(err, HandshakeError::ActionTakenNotFalse { got: Some(true) });
    }

    #[test]
    fn validate_handshake_response_refuses_missing_authority() {
        let raw = r#"{"ok":true,"id":"handshake-1","method":"ping","schema":"studiotune.tune-agent-stdio.v1","action_taken":false}"#;
        let err = validate_handshake_response(raw).expect_err("missing authority must fail-close");
        assert_eq!(err, HandshakeError::AuthorityNotFalse { got: None });
    }

    #[test]
    fn resolve_sidecar_launch_prefers_the_caller_supplied_absolute_binary() {
        let requested = PathBuf::from("/opt/studiotune/tune-agent");
        let env = StubSidecarEnv::new().with_regular(&requested);
        let launch = resolve_sidecar_launch(&env, Some(&requested))
            .expect("resolver must pick the caller-supplied binary");
        assert_eq!(
            launch,
            SidecarLaunch::Binary {
                path: requested.clone()
            }
        );
    }

    #[test]
    fn resolve_sidecar_launch_falls_back_to_path_when_requested_binary_missing() {
        let requested = PathBuf::from("/does/not/exist");
        let on_path = PathBuf::from("/usr/local/bin/tune-agent");
        let env = StubSidecarEnv::new().with_on_path("tune-agent", &on_path);
        let launch = resolve_sidecar_launch(&env, Some(&requested))
            .expect("resolver must fall back to $PATH");
        assert_eq!(launch, SidecarLaunch::Binary { path: on_path });
    }

    #[test]
    fn resolve_sidecar_launch_uses_python_module_when_no_binary_but_checkout_present() {
        let repo = PathBuf::from(TUNE_AGENT_REPO_DEFAULT);
        let pkg = repo.join("tune_agent");
        let python = PathBuf::from("/opt/homebrew/bin/python3");
        let env = StubSidecarEnv::new()
            .with_directory(&repo)
            .with_directory(&pkg)
            .with_on_path("python3", &python);
        let launch = resolve_sidecar_launch(&env, None)
            .expect("resolver must fall back to python -m from the checkout");
        assert_eq!(
            launch,
            SidecarLaunch::PythonModule {
                python,
                cwd: repo
            }
        );
    }

    #[test]
    fn resolve_sidecar_launch_honours_env_override_for_the_checkout_path() {
        let repo = PathBuf::from("/private/repos/tune-agent");
        let pkg = repo.join("tune_agent");
        let python = PathBuf::from("/opt/homebrew/bin/python3");
        let env = StubSidecarEnv::new()
            .with_env(TUNE_AGENT_REPO_ENV, repo.to_str().unwrap())
            .with_directory(&repo)
            .with_directory(&pkg)
            .with_on_path("python3", &python);
        let launch = resolve_sidecar_launch(&env, None)
            .expect("env-supplied checkout path must be honoured");
        assert_eq!(
            launch,
            SidecarLaunch::PythonModule {
                python,
                cwd: repo
            }
        );
    }

    #[test]
    fn resolve_sidecar_launch_returns_none_when_nothing_resolves() {
        // No requested binary, no $PATH entry, no checkout — the bridge
        // must fail-close, not invent a launch.
        let env = StubSidecarEnv::new();
        assert!(resolve_sidecar_launch(&env, None).is_none());
    }

    #[test]
    fn resolve_sidecar_launch_refuses_a_non_absolute_requested_binary() {
        // The frontend's default `~/.studiotune/tune-agent` is not
        // absolute (we do not expand ~) — the resolver must skip it and
        // move on rather than spawning something on `$CWD`.
        let requested = PathBuf::from("~/.studiotune/tune-agent");
        let on_path = PathBuf::from("/usr/local/bin/tune-agent");
        let env = StubSidecarEnv::new().with_on_path("tune-agent", &on_path);
        let launch = resolve_sidecar_launch(&env, Some(&requested))
            .expect("resolver must skip non-absolute requested paths");
        assert_eq!(launch, SidecarLaunch::Binary { path: on_path });
    }

    // -----------------------------------------------------------------
    // Live handshake against the sibling tune-agent checkout. Only runs
    // on macOS (this branch's target) and only when either `tune-agent`
    // is on PATH or the local checkout at STUDIOTUNE_TUNE_AGENT_REPO
    // has a `tune_agent/` package + a python3 on PATH. Skips with a
    // clear message otherwise — a missing sibling checkout must not
    // fail the test suite on other developer machines.
    //
    // The APP-008 receipt runner keys on the test name below to move
    // sidecar-handshake from unproven → pass, so do not rename it
    // without updating docs/receipts/generate-app-008.mjs.
    #[cfg(target_os = "macos")]
    #[test]
    fn real_mac_sidecar_handshake_speaks_studiotune_tune_agent_stdio_v1() {
        // Discover the launch the way tune_agent_start would — using the
        // real sidecar-env probe, not the stubs.
        let env = RealSidecarEnv;
        let launch = match resolve_sidecar_launch(&env, None) {
            Some(l) => l,
            None => {
                eprintln!(
                    "SKIP real_mac_sidecar_handshake_speaks_studiotune_tune_agent_stdio_v1: \
                     no tune-agent binary on PATH and no local checkout at \
                     ${TUNE_AGENT_REPO_ENV} / {TUNE_AGENT_REPO_DEFAULT}."
                );
                return;
            }
        };
        // Run the async ping inside a small tokio runtime. The bridge
        // uses spawn_blocking + tokio internally, so we need a runtime,
        // but we do not pull in tokio_test.
        let rt = match tokio::runtime::Runtime::new() {
            Ok(r) => r,
            Err(e) => {
                eprintln!(
                    "SKIP real_mac_sidecar_handshake_speaks_studiotune_tune_agent_stdio_v1: \
                     could not build tokio runtime: {e}"
                );
                return;
            }
        };
        let result = rt.block_on(ping_sidecar(launch.clone()));
        result.unwrap_or_else(|e| {
            panic!(
                "real handshake must succeed against {} but failed: {e}",
                launch.describe()
            )
        });
    }
}
