use std::{env, error::Error, fs, path::PathBuf};

use smb_server::{Access, LocalFsBackend, Share, SmbServer};
use tracing::info;

const LISTEN: &str = "127.0.0.1:4445";

fn required_secret(name: &str) -> Result<String, Box<dyn Error>> {
    let secret = env::var(name)?;
    if secret.len() < 16 {
        return Err(format!("{name} must contain at least 16 characters").into());
    }
    Ok(secret)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .init();

    let requested_root =
        PathBuf::from(env::var_os("SMB_POC_ROOT").ok_or("SMB_POC_ROOT is required")?);
    let temp_root = fs::canonicalize(env::temp_dir())?;
    let root_name = requested_root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.starts_with("nanako-smb-poc-data"))
        .ok_or("SMB_POC_ROOT must be named nanako-smb-poc-data*")?;
    let requested_parent = requested_root
        .parent()
        .ok_or("SMB_POC_ROOT must have a parent directory")?;
    let parent = fs::canonicalize(requested_parent)?;
    if !parent.starts_with(&temp_root) {
        return Err("SMB_POC_ROOT must be a nanako-smb-poc-data* directory under %TEMP%".into());
    }
    let root_path = parent.join(root_name);
    if !root_path.exists() {
        fs::create_dir(&root_path)?;
    }
    let root = fs::canonicalize(root_path)?;
    if !root.starts_with(&temp_root) {
        return Err("SMB_POC_ROOT must be a nanako-smb-poc-data* directory under %TEMP%".into());
    }

    let alpha_root = root.join("alpha");
    let beta_root = root.join("beta");
    fs::create_dir_all(&alpha_root)?;
    fs::create_dir_all(&beta_root)?;
    let seed = alpha_root.join("poc-readme.txt");
    if !seed.exists() {
        fs::write(&seed, b"Synthetic SMB POC data.\r\n")?;
    }

    let alice_password = required_secret("SMB_POC_ALICE_PASSWORD")?;
    let bob_password = required_secret("SMB_POC_BOB_PASSWORD")?;
    let server = SmbServer::builder()
        .listen(LISTEN.parse()?)
        .user("alice", alice_password)
        .user("bob", bob_password)
        .require_signing(true)
        .encrypt_data(true)
        .reject_unencrypted_access(true)
        .share(
            Share::new("alpha", LocalFsBackend::new(&alpha_root)?)
                .user("alice", Access::ReadWrite)
                .user("bob", Access::Read),
        )
        .share(
            Share::new("beta", LocalFsBackend::new(&beta_root)?).user("alice", Access::ReadWrite),
        )
        .build()?;

    let addr = server.bind().await?;
    info!(%addr, signing_required = true, encryption_required = true, "private SMB POC listening");
    let shutdown = server.shutdown_handle();
    let mut serve = std::pin::pin!(server.serve());
    tokio::select! {
        result = &mut serve => result?,
        signal = tokio::signal::ctrl_c() => {
            signal?;
            shutdown.shutdown();
            serve.await?;
        }
    }
    info!(%addr, "private SMB POC stopped");
    Ok(())
}
