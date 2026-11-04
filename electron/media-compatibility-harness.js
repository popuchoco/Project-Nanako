const profiles = [
  { label: 'MP4／H.264＋AAC', kind: 'video', mime: 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"', ext: '.mp4, .m4v' },
  { label: 'MP4／HEVC＋AAC', kind: 'video', mime: 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"', ext: '.mp4, .m4v' },
  { label: 'WebM／VP8＋Opus', kind: 'video', mime: 'video/webm; codecs="vp8,opus"', ext: '.webm' },
  { label: 'WebM／VP9＋Opus', kind: 'video', mime: 'video/webm; codecs="vp9,opus"', ext: '.webm' },
  { label: 'WebM／AV1＋Opus', kind: 'video', mime: 'video/webm; codecs="av01.0.05M.08,opus"', ext: '.webm' },
  { label: 'QuickTime／MOV', kind: 'video', mime: 'video/quicktime', ext: '.mov' },
  { label: 'MP3', kind: 'audio', mime: 'audio/mpeg', ext: '.mp3' },
  { label: 'AAC／M4A', kind: 'audio', mime: 'audio/mp4; codecs="mp4a.40.2"', ext: '.m4a, .aac' },
  { label: 'WAV／PCM', kind: 'audio', mime: 'audio/wav; codecs="1"', ext: '.wav' },
  { label: 'Ogg／Opus', kind: 'audio', mime: 'audio/ogg; codecs="opus"', ext: '.ogg, .oga, .opus' },
  { label: 'Ogg／Vorbis', kind: 'audio', mime: 'audio/ogg; codecs="vorbis"', ext: '.ogg, .oga' },
  { label: 'FLAC', kind: 'audio', mime: 'audio/flac', ext: '.flac' },
  { label: 'WebM／Opus', kind: 'audio', mime: 'audio/webm; codecs="opus"', ext: '.webm' },
];

const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function eventOnce(target, eventName, errorName = 'error', waitMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`等待 ${eventName} 逾時。`)), waitMs);
    const done = (error, event) => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener(errorName, onError);
      error ? reject(error) : resolve(event);
    };
    const onSuccess = (event) => done(null, event);
    const onError = () => done(new Error(target.error?.message || '媒體解碼失敗。'));
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener(errorName, onError, { once: true });
  });
}

function recordingSupported(mime) {
  return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
}

async function createVideoSample(mime) {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext('2d');
  const stream = canvas.captureStream(12);
  let frame = 0;
  const paint = setInterval(() => {
    context.fillStyle = frame++ % 2 ? '#176b68' : '#f1b756';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.font = '18px sans-serif';
    context.fillText('Nanako media test', 8, 48);
  }, 80);
  try {
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const parts = [];
    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) parts.push(event.data); });
      recorder.addEventListener('error', () => reject(new Error('測試影片編碼失敗。')), { once: true });
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.start(250);
      setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 1500);
    });
    await stopped;
    return new Blob(parts, { type: recorder.mimeType || mime });
  } finally {
    clearInterval(paint);
    for (const track of stream.getTracks()) track.stop();
  }
}

async function createAudioSample(mime) {
  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.frequency.value = 440;
  oscillator.connect(destination);
  try {
    const recorder = new MediaRecorder(destination.stream, { mimeType: mime });
    const parts = [];
    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size) parts.push(event.data); });
      recorder.addEventListener('error', () => reject(new Error('測試音訊編碼失敗。')), { once: true });
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.start(250);
      oscillator.start();
      setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, 1500);
    });
    await stopped;
    return new Blob(parts, { type: recorder.mimeType || mime });
  } finally {
    try { oscillator.stop(); } catch {}
    for (const track of destination.stream.getTracks()) track.stop();
    await audioContext.close().catch(() => {});
  }
}

async function verifyPlayback(blob, kind) {
  if (!blob.size) throw new Error('測試片段是空的。');
  const player = document.querySelector(kind === 'video' ? '#video-probe' : '#audio-probe');
  player.muted = true;
  const objectUrl = URL.createObjectURL(blob);
  const loaded = eventOnce(player, 'loadeddata');
  const playing = eventOnce(player, 'playing');
  player.src = objectUrl;
  player.load();
  try {
    const started = player.play();
    await Promise.all([loaded, playing, started]);
    await timeout(280);
    if (player.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) throw new Error('沒有解出可播放的媒體資料。');
    if (kind === 'video' && (!player.videoWidth || !player.videoHeight)) throw new Error('影片沒有解出影格。');
    if (kind === 'audio' && !player.duration) throw new Error('音訊沒有取得有效長度。');
    return { ok: true, durationSeconds: Number.isFinite(player.duration) ? Number(player.duration.toFixed(2)) : null };
  } finally {
    player.pause();
    player.removeAttribute('src');
    player.load();
    URL.revokeObjectURL(objectUrl);
  }
}

async function advertisedSupport(profile) {
  const element = document.createElement(profile.kind);
  const result = {
    label: profile.label,
    kind: profile.kind,
    mime: profile.mime,
    extensions: profile.ext,
    canPlayType: element.canPlayType(profile.mime) || '不支援／未宣告',
    mediaRecorder: recordingSupported(profile.mime),
    mediaCapabilities: null,
  };
  if (navigator.mediaCapabilities?.decodingInfo) {
    try {
      const configuration = profile.kind === 'video'
        ? { type: 'file', video: { contentType: profile.mime, width: 320, height: 180, bitrate: 450000, framerate: 24 } }
        : { type: 'file', audio: { contentType: profile.mime, channels: '2', bitrate: 128000, samplerate: 44100 } };
      const info = await navigator.mediaCapabilities.decodingInfo(configuration);
      result.mediaCapabilities = { supported: info.supported, smooth: info.smooth, powerEfficient: info.powerEfficient };
    } catch (error) {
      result.mediaCapabilities = { error: error.message };
    }
  }
  return result;
}

window.runMediaCompatibilitySuite = async () => {
  const capabilities = [];
  const generatedPlayback = [];
  const failures = [];
  const sampleGenerationIssues = [];
  for (const profile of profiles) {
    capabilities.push(await advertisedSupport(profile));
    if (!recordingSupported(profile.mime)) continue;
    let sample;
    try {
      sample = profile.kind === 'video' ? await createVideoSample(profile.mime) : await createAudioSample(profile.mime);
    } catch (error) {
      sampleGenerationIssues.push({ label: profile.label, mime: profile.mime, error: error.message });
      continue;
    }
    if (!sample.size) {
      sampleGenerationIssues.push({ label: profile.label, mime: profile.mime, error: 'MediaRecorder 未產生可測試的媒體資料。' });
      continue;
    }
    try {
      const playback = await verifyPlayback(sample, profile.kind);
      generatedPlayback.push({ label: profile.label, mime: profile.mime, ...playback });
    } catch (error) {
      const item = { label: profile.label, mime: profile.mime, ok: false, error: error.message };
      generatedPlayback.push(item);
      failures.push(item);
    }
  }
  return {
    testedAt: new Date().toISOString(),
    capabilities,
    generatedPlayback,
    failures,
    sampleGenerationIssues,
    notes: [
      'canPlayType 與 MediaCapabilities 是瀏覽器宣告能力，不代表所有實際檔案都能播放。',
      'generatedPlayback 是 Electron 內建 MediaRecorder 產生的短測試片段，並由相同執行環境實際解碼播放。',
      'sampleGenerationIssues 表示無法產生測試片段，不等於實際播放器解碼失敗。',
      '未列入 generatedPlayback 的格式仍需用實際來源檔測試；這項測試不會轉檔或安裝額外 codec。',
    ],
  };
};
