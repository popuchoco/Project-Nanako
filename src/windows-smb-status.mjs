import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const POWERSHELL_PROBE = [
  "$version = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'",
  "$service = Get-Service -Name LanmanServer -ErrorAction SilentlyContinue",
  "$listener = Get-NetTCPConnection -LocalPort 445 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1",
  "$shareCommand = Get-Command New-SmbShare -ErrorAction SilentlyContinue",
  "$productName = [string]$version.ProductName",
  "$displayVersion = [string]$version.DisplayVersion",
  "$currentBuild = 0; [void][int]::TryParse([string]$version.CurrentBuildNumber, [ref]$currentBuild)",
  "$supportsExperimentalSmb = ($productName -match '^Windows 11(?:\\s|$)') -and ($currentBuild -ge 26100)",
  "$serviceState = if ($null -eq $service) { 'NotInstalled' } else { $service.Status.ToString() }",
  "[pscustomobject]@{ serverService = $serviceState; port445Listening = [bool]$listener; shareManagementAvailable = [bool]$shareCommand; productName = $productName; displayVersion = $displayVersion; currentBuild = $currentBuild; supportsExperimentalSmb = [bool]$supportsExperimentalSmb } | ConvertTo-Json -Compress",
].join('; ');

export function isWindows11_24H2OrLater({ productName, currentBuild } = {}) {
  return typeof productName === 'string'
    && /^Windows 11(?:\s|$)/u.test(productName.trim())
    && Number.isInteger(currentBuild)
    && currentBuild >= 26100;
}

const unknownWindowsVersion = () => ({
  productName: '未知',
  displayVersion: '未知',
  currentBuild: null,
  supportsExperimentalSmb: false,
});

export async function readWindowsSmbStatus({ platform = process.platform, run = execFileAsync } = {}) {
  if (platform !== 'win32') {
    return {
      supported: false,
      detected: false,
      serverService: 'Unsupported',
      port445Listening: false,
      shareManagementAvailable: false,
      windowsVersion: unknownWindowsVersion(),
      message: 'SMB 主機狀態檢查僅支援 Windows。',
    };
  }

  try {
    const { stdout } = await run('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PROBE,
    ], { windowsHide: true, timeout: 7000, maxBuffer: 32 * 1024 });
    const result = JSON.parse(stdout.trim());
    const knownStates = new Set(['Running', 'Stopped', 'Paused', 'StartPending', 'StopPending', 'NotInstalled']);
    if (!result || !knownStates.has(result.serverService)
      || typeof result.port445Listening !== 'boolean'
      || typeof result.shareManagementAvailable !== 'boolean'
      || typeof result.productName !== 'string'
      || typeof result.displayVersion !== 'string'
      || !Number.isInteger(result.currentBuild)
      || typeof result.supportsExperimentalSmb !== 'boolean') {
      throw new Error('Windows SMB 狀態資料格式不正確。');
    }
    return {
      supported: true,
      detected: true,
      serverService: result.serverService,
      port445Listening: result.port445Listening,
      shareManagementAvailable: result.shareManagementAvailable,
      windowsVersion: {
        productName: result.productName,
        displayVersion: result.displayVersion,
        currentBuild: result.currentBuild,
        supportsExperimentalSmb: result.supportsExperimentalSmb
          && isWindows11_24H2OrLater({ productName: result.productName, currentBuild: result.currentBuild }),
      },
      message: null,
    };
  } catch {
    return {
      supported: true,
      detected: false,
      serverService: 'Unknown',
      port445Listening: false,
      shareManagementAvailable: false,
      windowsVersion: unknownWindowsVersion(),
      message: '無法讀取 Windows SMB 伺服器狀態。',
    };
  }
}
