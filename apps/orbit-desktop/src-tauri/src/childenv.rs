//! The environment of the `orbit` child (ADR-005, mirrored from
//! `packages/runtime/src/env.ts`, kind `orbitd`): the CLI may start orbitd,
//! so it gets Orbit's settings and the API credentials orbitd hands the SDK
//! engine, and nothing else. OAuth tokens never pass, whatever their source.

use std::path::Path;

const BASE: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TERM",
    "COLORTERM",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    // Windows essentials
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "COMSPEC",
    "PATHEXT",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "PROGRAMDATA",
    "HOMEDRIVE",
    "HOMEPATH",
];

const NETWORK: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

/// Non-secret setting of the user's own `claude` CLI.
const CLI_ENGINE: &[&str] = &["CLAUDE_CONFIG_DIR"];

/// API and cloud credentials: orbitd hands them only to the SDK engine.
const SDK_ENGINE: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLOUD_ML_REGION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
];

const PREFIXES: &[&str] = &["LC_", "XDG_", "VERTEX_REGION_", "ORBIT_"];

/// Never in any environment Orbit builds.
pub const ALWAYS_DENIED: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
];

/// Environment variable names compare case-insensitively on Windows.
fn same(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// `prefix` (ASCII) starts `name`, ignoring ASCII case. Never slices inside a
/// character: a name that is not ASCII where the prefix ends simply does not match.
fn starts_ignore_case(name: &str, prefix: &str) -> bool {
    name.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn starts(name: &str, prefix: &str) -> bool {
    if cfg!(windows) {
        starts_ignore_case(name, prefix)
    } else {
        name.starts_with(prefix)
    }
}

fn allowed(name: &str) -> bool {
    if ALWAYS_DENIED.iter().any(|d| same(name, d)) {
        return false;
    }
    [BASE, NETWORK, CLI_ENGINE, SDK_ENGINE]
        .iter()
        .any(|list| list.iter().any(|n| same(name, n)))
        || PREFIXES.iter().any(|p| starts(name, p))
}

/// The child's variables: the allowlisted ones from `source`, with the CLI's
/// own folder first on PATH (its `#!/usr/bin/env node` needs the Node.js the
/// package was installed with; GUI apps on macOS start with a minimal PATH).
pub fn build(source: &[(String, String)], cli_dir: Option<&Path>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> =
        source.iter().filter(|(k, _)| allowed(k)).cloned().collect();
    if let Some(dir) = cli_dir.and_then(|d| d.to_str()) {
        let sep = if cfg!(windows) { ";" } else { ":" };
        match out.iter_mut().find(|(k, _)| same(k, "PATH")) {
            Some((_, v)) if !v.is_empty() => *v = format!("{dir}{sep}{v}"),
            Some((_, v)) => *v = dir.to_string(),
            None => out.push(("PATH".to_string(), dir.to_string())),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn oauth_tokens_and_unrelated_secrets_never_pass() {
        let env = build(
            &vars(&[
                ("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-never"),
                ("CLAUDE_CODE_SESSION_ACCESS_TOKEN", "never"),
                ("ANTHROPIC_AUTH_TOKEN", "never"),
                ("GITHUB_TOKEN", "ghp_unrelated"),
                ("SOME_RANDOM", "x"),
            ]),
            None,
        );
        assert!(env.is_empty(), "{env:?}");
    }

    #[test]
    fn orbit_settings_and_api_credentials_reach_the_cli() {
        let env = build(
            &vars(&[
                ("HOME", "/home/me"),
                ("ORBIT_HOME", "/home/me/.orbit"),
                ("ANTHROPIC_API_KEY", "sk-ant-api03-test"),
                ("LC_ALL", "C.UTF-8"),
                ("HTTPS_PROXY", "http://proxy:3128"),
            ]),
            None,
        );
        assert_eq!(get(&env, "HOME"), Some("/home/me"));
        assert_eq!(get(&env, "ORBIT_HOME"), Some("/home/me/.orbit"));
        assert_eq!(get(&env, "ANTHROPIC_API_KEY"), Some("sk-ant-api03-test"));
        assert_eq!(get(&env, "LC_ALL"), Some("C.UTF-8"));
        assert_eq!(get(&env, "HTTPS_PROXY"), Some("http://proxy:3128"));
    }

    #[test]
    fn windows_prefix_match_never_panics_on_non_ascii_names() {
        assert!(starts_ignore_case("lc_all", "LC_"));
        assert!(starts_ignore_case("Orbit_Home", "ORBIT_"));
        // The prefix would end inside a multi-byte character: no match, no panic.
        assert!(!starts_ignore_case("a\u{20ac}", "LC_"));
        assert!(!starts_ignore_case("\u{e9}\u{e9}\u{e9}x", "XDG_"));
        assert!(!starts_ignore_case("LC", "LC_"));
        assert!(!starts_ignore_case("", "LC_"));
    }

    #[test]
    fn the_cli_folder_goes_first_on_path() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let env = build(
            &vars(&[("PATH", "/usr/bin")]),
            Some(Path::new("/opt/homebrew/bin")),
        );
        assert_eq!(
            get(&env, "PATH"),
            Some(format!("/opt/homebrew/bin{sep}/usr/bin").as_str())
        );
        let env = build(&[], Some(Path::new("/opt/homebrew/bin")));
        assert_eq!(get(&env, "PATH"), Some("/opt/homebrew/bin"));
    }
}
