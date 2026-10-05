//! Where the main window may go (ADR-017). Before sign-in only the bundled
//! start/error page; after it only orbitd's own origin, so the App keeps its
//! cookie + CSRF session and orbitd's CSP. Web links open in the system
//! browser; anything else (file:, custom schemes, javascript:) goes nowhere.

use tauri::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    OpenExternally,
    Block,
}

/// The bundled page: `tauri://localhost` (macOS, Linux) or
/// `http(s)://tauri.localhost` (Windows).
pub fn is_shell_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

fn is_web(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// `signed_in`: orbitd's origin (`http://127.0.0.1:7420`) once the window
/// was sent to its sign-in link.
pub fn decide(url: &Url, signed_in: Option<&str>) -> Decision {
    if url.as_str() == "about:blank" {
        return Decision::Allow;
    }
    match signed_in {
        Some(origin) if url.origin().ascii_serialization() == origin => Decision::Allow,
        None if is_shell_page(url) => Decision::Allow,
        _ if is_web(url) && !is_shell_page(url) => Decision::OpenExternally,
        _ => Decision::Block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    const ORBITD: &str = "http://127.0.0.1:7420";

    #[test]
    fn before_sign_in_only_the_bundled_page() {
        assert_eq!(
            decide(&u("tauri://localhost/index.html"), None),
            Decision::Allow
        );
        assert_eq!(
            decide(&u("http://tauri.localhost/index.html?error=x"), None),
            Decision::Allow
        );
        assert_eq!(
            decide(&u("http://127.0.0.1:7420/login"), None),
            Decision::OpenExternally
        );
    }

    #[test]
    fn after_sign_in_only_orbitd_origin() {
        let signed_in = Some(ORBITD);
        assert_eq!(
            decide(&u("http://127.0.0.1:7420/login#ticket=abc"), signed_in),
            Decision::Allow
        );
        assert_eq!(
            decide(&u("http://127.0.0.1:7420/runs/r1"), signed_in),
            Decision::Allow
        );
        // The bundled page is not reachable from orbitd's page.
        assert_eq!(
            decide(&u("tauri://localhost/index.html"), signed_in),
            Decision::Block
        );
        assert_eq!(
            decide(&u("http://tauri.localhost/index.html"), signed_in),
            Decision::Block
        );
        // Another port or host name is another origin.
        assert_eq!(
            decide(&u("http://127.0.0.1:5173/"), signed_in),
            Decision::OpenExternally
        );
        assert_eq!(
            decide(&u("http://localhost:7420/"), signed_in),
            Decision::OpenExternally
        );
    }

    #[test]
    fn web_links_open_in_the_browser_and_nothing_else_opens_at_all() {
        let signed_in = Some(ORBITD);
        assert_eq!(
            decide(&u("https://github.com/x/y/pull/1"), signed_in),
            Decision::OpenExternally
        );
        assert_eq!(decide(&u("file:///etc/passwd"), signed_in), Decision::Block);
        assert_eq!(
            decide(&u("javascript:alert(1)"), signed_in),
            Decision::Block
        );
        assert_eq!(decide(&u("smb://host/share"), signed_in), Decision::Block);
        assert_eq!(decide(&u("about:blank"), signed_in), Decision::Allow);
    }
}
