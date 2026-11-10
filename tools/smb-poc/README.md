# Nanako SMB candidate POC

This is an isolated, **loopback-only** harness for evaluating the pinned `paltaio/rust-smb-server` candidate. It is not a Nanako product service and must never use product data or real credentials.

- Fixed listener: `127.0.0.1:4445`.
- No network discovery, Windows share, Windows service, firewall, router, or TCP 445 changes.
- Synthetic accounts only: `alice` can read/write `alpha` and `beta`; `bob` can read `alpha` only. No public or guest share exists.
- SMB signing and encryption are required; unencrypted access is rejected.
- `SMB_POC_ROOT` must point to a disposable synthetic directory named `nanako-smb-poc-data*` under `%TEMP%`; the harness refuses paths outside that location. Set both password variables only in the current process environment and use one-time synthetic passwords of at least 16 characters.

In terminal A, build/run in a disposable Rust environment. Keep this process open while testing:

```powershell
$env:SMB_POC_ROOT = Join-Path $env:TEMP 'nanako-smb-poc-data'
$env:SMB_POC_ALICE_PASSWORD = 'synthetic-one-time-secret-a'
$env:SMB_POC_BOB_PASSWORD = 'synthetic-one-time-secret-b'
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP 'nanako-smb-poc-target'
cargo run --manifest-path tools/smb-poc/Cargo.toml
```

In terminal B, set the same one-time passwords. Optional Impacket protocol smoke test (test-only dependency; not used by Nanako):

```powershell
$env:SMB_POC_ROOT = Join-Path $env:TEMP 'nanako-smb-poc-data'
$env:SMB_POC_ALICE_PASSWORD = 'synthetic-one-time-secret-a'
$env:SMB_POC_BOB_PASSWORD = 'synthetic-one-time-secret-b'
$venv = Join-Path $env:TEMP 'nanako-smb-poc-python-venv'
python -m venv $venv
& (Join-Path $venv 'Scripts\python.exe') -m pip install impacket==0.13.1
& (Join-Path $venv 'Scripts\python.exe') tools/smb-poc/impacket_smoke.py
```

This checks SMB 3.1.1 negotiation, session signing/encryption, Alice's read/write and CRUD, Bob's read-only/denied-share access, and anonymous logon rejection. Impacket is only a protocol smoke client; it does not satisfy the separate Windows-native-client acceptance gate. Do not commit credentials, logs containing secrets, or data from a real NanakoData directory.

The Windows host used for the initial test is Windows 10 22H2 (build 19045), which lacks Microsoft's documented alternate-port client option. Their supported client flow is `New-SmbMapping -TcpPort` or `NET USE /TCPPORT` on Windows 11 24H2+ / Windows Server 2025+; use one of those before promoting this harness into the app: [Configure alternative SMB ports](https://learn.microsoft.com/en-us/windows-server/storage/file-server/smb-ports).
