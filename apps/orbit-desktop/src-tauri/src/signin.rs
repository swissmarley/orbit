//! Sign-in through the `orbit` CLI (ADR-011, ADR-017): `orbit app --json
//! --no-open` starts orbitd if needed and prints a one-time link
//! `<origin>/login#ticket=…` on its stdout. The link never goes on a command
//! line and the bearer token never leaves the CLI; the window only ever sees
//! the ticket, which orbitd trades for its HttpOnly session cookie.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::Url;

use crate::childenv;

/// orbitd may take a while to start the first time (the CLI waits 15 s).
const CLI_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct SignInLink {
    pub url: Url,
    /// orbitd's origin, e.g. `http://127.0.0.1:7420`.
    pub origin: String,
}

#[derive(Debug)]
pub enum SignInError {
    CliMissing,
    CliFailed { detail: String },
    BadAnswer(String),
}

pub const INSTALL_HINT: &str = "Install it with \u{201c}npm install --global orbit-bots\u{201d} (Node.js 22.13 or newer), or set ORBIT_CLI to the full path of the orbit program.";

impl SignInError {
    pub fn message(&self) -> String {
        match self {
            SignInError::CliMissing => {
                "Orbit\u{2019}s command-line tool (orbit) was not found.".into()
            }
            SignInError::CliFailed { .. } => "orbit could not sign this window in.".into(),
            SignInError::BadAnswer(_) => {
                "orbit gave an answer this window does not understand.".into()
            }
        }
    }

    pub fn hint(&self) -> String {
        match self {
            SignInError::CliMissing => INSTALL_HINT.into(),
            SignInError::CliFailed { detail } => format!(
                "{detail}\n\nRun \u{201c}orbit doctor\u{201d} in a terminal to see what is missing."
            ),
            SignInError::BadAnswer(detail) => format!(
                "{detail}\n\nThe orbit program may be older than this app: update it with \u{201c}npm install --global orbit-bots\u{201d}."
            ),
        }
    }
}

#[derive(Deserialize)]
struct AppJson {
    url: String,
}

/// Program names npm installs for the `orbit` bin.
fn program_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["orbit.cmd", "orbit.exe", "orbit.ps1", "orbit"]
    } else {
        &["orbit"]
    }
}

/// Where npm and friends put global bins when a GUI app's PATH lacks them.
fn fallback_dirs(env: &[(String, String)]) -> Vec<PathBuf> {
    let var = |k: &str| {
        env.iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| PathBuf::from(v))
    };
    let mut dirs = Vec::new();
    if cfg!(windows) {
        if let Some(appdata) = var("APPDATA") {
            dirs.push(appdata.join("npm"));
        }
        if let Some(local) = var("LOCALAPPDATA") {
            dirs.push(local.join("pnpm"));
        }
    } else {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        if let Some(home) = var("HOME") {
            for sub in [
                ".npm-global/bin",
                ".local/bin",
                ".volta/bin",
                "Library/pnpm",
                ".local/share/pnpm",
            ] {
                dirs.push(home.join(sub));
            }
        }
    }
    dirs
}

/// `ORBIT_CLI` (an absolute path), else `orbit` on PATH, else the usual
/// global bin folders.
pub fn find_cli(env: &[(String, String)]) -> Option<PathBuf> {
    if let Some((_, v)) = env.iter().find(|(k, _)| k == "ORBIT_CLI") {
        let p = PathBuf::from(v);
        return (p.is_absolute() && p.is_file()).then_some(p);
    }
    let path = env
        .iter()
        .find(|(k, _)| {
            if cfg!(windows) {
                k.eq_ignore_ascii_case("PATH")
            } else {
                k == "PATH"
            }
        })
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    std::env::split_paths(path)
        .chain(fallback_dirs(env))
        .flat_map(|dir| program_names().iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

/// The link from `orbit app --json`: a loopback `http` origin, `/login`, and
/// a ticket in the fragment. Anything else is refused.
pub fn parse_link(stdout: &str) -> Result<SignInLink, SignInError> {
    let answer: AppJson = serde_json::from_str(stdout.trim())
        .map_err(|_| SignInError::BadAnswer("orbit app --json printed no sign-in link.".into()))?;
    let url = Url::parse(&answer.url)
        .map_err(|_| SignInError::BadAnswer("The sign-in link is not a URL.".into()))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let ticket = url
        .fragment()
        .is_some_and(|f| f.len() > "ticket=".len() && f.starts_with("ticket="));
    if url.scheme() != "http" || !loopback || url.path() != "/login" || !ticket {
        return Err(SignInError::BadAnswer(
            "The sign-in link does not point to an orbitd on this computer.".into(),
        ));
    }
    let origin = url.origin().ascii_serialization();
    Ok(SignInLink { url, origin })
}

/// Printable text from the CLI (no control characters), at most `max` chars from the end.
fn tail(text: &str, max: usize) -> String {
    let clean: String = text
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .collect();
    let clean = clean.trim();
    let count = clean.chars().count();
    if count <= max {
        clean.to_string()
    } else {
        format!(
            "\u{2026}{}",
            clean.chars().skip(count - max).collect::<String>()
        )
    }
}

fn read_all(mut r: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut s = String::new();
        let _ = r.read_to_string(&mut s);
        s
    })
}

fn run_cli(cli: &Path, env: Vec<(String, String)>) -> Result<String, SignInError> {
    let mut cmd = Command::new(cli);
    cmd.args(["app", "--json", "--no-open"])
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| SignInError::CliFailed {
        detail: format!("Could not start {}: {e}", cli.display()),
    })?;
    let out = read_all(child.stdout.take().expect("piped stdout"));
    let err = read_all(child.stderr.take().expect("piped stderr"));
    let deadline = Instant::now() + CLI_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(SignInError::CliFailed {
                    detail: format!(
                        "orbit app did not answer within {} s.",
                        CLI_TIMEOUT.as_secs()
                    ),
                });
            }
            Err(e) => {
                return Err(SignInError::CliFailed {
                    detail: e.to_string(),
                })
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if !status.success() {
        let detail = tail(&stderr, 600);
        return Err(SignInError::CliFailed {
            detail: if detail.is_empty() {
                format!("orbit app exited with {status}.")
            } else {
                detail
            },
        });
    }
    Ok(stdout)
}

/// Find the CLI, ask it for a sign-in link, check the link.
pub fn sign_in() -> Result<SignInLink, SignInError> {
    let source: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    let cli = find_cli(&source).ok_or(SignInError::CliMissing)?;
    let env = childenv::build(&source, cli.parent());
    parse_link(&run_cli(&cli, env)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_link_orbit_app_prints() {
        let link = parse_link(
            r#"{"url":"http://127.0.0.1:7420/login#ticket=0123456789abcdef","expiresAt":"2026-10-05T12:00:00.000Z"}"#,
        )
        .expect("a valid link");
        assert_eq!(link.origin, "http://127.0.0.1:7420");
        assert_eq!(link.url.fragment(), Some("ticket=0123456789abcdef"));
    }

    #[test]
    fn refuses_anything_but_a_loopback_sign_in_link() {
        for bad in [
            "",
            "not json",
            r#"{"url":"https://evil.example/login#ticket=x"}"#,
            r#"{"url":"http://192.168.1.2:7420/login#ticket=x"}"#,
            r#"{"url":"https://127.0.0.1:7420/login#ticket=x"}"#,
            r#"{"url":"http://127.0.0.1:7420/runs#ticket=x"}"#,
            r#"{"url":"http://127.0.0.1:7420/login"}"#,
            r#"{"url":"http://127.0.0.1:7420/login#ticket="}"#,
            r#"{"url":"file:///login#ticket=x"}"#,
        ] {
            assert!(parse_link(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn orbit_cli_must_be_an_absolute_existing_file() {
        let env = vec![("ORBIT_CLI".to_string(), "orbit".to_string())];
        assert!(find_cli(&env).is_none());
        let me = std::env::current_exe().unwrap();
        let env = vec![("ORBIT_CLI".to_string(), me.display().to_string())];
        assert_eq!(find_cli(&env), Some(me));
    }

    #[test]
    fn cli_output_is_shown_as_plain_text_and_bounded() {
        assert_eq!(tail("a\u{1b}[31mb\u{7}c\n", 100), "a[31mbc");
        assert_eq!(tail("abcdef", 3), "\u{2026}def");
    }
}
