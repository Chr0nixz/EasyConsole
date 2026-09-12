//! Locale plumbing for the native side.
//!
//! The webview owns the language setting; Rust only needs to know which of the
//! two dictionaries to render. The frontend pushes the current locale through
//! the `set_locale` command on startup and whenever the user switches language.
//!
//! Message rendering goes through the `trf!` macro in `lib.rs`, which mirrors
//! `i18nText()` in `src/lib/i18n-text.ts`.

use std::sync::atomic::{AtomicBool, Ordering};

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// Update the active locale. Anything not starting with `en` selects Chinese,
/// matching `normalizeLocale()` on the TypeScript side.
pub fn set_locale(locale: &str) {
    ENGLISH.store(
        locale.to_ascii_lowercase().starts_with("en"),
        Ordering::Relaxed,
    );
}

pub fn is_english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}
