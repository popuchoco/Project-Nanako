param(
  [int]$IdleSeconds = 60,
  [int]$StageSeconds = 12,
  [int]$AfterCloseSeconds = 30,
  [int]$SampleIntervalSeconds = 2,
  [int]$FileCount = 1000,
  [int]$MediaCount = 1000,
  [int]$ImageCount = 1000
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputDirectory = Join-Path $projectRoot ("work\memory-measurement-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$portableDirectory = Join-Path $outputDirectory 'fixture-portable'
$appDataDirectory = Join-Path $portableDirectory 'NanakoData'
$filesDirectory = Join-Path $appDataDirectory 'data\files'
$rawCsvPath = Join-Path $outputDirectory 'samples.csv'
$summaryJsonPath = Join-Path $outputDirectory 'summary.json'
$summaryCsvPath = Join-Path $outputDirectory 'summary.csv'
$helperPath = Join-Path $outputDirectory 'memory-cdp-helper.mjs'
$nodeLogPath = Join-Path $outputDirectory 'cdp-helper.log'
$electronLogPath = Join-Path $outputDirectory 'electron.log'
$electronErrorPath = Join-Path $outputDirectory 'electron-error.log'
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$helperSource = @'
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2]);
const action = process.argv[3];
let input = '';
for await (const chunk of process.stdin) input += chunk;
const payload = input.trim() ? JSON.parse(input) : {};

async function waitForTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    if (response?.ok) {
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    }
    await delay(200);
  }
  throw new Error('Timed out waiting for the Nanako renderer DevTools target.');
}

const target = await waitForTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data));
  if (!message.id) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(body) {
  const response = await send('Runtime.evaluate', {
    expression: `(async()=>{${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    timeout: 60000,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value;
}
async function close() {
  try { await send('Runtime.disable'); } catch {}
  socket.close();
}
const wait = `async (predicate, label, timeout=30000) => { const end=Date.now()+timeout; while(Date.now()<end){ if(predicate()) return; await new Promise(r=>setTimeout(r,100)); } throw new Error('Timed out waiting for '+label); }`;

try {
  let result;
  if (action === 'setup') {
    result = await evaluate(`
      const waitFor=${wait};
      await waitFor(()=>!document.querySelector('#auth-screen')?.hidden,'first-run setup screen');
      const username=document.querySelector('#auth-username');
      const password=document.querySelector('#auth-password');
      if(document.querySelector('#auth-form')?.dataset.mode!=='setup') throw new Error('Expected a fresh Nanako profile.');
      username.value=${JSON.stringify(payload.username)};
      password.value=${JSON.stringify(payload.password)};
      document.querySelector('#auth-form').requestSubmit();
      await waitFor(()=>!document.querySelector('#app-shell')?.hidden,'authenticated desktop');
      await waitFor(()=>document.querySelector('#view-files')?.closest('.app-window'),'initial Files window');
      return {title:document.title,mode:'setup',appVisible:true};
    `);
  } else if (action === 'upload-video') {
    result = await evaluate(`
      if(!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return {created:false,reason:'MediaRecorder/canvas captureStream is not supported'};
      const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=180;
      const context=canvas.getContext('2d');
      const stream=canvas.captureStream(12);
      const options=MediaRecorder.isTypeSupported('video/webm;codecs=vp8')?{mimeType:'video/webm;codecs=vp8'}:{};
      const recorder=new MediaRecorder(stream,options); const chunks=[];
      recorder.addEventListener('dataavailable',event=>{if(event.data.size) chunks.push(event.data);});
      const stopped=new Promise(resolve=>recorder.addEventListener('stop',resolve,{once:true}));
      recorder.start();
      const started=Date.now(); let frame=0;
      while(Date.now()-started<8000){
        context.fillStyle='hsl('+((frame*7)%360)+' 70% 45%)'; context.fillRect(0,0,canvas.width,canvas.height);
        context.fillStyle='#fff'; context.font='24px sans-serif'; context.fillText('Nanako benchmark '+frame,16,90);
        frame++; await new Promise(resolve=>setTimeout(resolve,80));
      }
      recorder.stop(); await stopped; stream.getTracks().forEach(track=>track.stop());
      const blob=new Blob(chunks,{type:recorder.mimeType||'video/webm'});
      const query=new URLSearchParams({shareId:${JSON.stringify(payload.shareId)},path:'media',name:'benchmark-clip.webm'});
      const response=await fetch('/api/upload?'+query,{method:'POST',body:blob,credentials:'same-origin'});
      if(!response.ok) throw new Error('Video fixture upload failed: '+response.status+' '+await response.text());
      return {created:true,bytes:blob.size,type:blob.type,frames:frame};
    `);
  } else if (action === 'refresh-files') {
    result = await evaluate(`
      const waitFor=${wait};
      document.querySelector('[data-file-location="root"]')?.click();
      await waitFor(()=>document.querySelectorAll('#file-list tr').length>=100,'first 100 file rows');
      return {rows:document.querySelectorAll('#file-list tr').length,more:document.querySelector('#file-more')?.textContent||''};
    `);
  } else if (action === 'file-next') {
    result = await evaluate(`
      const waitFor=${wait};
      const button=document.querySelector('#file-more'); if(button.hidden) throw new Error('Files list has no next batch.');
      const before=document.querySelectorAll('#file-list tr').length; button.click();
      await waitFor(()=>document.querySelectorAll('#file-list tr').length>before,'next file batch');
      return {rows:document.querySelectorAll('#file-list tr').length,more:button.textContent};
    `);
  } else if (action === 'open-album') {
    result = await evaluate(`
      const waitFor=${wait};
      document.querySelector('#desktop-area [data-open-view="album"]')?.click();
      await waitFor(()=>document.querySelectorAll('#album-grid .album-card').length>=48,'first album batch');
      return {cards:document.querySelectorAll('#album-grid .album-card').length,more:document.querySelector('#album-more')?.textContent||''};
    `);
  } else if (action === 'album-next') {
    result = await evaluate(`
      const waitFor=${wait};
      const button=document.querySelector('#album-more'); if(button.hidden) throw new Error('Album has no next batch.');
      button.click(); await waitFor(()=>document.querySelectorAll('#album-grid .album-card').length>=96,'second album batch');
      return {cards:document.querySelectorAll('#album-grid .album-card').length,more:button.textContent};
    `);
  } else if (action === 'open-player') {
    result = await evaluate(`
      const waitFor=${wait};
      document.querySelector('#desktop-area [data-open-view="player"]')?.click();
      await waitFor(()=>document.querySelectorAll('#player-queue .queue-track').length>=48,'first player batch');
      return {tracks:document.querySelectorAll('#player-queue .queue-track').length,more:document.querySelector('#player-more')?.textContent||''};
    `);
  } else if (action === 'player-all') {
    result = await evaluate(`
      const waitFor=${wait}; const button=document.querySelector('#player-more');
      let count=document.querySelectorAll('#player-queue .queue-track').length; let rounds=0;
      while(!button.hidden && rounds<30){ const before=count; button.click(); rounds++; await waitFor(()=>document.querySelectorAll('#player-queue .queue-track').length>before,'next player batch'); count=document.querySelectorAll('#player-queue .queue-track').length; }
      if(count<${Number(payload.expected || 1000)}) throw new Error('Player queue did not reach the expected fixture count: '+count);
      return {tracks:count,rounds,moreHidden:button.hidden};
    `);
  } else if (action === 'play-video') {
    result = await evaluate(`
      const waitFor=${wait}; const video=document.querySelector('#video-player'); video.loop=true;
      const track=[...document.querySelectorAll('#player-queue .queue-track')].find(item=>item.dataset.trackPath==='media/benchmark-clip.webm');
      if(!track) throw new Error('Generated WebM fixture is missing from the playlist.');
      track.click();
      await waitFor(()=>Boolean(video.currentSrc),'video source assignment',10000);
      video.muted=true;
      await video.play();
      await waitFor(()=>!video.paused && video.readyState>=2,'video playback',20000);
      return {playing:!video.paused,readyState:video.readyState,width:video.videoWidth,height:video.videoHeight,source:'local synthetic WebM'};
    `);
  } else if (action === 'close-player') {
    result = await evaluate(`
      const waitFor=${wait};
      const window=document.querySelector('#player-queue')?.closest('.app-window');
      window?.querySelector('[data-window-action="close"]')?.click();
      await waitFor(()=>!document.querySelector('#player-queue')?.closest('.app-window'),'player window close');
      return {playerClosed:true,videoSrc:document.querySelector('#video-player')?.getAttribute('src')||'',queue:document.querySelectorAll('#player-queue .queue-track').length};
    `);
  } else if (action === 'window-cycles') {
    result = await evaluate(`
      const waitFor=${wait}; let completed=0;
      for(let i=0;i<20;i++){
        document.querySelector('#desktop-area [data-open-view="files"]')?.click();
        await waitFor(()=>document.querySelector('#file-list')?.closest('.app-window'),'Files window open '+i);
        const win=document.querySelector('#file-list').closest('.app-window');
        win.querySelector('[data-window-action="minimize"]')?.click();
        await waitFor(()=>win.hidden,'Files window minimized '+i);
        document.querySelector('#taskbar-windows [data-window-view="files"]')?.click();
        await waitFor(()=>!win.hidden,'Files window restored '+i);
        win.querySelector('[data-window-action="close"]')?.click();
        await waitFor(()=>!document.querySelector('#file-list')?.closest('.app-window'),'Files window closed '+i);
        completed++;
      }
      return {cycles:completed,windowCount:document.querySelectorAll('#window-layer .app-window').length};
    `);
  } else if (action === 'rapid-switch') {
    result = await evaluate(`
      const waitFor=${wait};
      for(const view of ['files','album','player']){
        document.querySelector('#desktop-area [data-open-view="'+view+'"]')?.click();
        await waitFor(()=>document.querySelector('#window-layer [data-window-content] #view-'+view),'open '+view);
      }
      for(let i=0;i<20;i++){
        for(const view of ['album','player','files']) document.querySelector('#taskbar-windows [data-window-view="'+view+'"]')?.click();
      }
      return {switches:60,windowCount:document.querySelectorAll('#window-layer .app-window').length};
    `);
  } else if (action === 'close-all') {
    result = await evaluate(`
      for(const win of [...document.querySelectorAll('#window-layer .app-window')]) win.querySelector('[data-window-action="close"]')?.click();
      return {openWindows:document.querySelectorAll('#window-layer .app-window').length};
    `);
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
  console.log(JSON.stringify({ action, result, renderer: target.url }));
} finally {
  await close();
}
'@

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
[System.IO.File]::WriteAllText($helperPath, $helperSource, [System.Text.UTF8Encoding]::new($false))

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return [int]$listener.LocalEndpoint.Port }
  finally { $listener.Stop() }
}

function Invoke-CdpAction {
  param([Parameter(Mandatory)][string]$Action, [hashtable]$Payload = @{})
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command node).Source
  $startInfo.ArgumentList.Add($helperPath)
  $startInfo.ArgumentList.Add([string]$debugPort)
  $startInfo.ArgumentList.Add($Action)
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $helper = [System.Diagnostics.Process]::new()
  $helper.StartInfo = $startInfo
  if (-not $helper.Start()) { throw '無法啟動 CDP 自動化 helper。' }
  $helper.StandardInput.WriteLine(($Payload | ConvertTo-Json -Compress -Depth 5))
  $helper.StandardInput.Close()
  $stdout = $helper.StandardOutput.ReadToEnd()
  $stderr = $helper.StandardError.ReadToEnd()
  $helper.WaitForExit()
  if ($helper.ExitCode -ne 0) {
    Add-Content -LiteralPath $nodeLogPath -Value $stderr
    throw "CDP action '$Action' failed: $stderr $stdout"
  }
  $line = ($stdout -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
  $parsed = $line | ConvertFrom-Json
  Add-Content -LiteralPath $nodeLogPath -Value ($parsed | ConvertTo-Json -Compress -Depth 6)
  return $parsed.result
}

function Get-ProcessTreeSnapshot {
  $processTable = Get-CimInstance Win32_Process
  $byParent = @{}
  foreach ($item in $processTable) {
    $parentId = [int]$item.ParentProcessId
    if (-not $byParent.ContainsKey($parentId)) { $byParent[$parentId] = [System.Collections.Generic.List[int]]::new() }
    $byParent[$parentId].Add([int]$item.ProcessId)
  }
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  $pendingIds = [System.Collections.Generic.Queue[int]]::new()
  $pendingIds.Enqueue([int]$electronProcess.Id)
  while ($pendingIds.Count -gt 0) {
    $id = $pendingIds.Dequeue()
    if (-not $ids.Add($id)) { continue }
    if ($byParent.ContainsKey($id)) { foreach ($childId in $byParent[$id]) { $pendingIds.Enqueue($childId) } }
  }
  $commandLines = @{}
  foreach ($item in $processTable) { if ($ids.Contains([int]$item.ProcessId)) { $commandLines[[int]$item.ProcessId] = [string]$item.CommandLine } }
  $processes = @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue)
  $rendererIds = @($ids | Where-Object { $commandLines[[int]$_] -match '(?i)(^|\s)--type=renderer(\s|$)' })
  $rendererProcesses = @($processes | Where-Object { $rendererIds -contains [int]$_.Id })
  $root = $processes | Where-Object Id -eq $electronProcess.Id | Select-Object -First 1
  [pscustomobject]@{
    ProcessCount = $processes.Count
    RendererCount = $rendererProcesses.Count
    WorkingSetBytes = [long](($processes | Measure-Object -Property WorkingSet64 -Sum).Sum)
    PrivateBytes = [long](($processes | Measure-Object -Property PrivateMemorySize64 -Sum).Sum)
    RendererWorkingSetBytes = [long](($rendererProcesses | Measure-Object -Property WorkingSet64 -Sum).Sum)
    RendererPrivateBytes = [long](($rendererProcesses | Measure-Object -Property PrivateMemorySize64 -Sum).Sum)
    MainWorkingSetBytes = [long]$root.WorkingSet64
    MainPrivateBytes = [long]$root.PrivateMemorySize64
  }
}

$samples = [System.Collections.Generic.List[object]]::new()
function Measure-Stage {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][int]$Seconds)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  $sampleIndex = 0
  do {
    $snapshot = Get-ProcessTreeSnapshot
    $sample = [pscustomobject]@{
      stage = $Name
      sample = $sampleIndex
      timestampUtc = [DateTime]::UtcNow.ToString('o')
      processCount = $snapshot.ProcessCount
      rendererCount = $snapshot.RendererCount
      workingSetMiB = [math]::Round($snapshot.WorkingSetBytes / 1MB, 2)
      privateMiB = [math]::Round($snapshot.PrivateBytes / 1MB, 2)
      rendererWorkingSetMiB = [math]::Round($snapshot.RendererWorkingSetBytes / 1MB, 2)
      rendererPrivateMiB = [math]::Round($snapshot.RendererPrivateBytes / 1MB, 2)
      mainWorkingSetMiB = [math]::Round($snapshot.MainWorkingSetBytes / 1MB, 2)
      mainPrivateMiB = [math]::Round($snapshot.MainPrivateBytes / 1MB, 2)
    }
    $samples.Add($sample)
    Write-Host ("{0,-27} sample {1,2}: app WS {2,7:N2} MiB / private {3,7:N2} MiB; renderer {4,7:N2} MiB private; {5} renderer(s)" -f $Name, $sampleIndex, $sample.workingSetMiB, $sample.privateMiB, $sample.rendererPrivateMiB, $sample.rendererCount)
    $sampleIndex++
    if ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Seconds ([math]::Min($SampleIntervalSeconds, [math]::Max(1, [int][math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)))) }
  } while ([DateTime]::UtcNow -lt $deadline)
}

function Get-Percentile {
  param([double[]]$Values, [double]$Percentile)
  $sorted = @($Values | Sort-Object)
  if ($sorted.Count -eq 0) { return 0 }
  $index = [math]::Max(0, [math]::Ceiling($Percentile * $sorted.Count) - 1)
  return [double]$sorted[[int]$index]
}

function Get-StageSummary {
  param([Parameter(Mandatory)][string]$Name, [object[]]$Rows)
  $metrics = @('workingSetMiB', 'privateMiB', 'rendererWorkingSetMiB', 'rendererPrivateMiB')
  $summary = [ordered]@{ stage = $Name; samples = $Rows.Count; processCount = [int](Get-Percentile @($Rows.processCount | ForEach-Object { [double]$_ }) 0.5); rendererCount = [int](Get-Percentile @($Rows.rendererCount | ForEach-Object { [double]$_ }) 0.5) }
  foreach ($metric in $metrics) {
    $values = @($Rows | ForEach-Object { [double]$_.$metric })
    $summary["${metric}Median"] = [math]::Round((Get-Percentile $values 0.5), 2)
    $summary["${metric}P95"] = [math]::Round((Get-Percentile $values 0.95), 2)
    $summary["${metric}Min"] = [math]::Round(($values | Measure-Object -Minimum).Minimum, 2)
    $summary["${metric}Max"] = [math]::Round(($values | Measure-Object -Maximum).Maximum, 2)
  }
  [pscustomobject]$summary
}

$electronProcess = $null
$originalPortable = $env:PORTABLE_EXECUTABLE_DIR
$originalSmokeTest = $env:NANAKO_DESKTOP_SMOKE_TEST
$originalNodeOptions = $env:NODE_OPTIONS
$appStopped = $false
try {
  if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) { throw "找不到 Electron：$electronPath，請先執行 npm ci。" }
  New-Item -ItemType Directory -Path $portableDirectory -Force | Out-Null
  $debugPort = Get-FreeTcpPort
  $env:PORTABLE_EXECUTABLE_DIR = $portableDirectory
  Remove-Item Env:NANAKO_DESKTOP_SMOKE_TEST -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  $electronProcess = Start-Process -FilePath $electronPath -ArgumentList @("--remote-debugging-port=$debugPort", '--remote-allow-origins=*', 'electron/main.mjs') -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $electronLogPath -RedirectStandardError $electronErrorPath
  if (-not $electronProcess) { throw '無法啟動 Electron。' }

  $debugReady = $false
  $debugDeadline = [DateTime]::UtcNow.AddSeconds(45)
  while (-not $debugReady -and [DateTime]::UtcNow -lt $debugDeadline) {
    if ($electronProcess.HasExited) { throw "Electron 提前結束，exit code $($electronProcess.ExitCode)。$(Get-Content $electronErrorPath -Raw -ErrorAction SilentlyContinue)" }
    try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$debugPort/json/version" -TimeoutSec 2; $debugReady = $true } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $debugReady) { throw '等待 Electron DevTools localhost 端點逾時。' }

  $username = 'memorybench'
  $password = 'Bench-' + [guid]::NewGuid().ToString('N') + '-LocalOnly'
  $setup = Invoke-CdpAction -Action 'setup' -Payload @{ username = $username; password = $password }
  Write-Host "Test profile ready; setup mode: $($setup.mode). Synthetic credentials are not written to the report."

  $shareRootDeadline = [DateTime]::UtcNow.AddSeconds(20)
  $shareRoot = $null
  while (-not $shareRoot -and [DateTime]::UtcNow -lt $shareRootDeadline) {
    $shareRoot = Get-ChildItem -LiteralPath $filesDirectory -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $shareRoot) { Start-Sleep -Milliseconds 200 }
  }
  if (-not $shareRoot) { throw '初始設定未建立 Nanako 測試資料空間。' }
  $shareId = $shareRoot.Name
  $photosPath = Join-Path $shareRoot.FullName 'photos'
  $mediaPath = Join-Path $shareRoot.FullName 'media'
  New-Item -ItemType Directory -Path $photosPath,$mediaPath -Force | Out-Null

  $pngBytes = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC')
  for ($index = 0; $index -lt $FileCount; $index++) {
    [System.IO.File]::WriteAllBytes((Join-Path $shareRoot.FullName ("file-{0:D4}.txt" -f $index)), [byte[]]::new(0))
  }
  for ($index = 0; $index -lt $ImageCount; $index++) {
    [System.IO.File]::WriteAllBytes((Join-Path $photosPath ("photo-{0:D4}.png" -f $index)), $pngBytes)
  }
  for ($index = 0; $index -lt ($MediaCount - 1); $index++) {
    [System.IO.File]::WriteAllBytes((Join-Path $mediaPath ("track-{0:D4}.mp3" -f $index)), [byte[]]::new(0))
  }
  Write-Host "Created synthetic fixture: $FileCount root files, $ImageCount PNGs, $($MediaCount - 1) audio queue entries."

  $videoFixture = Invoke-CdpAction -Action 'upload-video' -Payload @{ shareId = $shareId }
  if (-not $videoFixture.created) { throw "無法在 Chromium 產生測試影片：$($videoFixture.reason)" }
  $null = Invoke-CdpAction -Action 'refresh-files'

  Write-Host "讓首頁（100 列）閒置 $IdleSeconds 秒後開始取樣。"
  Start-Sleep -Seconds $IdleSeconds
  Measure-Stage -Name ("idle-after-{0}s" -f $IdleSeconds) -Seconds $StageSeconds
  Measure-Stage -Name 'files-first-100' -Seconds $StageSeconds
  $fileBatch = Invoke-CdpAction -Action 'file-next'
  if ($fileBatch.rows -lt 200) { throw '檔案清單第二批未載入 200 列。' }
  Measure-Stage -Name 'files-next-200' -Seconds $StageSeconds

  $albumFirst = Invoke-CdpAction -Action 'open-album'
  Measure-Stage -Name 'album-first-48' -Seconds $StageSeconds
  $albumNext = Invoke-CdpAction -Action 'album-next'
  Measure-Stage -Name 'album-next-96' -Seconds $StageSeconds

  $playerFirst = Invoke-CdpAction -Action 'open-player'
  Measure-Stage -Name 'player-first-48' -Seconds $StageSeconds
  $playerAll = Invoke-CdpAction -Action 'player-all' -Payload @{ expected = $MediaCount }
  Measure-Stage -Name 'player-full-1000' -Seconds $StageSeconds
  $videoResult = Invoke-CdpAction -Action 'play-video'
  Measure-Stage -Name 'video-playback' -Seconds $StageSeconds
  $null = Invoke-CdpAction -Action 'close-player'
  Write-Host "播放器關閉後等待 $AfterCloseSeconds 秒，再量測記憶體回落。"
  Start-Sleep -Seconds $AfterCloseSeconds
  Measure-Stage -Name ("player-closed-after-{0}s" -f $AfterCloseSeconds) -Seconds $StageSeconds

  $cycleResult = Invoke-CdpAction -Action 'window-cycles'
  Measure-Stage -Name 'windows-20-cycles' -Seconds $StageSeconds
  $switchResult = Invoke-CdpAction -Action 'rapid-switch'
  Measure-Stage -Name 'windows-60-switches' -Seconds $StageSeconds
  $null = Invoke-CdpAction -Action 'close-all'
  Start-Sleep -Seconds $AfterCloseSeconds
  Measure-Stage -Name ("all-windows-closed-after-{0}s" -f $AfterCloseSeconds) -Seconds $StageSeconds

  $samples | Export-Csv -LiteralPath $rawCsvPath -NoTypeInformation -Encoding utf8
  $stageSummary = @($samples | Group-Object stage | ForEach-Object { Get-StageSummary -Name $_.Name -Rows @($_.Group) })
  $windows = Get-CimInstance Win32_OperatingSystem
  $processor = Get-CimInstance Win32_Processor | Select-Object -First 1
  $metadata = [ordered]@{
    measuredAt = [DateTimeOffset]::Now.ToString('o')
    repositoryCommit = (git -C $projectRoot rev-parse HEAD).Trim()
    os = $windows.Caption
    osBuild = $windows.BuildNumber
    architecture = $windows.OSArchitecture
    cpu = $processor.Name
    physicalMemoryGiB = [math]::Round($windows.TotalVisibleMemorySize * 1KB / 1GB, 2)
    electronVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'node_modules\electron\package.json') -Raw | ConvertFrom-Json).version
    fixture = [ordered]@{ files = $FileCount; images = $ImageCount; mediaQueue = $MediaCount; generatedVideoBytes = $videoFixture.bytes }
    scenarios = [ordered]@{
      fileList = $fileBatch
      album = @{ first = $albumFirst; next = $albumNext }
      player = @{ first = $playerFirst; full = $playerAll; playback = $videoResult }
      windows = @{ cycles = $cycleResult; switching = $switchResult }
    }
    memory = $stageSummary
    notes = @(
      'Single-machine Windows measurement; app totals are sums of the Nanako Electron process tree, not unique physical pages.',
      'Private Bytes is the sum of per-process PrivateMemorySize64; renderer metrics include only processes with --type=renderer.',
      'Synthetic fixture files and a disposable local administrator were used; no production data or network listener was used.'
    )
  }
  $metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryJsonPath -Encoding utf8
  $stageSummary | Export-Csv -LiteralPath $summaryCsvPath -NoTypeInformation -Encoding utf8
  Write-Host "`nSummary: $summaryJsonPath"
  $stageSummary | Format-Table stage,samples,rendererCount,workingSetMiBMedian,privateMiBMedian,rendererPrivateMiBMedian -AutoSize
} finally {
  if ($electronProcess -and -not $electronProcess.HasExited) {
    try { $electronProcess.Kill($true); $electronProcess.WaitForExit(10000) | Out-Null } catch { }
  }
  if ($originalPortable -eq $null) { Remove-Item Env:PORTABLE_EXECUTABLE_DIR -ErrorAction SilentlyContinue } else { $env:PORTABLE_EXECUTABLE_DIR = $originalPortable }
  if ($originalSmokeTest -eq $null) { Remove-Item Env:NANAKO_DESKTOP_SMOKE_TEST -ErrorAction SilentlyContinue } else { $env:NANAKO_DESKTOP_SMOKE_TEST = $originalSmokeTest }
  if ($originalNodeOptions -eq $null) { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue } else { $env:NODE_OPTIONS = $originalNodeOptions }
  # The generated NanakoData contains only disposable benchmark content; retain reports/logs, not the test account or fixture.
  if (Test-Path -LiteralPath $portableDirectory) { Remove-Item -LiteralPath $portableDirectory -Recurse -Force -ErrorAction SilentlyContinue }
}
