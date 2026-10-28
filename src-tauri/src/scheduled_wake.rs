//! Windows Task Scheduler wake-up. No credentials or remote operations are
//! delegated to the OS task: it starts the desktop runner only when due.
use std::path::Path;
use std::process::Command;

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::trf;

fn ps_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn encoded_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn task_name(data_dir: &Path) -> String {
    let hash = format!(
        "{:x}",
        Sha256::digest(data_dir.to_string_lossy().as_bytes())
    );
    format!("EasyConsole-ScheduledWake-{}", &hash[..16])
}

fn wake_script(exe: &Path, legacy_path: &Path) -> String {
    let key_hash = format!("{:x}", Sha256::digest(b"easy-console.scheduledTasks"));
    let store = legacy_path.with_extension("d");
    let record = store.join(format!("{key_hash}.json"));
    format!(
        r#"$ErrorActionPreference='Stop'
$target={target}
if (Get-Process -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq $target }}) {{ exit 0 }}
function Read-Json([string]$path) {{
  try {{ return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json }} catch {{
    return Get-Content -LiteralPath ($path+'.bak') -Raw -Encoding UTF8 | ConvertFrom-Json
  }}
}}
if ((Test-Path -LiteralPath {manifest}) -or (Test-Path -LiteralPath {manifest_backup})) {{
  $record=Read-Json {record}
  if ($record.key -ne 'easy-console.scheduledTasks' -or $null -eq $record.value) {{ exit 0 }}
  $raw=$record.value
}} else {{
  $legacy=Read-Json {legacy}
  $raw=$legacy.'easy-console.scheduledTasks'
}}
if (!$raw) {{ exit 0 }}
$now=[DateTimeOffset]::Now
foreach ($plan in @($raw | ConvertFrom-Json)) {{
  $at=[DateTimeOffset]::MinValue
  if ($plan.status -eq 'pending' -and [DateTimeOffset]::TryParse([string]$plan.scheduleTime,[ref]$at) -and $at -le $now) {{
    Start-Process -FilePath $target -WindowStyle Hidden
    break
  }}
}}"#,
        target = ps_string(&exe.to_string_lossy()),
        manifest = ps_string(&store.join("manifest.json").to_string_lossy()),
        manifest_backup = ps_string(&store.join("manifest.json.bak").to_string_lossy()),
        record = ps_string(&record.to_string_lossy()),
        legacy = ps_string(&legacy_path.to_string_lossy()),
    )
}

fn task_xml(exe: &Path, legacy_path: &Path) -> String {
    let command = encoded_command(&wake_script(exe, legacy_path));
    format!(
        r#"<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>Start EasyConsole for due local schedules. Requires an interactive login.</Description></RegistrationInfo>
<Triggers><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>__START__</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
<Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT1M</ExecutionTimeLimit><WakeToRun>true</WakeToRun></Settings>
<Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {command}</Arguments></Exec></Actions>
</Task>"#
    )
}

fn powershell(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encoded_command(script),
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|error| {
            trf!(
                "无法访问系统计划任务：{error}",
                "Cannot access Task Scheduler: {error}"
            )
        })?;
    if !output.status.success() {
        return Err(trf!(
            "系统计划任务操作失败：{}",
            "Task Scheduler operation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn configure(exe: &Path, legacy_path: &Path, enabled: Option<bool>) -> Result<bool, String> {
    let name = task_name(
        legacy_path
            .parent()
            .ok_or_else(|| trf!("无效数据目录", "Invalid data directory"))?,
    );
    let setup = format!(
        "$ErrorActionPreference='Stop';$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$root=$s.GetFolder('\\');$name={};$task=@($root.GetTasks(1)|Where-Object {{$_.Name -eq $name}});",
        ps_string(&name)
    );
    let script = match enabled {
        None => format!(
            "{setup}[bool]($task.Count -gt 0 -and $task[0].Enabled) | ConvertTo-Json -Compress"
        ),
        Some(false) => {
            format!("{setup}if($task.Count -gt 0){{$root.DeleteTask($name,0)}}; 'false'")
        }
        Some(true) => {
            let xml = ps_string(&task_xml(exe, legacy_path));
            format!("{setup}$xml={xml};$xml=$xml.Replace('__START__',(Get-Date).AddMinutes(1).ToString('s'));$null=$root.RegisterTask($name,$xml,6,$null,$null,3,$null);'true'")
        }
    };
    match powershell(&script)?.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(trf!(
            "系统计划任务返回了无效状态",
            "Task Scheduler returned an invalid state"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_action_reads_migrated_data_and_never_revives_deleted_legacy_plans() {
        let dir = tempfile::Builder::new()
            .prefix("ec-wake-'unicode-")
            .tempdir()
            .unwrap();
        let path = dir.path().join("runtime-storage.json");
        let exe = dir.path().join("not-a-real-app.exe");
        let due = r#"[{"id":"due","status":"pending","scheduleTime":"2000-01-01T00:00:00Z"}]"#;
        let legacy = std::collections::HashMap::from([(
            "easy-console.scheduledTasks".to_string(),
            due.to_string(),
        )]);
        crate::write_string_map(&path, &legacy).unwrap();
        // Intercept only process launch; the production JSON parsing and due
        // checks still run in real Windows PowerShell, without starting an app.
        let script = format!("function Start-Process {{ param($FilePath,$WindowStyle); Write-Output 'launched' }}\n{}", wake_script(&exe, &path));
        assert_eq!(powershell(&script).unwrap(), "launched");
        let store = crate::runtime_storage::RuntimeStore::open(&path).unwrap();
        assert_eq!(powershell(&script).unwrap(), "launched");
        store
            .set(
                "easy-console.scheduledTasks",
                r#"[{"status":"paused","scheduleTime":"2000-01-01T00:00:00Z"}]"#,
            )
            .unwrap();
        assert_eq!(powershell(&script).unwrap(), "");
        store
            .set(
                "easy-console.scheduledTasks",
                r#"[{"status":"pending","scheduleTime":"2099-01-01T00:00:00Z"}]"#,
            )
            .unwrap();
        assert_eq!(powershell(&script).unwrap(), "");
        store.remove("easy-console.scheduledTasks").unwrap();
        assert_eq!(powershell(&script).unwrap(), "");
    }

    #[test]
    #[ignore = "creates and removes an isolated OS task; run explicitly for local acceptance"]
    fn windows_task_registration_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtime-storage.json");
        std::fs::write(&path, "{}").unwrap();
        let exe = dir.path().join("EasyConsole.exe");
        struct Cleanup<'a>(&'a Path, &'a Path);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = configure(self.0, self.1, Some(false));
            }
        }
        let _cleanup = Cleanup(&exe, &path);
        assert!(!configure(&exe, &path, None).unwrap());
        assert!(configure(&exe, &path, Some(true)).unwrap());
        assert!(configure(&exe, &path, None).unwrap());
        assert!(!configure(&exe, &path, Some(false)).unwrap());
        assert!(!configure(&exe, &path, Some(false)).unwrap());
        assert!(!configure(&exe, &path, None).unwrap());
    }

    #[test]
    fn task_has_no_credentials_and_runs_as_interactive_user() {
        let xml = task_xml(
            Path::new(r"C:\Apps\EasyConsole.exe"),
            Path::new(r"C:\Data\runtime-storage.json"),
        );
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(xml.contains("<Interval>PT1M</Interval>"));
        assert!(xml.contains("<WakeToRun>true</WakeToRun>"));
        assert!(!xml.contains("Password"));
    }

    #[test]
    fn paths_are_literal_and_script_checks_pending_due_and_existing_process() {
        let script = wake_script(
            Path::new(r"C:\Apps\O'Brien $app\EasyConsole.exe"),
            Path::new(r"C:\Data\runtime-storage.json"),
        );
        assert!(script.contains("O''Brien $app"));
        assert!(script.contains("$_.Path -eq $target"));
        assert!(script.contains("$plan.status -eq 'pending'"));
        assert!(script.contains("$at -le $now"));
        assert!(script.contains("manifest.json.bak"));
        assert!(script.contains(".bak'"));
    }

    #[test]
    fn stable_task_name_and_utf16_command_roundtrip() {
        assert_eq!(
            task_name(Path::new(r"C:\Data")),
            task_name(Path::new(r"C:\Data"))
        );
        assert_ne!(
            task_name(Path::new(r"C:\Data")),
            task_name(Path::new(r"C:\Other"))
        );
        let script = "Write-Output '中文'";
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded_command(script))
            .unwrap();
        let words: Vec<u16> = decoded
            .chunks_exact(2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .collect();
        assert_eq!(String::from_utf16(&words).unwrap(), script);
    }
}
