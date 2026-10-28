//! Fixed, read-only GPU probe over an already authenticated SSH connection.
use std::time::Duration;

use russh::{client, ChannelMsg};
use tokio::time::Instant;

use crate::ssh::host_key::EasyConsoleSshClient;
use crate::trf;

pub const GPU_PROBE_COMMAND: &str =
    "nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits";

const GPU_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const GPU_CHANNEL_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

fn parse_utilization(output: &[u8]) -> Result<Vec<f64>, String> {
    let raw = std::str::from_utf8(output)
        .map_err(|_| trf!("GPU 采样返回了无效文本", "GPU probe returned invalid text"))?;
    let values: Vec<f64> = raw
        .lines()
        .map(|line| line.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .map_err(|_| trf!("GPU 利用率不可用", "GPU utilization is unavailable"))?;
    if values.is_empty()
        || values.len() > 64
        || values
            .iter()
            .any(|value| !value.is_finite() || !(0.0..=100.0).contains(value))
    {
        return Err(trf!("GPU 利用率不可用", "GPU utilization is unavailable"));
    }
    Ok(values)
}

pub async fn read_utilization<R: tauri::Runtime>(
    session: &client::Handle<EasyConsoleSshClient<R>>,
) -> Result<Vec<f64>, String> {
    let deadline = Instant::now() + GPU_PROBE_TIMEOUT;
    let mut channel = tokio::time::timeout_at(deadline, session.channel_open_session())
        .await
        .map_err(|_| trf!("GPU 采样超时", "GPU probe timed out"))?
        .map_err(|error| error.to_string())?;

    let result = match tokio::time::timeout_at(deadline, async {
        channel
            .exec(true, GPU_PROBE_COMMAND)
            .await
            .map_err(|error| error.to_string())?;
        let mut output = Vec::new();
        let mut succeeded = false;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if output.len() + data.len() > 16 * 1024 {
                        return Err(trf!("GPU 采样输出过大", "GPU probe output is too large"));
                    }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => succeeded = exit_status == 0,
                ChannelMsg::Failure => {
                    return Err(trf!("GPU 采样命令被拒绝", "GPU probe command was rejected"))
                }
                _ => {}
            }
        }
        if !succeeded {
            return Err(trf!(
                "GPU 采样失败，请检查 nvidia-smi",
                "GPU probe failed; check nvidia-smi"
            ));
        }
        parse_utilization(&output)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(trf!("GPU 采样超时", "GPU probe timed out")),
    };

    // The read future is dropped on timeout; close the channel afterward so a
    // stuck remote command cannot consume a server session-channel slot.
    let _ = tokio::time::timeout(GPU_CHANNEL_CLOSE_TIMEOUT, channel.close()).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_every_device_and_rejects_unavailable_or_invalid_samples() {
        assert_eq!(parse_utilization(b"0\n35.5\n").unwrap(), vec![0.0, 35.5]);
        for invalid in ["", "N/A", "-1", "101", "NaN", "0\nN/A"] {
            assert!(parse_utilization(invalid.as_bytes()).is_err(), "{invalid}");
        }
    }
}
