use std::sync::Arc;

use serde::Deserialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh::session::{send_session_command_with_response, SshCommand, SshSessionState};
use crate::trf;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRuleValue {
    pub id: String,
    #[serde(rename = "type")]
    pub forward_type: String,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[allow(dead_code)]
    pub enabled: bool,
}

pub fn normalize_port_forward_bind_host(host: &str) -> Result<String, String> {
    let trimmed = host.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("localhost") || trimmed == "127.0.0.1" {
        return Ok("127.0.0.1".to_string());
    }
    if trimmed == "::1" || trimmed.eq_ignore_ascii_case("[::1]") {
        return Ok("::1".to_string());
    }
    Err(trf!(
        "端口转发仅允许绑定本机回环地址（127.0.0.1 或 ::1）",
        "Port forwarding may only bind to the local loopback address (127.0.0.1 or ::1)"
    ))
}

fn format_socks5_ipv6_host(addr: &[u8; 16]) -> String {
    let ip = std::net::Ipv6Addr::from(*addr);
    format!("[{ip}]")
}

/// Generic over the stream so tests can drive the handshake against an
/// in-memory duplex instead of a real TCP connection.
pub async fn socks5_handshake<S>(stream: &mut S) -> Result<(String, u16), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    // Greeting: version(1) + num_methods(1) + methods(N)
    let mut greeting = [0u8; 2];
    stream.read_exact(&mut greeting).await.map_err(|e| {
        trf!(
            "SOCKS5 读取问候失败：{e}",
            "SOCKS5: failed to read the greeting: {e}"
        )
    })?;
    if greeting[0] != 5 {
        return Err(trf!("SOCKS5 版本不匹配", "SOCKS5 version mismatch"));
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    stream.read_exact(&mut methods).await.map_err(|e| {
        trf!(
            "SOCKS5 读取方法失败：{e}",
            "SOCKS5: failed to read methods: {e}"
        )
    })?;
    // Reply: no auth
    stream.write_all(&[5, 0]).await.map_err(|e| {
        trf!(
            "SOCKS5 写入方法回复失败：{e}",
            "SOCKS5: failed to write the method reply: {e}"
        )
    })?;

    // Request: version(1) + cmd(1) + rsv(1) + atyp(1) + addr + port(2)
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).await.map_err(|e| {
        trf!(
            "SOCKS5 读取请求失败：{e}",
            "SOCKS5: failed to read the request: {e}"
        )
    })?;
    if header[0] != 5 {
        return Err(trf!(
            "SOCKS5 请求版本不匹配",
            "SOCKS5 request version mismatch"
        ));
    }
    if header[1] != 1 {
        // Only CONNECT supported
        let _ = stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return Err(trf!(
            "SOCKS5 仅支持 CONNECT 命令",
            "SOCKS5 supports the CONNECT command only"
        ));
    }
    let dest_host = match header[3] {
        1 => {
            // IPv4
            let mut addr = [0u8; 4];
            stream.read_exact(&mut addr).await.map_err(|e| {
                trf!(
                    "SOCKS5 读取 IPv4 地址失败：{e}",
                    "SOCKS5: failed to read the IPv4 address: {e}"
                )
            })?;
            format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3])
        }
        3 => {
            // Domain
            let mut len_buf = [0u8; 1];
            stream.read_exact(&mut len_buf).await.map_err(|e| {
                trf!(
                    "SOCKS5 读取域名长度失败：{e}",
                    "SOCKS5: failed to read the domain length: {e}"
                )
            })?;
            let mut domain = vec![0u8; len_buf[0] as usize];
            stream.read_exact(&mut domain).await.map_err(|e| {
                trf!(
                    "SOCKS5 读取域名失败：{e}",
                    "SOCKS5: failed to read the domain: {e}"
                )
            })?;
            String::from_utf8_lossy(&domain).to_string()
        }
        4 => {
            // IPv6
            let mut addr = [0u8; 16];
            stream.read_exact(&mut addr).await.map_err(|e| {
                trf!(
                    "SOCKS5 读取 IPv6 地址失败：{e}",
                    "SOCKS5: failed to read the IPv6 address: {e}"
                )
            })?;
            format_socks5_ipv6_host(&addr)
        }
        _ => {
            let _ = stream.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Err(trf!(
                "SOCKS5 不支持的地址类型",
                "Unsupported SOCKS5 address type"
            ));
        }
    };
    let mut port_buf = [0u8; 2];
    stream.read_exact(&mut port_buf).await.map_err(|e| {
        trf!(
            "SOCKS5 读取端口失败：{e}",
            "SOCKS5: failed to read the port: {e}"
        )
    })?;
    let dest_port = u16::from_be_bytes(port_buf);

    // Reply: success
    stream
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| {
            trf!(
                "SOCKS5 写入回复失败：{e}",
                "SOCKS5: failed to write the reply: {e}"
            )
        })?;

    Ok((dest_host, dest_port))
}

#[tauri::command]
pub async fn ssh_start_port_forward(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    rule: PortForwardRuleValue,
) -> Result<(), String> {
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::StartPortForward { rule, response }
    })
    .await
}

#[tauri::command]
pub async fn ssh_stop_port_forward(
    state: State<'_, Arc<SshSessionState>>,
    window: tauri::WebviewWindow,
    session_id: String,
    rule_id: String,
) -> Result<(), String> {
    send_session_command_with_response(state, &window, &session_id, |response| {
        SshCommand::StopPortForward { rule_id, response }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn port_forward_bind_host_rejects_non_loopback() {
        assert_eq!(normalize_port_forward_bind_host("").unwrap(), "127.0.0.1");
        assert_eq!(
            normalize_port_forward_bind_host("localhost").unwrap(),
            "127.0.0.1"
        );
        assert_eq!(
            normalize_port_forward_bind_host("127.0.0.1").unwrap(),
            "127.0.0.1"
        );
        assert_eq!(normalize_port_forward_bind_host("::1").unwrap(), "::1");
        assert_eq!(normalize_port_forward_bind_host("[::1]").unwrap(), "::1");
        assert!(normalize_port_forward_bind_host("0.0.0.0").is_err());
        assert!(normalize_port_forward_bind_host("192.168.1.10").is_err());
        assert!(normalize_port_forward_bind_host("::").is_err());
    }

    #[test]
    fn format_socks5_ipv6_host_uses_standard_notation() {
        let addr = std::net::Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1).octets();
        assert_eq!(format_socks5_ipv6_host(&addr), "[2001:db8::1]");
    }

    #[tokio::test]
    async fn socks5_handshake_negotiates_no_auth_and_parses_domain_target() {
        let (mut client, mut server) = tokio::io::duplex(128);
        let handshake = tokio::spawn(async move { socks5_handshake(&mut server).await });

        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut method_reply = [0u8; 2];
        client.read_exact(&mut method_reply).await.unwrap();
        assert_eq!(method_reply, [5, 0]);

        let mut request = vec![5, 1, 0, 3, 7];
        request.extend_from_slice(b"example");
        request.extend_from_slice(&80u16.to_be_bytes());
        client.write_all(&request).await.unwrap();

        let mut connect_reply = [0u8; 10];
        client.read_exact(&mut connect_reply).await.unwrap();
        assert_eq!(connect_reply, [5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

        let target = handshake.await.unwrap().unwrap();
        assert_eq!(target, ("example".to_string(), 80));
    }

    #[tokio::test]
    async fn socks5_handshake_rejects_non_connect_commands() {
        let (mut client, mut server) = tokio::io::duplex(128);
        let handshake = tokio::spawn(async move { socks5_handshake(&mut server).await });

        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut method_reply = [0u8; 2];
        client.read_exact(&mut method_reply).await.unwrap();
        assert_eq!(method_reply, [5, 0]);

        // BIND (cmd=2) must be refused with "command not supported" (7).
        client
            .write_all(&[5, 2, 0, 1, 10, 0, 0, 1, 0, 80])
            .await
            .unwrap();
        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 7);

        assert!(handshake.await.unwrap().is_err());
    }
}
