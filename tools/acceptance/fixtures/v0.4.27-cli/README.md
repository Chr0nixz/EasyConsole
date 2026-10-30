# Published 0.4.27 CLI fixture

These credential-free local records were created with the `easy-console-cli.exe` extracted from the published Windows v0.4.27 MSI, GitHub asset `671520937` (SHA-256 `4d8d74c59dde42414046A92B0E89FCE829759893B1D6E5ED083C9738E4FA4EEB`). The source CLI was run with an isolated temporary config and storage path, an unused image ID, and no token. Only local commands were run; no API request was made. Run-log IDs and timestamps were normalized; failed command output and machine-specific paths were excluded.

The records exercise old CLI templates, schedules, run logs, and v1 backup shape. They are synthetic data emitted by the published executable, not a capture of the desktop app or real user data. They support local schema and migration regression tests only; they do not satisfy the real 0.4.27 installation, keychain, saved-account, VS Code SSH, application-update, or device acceptance gates in `UPGRADE_ACCEPTANCE_0.5.0.md`.
