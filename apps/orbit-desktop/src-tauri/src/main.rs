//! Orbit's desktop shell (ADR-017, the "loads the App from orbitd" option of
//! ADR-011). The window first shows a bundled start page, asks the `orbit`
//! CLI for a one-time sign-in link and then navigates to orbitd's own origin,
//! so the App runs exactly as in a browser: HttpOnly session cookie, CSRF
//! header, orbitd's CSP. The remote page gets no Tauri IPC (no capability
//! names it), the window never leaves that origin, and no API token ever
//! reaches the webview.

// No console window next to the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod childenv;
mod navigation;
mod signin;

use std::sync::{Arc, Mutex};
use std::thread;

use navigation::{decide, Decision};
use signin::SignInError;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// orbitd's origin once the window was sent to its sign-in link.
type SignedIn = Arc<Mutex<Option<String>>>;

fn signed_in(state: &SignedIn) -> Option<String> {
    state.lock().map(|o| o.clone()).unwrap_or(None)
}

/// Open a web link in the system browser (never in this window).
fn open_externally(url: &Url) {
    if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        eprintln!("orbit-desktop: could not open a link in the browser: {e}");
    }
}

/// Back to the bundled page, which shows `error` (as text) and how to fix it.
fn show_problem(window: &WebviewWindow, state: &SignedIn, error: &SignInError) {
    if let Ok(mut origin) = state.lock() {
        *origin = None;
    }
    let shown = window
        .url()
        .ok()
        .filter(navigation::is_shell_page)
        .map(|mut page| {
            page.set_fragment(None);
            page.query_pairs_mut()
                .clear()
                .append_pair("error", &error.message())
                .append_pair("hint", &error.hint());
            window.navigate(page)
        });
    if !matches!(shown, Some(Ok(()))) {
        eprintln!("orbit-desktop: {} {}", error.message(), error.hint());
    }
}

fn main() {
    let state: SignedIn = Arc::new(Mutex::new(None));
    tauri::Builder::default()
        .setup(move |app| {
            let nav_state = state.clone();
            let popup_state = state.clone();
            let handle = app.handle().clone();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Orbit")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(900.0, 600.0)
                    .on_navigation(
                        move |url| match decide(url, signed_in(&nav_state).as_deref()) {
                            Decision::Allow => true,
                            Decision::OpenExternally => {
                                open_externally(url);
                                false
                            }
                            Decision::Block => false,
                        },
                    )
                    // window.open / target=_blank: never a second webview. Links within
                    // orbitd's origin stay in the main window; web links go to the browser.
                    .on_new_window(move |url, _features| {
                        match decide(&url, signed_in(&popup_state).as_deref()) {
                            Decision::Allow => {
                                if let Some(main) = handle.get_webview_window("main") {
                                    let _ = main.navigate(url);
                                }
                            }
                            Decision::OpenExternally => open_externally(&url),
                            Decision::Block => {}
                        }
                        NewWindowResponse::Deny
                    })
                    .build()?;

            let state = state.clone();
            thread::spawn(move || match signin::sign_in() {
                Ok(link) => {
                    // Allow the origin first: the navigation handler sees this load too.
                    if let Ok(mut origin) = state.lock() {
                        *origin = Some(link.origin.clone());
                    }
                    if let Err(e) = window.navigate(link.url) {
                        show_problem(
                            &window,
                            &state,
                            &SignInError::CliFailed {
                                detail: e.to_string(),
                            },
                        );
                    }
                }
                Err(error) => show_problem(&window, &state, &error),
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Orbit");
}
