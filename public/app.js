const $ = (selector) => document.querySelector(selector);
const state = {
  user: null, shares: [], shareId: '', path: '', albumPath: '', playerPath: '', view: 'files',
  currentItems: [], albumItems: [], albumImages: [], playerItems: [], pendingTrackPath: '',
  activeTrackPath: '', photoItems: [], photoIndex: 0, photoShareId: '', photoPath: '', systemRefreshTimer: null,
  windowState: 'open', windowMaximized: false, windowRestoreRect: null, desktopClockTimer: null,
};
const mediaExtensions = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']),
  video: new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']),
  audio: new Set(['mp3', 'm4a', 'aac', 'wav', 'oga', 'ogg', 'opus', 'flac']),
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

function mediaKind(name) {
  const extension = name.split('.').at(-1)?.toLowerCase() || '';
  return Object.entries(mediaExtensions).find(([, extensions]) => extensions.has(extension))?.[0] || '';
}

function mediaUrl(shareId, filePath) {
  return `/api/preview?${new URLSearchParams({ shareId, path: filePath })}`;
}

function syncShareSelectors() {
  for (const selector of ['#share-select', '#trash-share-select', '#album-share-select', '#player-share-select']) {
    const element = $(selector);
    if (element) element.value = state.shareId;
  }
}

function selectShare(shareId) {
  if (shareId === state.shareId) return;
  state.shareId = shareId;
  state.path = ''; state.albumPath = ''; state.playerPath = '';
  state.currentItems = []; state.albumItems = []; state.albumImages = []; state.playerItems = [];
  state.pendingTrackPath = ''; state.activeTrackPath = '';
  resetPlayer();
  syncShareSelectors();
  if (state.view === 'files') loadFiles();
  if (state.view === 'trash') loadTrash();
  if (state.view === 'album') loadAlbum();
  if (state.view === 'player') loadPlayer();
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
  setWindowState('open');
  updateDesktopClock();
  clearInterval(state.desktopClockTimer);
  state.desktopClockTimer = setInterval(updateDesktopClock, 15_000);
  loadShares().then(() => showView(state.view));
}

async function loadShares() {
  const { shares } = await api('/api/shares');
  state.shares = shares;
  if (!state.shares.some((share) => share.id === state.shareId)) state.shareId = state.shares[0]?.id || '';
  for (const selector of ['#share-select', '#trash-share-select', '#album-share-select', '#player-share-select']) {
    const element = $(selector);
    element.replaceChildren(...state.shares.map((share) => {
      const option = document.createElement('option'); option.value = share.id; option.textContent = share.name; return option;
    }));
    element.value = state.shareId;
    element.disabled = state.shares.length === 0;
  }
  syncShareSelectors();
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

function showView(view) {
  if (['users', 'system', 'settings'].includes(view) && state.user.role !== 'admin') view = 'files';
  const previousView = state.view;
  state.view = view;
  if (previousView !== view) void api('/api/activity', { method: 'POST', body: JSON.stringify({ view }) }).catch(() => {});
  clearTimeout(state.systemRefreshTimer);
  const names = { files: '檔案管理', album: '相簿', player: '播放器', trash: '資源回收桶', users: '使用者與權限', computer: '我的電腦', system: '電腦資訊', settings: '系統設定與紀錄', network: '網路狀態' };
  const icons = { files: '▤', album: '▧', player: '▶', trash: '⌫', users: '♙', computer: '▣', system: '▦', settings: '⚙', network: '⌁' };
  $('#page-title').textContent = names[view];
  $('#window-title').textContent = names[view];
  $('#window-app-icon').textContent = icons[view] || '▤';
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.taskbar-app[data-open-view]').forEach((button) => button.classList.toggle('active', button.dataset.openView === view));
  const dockApp = $('#dock-app');
  dockApp.setAttribute('aria-label', `顯示${names[view]}視窗`);
  dockApp.title = names[view];
  dockApp.classList.toggle('active', state.windowState === 'open');
  document.querySelectorAll('.view-panel').forEach((panel) => { panel.hidden = panel.id !== `view-${view}`; });
  if (view === 'files') loadFiles();
  if (view === 'album') loadAlbum();
  if (view === 'player') { loadPlayer(); if (!state.mediaCompatibilityLoaded) loadMediaCompatibility(); }
  if (view === 'trash') loadTrash();
  if (view === 'users') loadUsers();
  if (view === 'computer') loadComputer();
  if (view === 'system') loadSystem();
  if (view === 'settings') { loadAuditSettings(); loadAuditLogs(); }
  if (view === 'network') loadNetwork();
}

function setWindowState(nextState) {
  state.windowState = nextState;
  const windowElement = $('#app-window');
  const dockApp = $('#dock-app');
  windowElement.hidden = nextState !== 'open';
  dockApp.classList.toggle('active', nextState === 'open');
  dockApp.classList.toggle('running', nextState !== 'closed');
  dockApp.setAttribute('aria-pressed', String(nextState === 'open'));
}

function launchView(view) {
  closeLauncherMenu();
  showView(view);
  setWindowState('open');
}

function updateDesktopClock() {
  const clock = $('#desktop-clock');
  if (!clock) return;
  const now = new Date();
  clock.textContent = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  clock.title = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'full' }).format(now);
}

function toggleLauncherMenu(force) {
  const menu = $('#launcher-menu');
  const button = $('#launcher-toggle');
  const open = force ?? menu.hidden;
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

function closeLauncherMenu() { toggleLauncherMenu(false); }

function toggleWindowMaximized() {
  const windowElement = $('#app-window');
  if (!state.windowMaximized) {
    state.windowRestoreRect = {
      left: windowElement.style.left,
      top: windowElement.style.top,
      width: windowElement.style.width,
      height: windowElement.style.height,
    };
    state.windowMaximized = true;
    windowElement.classList.add('is-maximized');
    $('#window-maximize').textContent = '▢';
    $('#window-maximize').setAttribute('aria-label', '還原視窗');
    $('#window-maximize').title = '還原';
  } else {
    state.windowMaximized = false;
    windowElement.classList.remove('is-maximized');
    const rect = state.windowRestoreRect || {};
    for (const key of ['left', 'top', 'width', 'height']) windowElement.style[key] = rect[key] || '';
    $('#window-maximize').textContent = '□';
    $('#window-maximize').setAttribute('aria-label', '最大化視窗');
    $('#window-maximize').title = '最大化';
  }
}

function initializeDesktopInteractions() {
  document.querySelectorAll('[data-open-view]').forEach((button) => button.addEventListener('click', () => launchView(button.dataset.openView)));
  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  $('#launcher-toggle').addEventListener('click', () => toggleLauncherMenu());
  $('#dock-launcher').addEventListener('click', () => toggleLauncherMenu());
  $('#desktop-account').addEventListener('click', () => toggleLauncherMenu());
  $('#logout-menu-button').addEventListener('click', () => $('#logout-button').click());
  $('#dock-app').addEventListener('click', () => {
    if (state.windowState === 'open') showView(state.view);
    else setWindowState('open');
  });
  document.querySelectorAll('[data-window-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.windowAction;
    if (action === 'minimize' || action === 'close') setWindowState(action === 'minimize' ? 'minimized' : 'closed');
    if (action === 'maximize') toggleWindowMaximized();
  }));

  const titlebar = $('#window-titlebar');
  const windowElement = $('#app-window');
  let drag = null;
  titlebar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button') || state.windowMaximized) return;
    const rect = windowElement.getBoundingClientRect();
    const area = $('#desktop-area').getBoundingClientRect();
    drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, area, started: false };
    titlebar.setPointerCapture(event.pointerId);
  });
  titlebar.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    drag.started = true;
    const area = drag.area;
    const width = windowElement.offsetWidth;
    const height = windowElement.offsetHeight;
    const left = Math.max(0, Math.min(area.width - Math.min(width, 180), event.clientX - area.left - drag.offsetX));
    const top = Math.max(0, Math.min(area.height - 44, event.clientY - area.top - drag.offsetY));
    windowElement.style.left = `${left}px`;
    windowElement.style.top = `${top}px`;
  });
  const stopDrag = (event) => {
    if (drag?.pointerId === event.pointerId) drag = null;
  };
  titlebar.addEventListener('pointerup', stopDrag);
  titlebar.addEventListener('pointercancel', stopDrag);
  titlebar.addEventListener('dblclick', (event) => { if (!event.target.closest('button')) toggleWindowMaximized(); });
  titlebar.addEventListener('keydown', (event) => {
    if (event.target !== titlebar) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleWindowMaximized();
      return;
    }
    const movement = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[event.key];
    if (!movement || state.windowMaximized) return;
    event.preventDefault();
    const area = $('#desktop-area').getBoundingClientRect();
    const rect = windowElement.getBoundingClientRect();
    const nextLeft = Math.max(0, Math.min(area.width - Math.min(rect.width, 180), rect.left - area.left + movement[0]));
    const nextTop = Math.max(0, Math.min(area.height - 44, rect.top - area.top + movement[1]));
    windowElement.style.left = `${nextLeft}px`;
    windowElement.style.top = `${nextTop}px`;
  });

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

async function loadFiles() {
  if (!state.shareId) { $('#file-list').replaceChildren(); $('#empty-files').hidden = false; renderBreadcrumb($('#breadcrumb'), state.path, (next) => { state.path = next; loadFiles(); }); return; }
  try {
    const query = new URLSearchParams({ shareId: state.shareId, path: state.path });
    const { items, canWrite } = await api(`/api/files?${query}`);
    state.currentItems = items;
    renderBreadcrumb($('#breadcrumb'), state.path, (next) => { state.path = next; loadFiles(); });
    const body = $('#file-list'); body.replaceChildren();
    $('#empty-files').hidden = items.length !== 0;
    $('#new-folder').disabled = !canWrite; $('#file-input').disabled = !canWrite;
    for (const item of items) {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td'); const wrapper = document.createElement('div'); wrapper.className = 'item-name';
      const icon = document.createElement('span'); icon.className = `item-icon${item.isDirectory ? ' folder' : ''}`; icon.setAttribute('aria-hidden', 'true'); icon.textContent = item.isDirectory ? '▰' : '▧';
      const open = document.createElement('button'); open.type = 'button'; open.textContent = item.name;
      if (item.isDirectory) open.addEventListener('click', () => { state.path = state.path ? `${state.path}/${item.name}` : item.name; loadFiles(); });
      else open.addEventListener('click', () => openFile(item));
      wrapper.append(icon, open); nameCell.append(wrapper);
      const dateCell = document.createElement('td'); dateCell.textContent = formatDate(item.modifiedAt);
      const sizeCell = document.createElement('td'); sizeCell.textContent = item.isDirectory ? '資料夾' : formatSize(item.size);
      const actionCell = document.createElement('td');
      if (canWrite) {
        const actions = document.createElement('div'); actions.className = 'row-actions';
        if (!item.name.toLocaleLowerCase('en-US').endsWith('.zip')) {
          const compress = document.createElement('button'); compress.type = 'button'; compress.className = 'text-action'; compress.textContent = '壓縮 ZIP';
          compress.addEventListener('click', () => runArchiveAction(item.name, 'create', compress)); actions.append(compress);
        } else {
          const extract = document.createElement('button'); extract.type = 'button'; extract.className = 'text-action'; extract.textContent = '解壓縮';
          extract.addEventListener('click', () => runArchiveAction(item.name, 'extract', extract)); actions.append(extract);
        }
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-action danger'; remove.textContent = '移至回收桶'; remove.addEventListener('click', () => deleteItem(item.name)); actions.append(remove);
        actionCell.append(actions);
      }
      row.append(nameCell, dateCell, sizeCell, actionCell); body.append(row);
    }
  } catch (error) { notify(error.message, true); }
}

function joinedPath(name) { return state.path ? `${state.path}/${name}` : name; }

async function runArchiveAction(name, operation, button) {
  const label = operation === 'create' ? '壓縮 ZIP' : '解壓縮';
  button.disabled = true;
  try {
    const result = await api(`/api/archive/${operation}`, { method: 'POST', body: JSON.stringify({ shareId: state.shareId, path: joinedPath(name) }) });
    notify(operation === 'create' ? `已建立「${result.name}」。` : `已解壓縮至「${result.name}」。`);
    await loadFiles();
  } catch (error) { notify(`${label}失敗：${error.message}`, true); }
  finally { button.disabled = false; }
}

function openFile(item) {
  const kind = mediaKind(item.name);
  if (kind === 'image') {
    openPhotoGallery(state.currentItems, state.path, state.shareId, item.name);
  } else if (kind === 'audio' || kind === 'video') {
    state.playerPath = state.path;
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
  const index = state.photoItems.findIndex((item) => item.name === selectedName);
  if (index >= 0) showPhoto(index);
}

function showPhoto(index) {
  if (!state.photoItems.length) return;
  state.photoIndex = (index + state.photoItems.length) % state.photoItems.length;
  const item = state.photoItems[state.photoIndex];
  const image = $('#photo-image');
  image.alt = item.name;
  image.src = mediaUrl(state.photoShareId, state.photoPath ? `${state.photoPath}/${item.name}` : item.name);
  $('#photo-caption').textContent = item.name;
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
  await api(`/api/files?${query}`, { method: 'DELETE' }); notify('已移至資源回收桶。'); loadFiles();
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

async function loadUsers() {
  try {
    const { users } = await api('/api/users'); const body = $('#user-list'); body.replaceChildren();
    for (const user of users) { const row = document.createElement('div'); row.className = 'user-row'; const name = document.createElement('span'); name.textContent = user.username; const role = document.createElement('span'); role.className = 'user-role'; role.textContent = user.role === 'admin' ? '管理員' : '使用者'; row.append(name, role); body.append(row); }
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

async function loadAlbum() {
  const grid = $('#album-grid');
  if (!state.shareId) { grid.replaceChildren(); $('#empty-album').hidden = false; return; }
  try {
    const query = new URLSearchParams({ shareId: state.shareId, path: state.albumPath });
    const { items } = await api(`/api/files?${query}`);
    state.albumItems = items;
    state.albumImages = items.filter((item) => !item.isDirectory && mediaKind(item.name) === 'image');
    renderBreadcrumb($('#album-breadcrumb'), state.albumPath, (next) => { state.albumPath = next; loadAlbum(); });
    grid.replaceChildren();
    const folders = items.filter((item) => item.isDirectory);
    for (const folder of folders) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'album-folder';
      const icon = document.createElement('span'); icon.className = 'album-folder-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '▰';
      const label = document.createElement('span'); label.textContent = folder.name;
      button.append(icon, label);
      button.addEventListener('click', () => { state.albumPath = state.albumPath ? `${state.albumPath}/${folder.name}` : folder.name; loadAlbum(); });
      grid.append(button);
    }
    for (const item of state.albumImages) {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'album-card';
      const image = document.createElement('img'); image.loading = 'lazy'; image.decoding = 'async'; image.alt = '';
      image.src = mediaUrl(state.shareId, state.albumPath ? `${state.albumPath}/${item.name}` : item.name);
      image.addEventListener('error', () => { card.classList.add('image-unavailable'); image.removeAttribute('src'); }, { once: true });
      const caption = document.createElement('span'); caption.textContent = item.name;
      card.append(image, caption);
      card.addEventListener('click', () => openPhotoGallery(state.albumImages, state.albumPath, state.shareId, item.name));
      grid.append(card);
    }
    $('#empty-album').hidden = state.albumImages.length > 0 || folders.length > 0;
  } catch (error) { notify(error.message, true); }
}

async function loadPlayer() {
  const queue = $('#player-queue');
  if (!state.shareId) { state.playerItems = []; refreshMediaTestTracks(); queue.replaceChildren(); $('#empty-player').hidden = false; resetPlayer(); return; }
  try {
    const query = new URLSearchParams({ shareId: state.shareId, path: state.playerPath });
    const { items } = await api(`/api/files?${query}`);
    const folders = items.filter((item) => item.isDirectory);
    state.playerItems = items.filter((item) => !item.isDirectory && ['audio', 'video'].includes(mediaKind(item.name)));
    refreshMediaTestTracks();
    renderBreadcrumb($('#player-breadcrumb'), state.playerPath, (next) => { state.playerPath = next; loadPlayer(); });
    queue.replaceChildren();
    for (const folder of folders) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'queue-folder';
      button.textContent = `▰　${folder.name}`;
      button.addEventListener('click', () => { state.playerPath = state.playerPath ? `${state.playerPath}/${folder.name}` : folder.name; loadPlayer(); });
      queue.append(button);
    }
    for (const [index, item] of state.playerItems.entries()) {
      const relativePath = state.playerPath ? `${state.playerPath}/${item.name}` : item.name;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'queue-track';
      button.setAttribute('aria-current', String(state.activeTrackPath === relativePath));
      const name = document.createElement('span'); name.textContent = item.name;
      const details = document.createElement('small'); details.textContent = `${mediaKind(item.name) === 'video' ? '影片' : '音訊'} · ${formatSize(item.size)}`;
      button.append(name, details); button.addEventListener('click', () => playTrack(index)); queue.append(button);
    }
    $('#empty-player').hidden = state.playerItems.length > 0;
    const pending = state.pendingTrackPath;
    state.pendingTrackPath = '';
    if (pending) {
      const index = state.playerItems.findIndex((item) => (state.playerPath ? `${state.playerPath}/${item.name}` : item.name) === pending);
      if (index >= 0) playTrack(index);
      else notify('這個檔案目前無法播放。', true);
    }
  } catch (error) { notify(error.message, true); }
}

function playTrack(index) {
  const item = state.playerItems[index];
  if (!item) return;
  const kind = mediaKind(item.name);
  const relativePath = state.playerPath ? `${state.playerPath}/${item.name}` : item.name;
  const url = mediaUrl(state.shareId, relativePath);
  const video = $('#video-player'); const audio = $('#audio-player');
  const player = kind === 'video' ? video : audio;
  const inactive = kind === 'video' ? audio : video;
  state.activeTrackPath = relativePath;
  player.onerror = () => {
    if (state.activeTrackPath === relativePath) $('#player-message').textContent = '瀏覽器無法播放這個檔案或編碼格式。你仍可從檔案管理下載原始檔。';
    $('#player-message').hidden = state.activeTrackPath !== relativePath;
  };
  inactive.pause(); inactive.removeAttribute('src'); inactive.load(); inactive.hidden = true;
  player.pause(); player.hidden = false; player.src = url; player.load();
  $('#current-media-name').textContent = item.name;
  $('#player-placeholder').hidden = true;
  $('#player-message').hidden = true;
  for (const button of document.querySelectorAll('.queue-track')) {
    const isCurrent = button.querySelector('span')?.textContent === item.name;
    button.setAttribute('aria-current', String(isCurrent));
  }
  player.play().catch(() => {
    if (state.activeTrackPath === relativePath) {
      $('#player-message').textContent = '請按下播放按鈕開始播放。';
      $('#player-message').hidden = false;
    }
  });
}

function playNextTrack() {
  const currentIndex = state.playerItems.findIndex((item) => (state.playerPath ? `${state.playerPath}/${item.name}` : item.name) === state.activeTrackPath);
  if (currentIndex >= 0 && currentIndex + 1 < state.playerItems.length) playTrack(currentIndex + 1);
}

function resetPlayer() {
  for (const selector of ['#video-player', '#audio-player']) {
    const player = $(selector); player.pause(); player.removeAttribute('src'); player.load(); player.hidden = true;
  }
  $('#current-media-name').textContent = '尚未選取媒體';
  $('#player-placeholder').hidden = false;
  $('#player-message').hidden = true;
}

async function loadNetwork() {
  try { const result = await api('/api/network'); $('#network-endpoint').textContent = `http://${result.host}:${result.port}`; const list = $('#interface-list'); list.replaceChildren(); for (const item of result.interfaces) { const row = document.createElement('li'); const name = document.createElement('span'); name.textContent = item.name; const address = document.createElement('span'); address.className = 'ip'; address.textContent = `${item.address} · ${item.family}`; row.append(name, address); list.append(row); } if (!result.interfaces.length) list.textContent = '目前沒有可用的網路介面卡。'; }
  catch (error) { notify(error.message, true); }
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
    const relativePath = state.playerPath ? `${state.playerPath}/${item.name}` : item.name;
    const option = document.createElement('option');
    option.value = relativePath;
    option.textContent = `${item.name}（${mediaKind(item.name) === 'video' ? '影片' : '音訊'}）`;
    return option;
  }));
  if (state.playerItems.some((item) => (state.playerPath ? `${state.playerPath}/${item.name}` : item.name) === previous)) select.value = previous;
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
    container.append(device, memory, cpu, storage, network);
    if (state.view === 'system') state.systemRefreshTimer = setTimeout(loadSystem, 5000);
  } catch (error) {
    const container = $('#system-information'); container.replaceChildren();
    const message = document.createElement('p'); message.className = 'system-error'; message.textContent = error.message;
    container.append(message);
  }
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = new FormData(event.currentTarget); const mode = event.currentTarget.dataset.mode; const errorBox = $('#auth-error'); errorBox.hidden = true;
  try { const result = await api(mode === 'setup' ? '/api/setup' : '/api/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }); state.user = result.user; event.currentTarget.reset(); showApp(); }
  catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
});

$('#logout-button').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); resetPlayer(); state.user = null; state.path = ''; showAuth(false); });
initializeDesktopInteractions();
for (const selector of ['#share-select', '#trash-share-select', '#album-share-select', '#player-share-select']) {
  $(selector).addEventListener('change', (event) => selectShare(event.target.value));
}
$('#new-folder').addEventListener('click', async () => { const name = prompt('請輸入資料夾名稱'); if (!name) return; try { await api('/api/folders', { method: 'POST', body: JSON.stringify({ shareId: state.shareId, path: state.path, name }) }); loadFiles(); } catch (error) { notify(error.message, true); } });
$('#file-input').addEventListener('change', async (event) => { const files = [...event.target.files]; for (const file of files) { const query = new URLSearchParams({ shareId: state.shareId, path: state.path, name: file.name }); try { await api(`/api/upload?${query}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }); } catch (error) { notify(`${file.name}：${error.message}`, true); } } event.target.value = ''; loadFiles(); });
$('#user-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const permissions = state.shares.flatMap((share) => { const read = event.currentTarget.elements[`read-${share.id}`].checked; const write = event.currentTarget.elements[`write-${share.id}`].checked; return read ? [{ shareId: share.id, canRead: read, canWrite: write }] : []; }); const message = $('#user-message'); try { await api('/api/users', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password'), permissions }) }); event.currentTarget.reset(); message.textContent = '使用者已建立。'; message.classList.remove('error'); message.hidden = false; loadUsers(); } catch (error) { message.textContent = error.message; message.classList.add('error'); message.hidden = false; } });

$('#photo-close').addEventListener('click', () => $('#photo-dialog').close());
$('#photo-prev').addEventListener('click', () => showPhoto(state.photoIndex - 1));
$('#photo-next').addEventListener('click', () => showPhoto(state.photoIndex + 1));
$('#photo-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
$('#video-player').addEventListener('ended', playNextTrack);
$('#audio-player').addEventListener('ended', playNextTrack);
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

start();

