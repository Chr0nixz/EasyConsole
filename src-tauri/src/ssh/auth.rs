//! Password/PAM authentication and safe automatic prompt handling.

use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse, Prompt};
use russh::MethodKind;

use crate::trf;

fn is_password_prompt(prompts: &[Prompt], password_sent: bool) -> bool {
    if password_sent || prompts.len() != 1 || prompts[0].echo {
        return false;
    }
    // PAM/OpenSSH's standard password prompt. Do not send a saved password
    // to OTP, recovery-code, passphrase, password-change or unknown prompts.
    let prompt = prompts[0]
        .prompt
        .trim()
        .trim_end_matches([':', '：'])
        .trim();
    prompt.eq_ignore_ascii_case("password") || prompt == "密码"
}

fn interactive_required() -> String {
    trf!(
        "SSH 服务器要求额外交互式认证，当前仅支持单次密码提示；请使用支持交互式认证的 SSH 客户端",
        "The SSH server requires additional interactive authentication; only a single password prompt is supported. Use an SSH client with interactive authentication"
    )
}

pub async fn authenticate_password<H: client::Handler>(
    session: &mut client::Handle<H>,
    username: &str,
    password: &str,
) -> Result<bool, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        authenticate_password_inner(session, username, password),
    )
    .await
    .map_err(|_| trf!("SSH 认证超时", "SSH authentication timed out"))?
}

async fn authenticate_password_inner<H: client::Handler>(
    session: &mut client::Handle<H>,
    username: &str,
    password: &str,
) -> Result<bool, String> {
    let result = session
        .authenticate_password(username, password)
        .await
        .map_err(|error| {
            trf!(
                "SSH 认证失败：{error}",
                "SSH authentication failed: {error}"
            )
        })?;
    match result {
        AuthResult::Success => return Ok(true),
        AuthResult::Failure {
            partial_success: true,
            ..
        } => return Err(interactive_required()),
        AuthResult::Failure {
            remaining_methods, ..
        } if !remaining_methods.contains(&MethodKind::KeyboardInteractive) => return Ok(false),
        AuthResult::Failure { .. } => {}
    }

    let mut challenge = session
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(|error| {
            trf!(
                "SSH PAM 认证失败：{error}",
                "SSH PAM authentication failed: {error}"
            )
        })?;
    let mut password_sent = false;
    // Some PAM stacks send empty informational requests. Allow a bounded
    // number under the caller's overall authentication deadline.
    for _ in 0..4 {
        let responses = match challenge {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure {
                partial_success: true,
                ..
            } => {
                return Err(interactive_required());
            }
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { ref prompts, .. }
                if prompts.is_empty() =>
            {
                Vec::new()
            }
            KeyboardInteractiveAuthResponse::InfoRequest { ref prompts, .. }
                if is_password_prompt(prompts, password_sent) =>
            {
                password_sent = true;
                vec![password.to_string()]
            }
            KeyboardInteractiveAuthResponse::InfoRequest { .. } => {
                return Err(interactive_required())
            }
        };
        challenge = session
            .authenticate_keyboard_interactive_respond(responses)
            .await
            .map_err(|error| {
                trf!(
                    "SSH PAM 认证失败：{error}",
                    "SSH PAM authentication failed: {error}"
                )
            })?;
    }
    match challenge {
        KeyboardInteractiveAuthResponse::Success => Ok(true),
        _ => Err(interactive_required()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(text: &str, echo: bool) -> Prompt {
        Prompt {
            prompt: text.into(),
            echo,
        }
    }

    #[test]
    fn saved_password_is_only_used_for_one_standard_hidden_password_prompt() {
        for text in ["Password:", " password: ", "PASSWORD", "密码："] {
            assert!(is_password_prompt(&[prompt(text, false)], false));
        }
        for text in [
            "Verification code:",
            "OTP:",
            "New password:",
            "Passphrase:",
            "",
            "Password: OTP:",
        ] {
            assert!(!is_password_prompt(&[prompt(text, false)], false));
        }
        assert!(!is_password_prompt(&[prompt("Password:", true)], false));
        assert!(!is_password_prompt(&[prompt("Password:", false)], true));
        assert!(!is_password_prompt(&[], false));
        assert!(!is_password_prompt(
            &[prompt("Password:", false), prompt("OTP:", false)],
            false
        ));
    }
}
