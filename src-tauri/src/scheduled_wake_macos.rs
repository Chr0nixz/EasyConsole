//! macOS launchd wake-up, the counterpart of the Windows Task Scheduler task
//! in `scheduled_wake.rs`. A per-user LaunchAgent runs a JXA script every
//! minute that opens the app bundle only when a local plan is due. No
//! credentials or remote operations are delegated to the agent.
//!
//! launchd never wakes a sleeping Mac: `StartInterval` jobs that fall due
//! during sleep run once after the Mac wakes up.
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread::sleep;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::trf;

const SCHEDULED_TASKS_KEY: &str = "easy-console.scheduledTasks";
const LAUNCHCTL: &str = "/bin/launchctl";
const UNLOAD_TIMEOUT: Duration = Duration::from_secs(5);

fn agent_label(identifier: &str, data_dir: &Path) -> String {
    let hash = format!(
        "{:x}",
        Sha256::digest(data_dir.to_string_lossy().as_bytes())
    );
    format!("{identifier}.scheduled-wake.{}", &hash[..16])
}

/// `…/Name.app/Contents/MacOS/<exe>` → `…/Name.app`. Development builds run
/// outside a bundle and cannot be opened through LaunchServices.
fn app_bundle(exe: &Path) -> Option<&Path> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then_some(bundle)
}

/// JSON string literals are valid JavaScript string literals and escape every
/// control character, so paths reach the script verbatim.
fn js_string(value: &Path) -> String {
    serde_json::Value::String(value.to_string_lossy().into_owned()).to_string()
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Mirrors the PowerShell wake action: exit if the app already runs, read the
/// per-key record (or its `.bak`) once the store is migrated and the legacy
/// snapshot otherwise, and open the bundle for the first due pending plan.
/// A tombstone (record without `value`) never falls back to legacy data.
fn wake_script(exe: &Path, bundle: &Path, legacy_path: &Path) -> String {
    let key_hash = format!("{:x}", Sha256::digest(SCHEDULED_TASKS_KEY.as_bytes()));
    let store = legacy_path.with_extension("d");
    format!(
        r#"ObjC.import('AppKit');
const target = {target};
const bundle = {bundle};
const manifest = {manifest};
const recordPath = {record};
const legacy = {legacy};
const key = '{SCHEDULED_TASKS_KEY}';
function exists(path) {{ return $.NSFileManager.defaultManager.fileExistsAtPath(path); }}
function readText(path) {{
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (text.isNil()) throw new Error('Cannot read ' + path);
  return text.js;
}}
function readJson(path) {{
  try {{ return JSON.parse(readText(path)); }} catch (error) {{ return JSON.parse(readText(path + '.bak')); }}
}}
function pathOf(url) {{ return url.isNil() ? undefined : url.path.js; }}
function runningApp() {{
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (let i = 0; i < apps.count; i++) {{
    const app = apps.objectAtIndex(i);
    if (pathOf(app.bundleURL) === bundle || pathOf(app.executableURL) === target) return true;
  }}
  return false;
}}
function running() {{
  // Sessions without a window server fall back to the process list.
  try {{ if (runningApp()) return true; }} catch (error) {{}}
  const shell = Application.currentApplication();
  shell.includeStandardAdditions = true;
  const processes = shell.doShellScript('/bin/ps -x -o comm= -U "$(/usr/bin/id -u)"', {{ alteringLineEndings: false }});
  return processes.split('\n').indexOf(target) >= 0;
}}
function launch() {{
  const task = $.NSTask.launchedTaskWithLaunchPathArguments('/usr/bin/open', $(['-g', bundle]));
  task.waitUntilExit;
  if (task.terminationStatus !== 0) throw new Error('open exited with ' + task.terminationStatus);
}}
function wake() {{
  if (running()) return 'running';
  let raw;
  if (exists(manifest) || exists(manifest + '.bak')) {{
    const record = readJson(recordPath);
    if (record.key !== key || record.value == null) return '';
    raw = record.value;
  }} else {{
    raw = readJson(legacy)[key];
  }}
  if (!raw) return '';
  const now = Date.now();
  for (const plan of [].concat(JSON.parse(raw))) {{
    if (plan && plan.status === 'pending' && Date.parse(String(plan.scheduleTime)) <= now) {{
      launch();
      return 'launched';
    }}
  }}
  return '';
}}
wake();"#,
        target = js_string(exe),
        bundle = js_string(bundle),
        manifest = js_string(&store.join("manifest.json")),
        record = js_string(&store.join(format!("{key_hash}.json"))),
        legacy = js_string(legacy_path),
    )
}

/// `RunAtLoad` checks right after login; `LimitLoadToSessionType` keeps the
/// agent out of SSH and background sessions, where `open` has no GUI.
fn agent_plist(label: &str, identifier: &str, script: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{label}</string>
	<key>AssociatedBundleIdentifiers</key>
	<array>
		<string>{identifier}</string>
	</array>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/osascript</string>
		<string>-l</string>
		<string>JavaScript</string>
		<string>-e</string>
		<string>{script}</string>
	</array>
	<key>StartInterval</key>
	<integer>60</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>ProcessType</key>
	<string>Background</string>
</dict>
</plist>
"#,
        label = xml_escape(label),
        identifier = xml_escape(identifier),
        script = xml_escape(script),
    )
}

fn uid() -> u32 {
    extern "C" {
        fn getuid() -> u32;
    }
    // SAFETY: getuid(2) takes no arguments, has no preconditions and always succeeds.
    unsafe { getuid() }
}

fn launchctl(args: &[&str]) -> Result<Output, String> {
    Command::new(LAUNCHCTL)
        .args(args)
        .output()
        .map_err(|error| {
            trf!(
                "无法访问 launchd：{error}",
                "Cannot access launchd: {error}"
            )
        })
}

fn launchctl_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    trf!(
        "launchd 操作失败：{detail}",
        "launchd operation failed: {detail}"
    )
}

fn is_loaded(service: &str) -> Result<bool, String> {
    Ok(launchctl(&["print", service])?.status.success())
}

/// A label turned off under System Settings › General › Login Items, which
/// launchd refuses to bootstrap. Respect it instead of overriding it.
fn is_disabled(domain: &str, label: &str) -> bool {
    let Ok(output) = launchctl(&["print-disabled", domain]) else {
        return false;
    };
    let needle = format!("\"{label}\" =>");
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let line = line.trim();
        line.starts_with(&needle) && (line.ends_with("disabled") || line.ends_with("true"))
    })
}

fn unload(service: &str) -> Result<(), String> {
    if !is_loaded(service)? {
        return Ok(());
    }
    let output = launchctl(&["bootout", service])?;
    // bootout can return before launchd has finished tearing the job down.
    let deadline = Instant::now() + UNLOAD_TIMEOUT;
    while is_loaded(service)? {
        if Instant::now() >= deadline {
            return Err(launchctl_error(&output));
        }
        sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn remove_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(trf!(
            "无法删除 LaunchAgent：{error}",
            "Cannot remove the LaunchAgent: {error}"
        )),
        _ => Ok(()),
    }
}

fn write_plist(path: &Path, contents: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let write_error = |error: std::io::Error| {
        trf!(
            "无法写入 LaunchAgent：{error}",
            "Cannot write the LaunchAgent: {error}"
        )
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(write_error)?;
    }
    let staged = PathBuf::from(format!("{}.tmp", path.display()));
    fs::write(&staged, contents).map_err(write_error)?;
    // launchd ignores agents that are writable by group or others.
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o644)).map_err(write_error)?;
    fs::rename(&staged, path).map_err(write_error)
}

fn bundle_for(exe: &Path) -> Result<&Path, String> {
    let bundle = app_bundle(exe).ok_or_else(|| {
        trf!(
            "只有打包后的 EasyConsole.app 才能开启此功能，开发版本没有应用包。",
            "Only the packaged EasyConsole.app can turn this on; development builds have no app bundle."
        )
    })?;
    if bundle.to_string_lossy().contains("/AppTranslocation/") {
        return Err(trf!(
            "macOS 正从临时位置运行 EasyConsole。请先将其移到“应用程序”文件夹，重新打开后再开启。",
            "macOS is running EasyConsole from a temporary location. Move it to the Applications folder, reopen it, and try again."
        ));
    }
    Ok(bundle)
}

/// `None` queries, `Some(_)` applies; returns whether the agent file exists
/// and launchd has it loaded. `launch_agents` is `~/Library/LaunchAgents`.
pub fn configure(
    exe: &Path,
    legacy_path: &Path,
    identifier: &str,
    launch_agents: &Path,
    enabled: Option<bool>,
) -> Result<bool, String> {
    let data_dir = legacy_path
        .parent()
        .ok_or_else(|| trf!("无效数据目录", "Invalid data directory"))?;
    let label = agent_label(identifier, data_dir);
    let plist = launch_agents.join(format!("{label}.plist"));
    let domain = format!("gui/{}", uid());
    let service = format!("{domain}/{label}");
    match enabled {
        None => {}
        Some(false) => {
            unload(&service)?;
            remove_file(&plist)?;
        }
        Some(true) => {
            let bundle = bundle_for(exe)?;
            let script = wake_script(exe, bundle, legacy_path);
            write_plist(&plist, &agent_plist(&label, identifier, &script))?;
            let plist_arg = plist.to_string_lossy();
            let loaded = unload(&service)
                .and_then(|()| launchctl(&["bootstrap", &domain, &plist_arg]))
                .and_then(|output| {
                    if output.status.success() {
                        Ok(())
                    } else if is_disabled(&domain, &label) {
                        Err(trf!(
                            "EasyConsole 的后台项目已在“系统设置 › 通用 › 登录项与扩展”中关闭。请在那里允许后台运行后重试。",
                            "EasyConsole's background item is turned off in System Settings › General › Login Items & Extensions. Allow it in the background there and try again."
                        ))
                    } else {
                        Err(launchctl_error(&output))
                    }
                });
            if let Err(error) = loaded {
                let _ = remove_file(&plist);
                return Err(error);
            }
        }
    }
    Ok(plist.is_file() && is_loaded(&service)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_label_is_scoped_to_identifier_and_data_dir() {
        let data = Path::new("/Users/me/Library/Application Support/com.easyconsole.desktop");
        let label = agent_label("com.easyconsole.desktop", data);
        assert_eq!(label, agent_label("com.easyconsole.desktop", data));
        assert!(label.starts_with("com.easyconsole.desktop.scheduled-wake."));
        assert_eq!(label.rsplit('.').next().unwrap().len(), 16);
        assert_ne!(
            label,
            agent_label("com.easyconsole.desktop", Path::new("/other"))
        );
        assert_ne!(label, agent_label("com.easyconsole.acceptance", data));
    }

    #[test]
    fn only_installed_app_bundles_can_be_opened() {
        let exe = Path::new("/Applications/EasyConsole.app/Contents/MacOS/EasyConsole");
        assert_eq!(
            app_bundle(exe),
            Some(Path::new("/Applications/EasyConsole.app"))
        );
        assert!(app_bundle(Path::new("/repo/src-tauri/target/debug/EasyConsole")).is_none());
        assert!(app_bundle(Path::new("/Applications/EasyConsole/Contents/MacOS/x")).is_none());
        assert!(bundle_for(exe).is_ok());
        assert!(bundle_for(Path::new(
            "/private/var/folders/x/AppTranslocation/1234/d/EasyConsole.app/Contents/MacOS/EasyConsole"
        ))
        .is_err());
    }

    #[test]
    fn agent_has_no_credentials_and_checks_every_minute_in_the_gui_session() {
        let plist = agent_plist(
            "com.easyconsole.desktop.scheduled-wake.0123456789abcdef",
            "com.easyconsole.desktop",
            "const a = '<&>\"';",
        );
        assert!(plist.contains("<key>StartInterval</key>\n\t<integer>60</integer>"));
        assert!(plist.contains("<string>/usr/bin/osascript</string>"));
        assert!(plist.contains("<string>JavaScript</string>"));
        assert!(plist.contains("<string>Aqua</string>"));
        assert!(plist.contains("<string>com.easyconsole.desktop</string>"));
        assert!(plist.contains("const a = &apos;&lt;&amp;&gt;&quot;&apos;;"));
        assert!(!plist.contains("KeepAlive"));
        assert!(!plist.to_lowercase().contains("password"));
        assert!(!plist.to_lowercase().contains("token"));
    }

    #[test]
    fn paths_are_literal_and_script_checks_pending_due_and_existing_process() {
        let script = wake_script(
            Path::new("/Apps/O'Brien \"$app\"\n.app/Contents/MacOS/EasyConsole"),
            Path::new("/Apps/O'Brien \"$app\"\n.app"),
            Path::new("/Data/runtime-storage.json"),
        );
        assert!(script.contains(r#"const bundle = "/Apps/O'Brien \"$app\"\n.app";"#));
        assert!(script.contains("const manifest = \"/Data/runtime-storage.d/manifest.json\";"));
        let key_hash = format!("{:x}", Sha256::digest(SCHEDULED_TASKS_KEY.as_bytes()));
        assert!(script.contains(&format!("runtime-storage.d/{key_hash}.json")));
        assert!(script.contains("if (running()) return 'running';"));
        assert!(script.contains("plan.status === 'pending'"));
        assert!(script.contains("<= now"));
        assert!(script.contains("manifest + '.bak'"));
        assert!(script.contains("path + '.bak'"));
        assert!(script.contains("record.value == null"));
        assert!(script.contains("'/usr/bin/open', $(['-g', bundle])"));
    }

    /// Runs the production script in real `osascript`, with only `launch()`
    /// replaced (a later function declaration wins), as the Windows test does
    /// with real PowerShell.
    fn run_wake(exe: &Path, bundle: &Path, legacy_path: &Path) -> String {
        let script = format!(
            "{}\nfunction launch() {{}}\n",
            wake_script(exe, bundle, legacy_path)
        );
        let output = Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript", "-e", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn running_app_lookup_handles_every_registered_process() {
        // Runs only the NSWorkspace pass, without its fallback, so a process
        // without a bundle URL cannot silently abort the lookup.
        let check = |bundle: &str, exe: &str| {
            let script = format!(
                "{}\nfunction wake() {{ return String(runningApp()); }}\n",
                wake_script(Path::new(exe), Path::new(bundle), Path::new("/x/s.json"))
            );
            let output = Command::new("/usr/bin/osascript")
                .args(["-l", "JavaScript", "-e", &script])
                .output()
                .unwrap();
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(output.status.success(), "{stderr}");
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        assert_eq!(
            check("/Missing.app", "/Missing.app/Contents/MacOS/x"),
            "false"
        );
        let dock_running = Command::new("/usr/bin/pgrep")
            .args(["-x", "Dock"])
            .output()
            .is_ok_and(|output| output.status.success());
        if dock_running {
            let dock = "/System/Library/CoreServices/Dock.app";
            assert_eq!(check(dock, "/Missing"), "true");
            assert_eq!(
                check("/Missing.app", &format!("{dock}/Contents/MacOS/Dock")),
                "true"
            );
        }
    }

    #[test]
    fn real_launch_runs_open_and_reports_its_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        let due = r#"{"status":"pending","scheduleTime":"2000-01-01T00:00:00Z"}"#;
        let legacy =
            std::collections::HashMap::from([(SCHEDULED_TASKS_KEY.to_string(), due.to_string())]);
        crate::write_string_map(&path, &legacy).unwrap();
        // A bundle that does not exist: `open` fails without starting anything.
        let bundle = dir.path().join("Missing.app");
        let script = wake_script(&bundle.join("Contents/MacOS/EasyConsole"), &bundle, &path);
        let output = Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript", "-e", &script])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("open exited with 1"));
    }

    #[test]
    fn wake_action_reads_migrated_data_and_never_revives_deleted_legacy_plans() {
        let dir = tempfile::Builder::new()
            .prefix("ec-wake-'unicode-中文-")
            .tempdir()
            .unwrap();
        let path = dir.path().join("runtime-storage.json");
        let bundle = dir.path().join("Not \"Real\" $App.app");
        let exe = bundle.join("Contents/MacOS/EasyConsole");
        let due = r#"[{"id":"due","status":"pending","scheduleTime":"2000-01-01T00:00:00Z"}]"#;
        let future = r#"[{"status":"pending","scheduleTime":"2099-01-01T00:00:00Z"}]"#;
        let legacy =
            std::collections::HashMap::from([(SCHEDULED_TASKS_KEY.to_string(), due.to_string())]);
        crate::write_string_map(&path, &legacy).unwrap();
        assert_eq!(run_wake(&exe, &bundle, &path), "launched");

        let store = crate::runtime_storage::RuntimeStore::open(&path).unwrap();
        assert_eq!(run_wake(&exe, &bundle, &path), "launched");
        store
            .set(
                SCHEDULED_TASKS_KEY,
                r#"[{"status":"paused","scheduleTime":"2000-01-01T00:00:00Z"}]"#,
            )
            .unwrap();
        assert_eq!(run_wake(&exe, &bundle, &path), "");
        store.set(SCHEDULED_TASKS_KEY, future).unwrap();
        assert_eq!(run_wake(&exe, &bundle, &path), "");

        // A corrupt record falls back to its backup, which still holds `future`.
        store.set(SCHEDULED_TASKS_KEY, due).unwrap();
        let key_hash = format!("{:x}", Sha256::digest(SCHEDULED_TASKS_KEY.as_bytes()));
        let record = path.with_extension("d").join(format!("{key_hash}.json"));
        assert_eq!(run_wake(&exe, &bundle, &path), "launched");
        fs::write(&record, "broken JSON").unwrap();
        assert_eq!(run_wake(&exe, &bundle, &path), "");

        // The legacy snapshot still holds `due`; a tombstone must win over it.
        store.set(SCHEDULED_TASKS_KEY, due).unwrap();
        store.remove(SCHEDULED_TASKS_KEY).unwrap();
        assert_eq!(run_wake(&exe, &bundle, &path), "");
    }

    #[test]
    fn wake_action_exits_while_the_app_is_running() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        let due = r#"[{"status":"pending","scheduleTime":"2000-01-01T00:00:00Z"}]"#;
        let legacy =
            std::collections::HashMap::from([(SCHEDULED_TASKS_KEY.to_string(), due.to_string())]);
        crate::write_string_map(&path, &legacy).unwrap();
        // `ps -o comm` reports argv[0], which is the absolute executable path
        // for apps started by LaunchServices and for this test binary.
        let running = PathBuf::from(std::env::args().next().unwrap());
        let bundle = dir.path().join("Missing.app");
        assert_eq!(run_wake(&running, &bundle, &path), "running");
        assert_eq!(
            run_wake(&dir.path().join("not-running"), &bundle, &path),
            "launched"
        );
    }

    #[test]
    fn generated_plist_is_valid_and_carries_the_script_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let script = wake_script(
            Path::new("/Apps/A & <B> 'C'.app/Contents/MacOS/EasyConsole"),
            Path::new("/Apps/A & <B> 'C'.app"),
            Path::new("/Data/runtime-storage.json"),
        );
        let file = dir.path().join("agent.plist");
        fs::write(
            &file,
            agent_plist("com.example.wake", "com.example", &script),
        )
        .unwrap();
        let lint = Command::new("/usr/bin/plutil")
            .args(["-lint", "-s"])
            .arg(&file)
            .status()
            .unwrap();
        assert!(lint.success());
        let extracted = Command::new("/usr/bin/plutil")
            .args(["-extract", "ProgramArguments.4", "raw", "-o", "-"])
            .arg(&file)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(extracted.stdout).unwrap().trim_end(),
            script
        );
    }

    /// Runs a loaded agent once through launchd and returns its exit code.
    /// `kickstart` itself waits out launchd's 10 s spawn throttle.
    fn kickstart(service: &str) -> String {
        let print = || {
            String::from_utf8_lossy(&launchctl(&["print", service]).unwrap().stdout).into_owned()
        };
        let field = |text: &str, name: &str| {
            text.lines()
                .find_map(|line| line.trim().strip_prefix(name).map(str::to_string))
        };
        let runs = field(&print(), "runs = ");
        assert!(launchctl(&["kickstart", "-k", service])
            .unwrap()
            .status
            .success());
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let text = print();
            if field(&text, "runs = ") != runs && text.contains("state = not running") {
                return field(&text, "last exit code = ").unwrap();
            }
            assert!(Instant::now() < deadline, "{text}");
            sleep(Duration::from_millis(100));
        }
    }

    #[test]
    #[ignore = "loads and removes an isolated LaunchAgent; run explicitly for local acceptance"]
    fn macos_launch_agent_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        fs::write(&path, "{}").unwrap();
        let agents = dir.path().join("LaunchAgents");
        let exe = dir
            .path()
            .join("EasyConsole.app/Contents/MacOS/EasyConsole");
        let identifier = "com.easyconsole.test";
        struct Cleanup<'a>(&'a Path, &'a Path, &'a Path);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = configure(self.0, self.1, "com.easyconsole.test", self.2, Some(false));
            }
        }
        let _cleanup = Cleanup(&exe, &path, &agents);
        let label = agent_label(identifier, dir.path());
        let plist = agents.join(format!("{label}.plist"));
        let service = format!("gui/{}/{label}", uid());

        assert!(!configure(&exe, &path, identifier, &agents, None).unwrap());
        assert!(configure(&exe, &path, identifier, &agents, Some(true)).unwrap());
        assert!(plist.is_file() && is_loaded(&service).unwrap());
        assert!(configure(&exe, &path, identifier, &agents, None).unwrap());
        // launchd runs the script in the GUI session: nothing due exits cleanly,
        // and a due plan reaches `open`, which fails for this missing bundle.
        assert_eq!(kickstart(&service), "0");
        let due = r#"[{"status":"pending","scheduleTime":"2000-01-01T00:00:00Z"}]"#;
        let legacy =
            std::collections::HashMap::from([(SCHEDULED_TASKS_KEY.to_string(), due.to_string())]);
        crate::write_string_map(&path, &legacy).unwrap();
        assert_eq!(kickstart(&service), "1");
        // Re-enabling replaces the loaded agent in place.
        assert!(configure(&exe, &path, identifier, &agents, Some(true)).unwrap());
        assert!(!configure(&exe, &path, identifier, &agents, Some(false)).unwrap());
        assert!(!plist.exists() && !is_loaded(&service).unwrap());
        assert!(!configure(&exe, &path, identifier, &agents, Some(false)).unwrap());
        assert!(!configure(&exe, &path, identifier, &agents, None).unwrap());
        assert!(configure(
            &dir.path().join("dev-binary"),
            &path,
            identifier,
            &agents,
            Some(true)
        )
        .is_err());
        assert!(!plist.exists());
    }
}
