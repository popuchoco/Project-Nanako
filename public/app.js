import { filterAndSortFiles, mediaKind } from './file-listing.mjs';
import {
  formatPlaybackTime,
  shouldResumePlayback,
} from './playback-progress.mjs';

const $ = (selector) => document.querySelector(selector);
const state = {
  user: null, shares: [], shareId: '', path: '', albumPath: '', playerPath: '', albumScopeAll: true, playerScopeAll: true,
  albumSearch: '', playerSearch: '', albumLoadSequence: 0, playerLoadSequence: 0, albumSearchTimer: null, playerSearchTimer: null, view: null,
  currentItems: [], fileRenderedCount: 0, albumItems: [], albumImages: [], albumRenderedCount: 0, playerItems: [], playerRenderedCount: 0, pendingTrackPath: '',
  activeTrackPath: '', activeTrackShareId: '', activeTrackItem: null, activeTrackKind: '', playbackSequence: 0, playbackReady: false, lastProgressWrite: 0,
  playerProgress: new Map(),
  photoItems: [], photoIndex: 0, photoShareId: '', photoPath: '', systemRefreshTimer: null,
  selectedItems: new Set(), canWrite: false, fileCategory: 'all', fileSearch: '', fileSort: 'name-asc', fileSearchTimer: null, fileLoadSequence: 0,
  duplicateScanId: '', duplicateScanStatus: '', duplicatePollTimer: null, duplicateGroups: [], duplicateKeepers: new Map(),
  vaultSourceShareId: '', vaultSourcePath: '', vaultSourceItems: [], vaultItems: [], vaultPendingImport: null, vaultPendingDelete: null, vaultPreviewId: '', vaultLockRequest: null, vaultStatusTimer: null,
  vaultRecoveryCodePending: false, vaultImportRunning: false, vaultImportPollTimer: null,
  archiveRunning: false, archiveProgressTimer: null,
  windows: new Map(), windowZ: 10, desktopClockTimer: null,
};
const appDefinitions = {
  files: { name: '檔案管理', icon: '▤' }, duplicates: { name: '檔案去重', icon: '⧉' },
  album: { name: '相簿', icon: '▧' }, player: { name: '播放器', icon: '▶' },
  trash: { name: '資源回收桶', icon: '⌫' }, vault: { name: '加密空間', icon: '◉' }, users: { name: '使用者與權限', icon: '♙', adminOnly: true },
  computer: { name: '儲存空間', icon: '▣' }, system: { name: '電腦資訊', icon: '▦', adminOnly: true },
  settings: { name: '系統設定與紀錄', icon: '⚙', adminOnly: true }, network: { name: '網路狀態', icon: '⌁' },
};
const mediaProfiles = [
  { label: 'MP4／H.264＋AAC', kind: 'video', mime: 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"', extension: '.mp4、.m4v' },
  { label: 'MP4／HEVC＋AAC', kind: 'video', mime: 'video/mp4; codecs="hvc1.1.6.L93.B0,mp4a.40.2"', extension: '.mp4、.m4v' },
  { label: 'WebM／VP8＋Opus', kind: 'video', mime: 'video/webm; codecs="vp8,opus"', extension: '.webm' },
  { label: 'WebM／VP9＋Opus', kind: 'video', mime: 'video/webm; codecs="vp9,opus"', extension: '.webm' },
  { label: 'WebM／AV1＋Opus', kind: 'video', mime: 'video/webm; codecs="av01.0.05M.08,opus"', extension: '.webm' },
  { label: 'QuickTime／MOV', kind: 'video', mime: 'video/quicktime', extension: '.mov' },
  { label: 'MP3', kind: 'audio', mime: 'audio/mpeg', extension: '.mp3' },
  { label: 'AAC／M4A', kind: 'audio', mime: 'audio/mp4; codecs="mp4a.40.2"', extension: '.m4a、.aac' },
  { label: 'WAV／PCM', kind: 'audio', mime: 'audio/wav; codecs="1"', extension: '.wav' },
  { label: 'Ogg／Opus', kind: 'audio', mime: 'audio/ogg; codecs="opus"', extension: '.ogg、.oga、.opus' },
  { label: 'Ogg／Vorbis', kind: 'audio', mime: 'audio/ogg; codecs="vorbis"', extension: '.ogg、.oga' },
  { label: 'FLAC', kind: 'audio', mime: 'audio/flac', extension: '.flac' },
  { label: 'WebM／Opus', kind: 'audio', mime: 'audio/webm; codecs="opus"', extension: '.webm' },
];
const fileCategoryLabels = { all: '我的檔案', image: '圖片', video: '影片', audio: '音訊', document: '文件' };

function mediaUrl(shareId, filePath) {
  return `/api/preview?${new URLSearchParams({ shareId, path: filePath })}`;
}

function mediaItemPath(item, folderPath = '') {
  return item.path || (folderPath ? `${folderPath}/${item.name}` : item.name);
}

function playbackProgressKey(shareId, filePath) {
  return `${shareId}\0${filePath}`;
}

function playbackProgressFor(shareId, filePath) {
  return state.playerProgress.get(playbackProgressKey(shareId, filePath)) || null;
}

function refreshQueueProgress(shareId, filePath) {
  const button = [...document.querySelectorAll('.queue-track')]
    .find((candidate) => candidate.dataset.shareId === shareId && candidate.dataset.trackPath === filePath);
  if (!button) return;
  let hint = button.querySelector('.queue-resume');
  const progress = playbackProgressFor(shareId, filePath);
  if (!progress) { hint?.remove(); return; }
  if (!hint) {
    hint = document.createElement('small');
    hint.className = 'queue-resume';
    button.append(hint);
  }
  hint.textContent = `從 ${formatPlaybackTime(progress.position)} 繼續`;
}

async function persistActivePlayback(force = false, keepalive = false) {
  const item = state.activeTrackItem;
  if (!item || !state.playbackReady || !state.activeTrackPath || !state.activeTrackShareId) return false;
  const player = state.activeTrackKind === 'video' ? $('#video-player') : $('#audio-player');
  if (player.dataset.trackPath !== state.activeTrackPath || !Number.isFinite(player.duration) || player.duration <= 0) return false;
  const now = Date.now();
  if (!force && now - state.lastProgressWrite < 8_000) return false;
  state.lastProgressWrite = now;
  const shareId = state.activeTrackShareId;
  const filePath = state.activeTrackPath;
  const key = playbackProgressKey(shareId, filePath);
  try {
    const result = await api('/api/playback-progress', {
      method: 'POST', keepalive,
      body: JSON.stringify({ shareId, path: filePath, position: player.currentTime, duration: player.duration }),
    });
    if (result.saved) state.playerProgress.set(key, result.progress);
    else state.playerProgress.delete(key);
    refreshQueueProgress(shareId, filePath);
    return result.saved;
  } catch { return false; }
}

async function clearActivePlaybackProgress() {
  if (!state.activeTrackItem || !state.activeTrackPath || !state.activeTrackShareId) return;
  const shareId = state.activeTrackShareId;
  const filePath = state.activeTrackPath;
  const key = playbackProgressKey(shareId, filePath);
  state.playerProgress.delete(key);
  refreshQueueProgress(shareId, filePath);
  const query = new URLSearchParams({ shareId, path: filePath });
  await api(`/api/playback-progress?${query}`, { method: 'DELETE' }).catch(() => {});
}

function syncShareSelectors() {
  for (const selector of ['#share-select', '#trash-share-select', '#album-share-select', '#player-share-select', '#duplicates-share-select']) {
    const element = $(selector);
    if (element) element.value = state.shareId;
  }
}

function selectShare(shareId) {
  if (shareId === state.shareId) return;
  persistActivePlayback(true);
  if (state.duplicateScanId && ['scanning', 'cancelling'].includes(state.duplicateScanStatus)) {
    const query = new URLSearchParams({ scanId: state.duplicateScanId });
    void api(`/api/duplicates/scan?${query}`, { method: 'DELETE' }).catch(() => {});
  }
  clearTimeout(state.duplicatePollTimer);
  clearTimeout(state.albumSearchTimer); clearTimeout(state.playerSearchTimer);
  state.shareId = shareId;
  state.path = ''; state.albumPath = ''; state.playerPath = ''; state.albumScopeAll = true; state.playerScopeAll = true;
  state.albumSearch = ''; state.playerSearch = ''; $('#album-search').value = ''; $('#player-search').value = '';
  state.fileCategory = 'all'; state.fileSearch = ''; $('#file-search').value = '';
  state.selectedItems.clear();
  state.currentItems = []; state.fileRenderedCount = 0; state.albumItems = []; state.albumImages = []; state.albumRenderedCount = 0; state.playerItems = []; state.playerRenderedCount = 0;
  state.pendingTrackPath = ''; state.activeTrackPath = '';
  state.duplicateScanId = ''; state.duplicateScanStatus = ''; state.duplicateGroups = []; state.duplicateKeepers.clear();
  $('#file-more').hidden = true; $('#album-more').hidden = true; $('#player-more').hidden = true;
  $('#duplicate-results').hidden = true; $('#duplicate-empty').hidden = true; $('#duplicate-scan-progress').hidden = true;
  $('#duplicate-open-trash').hidden = true;
  resetPlayer();
  syncShareSelectors();
  for (const [view, entry] of state.windows) {
    if (entry.status === 'open' || entry.status === 'minimized') loadView(view);
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) } });
  if (response.status === 204) return null;
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : response;
  if (!response.ok) throw new Error(payload?.message || `連線失敗（${response.status}）`);
  return payload;
}

function notify(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function formatSize(size) {
  if (size === null || size === undefined) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(value));
}

function showAuth(needsSetup) {
  clearInterval(state.desktopClockTimer);
  clearTimeout(state.systemRefreshTimer);
  $('#app-shell').hidden = true;
  closeLauncherMenu();
  $('#auth-screen').hidden = false;
  $('#auth-title').textContent = needsSetup ? '設定本機管理員' : '登入 Nanako';
  $('#auth-description').textContent = needsSetup ? '建立只有這台電腦使用的管理員帳號。資料不會送到外部服務。' : '請使用本機帳號登入。這個帳號不會連結任何雲端服務。';
  $('#auth-submit').textContent = needsSetup ? '建立管理員' : '登入';
  $('#auth-password').autocomplete = needsSetup ? 'new-password' : 'current-password';
  $('#auth-error').hidden = true;
  $('#auth-form').dataset.mode = needsSetup ? 'setup' : 'login';
}

async function start() {
  try {
    const { needsSetup } = await api('/api/setup-state');
    if (needsSetup) return showAuth(true);
    try {
      const { user } = await api('/api/me');
      state.user = user;
      return showApp();
    } catch { showAuth(false); }
  } catch (error) { notify(error.message, true); }
}

function showApp() {
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#account-name').textContent = state.user.username;
  document.querySelectorAll('.admin-only').forEach((item) => { item.hidden = state.user.role !== 'admin'; });
  updateDesktopClock();
  updateDesktopWidget();
  clearInterval(state.desktopClockTimer);
  state.desktopClockTimer = setInterval(updateDesktopClock, 15_000);
  loadShares().then(() => launchView('files')).catch((error) => notify(error.message, true));
}

async function loadShares() {
  const { shares } = await api('/api/shares');
  state.shares = shares;
  if (!state.shares.some((share) => share.id === state.shareId)) state.shareId = state.shares[0]?.id || '';
  for (const selector of ['#share-select', '#trash-share-select', '#album-share-select', '#player-share-select', '#duplicates-share-select']) {
    const element = $(selector);
    element.replaceChildren(...state.shares.map((share) => {
      const option = document.createElement('option'); option.value = share.id; option.textContent = share.name; return option;
    }));
    element.value = state.shareId;
    element.disabled = state.shares.length === 0;
  }
  const vaultSources = state.shares.filter((share) => share.canWrite);
  const vaultSource = $('#vault-source-share');
  if (vaultSource) {
    vaultSource.replaceChildren(...vaultSources.map((share) => {
      const option = document.createElement('option'); option.value = share.id; option.textContent = share.name; return option;
    }));
    if (!vaultSources.some((share) => share.id === state.vaultSourceShareId)) {
      state.vaultSourceShareId = vaultSources[0]?.id || '';
      state.vaultSourcePath = '';
    }
    vaultSource.value = state.vaultSourceShareId;
    vaultSource.disabled = vaultSources.length === 0;
  }
  syncShareSelectors();
  updateDesktopWidget();
  renderPermissionOptions();
}

function renderPermissionOptions() {
  const container = $('#permission-options');
  container.replaceChildren();
  for (const share of state.shares) {
    const row = document.createElement('label'); row.className = 'permission-row';
    const read = document.createElement('input'); read.type = 'checkbox'; read.name = `read-${share.id}`; read.value = share.id;
    const write = document.createElement('input'); write.type = 'checkbox'; write.name = `write-${share.id}`; write.value = share.id;
    read.addEventListener('change', () => { if (!read.checked) write.checked = false; });
    write.addEventListener('change', () => { if (write.checked) read.checked = true; });
    row.append(read, document.createTextNode(`${share.name}：讀取`), write, document.createTextNode('寫入'));
    container.append(row);
  }
}

function loadView(view) {
  if (view === 'files') void loadFiles();
  if (view === 'duplicates') void loadDuplicates();
  if (view === 'album') void loadAlbum();
  if (view === 'player') { void loadPlayer(); if (!state.mediaCompatibilityLoaded) void loadMediaCompatibility(); }
  if (view === 'trash') void loadTrash();
  if (view === 'users') void loadUsers();
  if (view === 'vault') void loadVault();
  if (view === 'computer') void loadComputer();
  if (view === 'system') void loadSystem();
  if (view === 'settings') { void loadAuditSettings(); void loadAuditLogs(); }
  if (view === 'network') void loadNetwork();
}

function recordWindowAction(view, action) {
  void api('/api/activity', { method: 'POST', body: JSON.stringify({ view, action }) }).catch(() => {});
}

function renderWindowSwitchers() {
  const focusedView = document.activeElement?.dataset?.windowView;
  const focusedContainer = document.activeElement?.parentElement?.id;
  for (const [selector, className] of [['#taskbar-windows', 'taskbar-app'], ['#dock-windows', 'dock-app']]) {
    const container = $(selector);
    container.replaceChildren();
    for (const [view, entry] of state.windows) {
      const definition = appDefinitions[view];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.classList.toggle('active', entry.status === 'open' && state.view === view);
      button.classList.toggle('running', true);
      button.dataset.windowView = view;
      button.setAttribute('aria-pressed', String(entry.status === 'open' && state.view === view));
      button.setAttribute('aria-label', `${entry.status === 'minimized' ? '還原' : '切換至'}${definition.name}視窗`);
      button.title = `${definition.name}${entry.status === 'minimized' ? '（已最小化）' : ''}`;
      button.textContent = definition.icon;
      if (className === 'dock-app') { const indicator = document.createElement('i'); indicator.setAttribute('aria-hidden', 'true'); button.append(indicator); }
      button.addEventListener('click', () => focusWindow(view));
      container.append(button);
    }
  }
  if (focusedView && focusedContainer) $(`#${focusedContainer} [data-window-view="${focusedView}"]`)?.focus({ preventScroll: true });
}

function focusWindow(view, { record = true } = {}) {
  const entry = state.windows.get(view);
  if (!entry) return;
  const wasMinimized = entry.status === 'minimized';
  const isNew = entry.needsInitialLoad;
  const previousView = state.view;
  entry.status = 'open';
  entry.element.hidden = false;
  entry.z = ++state.windowZ;
  entry.element.style.zIndex = String(entry.z);
  for (const [otherView, other] of state.windows) other.element.classList.toggle('is-active', otherView === view);
  state.view = view;
  if (record && previousView !== view) recordWindowAction(view, isNew ? 'open' : wasMinimized ? 'restore' : 'focus');
  renderWindowSwitchers();
  if (entry.needsInitialLoad) {
    entry.needsInitialLoad = false;
    loadView(view);
  } else if (wasMinimized && (view === 'system' || view === 'duplicates')) {
    loadView(view);
  }
}

function createAppWindow(view) {
  const definition = appDefinitions[view];
  const sourcePanel = $(`#view-${view}`);
  if (!definition || !sourcePanel) return null;
  const element = document.importNode($('#app-window-template').content.firstElementChild, true);
  if (view === 'files') element.classList.add('file-manager-window');
  const titlebar = element.querySelector('.window-titlebar');
  element.setAttribute('aria-label', `${definition.name}視窗`);
  titlebar.setAttribute('aria-label', `${definition.name}視窗標題列。可拖曳移動，雙擊可最大化；聚焦後可用方向鍵移動，按 Enter 最大化或還原。`);
  element.querySelector('[data-window-icon]').textContent = definition.icon;
  element.querySelector('[data-window-title]').textContent = definition.name;
  const content = element.querySelector('[data-window-content]');
  sourcePanel.hidden = false;
  content.append(sourcePanel);

  const desktop = $('#desktop-area').getBoundingClientRect();
  const offset = (state.windows.size % 7) * 26;
  const left = Math.max(12, Math.min(desktop.width * 0.17 + offset, desktop.width - Math.min(390, desktop.width * 0.55)));
  const top = Math.max(14, Math.min(desktop.height * 0.07 + offset, desktop.height - 170));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  $('#window-layer').append(element);
  element.classList.add('is-entering');
  element.addEventListener('animationend', (event) => {
    if (event.animationName === 'window-enter') element.classList.remove('is-entering');
  }, { once: true });
  const entry = { view, element, panel: sourcePanel, status: 'open', z: ++state.windowZ, maximized: false, restoreRect: null, needsInitialLoad: true };
  element.style.zIndex = String(entry.z);
  state.windows.set(view, entry);
  initializeWindowInteractions(entry);
  renderWindowSwitchers();
  return entry;
}

function launchView(view) {
  closeLauncherMenu();
  const definition = appDefinitions[view];
  if (!definition) return;
  if (definition.adminOnly && state.user?.role !== 'admin') { notify('這項功能僅供管理員使用。', true); return; }
  const isNew = !state.windows.has(view);
  if (isNew) createAppWindow(view);
  focusWindow(view);
  if (isNew) state.windows.get(view)?.element.querySelector('.window-titlebar').focus();
}

function showView(view) { launchView(view); }

function updateDesktopClock() {
  const clock = $('#desktop-clock');
  if (!clock) return;
  const now = new Date();
  clock.textContent = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  clock.title = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'full' }).format(now);
  const widgetTime = $('#desktop-widget-time');
  const widgetDate = $('#desktop-widget-date');
  if (widgetTime) {
    widgetTime.textContent = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    widgetTime.dateTime = now.toISOString();
  }
  if (widgetDate) widgetDate.textContent = new Intl.DateTimeFormat('zh-TW', { weekday: 'long', month: 'long', day: 'numeric' }).format(now);
}

function updateDesktopWidget() {
  const count = $('#desktop-widget-share-count');
  if (!count) return;
  count.textContent = state.shares.length === 0 ? '尚未設定' : `${state.shares.length} 個`;
  count.title = state.shares.length ? state.shares.map((share) => share.name).join('、') : '目前沒有可存取的 Nanako 資料空間';
}

function toggleLauncherMenu(force) {
  const menu = $('#launcher-menu');
  const button = $('#launcher-toggle');
  const open = force ?? menu.hidden;
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

function closeLauncherMenu() { toggleLauncherMenu(false); }

function toggleWindowMaximized(entry) {
  const { element } = entry;
  const button = element.querySelector('[data-window-action="maximize"]');
  if (!entry.maximized) {
    entry.restoreRect = { left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height };
    entry.maximized = true;
    element.classList.add('is-maximized');
    button.textContent = '▢'; button.setAttribute('aria-label', '還原視窗'); button.title = '還原';
    recordWindowAction(entry.view, 'maximize');
  } else {
    entry.maximized = false;
    element.classList.remove('is-maximized');
    for (const key of ['left', 'top', 'width', 'height']) element.style[key] = entry.restoreRect?.[key] || '';
    button.textContent = '□'; button.setAttribute('aria-label', '最大化視窗'); button.title = '最大化';
    recordWindowAction(entry.view, 'restore');
  }
}

function minimizeWindow(view) {
  const entry = state.windows.get(view);
  if (!entry) return;
  entry.status = 'minimized'; entry.element.hidden = true; entry.element.classList.remove('is-active');
  recordWindowAction(view, 'minimize');
  if (state.view === view) {
    const next = [...state.windows.values()].filter((candidate) => candidate.status === 'open').sort((a, b) => b.z - a.z)[0];
    if (next) { focusWindow(next.view); next.element.querySelector('.window-titlebar').focus(); }
    else { state.view = null; renderWindowSwitchers(); $('#launcher-toggle').focus(); }
  } else renderWindowSwitchers();
}

function closeWindow(view) {
  const entry = state.windows.get(view);
  if (!entry) return;
  recordWindowAction(view, 'close');
  if (view === 'vault') {
    clearVaultContents();
    clearInterval(state.vaultStatusTimer); state.vaultStatusTimer = null;
    state.vaultLockRequest = api('/api/vault/lock', { method: 'POST' }).catch(() => {}).finally(() => { state.vaultLockRequest = null; });
  }
  if (view === 'player') resetPlayer();
  if (view === 'album') {
    state.albumLoadSequence += 1;
    $('#album-grid').replaceChildren();
    state.albumItems = []; state.albumImages = []; state.albumRenderedCount = 0;
    $('#album-more').hidden = true;
  }
  if (view === 'player') {
    state.playerLoadSequence += 1;
    $('#player-queue').replaceChildren();
    state.playerItems = []; state.playerRenderedCount = 0;
    state.activeTrackPath = '';
    refreshMediaTestTracks();
    $('#player-more').hidden = true;
  }
  if (view === 'files') {
    clearTimeout(state.fileSearchTimer); state.fileLoadSequence += 1;
    state.currentItems = []; state.fileRenderedCount = 0; state.selectedItems.clear();
    $('#file-list').replaceChildren(); $('#file-more').hidden = true; updateBatchToolbar();
  }
  if (view === 'system') { clearTimeout(state.systemRefreshTimer); state.systemRefreshTimer = null; }
  if (view === 'duplicates') {
    clearTimeout(state.duplicatePollTimer);
    if ($('#duplicate-cleanup-dialog').open) $('#duplicate-cleanup-dialog').close();
    if (state.duplicateScanId && ['scanning', 'cancelling'].includes(state.duplicateScanStatus)) {
      const query = new URLSearchParams({ scanId: state.duplicateScanId });
      void api(`/api/duplicates/scan?${query}`, { method: 'DELETE' }).catch(() => {});
      state.duplicateScanStatus = 'cancelling';
      $('#duplicate-scan-progress').hidden = true;
      $('#duplicate-scan-cancel').hidden = true;
      $('#duplicate-scan-start').disabled = false;
      $('#duplicates-share-select').disabled = false;
      setDuplicateMessage('視窗關閉時已送出取消掃描要求；重新開啟視窗會確認掃描已停止。');
    }
  }
  if ($('#photo-dialog').open && view === 'album') $('#photo-dialog').close();
  entry.panel.hidden = true;
  $('#window-content-bank').append(entry.panel);
  entry.element.remove();
  state.windows.delete(view);
  if (state.view === view) {
    const next = [...state.windows.values()].filter((candidate) => candidate.status === 'open').sort((a, b) => b.z - a.z)[0];
    if (next) { focusWindow(next.view, { record: true }); next.element.querySelector('.window-titlebar').focus(); }
    else { state.view = null; renderWindowSwitchers(); $('#launcher-toggle').focus(); }
  }
  renderWindowSwitchers();
}

function closeAllWindows() {
  if (state.duplicateScanId && ['scanning', 'cancelling'].includes(state.duplicateScanStatus)) {
    const query = new URLSearchParams({ scanId: state.duplicateScanId });
    void api(`/api/duplicates/scan?${query}`, { method: 'DELETE' }).catch(() => {});
    state.duplicateScanId = ''; state.duplicateScanStatus = 'cancelled';
  }
  clearTimeout(state.duplicatePollTimer); clearTimeout(state.systemRefreshTimer); clearInterval(state.desktopClockTimer);
  clearTimeout(state.fileSearchTimer); clearTimeout(state.albumSearchTimer); clearTimeout(state.playerSearchTimer);
  resetPlayer();
  if ($('#photo-dialog').open) $('#photo-dialog').close();
  $('#photo-image').removeAttribute('src');
  state.photoItems = []; state.photoIndex = 0; state.photoShareId = ''; state.photoPath = '';
  state.albumItems = []; state.albumImages = []; state.albumRenderedCount = 0; state.albumLoadSequence += 1;
  state.playerItems = []; state.playerRenderedCount = 0; state.playerLoadSequence += 1;
  state.currentItems = []; state.fileRenderedCount = 0; state.selectedItems.clear(); state.fileLoadSequence += 1;
  $('#album-grid').replaceChildren(); $('#album-more').hidden = true;
  $('#player-queue').replaceChildren(); $('#player-more').hidden = true;
  $('#file-list').replaceChildren(); $('#file-more').hidden = true; updateBatchToolbar();
  for (const selector of ['#duplicate-cleanup-dialog', '#change-password-dialog', '#clear-audit-dialog']) {
    const dialog = $(selector); if (dialog.open) dialog.close();
  }
  for (const entry of state.windows.values()) { entry.panel.hidden = true; $('#window-content-bank').append(entry.panel); entry.element.remove(); }
  state.windows.clear(); state.view = null; state.systemRefreshTimer = null;
  renderWindowSwitchers();
}

function initializeWindowInteractions(entry) {
  const { view, element } = entry;
  const titlebar = element.querySelector('.window-titlebar');
  let drag = null;
  element.addEventListener('pointerdown', () => { if (state.view !== view) focusWindow(view); });
  element.querySelectorAll('[data-window-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.windowAction;
    if (action === 'minimize') minimizeWindow(view);
    if (action === 'maximize') toggleWindowMaximized(entry);
    if (action === 'close') closeWindow(view);
  }));
  titlebar.addEventListener('pointerdown', (event) => {
    focusWindow(view);
    if (event.button !== 0 || event.target.closest('button') || entry.maximized) return;
    const rect = element.getBoundingClientRect(); const area = $('#desktop-area').getBoundingClientRect();
    drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, area, started: false };
    titlebar.setPointerCapture(event.pointerId);
  });
  titlebar.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.started = true;
    const left = Math.max(0, Math.min(drag.area.width - Math.min(element.offsetWidth, 180), event.clientX - drag.area.left - drag.offsetX));
    const top = Math.max(0, Math.min(drag.area.height - 44, event.clientY - drag.area.top - drag.offsetY));
    element.style.left = `${left}px`; element.style.top = `${top}px`;
  });
  const stopDrag = (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    if (drag.started) recordWindowAction(view, 'move');
    drag = null;
  };
  titlebar.addEventListener('pointerup', stopDrag); titlebar.addEventListener('pointercancel', stopDrag);
  titlebar.addEventListener('dblclick', (event) => { if (!event.target.closest('button')) toggleWindowMaximized(entry); });
  titlebar.addEventListener('keydown', (event) => {
    if (event.target !== titlebar) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleWindowMaximized(entry); return; }
    const movement = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[event.key];
    if (!movement || entry.maximized) return;
    event.preventDefault();
    const area = $('#desktop-area').getBoundingClientRect(); const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(0, Math.min(area.width - Math.min(rect.width, 180), rect.left - area.left + movement[0]))}px`;
    element.style.top = `${Math.max(0, Math.min(area.height - 44, rect.top - area.top + movement[1]))}px`;
    recordWindowAction(view, 'move');
  });
}

function initializeDesktopInteractions() {
  document.querySelectorAll('[data-open-view]').forEach((button) => button.addEventListener('click', () => launchView(button.dataset.openView)));
  document.querySelectorAll('[data-file-category]').forEach((button) => button.addEventListener('click', () => setFileCategory(button.dataset.fileCategory)));
  $('[data-file-location="root"]').addEventListener('click', () => {
    state.path = ''; state.fileCategory = 'all'; state.fileSearch = ''; state.selectedItems.clear(); $('#file-search').value = '';
    syncFileManagerNavigation(); loadFiles();
  });
  $('#launcher-toggle').addEventListener('click', () => toggleLauncherMenu());
  $('#dock-launcher').addEventListener('click', () => toggleLauncherMenu());
  $('#desktop-account').addEventListener('click', () => toggleLauncherMenu());
  $('#desktop-area').addEventListener('pointerdown', (event) => {
    if (event.target === event.currentTarget) closeLauncherMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#launcher-menu').hidden) closeLauncherMenu();
  });
}

function renderBreadcrumb(container, currentPath, onNavigate) {
  container.replaceChildren();
  const root = document.createElement('button'); root.type = 'button'; root.textContent = '主資料夾'; root.addEventListener('click', () => onNavigate('')); container.append(root);
  const parts = currentPath ? currentPath.split('/') : [];
  let joined = '';
  for (let index = 0; index < parts.length; index += 1) {
    const sep = document.createElement('span'); sep.textContent = '›'; sep.setAttribute('aria-hidden', 'true'); container.append(sep);
    joined = joined ? `${joined}/${parts[index]}` : parts[index];
    const target = joined;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = parts[index]; button.addEventListener('click', () => onNavigate(target)); container.append(button);
  }
}

function navigateFiles(nextPath) {
  if (nextPath !== state.path) state.selectedItems.clear();
  state.path = nextPath;
  loadFiles();
}

function setFileCategory(category) {
  if (!fileCategoryLabels[category]) return;
  state.fileCategory = category;
  state.path = '';
  state.selectedItems.clear();
  syncFileManagerNavigation();
  loadFiles();
}

function syncFileManagerNavigation() {
  for (const button of document.querySelectorAll('[data-file-category]')) {
    const active = button.dataset.fileCategory === state.fileCategory;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('active', active);
  }
  const rootButton = $('[data-file-location="root"]');
  rootButton?.classList.toggle('active', state.fileCategory === 'all' && !state.path);
  if (rootButton) {
    if (state.fileCategory === 'all' && !state.path) rootButton.setAttribute('aria-current', 'page');
    else rootButton.removeAttribute('aria-current');
  }
  $('#file-view-title').textContent = state.fileCategory === 'all' ? (state.path ? state.path.split('/').at(-1) : '我的檔案') : fileCategoryLabels[state.fileCategory];
  const categoryMode = state.fileCategory !== 'all';
  $('#view-files').classList.toggle('category-mode', categoryMode);
  $('#file-batch-toolbar').hidden = categoryMode;
  $('#file-scope-note').textContent = categoryMode
    ? `正在搜尋「${fileCategoryLabels[state.fileCategory]}」；範圍是目前 Nanako 資料空間的所有資料夾，不包含資源回收桶。`
    : '資料只儲存在 NanakoData；檔案管理、相簿、播放器與資源回收桶不會瀏覽其他磁碟或 Windows 個人資料夾。';
  $('#file-search').placeholder = categoryMode ? '搜尋整個資料空間' : '搜尋目前資料夾';
  $('#file-search').setAttribute('aria-label', categoryMode ? '搜尋目前 Nanako 資料空間中的檔案名稱' : '搜尋目前資料夾中的檔案名稱');
}

function updateBatchToolbar() {
  const count = state.selectedItems.size;
  $('#selected-file-count').textContent = count ? `已選取 ${count} 個項目` : '尚未選取項目';
  const canSelect = state.fileCategory === 'all' && state.canWrite;
  for (const id of ['#batch-move', '#batch-copy', '#batch-delete']) $(id).disabled = !canSelect || count === 0;
  const selectAll = $('#select-all-files');
  selectAll.setAttribute('aria-label', '選取目前資料夾的所有項目');
  const selectedVisible = canSelect ? state.currentItems.filter((item) => state.selectedItems.has(item.name)).length : 0;
  selectAll.checked = state.currentItems.length > 0 && selectedVisible === state.currentItems.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < state.currentItems.length;
  selectAll.disabled = !state.currentItems.length || !canSelect;
}

const FILE_BATCH_SIZE = 100;

function appendFileBatch() {
  const categoryMode = state.fileCategory !== 'all';
  const canManage = state.canWrite && !categoryMode;
  const end = Math.min(state.currentItems.length, state.fileRenderedCount + FILE_BATCH_SIZE);
  const body = $('#file-list');
  for (const item of state.currentItems.slice(state.fileRenderedCount, end)) {
    const row = document.createElement('tr');
    const selectCell = document.createElement('td'); selectCell.className = 'file-select-column';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = !categoryMode && state.selectedItems.has(item.name); checkbox.disabled = !canManage; checkbox.setAttribute('aria-label', `選取${item.name}`);
    checkbox.addEventListener('change', () => { if (checkbox.checked) state.selectedItems.add(item.name); else state.selectedItems.delete(item.name); updateBatchToolbar(); });
    selectCell.append(checkbox);
    const nameCell = document.createElement('td'); const wrapper = document.createElement('div'); wrapper.className = 'item-name';
    const icon = document.createElement('span'); icon.className = `item-icon${item.isDirectory ? ' folder' : ''}`; icon.setAttribute('aria-hidden', 'true'); icon.textContent = item.isDirectory ? '▰' : '▧';
    const open = document.createElement('button'); open.type = 'button'; open.textContent = item.name;
    if (item.isDirectory) open.addEventListener('click', () => navigateFiles(state.path ? `${state.path}/${item.name}` : item.name));
    else open.addEventListener('click', () => categoryMode ? openCatalogFile(item) : openFile(item));
    wrapper.append(icon, open); nameCell.append(wrapper);
    if (categoryMode) { const location = document.createElement('small'); location.className = 'item-location'; location.textContent = item.path; nameCell.append(location); }
    const dateCell = document.createElement('td'); dateCell.textContent = formatDate(item.modifiedAt);
    const sizeCell = document.createElement('td'); sizeCell.textContent = item.isDirectory ? '資料夾' : formatSize(item.size);
    const actionCell = document.createElement('td');
    if (canManage) {
      const actions = document.createElement('div'); actions.className = 'row-actions';
      const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'text-action'; rename.textContent = '重新命名'; rename.addEventListener('click', () => renameItem(item.name)); actions.append(rename);
      if (!item.name.toLocaleLowerCase('en-US').endsWith('.zip')) {
        const compress = document.createElement('button'); compress.type = 'button'; compress.className = 'text-action'; compress.textContent = '壓縮 ZIP'; compress.addEventListener('click', () => runArchiveAction(item.name, 'create', compress)); actions.append(compress);
      } else {
        const extract = document.createElement('button'); extract.type = 'button'; extract.className = 'text-action'; extract.textContent = '解壓縮'; extract.addEventListener('click', () => runArchiveAction(item.name, 'extract', extract)); actions.append(extract);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-action danger'; remove.textContent = '移至回收桶'; remove.addEventListener('click', () => deleteItem(item.name)); actions.append(remove);
      actionCell.append(actions);
    }
    row.append(selectCell, nameCell, dateCell, sizeCell, actionCell); body.append(row);
  }
  state.fileRenderedCount = end;
  const more = $('#file-more');
  more.hidden = end >= state.currentItems.length;
  more.textContent = `載入更多項目（${end}／${state.currentItems.length}）`;
}

async function loadFiles() {
  const loadSequence = ++state.fileLoadSequence;
  syncFileManagerNavigation();
  $('#file-more').hidden = true;
  if (!state.shareId) { state.currentItems = []; state.fileRenderedCount = 0; state.canWrite = false; $('#file-list').replaceChildren(); $('#file-more').hidden = true; $('#empty-files').hidden = false; renderBreadcrumb($('#breadcrumb'), state.path, navigateFiles); updateBatchToolbar(); return false; }
  try {
    const categoryMode = state.fileCategory !== 'all';
    if (categoryMode) {
      $('#file-list').replaceChildren(); $('#empty-files').hidden = false;
      $('#empty-files strong').textContent = '正在搜尋整個資料空間'; $('#empty-files span').textContent = '搜尋範圍僅限目前 Nanako 資料空間，不包含資源回收桶。';
    }
    const query = categoryMode
      ? new URLSearchParams({ shareId: state.shareId, category: state.fileCategory, search: state.fileSearch })
      : new URLSearchParams({ shareId: state.shareId, path: state.path });
    const result = await api(`${categoryMode ? '/api/files/search' : '/api/files'}?${query}`);
    if (loadSequence !== state.fileLoadSequence) return false;
    const { items, canWrite } = result;
    const visibleItems = filterAndSortFiles(items, { category: 'all', sort: state.fileSort });
    state.currentItems = visibleItems;
    state.canWrite = canWrite;
    for (const selected of [...state.selectedItems]) if (!items.some((item) => item.name === selected)) state.selectedItems.delete(selected);
    if (categoryMode) {
      renderBreadcrumb($('#breadcrumb'), '', () => setFileCategory('all'));
      const categoryCrumb = document.createElement('span'); categoryCrumb.textContent = `${fileCategoryLabels[state.fileCategory]}（整個資料空間）`; categoryCrumb.setAttribute('aria-current', 'page');
      $('#breadcrumb').append(document.createTextNode(' › '), categoryCrumb);
    } else renderBreadcrumb($('#breadcrumb'), state.path, navigateFiles);
    const body = $('#file-list'); body.replaceChildren();
    const message = $('#file-message');
    message.hidden = true; message.textContent = '';
    if (categoryMode && result.truncated) {
      message.textContent = `項目數較多，目前僅顯示前 ${visibleItems.length.toLocaleString('zh-TW')} 個結果；請輸入檔名縮小搜尋範圍。`;
      message.hidden = false;
    }
    $('#empty-files').hidden = visibleItems.length !== 0;
    $('#empty-files strong').textContent = categoryMode
      ? (items.length === 0 ? `這個資料空間沒有${fileCategoryLabels[state.fileCategory]}` : '沒有符合條件的檔案')
      : (items.length === 0 ? '這裡還沒有檔案' : '沒有符合條件的檔案');
    $('#empty-files span').textContent = categoryMode
      ? (items.length === 0 ? '分類搜尋只會檢查目前 Nanako 資料空間中的一般檔案。' : '請調整搜尋文字；分類搜尋範圍是整個資料空間。')
      : (items.length === 0 ? '可以匯入檔案，或先新增資料夾。' : '請調整搜尋文字；目前只搜尋這個資料夾。');
    const canManage = canWrite && !categoryMode;
    $('#new-folder').disabled = !canManage; $('#file-input').disabled = !canManage;
    $('#upload-file-label').setAttribute('aria-disabled', String(!canManage));
    state.fileRenderedCount = 0;
    $('#file-more').hidden = true;
    appendFileBatch();
    updateBatchToolbar();
    return true;
  } catch (error) {
    if (loadSequence !== state.fileLoadSequence) return false;
    state.currentItems = []; state.fileRenderedCount = 0; state.canWrite = false; state.selectedItems.clear();
    $('#file-list').replaceChildren(); $('#file-more').hidden = true; $('#empty-files').hidden = false;
    $('#empty-files strong').textContent = '無法載入檔案'; $('#empty-files span').textContent = '請確認資料空間權限或重新整理後再試。';
    $('#new-folder').disabled = true; $('#file-input').disabled = true;
    updateBatchToolbar(); notify(error.message, true); return false;
  }
}

async function openCatalogFile(item) {
  const expectedShare = state.shareId;
  const parts = item.path.split('/');
  const name = parts.pop();
  const expectedPath = parts.join('/');
  state.path = expectedPath;
  state.fileCategory = 'all';
  state.fileSearch = '';
  state.selectedItems.clear();
  $('#file-search').value = '';
  syncFileManagerNavigation();
  if (!await loadFiles() || state.shareId !== expectedShare || state.path !== expectedPath || state.fileCategory !== 'all') return;
  const resolved = state.currentItems.find((entry) => !entry.isDirectory && entry.name === name);
  if (resolved) openFile(resolved);
}

function joinedPath(name) { return state.path ? `${state.path}/${name}` : name; }

async function runArchiveAction(name, operation, button) {
  const label = operation === 'create' ? '壓縮 ZIP' : '解壓縮';
  button.disabled = true;
  state.archiveRunning = true;
  $('#archive-progress-title').textContent = `${label}中`;
  $('#archive-progress-bar').value = 0;
  $('#archive-progress-message').textContent = '正在準備 Nanako 資料空間內的檔案清單…';
  $('#archive-cancel').disabled = false; $('#archive-cancel').textContent = '取消作業';
  $('#archive-progress-dialog').showModal();
  clearInterval(state.archiveProgressTimer);
  state.archiveProgressTimer = setInterval(() => { void refreshArchiveProgress(); }, 350);
  void refreshArchiveProgress();
  try {
    const result = await api(`/api/archive/${operation}`, { method: 'POST', body: JSON.stringify({ shareId: state.shareId, path: joinedPath(name) }) });
    $('#archive-progress-dialog').close();
    notify(operation === 'create' ? `已建立「${result.name}」。` : `已解壓縮至「${result.name}」。`);
    await loadFiles();
  } catch (error) { if ($('#archive-progress-dialog').open) $('#archive-progress-dialog').close(); notify(`${label}失敗：${error.message}`, true); }
  finally { clearInterval(state.archiveProgressTimer); state.archiveProgressTimer = null; state.archiveRunning = false; button.disabled = false; }
}

async function refreshArchiveProgress() {
  try {
    const job = await api('/api/archive/status');
    if (!job.active) return;
    const bar = $('#archive-progress-bar');
    const percent = job.totalBytes > 0 ? Math.min(99, Math.floor(job.bytesRead * 100 / job.totalBytes))
      : job.totalEntries > 0 ? Math.min(99, Math.floor(job.entriesDone * 100 / job.totalEntries)) : 0;
    bar.value = percent;
    $('#archive-progress-message').textContent = job.totalBytes > 0
      ? `${job.phase} · ${formatSize(job.bytesRead)}／${formatSize(job.totalBytes)}（${percent}%） · 項目 ${job.entriesDone}/${job.totalEntries || '…'}`
      : `${job.phase} · 項目 ${job.entriesDone}/${job.totalEntries || '…'}`;
    const publishing = job.phase === '發佈 ZIP 成品' || job.phase === '發佈解壓內容';
    $('#archive-cancel').disabled = publishing;
    if (publishing) $('#archive-cancel').textContent = '即將完成';
  } catch { /* The archive response remains authoritative if a poll briefly fails. */ }
}

function openFile(item) {
  const kind = mediaKind(item.name);
  if (kind === 'image') {
    openPhotoGallery(state.currentItems, state.path, state.shareId, item.name);
  } else if (kind === 'audio' || kind === 'video') {
    state.playerPath = state.path;
    state.playerScopeAll = false;
    state.playerSearch = '';
    $('#player-search').value = '';
    state.pendingTrackPath = joinedPath(item.name);
    showView('player');
  } else {
    download(item.name);
  }
}

function openPhotoGallery(items, folderPath, shareId, selectedName = '') {
  state.photoItems = items.filter((item) => !item.isDirectory && mediaKind(item.name) === 'image');
  state.photoPath = folderPath;
  state.photoShareId = shareId;
  const index = state.photoItems.findIndex((item) => item.path ? item.path === selectedName : item.name === selectedName);
  if (index >= 0) showPhoto(index);
}

function showPhoto(index) {
  if (!state.photoItems.length) return;
  state.photoIndex = (index + state.photoItems.length) % state.photoItems.length;
  const item = state.photoItems[state.photoIndex];
  const image = $('#photo-image');
  image.alt = item.name;
  image.src = mediaUrl(state.photoShareId, mediaItemPath(item, state.photoPath));
  $('#photo-caption').textContent = item.path || item.name;
  $('#photo-prev').disabled = state.photoItems.length < 2;
  $('#photo-next').disabled = state.photoItems.length < 2;
  const dialog = $('#photo-dialog');
  if (!dialog.open) dialog.showModal();
}

async function download(name) {
  const query = new URLSearchParams({ shareId: state.shareId, path: joinedPath(name) });
  const response = await fetch(`/api/download?${query}`, { credentials: 'same-origin' });
  if (!response.ok) { const body = await response.json(); return notify(body.message, true); }
  const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

async function deleteItem(name) {
  if (!confirm(`要將「${name}」移至資源回收桶嗎？`)) return;
  const query = new URLSearchParams({ shareId: state.shareId, path: joinedPath(name) });
  try { await api(`/api/files?${query}`, { method: 'DELETE' }); state.selectedItems.delete(name); notify('已移至資源回收桶。'); await loadFiles(); }
  catch (error) { notify(error.message, true); }
}

async function renameItem(name) {
  const newName = prompt('請輸入新的檔案或資料夾名稱', name);
  if (newName === null || newName.trim() === name) return;
  try {
    await api('/api/files/rename', { method: 'POST', body: JSON.stringify({ shareId: state.shareId, path: joinedPath(name), newName }) });
    state.selectedItems.delete(name);
    notify(`已重新命名為「${newName.trim()}」。`);
    await loadFiles();
  } catch (error) { notify(`重新命名失敗：${error.message}`, true); }
}

async function batchFileOperation(operation) {
  const names = [...state.selectedItems];
  if (!names.length || !state.canWrite) return;
  const destinationPath = prompt('請輸入 Nanako 資料空間內的目的地資料夾路徑；留白代表主資料夾。', '');
  if (destinationPath === null) return;
  const labels = { move: '移動', copy: '複製' };
  for (const id of ['#batch-move', '#batch-copy', '#batch-delete']) $(id).disabled = true;
  let succeeded = 0;
  const errors = [];
  for (const name of names) {
    try {
      await api(`/api/files/${operation}`, { method: 'POST', body: JSON.stringify({ shareId: state.shareId, path: joinedPath(name), destinationPath: destinationPath.trim() }) });
      succeeded += 1;
      if (operation === 'move') state.selectedItems.delete(name);
    } catch (error) { errors.push(`${name}：${error.message}`); }
  }
  await loadFiles();
  const message = `${labels[operation]}完成 ${succeeded}/${names.length} 個項目${errors.length ? `；失敗：${errors.slice(0, 3).join('；')}` : '。'}`;
  notify(message, errors.length > 0);
}

async function batchDeleteItems() {
  const names = [...state.selectedItems];
  if (!names.length || !state.canWrite || !confirm(`確定要將選取的 ${names.length} 個項目移至資源回收桶嗎？`)) return;
  for (const id of ['#batch-move', '#batch-copy', '#batch-delete']) $(id).disabled = true;
  let succeeded = 0;
  const errors = [];
  for (const name of names) {
    try {
      const query = new URLSearchParams({ shareId: state.shareId, path: joinedPath(name) });
      await api(`/api/files?${query}`, { method: 'DELETE' });
      state.selectedItems.delete(name);
      succeeded += 1;
    } catch (error) { errors.push(`${name}：${error.message}`); }
  }
  await loadFiles();
  notify(`已移至資源回收桶 ${succeeded}/${names.length} 個項目${errors.length ? `；失敗：${errors.slice(0, 3).join('；')}` : '。'}`, errors.length > 0);
}

async function loadTrash() {
  if (!state.shareId) { $('#trash-list').replaceChildren(); $('#empty-trash').hidden = false; return; }
  try {
    const query = new URLSearchParams({ shareId: state.shareId }); const { items } = await api(`/api/trash?${query}`); const body = $('#trash-list'); body.replaceChildren(); $('#empty-trash').hidden = items.length !== 0;
    for (const item of items) {
      const row = document.createElement('tr'); const name = document.createElement('td'); name.textContent = item.name; const date = document.createElement('td'); date.textContent = formatDate(item.deletedAt); const type = document.createElement('td'); type.textContent = item.isDirectory ? '資料夾' : '檔案'; const actions = document.createElement('td'); const restore = document.createElement('button'); restore.className = 'text-action'; restore.textContent = '還原'; restore.addEventListener('click', async () => { await api('/api/trash/restore', { method: 'POST', body: JSON.stringify({ id: item.id }) }); notify('已還原。'); loadTrash(); }); actions.append(restore);
      if (state.user.role === 'admin') { const remove = document.createElement('button'); remove.className = 'text-action danger'; remove.textContent = '永久刪除'; remove.addEventListener('click', async () => { if (confirm(`永久刪除「${item.name}」？`)) { const q = new URLSearchParams({ id: item.id }); await api(`/api/trash?${q}`, { method: 'DELETE' }); loadTrash(); } }); actions.append(remove); }
      row.append(name, date, type, actions); body.append(row);
    }
  } catch (error) { notify(error.message, true); }
}

function selectedDuplicateShare() {
  return state.shares.find((share) => share.id === $('#duplicates-share-select').value) || null;
}

function setDuplicateMessage(message, isError = false) {
  const element = $('#duplicate-scan-message');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.hidden = !message;
}

function updateDuplicateSelection() {
  const selected = state.duplicateGroups.filter((group) => state.duplicateKeepers.has(group.id));
  const share = selectedDuplicateShare();
  const copyCount = selected.reduce((total, group) => total + group.items.length - 1, 0);
  const recoveredBytes = selected.reduce((total, group) => total + (group.items.length - 1) * group.size, 0);
  const summary = $('#duplicate-selection-summary');
  if (!share?.canWrite) summary.textContent = selected.length
    ? `已選 ${selected.length} 組；這個資料空間是唯讀，無法整理副本。`
    : '此資料空間為唯讀；可以掃描，但只有有寫入權限的使用者可整理副本。';
  else if (!selected.length) summary.textContent = '選取每組要保留的檔案後，才會整理其餘副本。';
  else summary.textContent = `已選 ${selected.length} 組，將移入回收桶 ${copyCount} 個副本，預估可回收 ${formatSize(recoveredBytes)}。`;
  $('#duplicate-cleanup-button').disabled = !selected.length || !share?.canWrite;
}

function renderDuplicateGroups(groups) {
  const container = $('#duplicate-groups');
  container.replaceChildren();
  state.duplicateGroups = groups;
  state.duplicateKeepers.clear();
  for (const [index, group] of groups.entries()) {
    const card = document.createElement('article');
    card.className = 'duplicate-group card';
    const title = document.createElement('h4');
    title.textContent = `第 ${index + 1} 組｜${formatSize(group.size)}｜${group.duplicateCount} 個相同內容檔案`;
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = `選一份保留；其他 ${group.duplicateCount - 1} 份會移至資源回收桶。`;
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'duplicate-keeper-options';
    const legend = document.createElement('legend');
    legend.textContent = '選擇要保留的檔案';
    fieldset.append(legend);
    for (const item of group.items) {
      const label = document.createElement('label');
      label.className = 'duplicate-file-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `duplicate-keeper-${group.id}`;
      radio.value = item.path;
      radio.addEventListener('change', () => {
        state.duplicateKeepers.set(group.id, item.path);
        updateDuplicateSelection();
      });
      const details = document.createElement('span');
      details.className = 'duplicate-file-details';
      const filePath = document.createElement('strong');
      filePath.textContent = item.path;
      const modified = document.createElement('span');
      modified.className = 'muted';
      modified.textContent = `修改時間：${formatDate(item.modifiedAt)}`;
      details.append(filePath, modified);
      label.append(radio, details);
      fieldset.append(label);
    }
    card.append(title, note, fieldset);
    container.append(card);
  }
  updateDuplicateSelection();
}

function showDuplicateProgress(progress = {}) {
  const area = $('#duplicate-scan-progress');
  const meter = $('#duplicate-progress-meter');
  area.hidden = false;
  if (progress.phase === 'hashing' && progress.totalFiles > 0) {
    meter.max = progress.totalFiles;
    meter.value = Math.min(progress.comparedFiles || 0, progress.totalFiles);
    $('#duplicate-scan-status').textContent = `已比對 ${progress.comparedFiles || 0}／${progress.totalFiles} 個候選檔案；已讀取 ${formatSize(progress.bytesHashed || 0)}。`;
  } else {
    meter.removeAttribute('value');
    $('#duplicate-scan-status').textContent = `正在檢查 Nanako 資料空間中的項目（${progress.visitedEntries || 0} 個）…`;
  }
}

function scheduleDuplicatePoll() {
  clearTimeout(state.duplicatePollTimer);
  state.duplicatePollTimer = setTimeout(() => { void pollDuplicateScan(); }, 400);
}

async function loadDuplicates() {
  const share = selectedDuplicateShare();
  const active = ['scanning', 'cancelling'].includes(state.duplicateScanStatus);
  $('#duplicate-scan-start').disabled = !share || active;
  $('#duplicates-share-select').disabled = !share || active;
  $('#duplicate-scan-cancel').hidden = !active;
  if (active && state.duplicateScanId) {
    $('#duplicate-scan-progress').hidden = false;
    void pollDuplicateScan();
  }
}

async function startDuplicateScan() {
  const share = selectedDuplicateShare();
  if (!share) { setDuplicateMessage('目前沒有可讀取的 Nanako 資料空間。', true); return; }
  clearTimeout(state.duplicatePollTimer);
  state.duplicateScanId = '';
  state.duplicateScanStatus = '';
  state.duplicateGroups = [];
  state.duplicateKeepers.clear();
  $('#duplicate-open-trash').hidden = true;
  $('#duplicate-results').hidden = true;
  $('#duplicate-empty').hidden = true;
  $('#duplicate-scan-progress').hidden = false;
  $('#duplicate-scan-cancel').hidden = false;
  $('#duplicate-scan-start').disabled = true;
  $('#duplicates-share-select').disabled = true;
  setDuplicateMessage('正在啟動掃描…');
  showDuplicateProgress({ phase: 'starting' });
  try {
    const result = await api('/api/duplicates/scan', { method: 'POST', body: JSON.stringify({ shareId: share.id }) });
    if (selectedDuplicateShare()?.id !== share.id || !state.windows.has('duplicates')) {
      const query = new URLSearchParams({ scanId: result.scanId });
      void api(`/api/duplicates/scan?${query}`, { method: 'DELETE' }).catch(() => {});
      return;
    }
    state.duplicateScanId = result.scanId;
    state.duplicateScanStatus = result.status;
    setDuplicateMessage('掃描進行中；不會修改任何檔案。');
    scheduleDuplicatePoll();
  } catch (error) {
    $('#duplicate-scan-progress').hidden = true;
    $('#duplicate-scan-cancel').hidden = true;
    $('#duplicate-scan-start').disabled = false;
    $('#duplicates-share-select').disabled = false;
    setDuplicateMessage(error.message, true);
  }
}

async function pollDuplicateScan() {
  if (!state.duplicateScanId) return;
  const scanId = state.duplicateScanId;
  try {
    const query = new URLSearchParams({ scanId });
    const result = await api(`/api/duplicates/scan?${query}`);
    if (state.duplicateScanId !== scanId) return;
    state.duplicateScanStatus = result.status;
    if (['scanning', 'cancelling'].includes(result.status)) {
      showDuplicateProgress(result.progress);
      $('#duplicate-scan-start').disabled = true;
      $('#duplicates-share-select').disabled = true;
      $('#duplicate-scan-cancel').hidden = result.status === 'cancelling';
      if (state.windows.has('duplicates')) scheduleDuplicatePoll();
      return;
    }
    clearTimeout(state.duplicatePollTimer);
    $('#duplicate-scan-progress').hidden = true;
    $('#duplicate-scan-cancel').hidden = true;
    $('#duplicate-scan-start').disabled = false;
    $('#duplicates-share-select').disabled = false;
    if (result.status === 'completed') {
      const statistics = result.statistics || {};
      const skipped = statistics.skippedFiles ? `，另有 ${statistics.skippedFiles} 個變動或無法讀取的項目已略過` : '';
      setDuplicateMessage(`掃描完成：檢查 ${statistics.scannedFiles || 0} 個檔案${skipped}。`);
      if (result.groups.length) {
        $('#duplicate-empty').hidden = true;
        $('#duplicate-results').hidden = false;
        $('#duplicate-results-summary').textContent = `找到 ${result.groups.length} 組重複內容；整理前請逐組指定要保留的檔案。`;
        renderDuplicateGroups(result.groups);
      } else {
        $('#duplicate-results').hidden = true;
        $('#duplicate-empty').hidden = false;
        state.duplicateGroups = [];
      }
    } else {
      state.duplicateScanId = '';
      state.duplicateScanStatus = result.status;
      $('#duplicate-results').hidden = true;
      $('#duplicate-empty').hidden = true;
      setDuplicateMessage(result.status === 'cancelled' ? '掃描已取消；沒有檔案遭到變更。' : result.error || '掃描失敗。', result.status !== 'cancelled');
    }
  } catch (error) {
    clearTimeout(state.duplicatePollTimer);
    $('#duplicate-scan-progress').hidden = true;
    $('#duplicate-scan-cancel').hidden = true;
    $('#duplicate-scan-start').disabled = false;
    $('#duplicates-share-select').disabled = false;
    state.duplicateScanId = '';
    state.duplicateScanStatus = '';
    state.duplicateGroups = [];
    state.duplicateKeepers.clear();
    $('#duplicate-results').hidden = true;
    $('#duplicate-empty').hidden = true;
    setDuplicateMessage(error.message, true);
  }
}

async function cancelDuplicateScan() {
  if (!state.duplicateScanId) return;
  $('#duplicate-scan-cancel').disabled = true;
  try {
    const query = new URLSearchParams({ scanId: state.duplicateScanId });
    await api(`/api/duplicates/scan?${query}`, { method: 'DELETE' });
    setDuplicateMessage('正在取消掃描…');
    scheduleDuplicatePoll();
  } catch (error) { setDuplicateMessage(error.message, true); }
  finally { $('#duplicate-scan-cancel').disabled = false; }
}

function openDuplicateCleanupConfirmation() {
  const selected = state.duplicateGroups.filter((group) => state.duplicateKeepers.has(group.id));
  if (!selected.length || !selectedDuplicateShare()?.canWrite) return;
  const count = selected.reduce((total, group) => total + group.items.length - 1, 0);
  $('#duplicate-cleanup-description').textContent = `你已選擇保留 ${selected.length} 組中的指定檔案；將把 ${count} 個相同內容副本移至 Nanako 資源回收桶。之後仍可還原，並不會刪除你選擇保留的檔案。`;
  $('#confirm-duplicate-cleanup').disabled = false;
  $('#duplicate-cleanup-dialog').showModal();
}

async function cleanDuplicateFiles(event) {
  event.preventDefault();
  const selected = state.duplicateGroups.filter((group) => state.duplicateKeepers.has(group.id));
  if (!selected.length || !state.duplicateScanId) return;
  const button = $('#confirm-duplicate-cleanup');
  button.disabled = true;
  button.textContent = '整理中…';
  try {
    const result = await api('/api/duplicates/cleanup', {
      method: 'POST',
      body: JSON.stringify({
        scanId: state.duplicateScanId,
        groups: selected.map((group) => ({ groupId: group.id, keepPath: state.duplicateKeepers.get(group.id) })),
      }),
    });
    $('#duplicate-cleanup-dialog').close();
    const moved = result.moved?.length || 0;
    const failures = result.failed?.length || 0;
    state.duplicateScanId = '';
    state.duplicateScanStatus = 'cleaned';
    state.duplicateGroups = [];
    state.duplicateKeepers.clear();
    $('#duplicate-results').hidden = true;
    $('#duplicate-empty').hidden = true;
    $('#duplicate-open-trash').hidden = moved === 0;
    setDuplicateMessage(failures
      ? `已移入資源回收桶 ${moved} 個副本；${failures} 個項目未處理，請重新掃描後再確認。`
      : `已將 ${moved} 個副本移至資源回收桶；保留的檔案未變更。`, failures > 0);
  } catch (error) {
    $('#duplicate-cleanup-dialog').close();
    setDuplicateMessage(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '移至資源回收桶';
    updateDuplicateSelection();
  }
}

function renderVaultStatus(status) {
  $('#vault-setup-panel').hidden = status.configured;
  $('#vault-unlock-panel').hidden = !status.configured || status.unlocked;
  $('#vault-open-panel').hidden = !status.unlocked;
  $('#vault-lock-button').hidden = !status.unlocked;
  $('#vault-content-panel').hidden = !status.unlocked;
  if (!status.unlocked) {
    for (const selector of ['#vault-import-dialog', '#vault-delete-dialog']) {
      const dialog = $(selector); if (dialog.open) dialog.close();
    }
    clearVaultContents();
  }
}

function clearVaultPreview() {
  const content = $('#vault-preview-content');
  for (const media of content.querySelectorAll('audio, video')) { media.pause(); media.removeAttribute('src'); media.replaceChildren(); media.load(); }
  content.replaceChildren();
  $('#vault-preview-panel').hidden = true;
  $('#vault-preview-message').hidden = true;
  state.vaultPreviewId = '';
}

function clearVaultContents() {
  clearVaultPreview();
  state.vaultItems = [];
  state.vaultSourceItems = [];
  state.vaultSourcePath = '';
  state.vaultPendingImport = null;
  state.vaultPendingDelete = null;
  $('#vault-object-list').replaceChildren();
  $('#vault-trash-list').replaceChildren();
  $('#vault-backup-list').replaceChildren();
  $('#vault-source-list').replaceChildren();
  $('#vault-recovery-list').replaceChildren();
  $('#vault-orphan-list').replaceChildren();
  $('#vault-recovery-panel').hidden = true;
  $('#vault-recovery-truncated').hidden = true;
  $('#vault-orphan-section').hidden = true;
  $('#vault-orphan-truncated').hidden = true;
  $('#vault-object-empty').hidden = true;
  $('#vault-trash-empty').hidden = true;
  $('#vault-backup-empty').hidden = true;
  $('#vault-source-path').textContent = '主資料夾';
  $('#vault-import-description').textContent = '';
  $('#vault-delete-description').textContent = '';
}

function showVaultRecoveryCode(code) {
  $('#vault-recovery-key-value').value = String(code || '').match(/.{1,4}/gu)?.join('-') || '';
  $('#vault-recovery-key-panel').hidden = false;
  state.vaultRecoveryCodePending = true;
  setVaultMessage('復原金鑰已更新。請先保存並確認，再關閉此提示；離開畫面後無法再次檢視這組金鑰。');
  $('#vault-recovery-key-value').focus();
}

function clearVaultRecoveryCode() {
  $('#vault-recovery-key-value').value = '';
  $('#vault-recovery-key-panel').hidden = true;
  state.vaultRecoveryCodePending = false;
}

function vaultSourceLocation() {
  return state.vaultSourcePath || '主資料夾';
}

async function loadVaultSource() {
  const list = $('#vault-source-list');
  const empty = $('#vault-source-empty');
  list.replaceChildren();
  $('#vault-source-path').textContent = vaultSourceLocation();
  $('#vault-source-up').disabled = !state.vaultSourcePath;
  if (!state.vaultSourceShareId) { empty.hidden = false; return; }
  try {
    const query = new URLSearchParams({ shareId: state.vaultSourceShareId, path: state.vaultSourcePath });
    const result = await api(`/api/files?${query}`);
    state.vaultSourceItems = result.items;
    for (const item of result.items) {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td');
      if (item.isDirectory) {
        const open = document.createElement('button'); open.type = 'button'; open.className = 'vault-file-name'; open.textContent = `▸ ${item.name}`;
        open.addEventListener('click', () => { state.vaultSourcePath = [state.vaultSourcePath, item.name].filter(Boolean).join('/'); loadVaultSource(); });
        nameCell.append(open);
      } else nameCell.textContent = item.name;
      const sizeCell = document.createElement('td'); sizeCell.textContent = item.isDirectory ? '資料夾' : formatSize(item.size);
      const actionCell = document.createElement('td');
      if (!item.isDirectory) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.textContent = '移入並上鎖';
        button.addEventListener('click', () => openVaultImport({ shareId: state.vaultSourceShareId, path: [state.vaultSourcePath, item.name].filter(Boolean).join('/'), name: item.name, size: item.size }));
        actionCell.append(button);
      }
      row.append(nameCell, sizeCell, actionCell); list.append(row);
    }
    empty.hidden = result.items.length !== 0;
  } catch (error) {
    empty.hidden = false; empty.textContent = error.message;
  }
}

async function loadVaultObjects() {
  const list = $('#vault-object-list'); list.replaceChildren();
  try {
    const result = await api('/api/vault/objects');
    state.vaultItems = result.items;
    for (const item of result.items) {
      const row = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = item.name;
      const size = document.createElement('td'); size.textContent = formatSize(item.size);
      const actions = document.createElement('td'); const group = document.createElement('div'); group.className = 'vault-row-actions';
      if (item.mediaType && item.mediaType !== 'application/octet-stream') {
        const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'button secondary'; preview.textContent = '預覽／播放';
        preview.addEventListener('click', () => showVaultPreview(item)); group.append(preview);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button secondary'; remove.textContent = '移至資源回收筒';
      remove.addEventListener('click', () => openVaultDelete(item)); group.append(remove);
      actions.append(group); row.append(name, size, actions); list.append(row);
    }
    $('#vault-object-empty').hidden = result.items.length !== 0;
  } catch (error) { setVaultMessage(error.message, true); }
}

async function loadVaultTrash() {
  const list = $('#vault-trash-list'); list.replaceChildren();
  try {
    const result = await api('/api/vault/trash');
    for (const item of result.items) {
      const row = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = item.name;
      const date = document.createElement('td'); date.textContent = formatDate(item.deletedAt);
      const actions = document.createElement('td'); const group = document.createElement('div'); group.className = 'vault-row-actions';
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'button secondary'; restore.textContent = '還原';
      restore.addEventListener('click', async () => {
        if (!confirm(`將「${item.name}」還原至已上鎖檔案？`)) return;
        try {
          await api(`/api/vault/trash/${encodeURIComponent(item.id)}/restore`, { method: 'POST', body: '{}' });
          await Promise.all([loadVaultObjects(), loadVaultTrash()]); setVaultMessage('加密空間檔案已還原。');
        } catch (error) { setVaultMessage(error.message, true); }
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button danger'; remove.textContent = '永久刪除';
      remove.addEventListener('click', async () => {
        if (prompt(`永久刪除「${item.name}」的密文？此動作無法復原。\n\n請輸入：永久刪除`) !== '永久刪除') return;
        try {
          await api(`/api/vault/trash/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: JSON.stringify({ confirmText: '永久刪除' }) });
          await loadVaultTrash(); setVaultMessage('已永久刪除加密空間檔案。');
        } catch (error) { setVaultMessage(error.message, true); }
      });
      group.append(restore, remove); actions.append(group); row.append(name, date, actions); list.append(row);
    }
    $('#vault-trash-empty').hidden = result.items.length !== 0;
  } catch (error) { $('#vault-trash-empty').hidden = false; $('#vault-trash-empty').textContent = error.message; }
}

async function loadVaultBackups() {
  const list = $('#vault-backup-list'); list.replaceChildren();
  try {
    const result = await api('/api/vault/backups');
    for (const item of result.items) {
      const row = document.createElement('tr');
      const date = document.createElement('td'); date.textContent = item.invalid ? '備份索引無法驗證' : formatDate(item.createdAt);
      const count = document.createElement('td'); count.textContent = item.invalid ? '—' : `${item.itemCount} 個檔案`;
      const size = document.createElement('td'); size.textContent = item.invalid ? '—' : formatSize(item.encryptedBytes);
      const actions = document.createElement('td'); const group = document.createElement('div'); group.className = 'vault-row-actions';
      if (!item.invalid) {
        const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'button secondary'; restore.textContent = '還原缺少檔案';
        restore.addEventListener('click', async () => {
          if (!confirm(`使用此備份還原目前加密空間缺少的檔案？已存在的物件不會覆寫。`)) return;
          try {
            const restored = await api(`/api/vault/backups/${encodeURIComponent(item.id)}/restore`, { method: 'POST', body: '{}' });
            await Promise.all([loadVaultObjects(), loadVaultTrash(), loadVaultRecovery()]);
            setVaultMessage(`備份還原完成：新增 ${restored.restored} 個，略過 ${restored.skipped} 個既有檔案。`);
          } catch (error) { setVaultMessage(error.message, true); }
        });
        group.append(restore);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button danger'; remove.textContent = '刪除備份';
      remove.addEventListener('click', async () => {
        if (prompt('刪除此 NanakoData 內的加密備份？此動作無法復原。\n\n請輸入：刪除備份') !== '刪除備份') return;
        try {
          await api(`/api/vault/backups/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: JSON.stringify({ confirmText: '刪除備份' }) });
          await loadVaultBackups(); setVaultMessage('加密備份已刪除。');
        } catch (error) { setVaultMessage(error.message, true); }
      });
      group.append(remove); actions.append(group); row.append(date, count, size, actions); list.append(row);
    }
    $('#vault-backup-empty').hidden = result.items.length !== 0;
  } catch (error) { $('#vault-backup-empty').hidden = false; $('#vault-backup-empty').textContent = error.message; }
}

async function loadVaultRecovery() {
  const panel = $('#vault-recovery-panel');
  const list = $('#vault-recovery-list');
  const orphanList = $('#vault-orphan-list');
  list.replaceChildren();
  orphanList.replaceChildren();
  try {
    const result = await api('/api/vault/recovery');
    $('#vault-recovery-truncated').hidden = !result.truncated;
    for (const item of result.items) {
      const card = document.createElement('article'); card.className = 'vault-recovery-item';
      const details = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = item.name;
      const location = document.createElement('p'); location.textContent = `${state.shares.find((share) => share.id === item.shareId)?.name || 'Nanako 資料空間'}／${item.relativePath} · ${formatSize(item.size)}`;
      const status = document.createElement('p'); status.className = `vault-recovery-state is-${item.sourceState}`;
      const statusText = {
        unchanged: '來源檔案仍在，內容與已加密版本相符。',
        missing: '原始路徑已不存在；加密版本仍保留。',
        changed: '來源檔案已變更或類型不同；為避免刪錯，不會移除。',
        'ciphertext-missing': '加密密文不存在或無法安全讀取；不能完成上鎖。若原檔仍在，請保留原檔並清除失效索引。',
        unavailable: '目前無法檢查來源（可能已無資料空間權限）；不會自動移除。',
      };
      status.textContent = statusText[item.sourceState] || statusText.unavailable;
      details.append(title, location, status);
      const actions = document.createElement('div'); actions.className = 'vault-row-actions';
      if (['unchanged', 'missing'].includes(item.sourceState)) {
        const complete = document.createElement('button'); complete.type = 'button'; complete.className = 'button primary'; complete.textContent = '完成上鎖';
        complete.addEventListener('click', () => resolveVaultRecovery(item, 'complete'));
        actions.append(complete);
      }
      const keep = document.createElement('button'); keep.type = 'button'; keep.className = 'button secondary'; keep.textContent = item.sourceState === 'ciphertext-missing' ? '清除失效索引' : '保留原檔';
      keep.addEventListener('click', () => resolveVaultRecovery(item, 'keep'));
      actions.append(keep); card.append(details, actions); list.append(card);
    }
    for (const item of result.orphans || []) {
      const card = document.createElement('article'); card.className = 'vault-recovery-item';
      const details = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = '未編入索引的加密檔案';
      const description = document.createElement('p'); description.textContent = `識別碼 ${item.id.slice(0, 8)}… · ${formatSize(item.encryptedBytes)} · 無法還原檔名`;
      details.append(title, description);
      const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'button danger'; discard.textContent = '清理孤兒密文';
      discard.addEventListener('click', () => discardVaultOrphan(item));
      const actions = document.createElement('div'); actions.className = 'vault-row-actions'; actions.append(discard);
      card.append(details, actions); orphanList.append(card);
    }
    $('#vault-orphan-section').hidden = !(result.orphans || []).length && !result.orphansTruncated;
    $('#vault-orphan-truncated').hidden = !result.orphansTruncated;
    panel.hidden = result.items.length === 0 && !result.truncated && !(result.orphans || []).length && !result.orphansTruncated;
  } catch (error) { panel.hidden = true; setVaultMessage(error.message, true); }
}

async function discardVaultOrphan(item) {
  const confirmation = prompt(`這筆密文無法還原檔名或驗證內容。確認只清除加密空間中的孤兒密文，不會刪除 Nanako 資料空間中的任何來源檔案。\n\n請輸入：永久刪除孤兒密文\n識別碼：${item.id}`);
  if (confirmation !== '永久刪除孤兒密文') return;
  try {
    await api(`/api/vault/orphans/${encodeURIComponent(item.id)}`, { method: 'POST', body: JSON.stringify({ confirmText: confirmation }) });
    await loadVaultRecovery(); setVaultMessage('未編入索引的加密暫存資料已清理；來源資料空間未變更。');
  } catch (error) { setVaultMessage(error.message, true); await loadVaultRecovery(); }
}

async function refreshVaultImportProgress() {
  try {
    const progress = await api('/api/vault/objects/import/status');
    if (!progress.active) return;
    const bar = $('#vault-import-progress'); bar.hidden = false;
    const percent = progress.totalBytes > 0 ? Math.min(99, Math.floor(progress.bytesRead * 100 / progress.totalBytes)) : 10;
    bar.value = percent;
    $('#cancel-vault-import').disabled = progress.phase === '移除已驗證來源';
    const message = $('#vault-import-message');
    message.textContent = `${progress.phase} · ${formatSize(progress.bytesRead)}／${formatSize(progress.totalBytes)}（${percent}%）`;
    message.hidden = false; message.classList.remove('error');
  } catch { /* The import response remains authoritative if progress polling briefly fails. */ }
}

async function resolveVaultRecovery(item, action) {
  const complete = action === 'complete';
  const prompt = complete
    ? `確認處理「${item.name}」的中斷移入？只有來源仍存在且內容相符時，Nanako 才會移除 Nanako 資料空間中的原檔。`
    : item.sourceState === 'ciphertext-missing'
      ? `確認清除「${item.name}」失效的加密索引？Nanako 不會刪除 Nanako 資料空間中的來源檔案。`
      : `保留「${item.name}」的原始檔案，並結束這筆待確認作業？加密版本也會保留。`;
  if (!confirm(prompt)) return;
  try {
    await api(`/api/vault/recovery/${encodeURIComponent(item.id)}`, { method: 'POST', body: JSON.stringify({ action }) });
    await Promise.all([loadVaultRecovery(), loadVaultObjects(), loadVaultSource()]);
    setVaultMessage(complete ? '復原作業已完成；若來源內容不同，Nanako 會保留原檔。'
      : item.sourceState === 'ciphertext-missing' ? '已清除失效的加密索引；未刪除來源檔案。'
        : '已保留原檔；加密版本也未變更。');
  } catch (error) { setVaultMessage(error.message, true); await loadVaultRecovery(); }
}

function setVaultMessage(message, isError = false) {
  const box = $('#vault-message'); box.textContent = message; box.hidden = !message; box.classList.toggle('error', isError);
}

function showVaultPreview(item) {
  clearVaultPreview();
  const panel = $('#vault-preview-panel'); const content = $('#vault-preview-content');
  $('#vault-preview-title').textContent = item.name;
  const url = `/api/vault/objects/${encodeURIComponent(item.id)}/content`;
  let element;
  if (item.mediaType.startsWith('image/')) {
    element = document.createElement('img'); element.alt = item.name;
  } else if (item.mediaType.startsWith('video/')) {
    element = document.createElement('video'); element.controls = true; element.preload = 'metadata'; element.setAttribute('aria-label', item.name);
  } else if (item.mediaType.startsWith('audio/')) {
    element = document.createElement('audio'); element.controls = true; element.preload = 'metadata'; element.setAttribute('aria-label', item.name);
  } else {
    $('#vault-preview-message').textContent = '此檔案格式尚未支援預覽或播放。'; $('#vault-preview-message').hidden = false; panel.hidden = false; return;
  }
  element.src = url;
  content.append(element);
  state.vaultPreviewId = item.id;
  panel.hidden = false;
  void api('/api/activity', { method: 'POST', body: JSON.stringify({ view: 'vault', action: 'preview' }) }).catch(() => {});
}

function openVaultImport(item) {
  state.vaultPendingImport = item;
  $('#vault-import-description').textContent = `即將加密「${item.name}」（${formatSize(item.size)}），來源位置：${state.shares.find((share) => share.id === item.shareId)?.name || 'Nanako 資料空間'}／${item.path}。成功後會移除這個來源檔案。`;
  $('#vault-import-message').hidden = true; $('#vault-import-message').textContent = '';
  $('#confirm-vault-import').disabled = false; $('#confirm-vault-import').textContent = '移入並加密';
  $('#vault-import-dialog').showModal();
}

function openVaultDelete(item) {
  state.vaultPendingDelete = item;
  $('#vault-delete-description').textContent = `將「${item.name}」移至加密空間資源回收筒。密文會繼續保留，可稍後還原或永久刪除。`;
  $('#vault-delete-confirm').value = ''; $('#confirm-vault-delete').disabled = true;
  $('#vault-delete-message').hidden = true; $('#vault-delete-message').textContent = '';
  $('#vault-delete-dialog').showModal(); $('#vault-delete-confirm').focus();
}

async function loadVault() {
  setVaultMessage('');
  try {
    if (state.vaultLockRequest) await state.vaultLockRequest;
    const status = await api('/api/vault/status');
    renderVaultStatus(status);
    if (status.unlocked) await Promise.all([loadVaultObjects(), loadVaultTrash(), loadVaultBackups(), loadVaultSource(), loadVaultRecovery()]);
    clearInterval(state.vaultStatusTimer);
    state.vaultStatusTimer = setInterval(() => {
      void api('/api/vault/status').then(renderVaultStatus).catch(() => renderVaultStatus({ configured: true, unlocked: false }));
    }, 30_000);
  } catch (error) {
    setVaultMessage(error.message, true);
  }
}

async function lockVaultFromUi() {
  clearVaultPreview();
  try {
    renderVaultStatus(await api('/api/vault/lock', { method: 'POST' }));
    $('#vault-unlock-form').reset();
    setVaultMessage('加密空間已鎖定。');
  } catch (error) { setVaultMessage(error.message, true); }
}

async function loadUsers() {
  try {
    const { users } = await api('/api/users'); const body = $('#user-list'); body.replaceChildren();
    for (const user of users) {
      const row = document.createElement('article'); row.className = 'user-card';
      const heading = document.createElement('div'); heading.className = 'user-row';
      const name = document.createElement('strong'); name.textContent = user.username;
      const badges = document.createElement('div'); badges.className = 'user-badges';
      const role = document.createElement('span'); role.className = 'user-role'; role.textContent = user.role === 'admin' ? '管理員' : '使用者';
      const status = document.createElement('span'); status.className = `user-role${user.isActive ? '' : ' user-disabled'}`; status.textContent = user.isActive ? '啟用中' : '已停用';
      badges.append(role, status); heading.append(name, badges); row.append(heading);
      if (user.role === 'user') {
        const details = document.createElement('details'); details.className = 'user-permission-details';
        const summary = document.createElement('summary'); summary.textContent = '權限與帳號狀態'; details.append(summary);
        const form = document.createElement('form'); form.className = 'form-stack user-permission-form';
        const fieldset = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = '資料空間權限'; fieldset.append(legend);
        for (const share of state.shares) {
          const current = user.permissions?.find((permission) => permission.shareId === share.id);
          const permissionRow = document.createElement('label'); permissionRow.className = 'permission-row';
          const read = document.createElement('input'); read.type = 'checkbox'; read.name = `read-${share.id}`; read.checked = Boolean(current?.canRead);
          const write = document.createElement('input'); write.type = 'checkbox'; write.name = `write-${share.id}`; write.checked = Boolean(current?.canWrite);
          read.addEventListener('change', () => { if (!read.checked) write.checked = false; });
          write.addEventListener('change', () => { if (write.checked) read.checked = true; });
          permissionRow.append(read, document.createTextNode(`${share.name}：讀取`), write, document.createTextNode('寫入')); fieldset.append(permissionRow);
        }
        const activeLabel = document.createElement('label'); activeLabel.className = 'account-active-toggle';
        const active = document.createElement('input'); active.type = 'checkbox'; active.name = 'isActive'; active.checked = Boolean(user.isActive);
        activeLabel.append(active, document.createTextNode('允許此帳號登入'));
        const save = document.createElement('button'); save.type = 'submit'; save.className = 'button primary'; save.textContent = '儲存變更';
        const message = document.createElement('p'); message.className = 'inline-message'; message.hidden = true; message.setAttribute('role', 'status');
        form.append(fieldset, activeLabel, save, message);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const permissions = state.shares.flatMap((share) => {
            const canRead = form.elements[`read-${share.id}`].checked;
            const canWrite = form.elements[`write-${share.id}`].checked;
            return canRead ? [{ shareId: share.id, canRead, canWrite }] : [];
          });
          save.disabled = true;
          try {
            await api(`/api/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: JSON.stringify({ isActive: active.checked, permissions }) });
            notify('使用者權限已更新。');
            await loadUsers();
          } catch (error) {
            message.textContent = error.message; message.classList.add('error'); message.hidden = false;
          } finally { save.disabled = false; }
        });
        details.append(form); row.append(details);
      }
      body.append(row);
    }
  } catch (error) { notify(error.message, true); }
}

async function loadAuditSettings() {
  try {
    const settings = await api('/api/audit-settings');
    $('#audit-retention').value = String(settings.retentionDays);
  } catch (error) { notify(error.message, true); }
}

async function loadAuditLogs() {
  try {
    const { logs, retentionDays } = await api('/api/audit-logs');
    const body = $('#audit-log-list');
    body.replaceChildren();
    $('#audit-log-summary').textContent = `保留最近 ${retentionDays} 日的紀錄；畫面最多顯示最近 500 筆。`;
    $('#empty-audit-logs').hidden = logs.length > 0;
    for (const item of logs) {
      const row = document.createElement('tr');
      const time = document.createElement('td'); time.textContent = formatDate(item.occurredAt);
      const actor = document.createElement('td'); actor.textContent = item.actorName;
      const action = document.createElement('td'); action.textContent = item.action;
      const target = document.createElement('td'); target.textContent = item.target || '—';
      const outcome = document.createElement('td'); outcome.textContent = item.outcome;
      outcome.className = item.outcome === '成功' ? 'audit-success' : 'audit-failure';
      row.append(time, actor, action, target, outcome);
      body.append(row);
    }
  } catch (error) { notify(error.message, true); }
}

async function saveAuditSettings(event) {
  event.preventDefault();
  const message = $('#audit-settings-message');
  try {
    const result = await api('/api/audit-settings', { method: 'POST', body: JSON.stringify({ retentionDays: Number($('#audit-retention').value) }) });
    message.textContent = `已儲存，操作紀錄將保留 ${result.retentionDays} 日。`;
    message.classList.remove('error'); message.hidden = false;
    await loadAuditLogs();
  } catch (error) {
    message.textContent = error.message; message.classList.add('error'); message.hidden = false;
  }
}

async function clearAllAuditLogs(event) {
  event.preventDefault();
  const phrase = $('#clear-audit-confirm').value;
  if (phrase !== '刪除所有紀錄') return;
  const button = $('#confirm-clear-audit'); button.disabled = true;
  try {
    await api('/api/audit-logs', { method: 'DELETE', body: JSON.stringify({ confirmText: phrase }) });
    $('#clear-audit-dialog').close();
    $('#clear-audit-confirm').value = '';
    notify('已刪除所有使用者操作紀錄。');
    await loadAuditLogs();
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = $('#clear-audit-confirm').value !== '刪除所有紀錄'; }
}

function setAlbumScopeAll(isAll) {
  state.albumScopeAll = isAll;
  if (!isAll && !state.albumPath) state.albumPath = '';
  loadAlbum();
}

const ALBUM_BATCH_SIZE = 48;
const PLAYER_BATCH_SIZE = 48;

function appendAlbumBatch() {
  const allScope = state.albumScopeAll;
  const grid = $('#album-grid');
  const end = Math.min(state.albumImages.length, state.albumRenderedCount + ALBUM_BATCH_SIZE);
  for (const item of state.albumImages.slice(state.albumRenderedCount, end)) {
    const relativePath = mediaItemPath(item, state.albumPath);
    const card = document.createElement('button'); card.type = 'button'; card.className = 'album-card';
    const image = document.createElement('img'); image.loading = 'lazy'; image.decoding = 'async'; image.alt = item.name;
    image.src = mediaUrl(state.shareId, relativePath);
    image.addEventListener('error', () => { card.classList.add('image-unavailable'); image.removeAttribute('src'); }, { once: true });
    const caption = document.createElement('span'); caption.textContent = item.name;
    card.append(image, caption);
    if (allScope) { const location = document.createElement('small'); location.className = 'media-location'; location.textContent = relativePath; card.append(location); }
    card.addEventListener('click', () => openPhotoGallery(state.albumImages, state.albumPath, state.shareId, allScope ? relativePath : item.name));
    grid.append(card);
  }
  state.albumRenderedCount = end;
  const more = $('#album-more');
  more.hidden = end >= state.albumImages.length;
  more.textContent = `載入更多圖片（${end}／${state.albumImages.length}）`;
}

function appendPlayerBatch() {
  const allScope = state.playerScopeAll;
  const queue = $('#player-queue');
  const end = Math.min(state.playerItems.length, state.playerRenderedCount + PLAYER_BATCH_SIZE);
  for (let index = state.playerRenderedCount; index < end; index += 1) {
    const item = state.playerItems[index];
    const relativePath = mediaItemPath(item, state.playerPath);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'queue-track';
    button.dataset.trackPath = relativePath; button.dataset.shareId = state.shareId;
    button.setAttribute('aria-current', String(state.activeTrackPath === relativePath));
    const name = document.createElement('span'); name.textContent = item.name;
    const details = document.createElement('small'); details.textContent = `${mediaKind(item.name) === 'video' ? '影片' : '音訊'} · ${formatSize(item.size)}${allScope ? ` · ${relativePath}` : ''}`;
    button.append(name, details);
    const progress = playbackProgressFor(state.shareId, relativePath);
    if (progress) {
      const resume = document.createElement('small'); resume.className = 'queue-resume';
      resume.textContent = `從 ${formatPlaybackTime(progress.position)} 繼續`; button.append(resume);
    }
    button.addEventListener('click', () => { void playTrack(index); }); queue.append(button);
  }
  state.playerRenderedCount = end;
  const more = $('#player-more');
  more.hidden = end >= state.playerItems.length;
  more.textContent = `載入更多影音（${end}／${state.playerItems.length}）`;
}

async function loadAlbum() {
  const loadSequence = ++state.albumLoadSequence;
  const grid = $('#album-grid');
  if (!state.shareId) {
    grid.replaceChildren(); grid.setAttribute('aria-busy', 'false'); state.albumItems = []; state.albumImages = []; state.albumRenderedCount = 0; $('#album-more').hidden = true;
    $('#empty-album').hidden = false; $('#empty-album strong').textContent = '沒有可存取的資料空間'; $('#empty-album span').textContent = '請確認目前帳號的 Nanako 資料空間權限。';
    return false;
  }
  const allScope = state.albumScopeAll;
  $('#album-scope-toggle').textContent = allScope ? '依資料夾瀏覽' : '瀏覽整個資料空間';
  $('#album-scope-note').textContent = allScope
    ? '顯示目前 Nanako 資料空間內的圖片；點選圖片可檢視，清單最多顯示 1,000 張。'
    : '依 Nanako 資料夾逐層瀏覽圖片；不會離開目前資料空間。';
  $('#album-catalog-message').hidden = true;
  $('#album-more').hidden = true;
  $('#empty-album').hidden = false;
  $('#empty-album strong').textContent = allScope ? '正在搜尋圖片…' : '正在載入資料夾…';
  $('#empty-album span').textContent = '只讀取目前選取的 Nanako 資料空間。';
  grid.setAttribute('aria-busy', 'true');
  grid.replaceChildren();
  try {
    const query = allScope
      ? new URLSearchParams({ shareId: state.shareId, category: 'image', search: state.albumSearch })
      : new URLSearchParams({ shareId: state.shareId, path: state.albumPath });
    const result = await api(`${allScope ? '/api/files/search' : '/api/files'}?${query}`);
    if (loadSequence !== state.albumLoadSequence) return false;
    grid.setAttribute('aria-busy', 'false');
    const { items } = result;
    state.albumItems = items;
    const matchesSearch = (item) => !state.albumSearch || item.name.toLocaleLowerCase('zh-TW').includes(state.albumSearch.trim().toLocaleLowerCase('zh-TW'));
    state.albumImages = items.filter((item) => !item.isDirectory && mediaKind(item.name) === 'image' && matchesSearch(item));
    state.albumRenderedCount = 0;
    if (allScope) {
      renderBreadcrumb($('#album-breadcrumb'), '', () => setAlbumScopeAll(false));
      const crumb = document.createElement('span'); crumb.textContent = '全部圖片（整個資料空間）'; crumb.setAttribute('aria-current', 'page');
      $('#album-breadcrumb').append(document.createTextNode(' › '), crumb);
    } else renderBreadcrumb($('#album-breadcrumb'), state.albumPath, (next) => { state.albumPath = next; loadAlbum(); });
    grid.replaceChildren();
    const folders = allScope ? [] : items.filter((item) => item.isDirectory);
    for (const folder of folders) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'album-folder';
      const icon = document.createElement('span'); icon.className = 'album-folder-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '▰';
      const label = document.createElement('span'); label.textContent = folder.name;
      button.append(icon, label);
      button.addEventListener('click', () => { state.albumPath = state.albumPath ? `${state.albumPath}/${folder.name}` : folder.name; loadAlbum(); });
      grid.append(button);
    }
    appendAlbumBatch();
    if (allScope && result.truncated) {
      $('#album-catalog-message').textContent = '圖片數量較多，目前只顯示前 1,000 張；請輸入檔名縮小範圍。';
      $('#album-catalog-message').hidden = false;
    }
    $('#empty-album').hidden = state.albumImages.length > 0 || folders.length > 0;
    $('#empty-album strong').textContent = state.albumImages.length ? '' : allScope ? '找不到符合的圖片' : '這個資料夾沒有圖片';
    $('#empty-album span').textContent = state.albumImages.length ? '' : '支援 JPG、PNG、GIF、WebP、AVIF 與 BMP。';
    return true;
  } catch (error) {
    if (loadSequence !== state.albumLoadSequence) return false;
    grid.setAttribute('aria-busy', 'false');
    grid.replaceChildren(); state.albumImages = []; state.albumRenderedCount = 0; $('#album-more').hidden = true;
    $('#empty-album').hidden = false; $('#empty-album strong').textContent = '無法載入圖片'; $('#empty-album span').textContent = '請確認資料空間權限或重新整理後再試。';
    notify(error.message, true); return false;
  }
}

function setPlayerScopeAll(isAll) {
  state.playerScopeAll = isAll;
  loadPlayer();
}

async function loadPlayer() {
  const loadSequence = ++state.playerLoadSequence;
  const queue = $('#player-queue');
  if (!state.shareId) {
    state.playerItems = []; state.playerRenderedCount = 0; state.playerProgress.clear(); refreshMediaTestTracks(); queue.replaceChildren(); queue.setAttribute('aria-busy', 'false'); $('#player-more').hidden = true; $('#empty-player').hidden = false;
    $('#empty-player strong').textContent = '沒有可存取的資料空間'; $('#empty-player span').textContent = '請確認目前帳號的 Nanako 資料空間權限。';
    resetPlayer(); return false;
  }
  const allScope = state.playerScopeAll;
  $('#player-scope-toggle').textContent = allScope ? '依資料夾瀏覽' : '瀏覽整個資料空間';
  $('#player-scope-note').textContent = allScope
    ? '播放清單涵蓋目前 Nanako 資料空間中的音訊與影片；清單最多顯示 1,000 項。'
    : '播放清單只涵蓋目前所在的 Nanako 資料夾。';
  $('#player-catalog-message').hidden = true;
  $('#player-more').hidden = true;
  queue.replaceChildren();
  $('#empty-player').hidden = false;
  $('#empty-player strong').textContent = allScope ? '正在搜尋影音…' : '正在載入資料夾…';
  $('#empty-player span').textContent = '只讀取目前選取的 Nanako 資料空間。';
  queue.setAttribute('aria-busy', 'true');
  try {
    const query = allScope
      ? new URLSearchParams({ shareId: state.shareId, category: 'media', search: state.playerSearch })
      : new URLSearchParams({ shareId: state.shareId, path: state.playerPath });
    const [result, progressResult] = await Promise.all([
      api(`${allScope ? '/api/files/search' : '/api/files'}?${query}`),
      api(`/api/playback-progress?${new URLSearchParams({ shareId: state.shareId })}`).catch(() => ({ progress: [] })),
    ]);
    if (loadSequence !== state.playerLoadSequence) return false;
    state.playerProgress = new Map(progressResult.progress.map((item) => [playbackProgressKey(state.shareId, item.path), item]));
    queue.setAttribute('aria-busy', 'false');
    const items = result.items;
    const folders = allScope ? [] : items.filter((item) => item.isDirectory);
    state.playerItems = items.filter((item) => !item.isDirectory && ['audio', 'video'].includes(mediaKind(item.name))
      && (allScope || !state.playerSearch || item.name.toLocaleLowerCase('zh-TW').includes(state.playerSearch.trim().toLocaleLowerCase('zh-TW'))));
    state.playerRenderedCount = 0;
    refreshMediaTestTracks();
    if (allScope) {
      renderBreadcrumb($('#player-breadcrumb'), '', () => setPlayerScopeAll(false));
      const crumb = document.createElement('span'); crumb.textContent = '所有影音（整個資料空間）'; crumb.setAttribute('aria-current', 'page');
      $('#player-breadcrumb').append(document.createTextNode(' › '), crumb);
    } else renderBreadcrumb($('#player-breadcrumb'), state.playerPath, (next) => { state.playerPath = next; loadPlayer(); });
    queue.replaceChildren();
    for (const folder of folders) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'queue-folder';
      button.textContent = `▰　${folder.name}`;
      button.addEventListener('click', () => { state.playerPath = state.playerPath ? `${state.playerPath}/${folder.name}` : folder.name; loadPlayer(); });
      queue.append(button);
    }
    appendPlayerBatch();
    $('#empty-player').hidden = state.playerItems.length > 0 || folders.length > 0;
    $('#empty-player strong').textContent = state.playerItems.length || folders.length ? '' : allScope ? '找不到可播放的影音' : '這個資料夾沒有可播放的影音';
    $('#empty-player span').textContent = state.playerItems.length || folders.length ? '' : '支援格式的實際播放能力依 Electron 內建 Chromium 與檔案編碼而異。';
    if (allScope && result.truncated) {
      $('#player-catalog-message').textContent = '影音數量較多，目前只顯示前 1,000 項；請輸入檔名縮小範圍。';
      $('#player-catalog-message').hidden = false;
    }
    const pending = state.pendingTrackPath;
    state.pendingTrackPath = '';
    if (pending) {
      const index = state.playerItems.findIndex((item) => mediaItemPath(item, state.playerPath) === pending);
      if (index >= 0) playTrack(index);
      else notify('這個檔案目前無法播放。', true);
    }
    return true;
  } catch (error) {
    if (loadSequence !== state.playerLoadSequence) return false;
    queue.setAttribute('aria-busy', 'false');
    state.playerItems = []; state.playerRenderedCount = 0; refreshMediaTestTracks(); queue.replaceChildren(); $('#player-more').hidden = true;
    $('#empty-player').hidden = false; $('#empty-player strong').textContent = '無法載入播放清單'; $('#empty-player span').textContent = '請確認資料空間權限或重新整理後再試。';
    notify(error.message, true); return false;
  }
}

async function playTrack(index) {
  const item = state.playerItems[index];
  if (!item) return;
  await persistActivePlayback(true);
  const kind = mediaKind(item.name);
  const relativePath = mediaItemPath(item, state.playerPath);
  const url = mediaUrl(state.shareId, relativePath);
  const video = $('#video-player'); const audio = $('#audio-player');
  const player = kind === 'video' ? video : audio;
  const inactive = kind === 'video' ? audio : video;
  const sequence = ++state.playbackSequence;
  inactive.pause(); inactive.removeAttribute('src'); delete inactive.dataset.trackPath; inactive.load(); inactive.hidden = true;
  player.pause();
  state.activeTrackPath = relativePath;
  state.activeTrackShareId = state.shareId;
  state.activeTrackItem = item;
  state.activeTrackKind = kind;
  state.playbackReady = false;
  state.lastProgressWrite = 0;
  player.dataset.trackPath = relativePath; player.dataset.shareId = state.shareId;
  player.addEventListener('loadedmetadata', () => {
    if (sequence !== state.playbackSequence || state.activeTrackPath !== relativePath) return;
    state.playbackReady = true;
    const progress = playbackProgressFor(state.activeTrackShareId, relativePath);
    if (!shouldResumePlayback(progress, player.duration)) return;
    player.currentTime = progress.position;
    $('#player-message').textContent = `已從 ${formatPlaybackTime(progress.position)} 繼續播放。`;
    $('#player-message').hidden = false;
  }, { once: true });
  player.onerror = () => {
    if (state.activeTrackPath === relativePath) $('#player-message').textContent = '瀏覽器無法播放這個檔案或編碼格式。你仍可從檔案管理下載原始檔。';
    $('#player-message').hidden = state.activeTrackPath !== relativePath;
  };
  player.hidden = false; player.src = url; player.load();
  $('#current-media-name').textContent = item.name;
  $('#player-placeholder').hidden = true;
  $('#player-message').hidden = true;
  for (const button of document.querySelectorAll('.queue-track')) {
    const isCurrent = button.dataset.trackPath === relativePath;
    button.setAttribute('aria-current', String(isCurrent));
  }
  player.play().catch(() => {
    if (state.activeTrackPath === relativePath) {
      $('#player-message').textContent = '請按下播放按鈕開始播放。';
      $('#player-message').hidden = false;
    }
  });
}

async function playNextTrack() {
  await clearActivePlaybackProgress();
  const currentIndex = state.playerItems.findIndex((item) => mediaItemPath(item, state.playerPath) === state.activeTrackPath);
  if (currentIndex >= 0 && currentIndex + 1 < state.playerItems.length) void playTrack(currentIndex + 1);
}

function resetPlayer() {
  void persistActivePlayback(true);
  state.playbackSequence += 1;
  state.playbackReady = false;
  state.activeTrackPath = ''; state.activeTrackShareId = ''; state.activeTrackItem = null; state.activeTrackKind = '';
  for (const selector of ['#video-player', '#audio-player']) {
    const player = $(selector); player.pause(); player.removeAttribute('src'); delete player.dataset.trackPath; delete player.dataset.shareId; player.load(); player.hidden = true;
  }
  $('#current-media-name').textContent = '尚未選取媒體';
  $('#player-placeholder').hidden = false;
  $('#player-message').hidden = true;
}

async function loadNetwork() {
  try {
    const result = await api('/api/network');
    $('#network-endpoint').textContent = `http://${result.host}:${result.port}`;
    const list = $('#interface-list'); list.replaceChildren();
    for (const item of result.interfaces) {
      const row = document.createElement('li');
      const name = document.createElement('span'); name.textContent = item.name;
      const address = document.createElement('span'); address.className = 'ip'; address.textContent = `${item.address} · ${item.family}`;
      row.append(name, address); list.append(row);
    }
    if (!result.interfaces.length) list.textContent = '目前沒有可用的網路介面卡。';
    if (state.user.role === 'admin') await loadSmbStatus();
  }
  catch (error) { notify(error.message, true); }
}

async function loadSmbStatus() {
  const fields = {
    service: $('#smb-server-service'), port: $('#smb-port-status'), command: $('#smb-command-status'), elevation: $('#smb-elevation-status'),
  };
  const message = $('#smb-preflight-message');
  message.hidden = true;
  try {
    const status = await api('/api/smb/status');
    if (!status.supported) {
      fields.service.textContent = '不支援此作業系統';
      fields.port.textContent = '不適用';
      fields.command.textContent = '不適用';
      fields.elevation.textContent = '無法判定';
      message.textContent = status.message || 'SMB 前置檢查僅支援 Windows。'; message.hidden = false;
      return;
    }
    if (!status.detected) {
      fields.service.textContent = '無法判定';
      fields.port.textContent = '無法判定';
      fields.command.textContent = '無法判定';
      fields.elevation.textContent = status.processElevated === null ? '無法判定' : status.processElevated ? '已提升' : '未提升';
      message.textContent = status.message || '無法讀取 Windows SMB 伺服器狀態。'; message.hidden = false;
      return;
    }
    const serviceLabels = { Running: '執行中（Windows 內建服務）', Stopped: '已停止', Paused: '已暫停', StartPending: '啟動中', StopPending: '停止中', NotInstalled: '找不到服務' };
    fields.service.textContent = serviceLabels[status.serverService] || '無法判定';
    fields.port.textContent = status.port445Listening ? '使用中（Nanako 尚未監聽）' : '目前未使用';
    fields.command.textContent = status.shareManagementAvailable ? '可用' : '不可用';
    fields.elevation.textContent = status.processElevated === null ? '無法判定' : status.processElevated ? '已提升' : '未提升';
  } catch (error) {
    for (const field of Object.values(fields)) field.textContent = '讀取失敗';
    message.textContent = error.message; message.hidden = false;
  }
}

function addSupportPill(text, tone = '') {
  const pill = document.createElement('span');
  pill.className = `support-pill ${tone ? `support-${tone}` : ''}`.trim();
  pill.textContent = text;
  return pill;
}

async function loadMediaCompatibility() {
  const table = $('#media-capability-list');
  table.replaceChildren();
  const electronVersion = /Electron\/([\d.]+)/u.exec(navigator.userAgent)?.[1] || '非 Electron';
  const chromiumVersion = /Chrome\/([\d.]+)/u.exec(navigator.userAgent)?.[1] || '未知';
  $('#media-runtime').textContent = `Electron ${electronVersion} · Chromium ${chromiumVersion} · 這些提示不是實際播放保證。`;
  for (const profile of mediaProfiles) {
    const element = document.createElement(profile.kind);
    const canPlay = element.canPlayType(profile.mime);
    let capability = null;
    if (navigator.mediaCapabilities?.decodingInfo) {
      try {
        const configuration = profile.kind === 'video'
          ? { type: 'file', video: { contentType: profile.mime, width: 320, height: 180, bitrate: 450000, framerate: 24 } }
          : { type: 'file', audio: { contentType: profile.mime, channels: '2', bitrate: 128000, samplerate: 44100 } };
        capability = await navigator.mediaCapabilities.decodingInfo(configuration);
      } catch { capability = null; }
    }
    const row = document.createElement('tr');
    const label = document.createElement('td'); label.textContent = profile.label;
    const extension = document.createElement('td'); extension.textContent = profile.extension;
    const declared = document.createElement('td');
    declared.append(addSupportPill(canPlay || '未宣告支援', canPlay === 'probably' ? 'yes' : canPlay === 'maybe' ? 'maybe' : 'no'));
    const playback = document.createElement('td');
    const status = capability?.supported === true ? '能力 API 回報支援' : capability?.supported === false ? '能力 API 未回報支援' : '需用實際檔案確認';
    playback.append(addSupportPill(status, capability?.supported === true ? 'yes' : capability?.supported === false ? 'no' : 'maybe'));
    if (capability?.supported) {
      const detail = document.createElement('small');
      detail.className = 'capability-detail';
      detail.textContent = capability.powerEfficient ? '較省電' : capability.smooth ? '流暢度預估良好' : '可能較耗資源';
      playback.append(document.createElement('br'), detail);
    }
    row.append(label, extension, declared, playback);
    table.append(row);
  }
  state.mediaCompatibilityLoaded = true;
}

function waitForMediaEvent(element, eventName, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('讀取媒體逾時。')), timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      element.removeEventListener(eventName, success);
      element.removeEventListener('error', failure);
      error ? reject(error) : resolve();
    };
    const success = () => finish();
    const failure = () => finish(new Error(element.error?.message || '媒體解碼失敗。'));
    element.addEventListener(eventName, success, { once: true });
    element.addEventListener('error', failure, { once: true });
  });
}

function refreshMediaTestTracks() {
  const select = $('#media-test-track');
  const previous = select.value;
  select.replaceChildren(...state.playerItems.map((item) => {
    const relativePath = mediaItemPath(item, state.playerPath);
    const option = document.createElement('option');
    option.value = relativePath;
    option.textContent = `${item.name}（${mediaKind(item.name) === 'video' ? '影片' : '音訊'} · ${relativePath}）`;
    return option;
  }));
  if (state.playerItems.some((item) => mediaItemPath(item, state.playerPath) === previous)) select.value = previous;
  select.disabled = state.playerItems.length === 0;
  $('#media-test-run').disabled = !select.value;
}

async function testSelectedMedia() {
  const relativePath = $('#media-test-track').value;
  const result = $('#media-test-result');
  const button = $('#media-test-run');
  if (!relativePath || !state.shareId) return;
  const fileName = relativePath.split('/').at(-1);
  const kind = mediaKind(fileName);
  if (!['audio', 'video'].includes(kind)) {
    result.textContent = '無法從檔案類型判斷這是音訊或影片；請在目前資料夾選擇支援的影音檔。';
    result.className = 'inline-message media-test-result-error';
    return;
  }
  const player = kind === 'video' ? $('#media-test-video') : $('#media-test-audio');
  const inactive = kind === 'video' ? $('#media-test-audio') : $('#media-test-video');
  inactive.pause(); inactive.removeAttribute('src'); inactive.load();
  player.pause(); player.muted = true;
  const loaded = waitForMediaEvent(player, 'loadeddata');
  const playing = waitForMediaEvent(player, 'playing');
  result.textContent = `正在測試 Nanako 資料空間中的「${fileName}」…`;
  result.className = 'inline-message';
  button.disabled = true;
  try {
    player.src = mediaUrl(state.shareId, relativePath);
    player.load();
    const started = player.play();
    await Promise.all([loaded, playing, started]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (player.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) throw new Error('沒有解出可播放的影音資料。');
    if (kind === 'video' && (!player.videoWidth || !player.videoHeight)) throw new Error('沒有解出影片影格。');
    const detail = kind === 'video' ? `${player.videoWidth} × ${player.videoHeight}` : `${Number(player.duration || 0).toFixed(1)} 秒`;
    result.textContent = `播放測試成功：${fileName}（${detail}）。只驗證開頭片段，未檢查整份檔案。`;
    result.className = 'inline-message media-test-result-success';
  } catch (error) {
    result.textContent = `播放測試失敗：${fileName}（${error.message}）。這可能是容器、編碼、檔案損毀或執行環境不支援；原始檔未變更。`;
    result.className = 'inline-message media-test-result-error';
  } finally {
    player.pause();
    player.removeAttribute('src');
    player.load();
    button.disabled = !$('#media-test-track').value;
  }
}

async function loadComputer() {
  const list = $('#managed-storage-list');
  list.replaceChildren();
  for (const share of state.shares) {
    const tile = document.createElement('article'); tile.className = 'library-tile';
    const title = document.createElement('strong'); title.textContent = share.name;
    const detail = document.createElement('small'); detail.textContent = share.canWrite ? 'Nanako 可攜式資料目錄 · 可讀取與寫入' : 'Nanako 可攜式資料目錄 · 唯讀';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.textContent = '開啟資料空間';
    button.addEventListener('click', () => { selectShare(share.id); showView('files'); });
    tile.append(title, detail, button); list.append(tile);
  }
  $('#managed-storage-empty').hidden = state.shares.length > 0;
}
function makeSystemCard(title, wide = false) {
  const card = document.createElement('section');
  card.className = `system-card${wide ? ' system-card-wide' : ''}`;
  const heading = document.createElement('h3'); heading.textContent = title;
  card.append(heading);
  return card;
}

function addSystemFact(list, label, value) {
  const term = document.createElement('dt'); term.textContent = label;
  const detail = document.createElement('dd'); detail.textContent = value || '—';
  list.append(term, detail);
}

function makeSystemMeter(label, percent, text) {
  const row = document.createElement('div'); row.className = 'system-fact-row';
  const name = document.createElement('span'); name.textContent = label;
  const meter = document.createElement('div'); meter.className = 'system-meter';
  const track = document.createElement('div'); track.className = 'system-meter-track';
  const fill = document.createElement('div'); fill.className = 'system-meter-fill'; fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  track.append(fill);
  const number = document.createElement('strong'); number.textContent = text;
  meter.append(track, number); row.append(name, meter);
  return row;
}

async function loadSystem() {
  clearTimeout(state.systemRefreshTimer);
  state.systemRefreshTimer = null;
  try {
    const info = await api('/api/system');
    const container = $('#system-information'); container.replaceChildren();
    const device = makeSystemCard('裝置資訊');
    const deviceFacts = document.createElement('dl'); deviceFacts.className = 'system-facts';
    addSystemFact(deviceFacts, '電腦名稱', info.computerName);
    addSystemFact(deviceFacts, '作業系統', `${info.operatingSystem} ${info.operatingSystemVersion || ''}`.trim());
    addSystemFact(deviceFacts, '版本組建', info.buildNumber ? `Build ${info.buildNumber}` : '—');
    addSystemFact(deviceFacts, '系統架構', `${info.architecture}（${info.logicalProcessors} 個邏輯處理器）`);
    addSystemFact(deviceFacts, '處理器', info.processor);
    device.append(deviceFacts);

    const execution = makeSystemCard('Windows 權限狀態');
    const executionFacts = document.createElement('dl'); executionFacts.className = 'system-facts';
    const windowsExecution = info.windowsExecution || {};
    addSystemFact(executionFacts, '目前 Windows 身分', windowsExecution.identity || '無法判定');
    addSystemFact(executionFacts, '系統管理員群組', windowsExecution.checked ? (windowsExecution.isAdministrator ? '是' : '否') : '無法判定');
    addSystemFact(executionFacts, '目前程序權限', !windowsExecution.supported ? '非 Windows 環境' : windowsExecution.checked ? (windowsExecution.isElevated ? '已提升（高完整性）' : '未提升') : '無法判定');
    const executionNote = document.createElement('p'); executionNote.className = 'muted';
    executionNote.textContent = windowsExecution.isElevated
      ? 'Nanako 目前以 Windows 提升權限執行。'
      : 'Nanako 目前尚未以 Windows 提升權限執行；此狀態不同於 Nanako 內的管理員帳號。';
    execution.append(executionFacts, executionNote);

    const memory = makeSystemCard('記憶體');
    const memoryFacts = document.createElement('dl'); memoryFacts.className = 'system-facts';
    addSystemFact(memoryFacts, '已使用', `${formatSize(info.memory.usedBytes)}／${formatSize(info.memory.totalBytes)}`);
    addSystemFact(memoryFacts, '可用', formatSize(info.memory.availableBytes));
    memory.append(memoryFacts, makeSystemMeter('使用率', info.memory.usagePercent, `${info.memory.usagePercent}%`));

    const cpu = makeSystemCard('處理器狀態');
    const cpuValue = info.cpuUsagePercent === null ? '收集基準中' : `${info.cpuUsagePercent}%`;
    cpu.append(makeSystemMeter('整體使用率', info.cpuUsagePercent, cpuValue));

    const storage = makeSystemCard('Nanako 資料所在磁碟');
    const storageFacts = document.createElement('dl'); storageFacts.className = 'system-facts';
    addSystemFact(storageFacts, '已使用', `${formatSize(info.storage.usedBytes)}／${formatSize(info.storage.totalBytes)}`);
    addSystemFact(storageFacts, '可用', formatSize(info.storage.freeBytes));
    storage.append(storageFacts, makeSystemMeter('空間使用率', info.storage.totalBytes ? info.storage.usedBytes / info.storage.totalBytes * 100 : 0, info.storage.totalBytes ? `${Math.round(info.storage.usedBytes / info.storage.totalBytes * 100)}%` : '未知'));

    const network = makeSystemCard('網路介面', true);
    const interfaces = document.createElement('div'); interfaces.className = 'system-interface-list';
    for (const item of info.networkInterfaces) {
      const row = document.createElement('div'); row.className = 'system-interface';
      const name = document.createElement('strong'); name.textContent = item.name;
      const address = document.createElement('span'); address.textContent = `${item.address}（${item.family}${item.private ? '・私人網段' : ''}）`;
      const macLabel = document.createElement('span'); macLabel.textContent = 'MAC 位址';
      const mac = document.createElement('span'); mac.textContent = item.mac || '—';
      row.append(name, address, macLabel, mac); interfaces.append(row);
    }
    if (!info.networkInterfaces.length) interfaces.textContent = '目前沒有啟用中的網路介面。';
    network.append(interfaces);
    container.append(device, execution, memory, cpu, storage, network);
    if (state.windows.get('system')?.status === 'open') state.systemRefreshTimer = setTimeout(loadSystem, 5000);
  } catch (error) {
    const container = $('#system-information'); container.replaceChildren();
    const message = document.createElement('p'); message.className = 'system-error'; message.textContent = error.message;
    container.append(message);
  }
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const mode = formElement.dataset.mode; const errorBox = $('#auth-error'); errorBox.hidden = true;
  try { const result = await api(mode === 'setup' ? '/api/setup' : '/api/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }); state.user = result.user; formElement.reset(); showApp(); }
  catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
});

$('#logout-button').addEventListener('click', async () => {
  if (state.duplicateScanId && ['scanning', 'cancelling'].includes(state.duplicateScanStatus)) {
    const query = new URLSearchParams({ scanId: state.duplicateScanId });
    await api(`/api/duplicates/scan?${query}`, { method: 'DELETE' }).catch(() => {});
    state.duplicateScanId = ''; state.duplicateScanStatus = 'cancelled';
  }
  await persistActivePlayback(true);
  await api('/api/logout', { method: 'POST' }); closeAllWindows(); state.user = null; state.path = ''; showAuth(false);
});
$('#change-password-button').addEventListener('click', () => {
  const form = $('#change-password-form'); form.reset();
  const message = $('#change-password-message'); message.hidden = true; message.textContent = ''; message.classList.remove('error');
  $('#change-password-dialog').showModal(); form.elements.currentPassword.focus();
});
$('#cancel-change-password').addEventListener('click', () => $('#change-password-dialog').close());
$('#change-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget; const values = new FormData(form); const message = $('#change-password-message');
  if (values.get('newPassword') !== values.get('confirmPassword')) {
    message.textContent = '兩次輸入的新密碼不一致。'; message.classList.add('error'); message.hidden = false; return;
  }
  const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: values.get('currentPassword'), newPassword: values.get('newPassword') }) });
    $('#change-password-dialog').close(); form.reset(); notify('密碼已更新，其他登入工作階段已撤銷。');
  } catch (error) { message.textContent = error.message; message.classList.add('error'); message.hidden = false; }
  finally { submit.disabled = false; }
});
initializeDesktopInteractions();
for (const selector of ['#share-select', '#trash-share-select', '#album-share-select', '#player-share-select', '#duplicates-share-select']) {
  $(selector).addEventListener('change', (event) => selectShare(event.target.value));
}
$('#album-scope-toggle').addEventListener('click', () => setAlbumScopeAll(!state.albumScopeAll));
$('#album-more').addEventListener('click', appendAlbumBatch);
$('#file-more').addEventListener('click', appendFileBatch);
$('#album-search').addEventListener('input', () => {
  clearTimeout(state.albumSearchTimer);
  state.albumSearchTimer = setTimeout(() => { state.albumSearch = $('#album-search').value; loadAlbum(); }, 400);
});
$('#player-scope-toggle').addEventListener('click', () => setPlayerScopeAll(!state.playerScopeAll));
$('#player-more').addEventListener('click', appendPlayerBatch);
$('#player-search').addEventListener('input', () => {
  clearTimeout(state.playerSearchTimer);
  state.playerSearchTimer = setTimeout(() => { state.playerSearch = $('#player-search').value; loadPlayer(); }, 400);
});
$('#new-folder').addEventListener('click', async () => { const name = prompt('請輸入資料夾名稱'); if (!name) return; try { await api('/api/folders', { method: 'POST', body: JSON.stringify({ shareId: state.shareId, path: state.path, name }) }); loadFiles(); } catch (error) { notify(error.message, true); } });
$('#upload-file-label').addEventListener('click', (event) => { if ($('#file-input').disabled) { event.preventDefault(); event.stopPropagation(); } });
$('#file-search').addEventListener('input', () => {
  clearTimeout(state.fileSearchTimer);
  state.fileSearchTimer = setTimeout(() => { state.fileSearch = $('#file-search').value; state.selectedItems.clear(); loadFiles(); }, state.fileCategory === 'all' ? 180 : 350);
});
$('#file-sort').addEventListener('change', (event) => { state.fileSort = event.currentTarget.value; loadFiles(); });
$('#select-all-files').addEventListener('change', (event) => {
  if (event.target.checked) for (const item of state.currentItems) state.selectedItems.add(item.name);
  else for (const item of state.currentItems) state.selectedItems.delete(item.name);
  loadFiles();
});
$('#batch-move').addEventListener('click', () => batchFileOperation('move'));
$('#batch-copy').addEventListener('click', () => batchFileOperation('copy'));
$('#batch-delete').addEventListener('click', batchDeleteItems);
$('#archive-cancel').addEventListener('click', async () => {
  if (!state.archiveRunning) return;
  const button = $('#archive-cancel'); button.disabled = true; button.textContent = '取消中…';
  $('#archive-progress-message').textContent = '正在取消 ZIP 作業並清除暫存項目；來源檔案不會變更。';
  try { await api('/api/archive/cancel', { method: 'POST', body: '{}' }); }
  catch (error) { $('#archive-progress-message').textContent = error.message; button.disabled = false; button.textContent = '取消作業'; }
});
$('#file-input').addEventListener('change', async (event) => { const files = [...event.target.files]; for (const file of files) { const query = new URLSearchParams({ shareId: state.shareId, path: state.path, name: file.name }); try { await api(`/api/upload?${query}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }); } catch (error) { notify(`${file.name}：${error.message}`, true); } } event.target.value = ''; loadFiles(); });
$('#vault-setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget; const values = new FormData(form); const password = String(values.get('password') || '');
  if (password !== values.get('confirmPassword')) { setVaultMessage('兩次輸入的加密空間密碼不一致。', true); return; }
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const result = await api('/api/vault/setup', { method: 'POST', body: JSON.stringify({ password }) });
    form.reset(); showVaultRecoveryCode(result.recoveryCode); await loadVault();
    setVaultMessage('加密空間已建立。請立即將復原金鑰保存至 Nanako 資料空間以外的安全位置。');
  } catch (error) { setVaultMessage(error.message, true); }
  finally { button.disabled = false; }
});
$('#vault-unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget; const values = new FormData(form); const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    await api('/api/vault/unlock', { method: 'POST', body: JSON.stringify({ password: values.get('password') }) });
    form.reset(); await loadVault();
  } catch (error) { setVaultMessage(error.message, true); }
  finally { button.disabled = false; }
});
$('#vault-lock-button').addEventListener('click', lockVaultFromUi);
$('#vault-recover-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget; const values = new FormData(form); const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    await api('/api/vault/recover', { method: 'POST', body: JSON.stringify({ recoveryCode: values.get('recoveryCode') }) });
    form.reset(); $('#vault-unlock-form').reset(); await loadVault(); setVaultMessage('已使用復原金鑰解鎖。若忘記原密碼，可在「已解鎖」區段設定新密碼；請一併妥善保存復原金鑰。');
  } catch (error) { setVaultMessage(error.message, true); }
  finally { button.disabled = false; }
});
$('#vault-password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget; const values = new FormData(form); const password = String(values.get('password') || '');
  if (password !== values.get('confirmPassword')) { setVaultMessage('兩次輸入的加密空間密碼不一致。', true); return; }
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    await api('/api/vault/password', { method: 'POST', body: JSON.stringify({ password }) });
    form.reset(); setVaultMessage('加密空間密碼已更新。現有檔案未重新加密，復原金鑰仍有效。');
  } catch (error) { setVaultMessage(error.message, true); }
  finally { button.disabled = false; }
});
$('#vault-recovery-key-rotate').addEventListener('click', async () => {
  if (state.vaultRecoveryCodePending && !confirm('重新產生會立即讓目前畫面上的舊復原金鑰失效。要繼續嗎？')) return;
  try {
    const result = await api('/api/vault/recovery-key', { method: 'POST', body: '{}' });
    showVaultRecoveryCode(result.recoveryCode);
  } catch (error) { setVaultMessage(error.message, true); }
});
$('#vault-recovery-key-copy').addEventListener('click', async () => {
  const code = $('#vault-recovery-key-value').value;
  try { await navigator.clipboard.writeText(code); setVaultMessage('復原金鑰已複製。請確認已貼到安全位置後再關閉提示。'); }
  catch { $('#vault-recovery-key-value').select(); setVaultMessage('無法自動複製；已選取復原金鑰，請手動複製並保存。', true); }
});
$('#vault-recovery-key-saved').addEventListener('click', () => {
  if (!confirm('確認已將復原金鑰保存到 Nanako 資料空間以外的安全位置？關閉後無法再次檢視這組金鑰。')) return;
  clearVaultRecoveryCode(); setVaultMessage('已關閉復原金鑰提示；你仍可在加密空間解鎖後重新產生金鑰。');
});
$('#vault-source-share').addEventListener('change', (event) => { state.vaultSourceShareId = event.currentTarget.value; state.vaultSourcePath = ''; loadVaultSource(); });
$('#vault-source-up').addEventListener('click', () => { state.vaultSourcePath = state.vaultSourcePath.split('/').slice(0, -1).join('/'); loadVaultSource(); });
$('#vault-source-refresh').addEventListener('click', loadVaultSource);
$('#vault-refresh').addEventListener('click', loadVaultObjects);
$('#vault-trash-refresh').addEventListener('click', loadVaultTrash);
$('#vault-backup-create').addEventListener('click', async () => {
  const button = $('#vault-backup-create'); button.disabled = true; button.textContent = '建立中…';
  try {
    const result = await api('/api/vault/backups', { method: 'POST', body: '{}' });
    await loadVaultBackups(); setVaultMessage(`已建立加密備份：${result.backup.itemCount} 個檔案，${formatSize(result.backup.encryptedBytes)}。備份仍位於 NanakoData。`);
  } catch (error) { setVaultMessage(error.message, true); }
  finally { button.disabled = false; button.textContent = '建立備份'; }
});
$('#vault-recovery-refresh').addEventListener('click', loadVaultRecovery);
$('#vault-preview-close').addEventListener('click', clearVaultPreview);
$('#vault-import-dialog').addEventListener('cancel', (event) => { if ($('#confirm-vault-import').disabled) event.preventDefault(); });
$('#cancel-vault-import').addEventListener('click', async () => {
  if (state.vaultImportRunning) {
    const cancel = $('#cancel-vault-import'); cancel.disabled = true; cancel.textContent = '取消中…';
    const message = $('#vault-import-message'); message.textContent = '正在取消加密移入；來源檔案會保留。'; message.hidden = false;
    try { await api('/api/vault/objects/import/cancel', { method: 'POST', body: '{}' }); }
    catch (error) { message.textContent = error.message; message.classList.add('error'); }
    return;
  }
  if (!$('#confirm-vault-import').disabled) { state.vaultPendingImport = null; $('#vault-import-dialog').close(); }
});
$('#vault-import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const item = state.vaultPendingImport; if (!item) return;
  const button = $('#confirm-vault-import'); button.disabled = true; $('#cancel-vault-import').disabled = false; $('#cancel-vault-import').textContent = '取消作業'; button.textContent = '加密驗證中…';
  state.vaultImportRunning = true;
  const bar = $('#vault-import-progress'); bar.value = 0; bar.hidden = false;
  const status = $('#vault-import-message'); status.textContent = '檔案會以串流方式加密並驗證；完成前來源檔案不會移除。'; status.hidden = false; status.classList.remove('error');
  clearInterval(state.vaultImportPollTimer); state.vaultImportPollTimer = setInterval(() => { void refreshVaultImportProgress(); }, 350);
  void refreshVaultImportProgress();
  try {
    const result = await api('/api/vault/objects/import', { method: 'POST', body: JSON.stringify({ shareId: item.shareId, path: item.path }) });
    state.vaultPendingImport = null; $('#vault-import-dialog').close();
    setVaultMessage(result.item.sourceRemovalPending
      ? `「${result.item.name}」已加密；原始檔尚未移除，請在「未完成的移入作業」中檢查並處理。`
      : `已加密並移除來源檔案「${result.item.name}」。`);
    await Promise.all([loadVaultObjects(), loadVaultSource(), loadVaultRecovery()]);
    if (state.shareId === item.shareId) loadFiles();
  } catch (error) { status.textContent = error.message; status.classList.add('error'); status.hidden = false; }
  finally {
    clearInterval(state.vaultImportPollTimer); state.vaultImportPollTimer = null; state.vaultImportRunning = false;
    button.disabled = false; $('#cancel-vault-import').disabled = false; $('#cancel-vault-import').textContent = '取消'; button.textContent = '移入並加密';
    bar.hidden = true;
  }
});
$('#vault-delete-confirm').addEventListener('input', (event) => { $('#confirm-vault-delete').disabled = event.currentTarget.value !== '移至資源回收筒'; });
$('#cancel-vault-delete').addEventListener('click', () => { state.vaultPendingDelete = null; $('#vault-delete-dialog').close(); });
$('#vault-delete-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const item = state.vaultPendingDelete; if (!item) return;
  const button = $('#confirm-vault-delete'); button.disabled = true;
  try {
    await api(`/api/vault/objects/${encodeURIComponent(item.id)}`, { method: 'DELETE', body: JSON.stringify({ confirmText: '移至資源回收筒' }) });
    if (state.vaultPreviewId === item.id) clearVaultPreview();
    state.vaultPendingDelete = null; $('#vault-delete-dialog').close(); await Promise.all([loadVaultObjects(), loadVaultTrash()]); setVaultMessage('已移至加密空間資源回收筒。');
  } catch (error) { const message = $('#vault-delete-message'); message.textContent = error.message; message.classList.add('error'); message.hidden = false; }
  finally { button.disabled = $('#vault-delete-confirm').value !== '移至資源回收筒'; }
});
$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const permissions = state.shares.flatMap((share) => {
    const read = formElement.elements[`read-${share.id}`].checked;
    const write = formElement.elements[`write-${share.id}`].checked;
    return read ? [{ shareId: share.id, canRead: read, canWrite: write }] : [];
  });
  const message = $('#user-message');
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password'), permissions }) });
    formElement.reset();
    message.textContent = '使用者已建立。';
    message.classList.remove('error'); message.hidden = false; loadUsers();
  } catch (error) { message.textContent = error.message; message.classList.add('error'); message.hidden = false; }
});

$('#photo-close').addEventListener('click', () => $('#photo-dialog').close());
$('#photo-prev').addEventListener('click', () => showPhoto(state.photoIndex - 1));
$('#photo-next').addEventListener('click', () => showPhoto(state.photoIndex + 1));
$('#photo-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
$('#photo-dialog').addEventListener('close', () => {
  $('#photo-image').removeAttribute('src');
  state.photoItems = []; state.photoIndex = 0; state.photoShareId = ''; state.photoPath = '';
});
$('#video-player').addEventListener('ended', playNextTrack);
$('#audio-player').addEventListener('ended', playNextTrack);
for (const [kind, selector] of [['video', '#video-player'], ['audio', '#audio-player']]) {
  const player = $(selector);
  player.addEventListener('timeupdate', () => {
    if (state.playbackReady && state.activeTrackKind === kind && player.dataset.trackPath === state.activeTrackPath) persistActivePlayback();
  });
  player.addEventListener('seeked', () => {
    if (state.playbackReady && state.activeTrackKind === kind && player.dataset.trackPath === state.activeTrackPath) persistActivePlayback(true);
  });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) void persistActivePlayback(true); });
window.addEventListener('pagehide', () => { void persistActivePlayback(true, true); });
$('#media-test-track').addEventListener('change', () => {
  const option = $('#media-test-track').selectedOptions[0];
  $('#media-test-run').disabled = !option;
  $('#media-test-result').textContent = option ? `已選取 Nanako 資料空間內的「${option.textContent}」。播放測試透過本機 API 串流讀取，不會存取其他資料夾。` : '請先在播放器上方選取資料空間與資料夾。';
  $('#media-test-result').className = 'inline-message';
});
$('#media-test-run').addEventListener('click', testSelectedMedia);
$('#refresh-system').addEventListener('click', loadSystem);
$('#audit-settings-form').addEventListener('submit', saveAuditSettings);
$('#refresh-audit-logs').addEventListener('click', loadAuditLogs);
$('#clear-audit-logs').addEventListener('click', () => { $('#clear-audit-confirm').value = ''; $('#confirm-clear-audit').disabled = true; $('#clear-audit-dialog').showModal(); $('#clear-audit-confirm').focus(); });
$('#clear-audit-confirm').addEventListener('input', (event) => { $('#confirm-clear-audit').disabled = event.currentTarget.value !== '刪除所有紀錄'; });
$('#clear-audit-form').addEventListener('submit', clearAllAuditLogs);
$('#cancel-clear-audit').addEventListener('click', () => $('#clear-audit-dialog').close());
$('#duplicate-scan-start').addEventListener('click', startDuplicateScan);
$('#duplicate-scan-cancel').addEventListener('click', cancelDuplicateScan);
$('#duplicate-cleanup-button').addEventListener('click', openDuplicateCleanupConfirmation);
$('#duplicate-cleanup-form').addEventListener('submit', cleanDuplicateFiles);
$('#cancel-duplicate-cleanup').addEventListener('click', () => $('#duplicate-cleanup-dialog').close());
$('#duplicate-open-trash').addEventListener('click', () => showView('trash'));

start();

