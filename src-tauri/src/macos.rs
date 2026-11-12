//! macOS shell integration.
//!
//! On macOS the app follows platform conventions instead of the Windows-style
//! shell: a localized menu bar (⌘, opens Settings, ⌘Q quits, ⌘W closes the
//! window), a native status-bar menu with a template icon instead of the
//! webview tray popup, and Dock clicks that bring the main window back.
//!
//! Menus are rebuilt when the interface language changes, so the native
//! chrome always matches the renderer.

use std::sync::OnceLock;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::i18n;

pub const MENU_OPEN_SETTINGS: &str = "app.open-settings";
pub const MENU_QUIT: &str = "app.quit";
pub const MENU_SHOW_MAIN: &str = "app.show-main-window";
pub const MENU_RUN_DUE: &str = "app.run-due-scheduled-tasks";

/// Renderer event asking the main window to navigate to Settings.
pub const OPEN_SETTINGS_EVENT: &str = "desktop-open-settings";

const TRAY_ID: &str = "main";
const TRAY_TEMPLATE_ICON: &[u8] = include_bytes!("../icons/tray-template.png");

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

fn label(zh: &'static str, en: &'static str) -> &'static str {
    if i18n::is_english() {
        en
    } else {
        zh
    }
}

/// Installs the menu bar and the status-bar item. Call once from `setup`.
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let _ = APP_HANDLE.set(app.handle().clone());
    install_app_menu(app.handle())?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(TRAY_TEMPLATE_ICON)?)
        .icon_as_template(true)
        .tooltip("EasyConsole")
        .menu(&build_tray_menu(app.handle())?)
        .show_menu_on_left_click(true)
        .build(app)?;
    Ok(())
}

/// Re-renders native menus in the current interface language.
pub fn refresh_menus() {
    let Some(app) = APP_HANDLE.get() else {
        return;
    };
    if let Err(error) = install_app_menu(app) {
        log::warn!("failed to rebuild the macOS menu bar: {error}");
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_tray_menu(app) {
            Ok(menu) => {
                if let Err(error) = tray.set_menu(Some(menu)) {
                    log::warn!("failed to update the status-bar menu: {error}");
                }
            }
            Err(error) => log::warn!("failed to rebuild the status-bar menu: {error}"),
        }
    }
}

fn install_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let window_menu = build_window_menu(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &build_app_submenu(app)?,
            &build_edit_menu(app)?,
            &build_view_menu(app)?,
            &window_menu,
        ],
    )?;
    app.set_menu(menu)?;
    // Lets macOS list open windows (main window, SSH pop-outs) in this menu.
    window_menu.set_as_windows_menu_for_nsapp()?;
    Ok(())
}

fn build_app_submenu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    SubmenuBuilder::new(app, "EasyConsole")
        .item(&PredefinedMenuItem::about(
            app,
            Some(label("关于 EasyConsole", "About EasyConsole")),
            None,
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            MENU_OPEN_SETTINGS,
            label("设置…", "Settings…"),
            true,
            Some("CmdOrCtrl+,"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(
            app,
            Some(label("服务", "Services")),
        )?)
        .separator()
        .item(&PredefinedMenuItem::hide(
            app,
            Some(label("隐藏 EasyConsole", "Hide EasyConsole")),
        )?)
        .item(&PredefinedMenuItem::hide_others(
            app,
            Some(label("隐藏其他", "Hide Others")),
        )?)
        .item(&PredefinedMenuItem::show_all(
            app,
            Some(label("全部显示", "Show All")),
        )?)
        .separator()
        // A custom item rather than the predefined one: `terminate:` would
        // skip Tauri's exit path, so the app could not shut down cleanly.
        .item(&MenuItem::with_id(
            app,
            MENU_QUIT,
            label("退出 EasyConsole", "Quit EasyConsole"),
            true,
            Some("CmdOrCtrl+Q"),
        )?)
        .build()
}

fn build_edit_menu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    // Without these items WKWebView receives no ⌘C/⌘V/⌘X/⌘A/⌘Z at all.
    SubmenuBuilder::new(app, label("编辑", "Edit"))
        .item(&PredefinedMenuItem::undo(app, Some(label("撤销", "Undo")))?)
        .item(&PredefinedMenuItem::redo(app, Some(label("重做", "Redo")))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some(label("剪切", "Cut")))?)
        .item(&PredefinedMenuItem::copy(app, Some(label("拷贝", "Copy")))?)
        .item(&PredefinedMenuItem::paste(
            app,
            Some(label("粘贴", "Paste")),
        )?)
        .item(&PredefinedMenuItem::select_all(
            app,
            Some(label("全选", "Select All")),
        )?)
        .build()
}

fn build_view_menu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    SubmenuBuilder::new(app, label("显示", "View"))
        .item(&PredefinedMenuItem::fullscreen(
            app,
            Some(label("进入全屏幕", "Enter Full Screen")),
        )?)
        .build()
}

fn build_window_menu(app: &AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    SubmenuBuilder::new(app, label("窗口", "Window"))
        .item(&PredefinedMenuItem::minimize(
            app,
            Some(label("最小化", "Minimize")),
        )?)
        .item(&PredefinedMenuItem::maximize(
            app,
            Some(label("缩放", "Zoom")),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            MENU_SHOW_MAIN,
            label("EasyConsole 主窗口", "EasyConsole Main Window"),
            true,
            Some("CmdOrCtrl+0"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::close_window(
            app,
            Some(label("关闭窗口", "Close Window")),
        )?)
        .item(&PredefinedMenuItem::bring_all_to_front(
            app,
            Some(label("前置全部窗口", "Bring All to Front")),
        )?)
        .build()
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(
                app,
                MENU_SHOW_MAIN,
                label("显示主窗口", "Show Main Window"),
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                MENU_RUN_DUE,
                label("执行到期计划", "Run Due Schedules"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                MENU_QUIT,
                label("退出 EasyConsole", "Quit EasyConsole"),
                true,
                None::<&str>,
            )?,
        ],
    )
}

/// The Dock icon was clicked. macOS only restores windows it still considers
/// open, so a main window hidden by "close to background" must be shown here.
pub fn should_restore_main_window(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_template_icon_is_a_retina_menu_bar_glyph() {
        let icon = Image::from_bytes(TRAY_TEMPLATE_ICON).expect("tray icon decodes");
        // tray-icon scales the image to 18pt tall; 36px keeps it crisp @2x.
        assert_eq!((icon.width(), icon.height()), (36, 36));
        // Template images must be monochrome: every visible pixel is black.
        for pixel in icon.rgba().chunks_exact(4) {
            if pixel[3] > 0 {
                assert_eq!(&pixel[..3], &[0, 0, 0]);
            }
        }
    }
}
