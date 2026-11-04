const $ = (selector) => document.querySelector(selector);
const state = { user: null, shares: [], shareId: '', path: '', view: 'files' };

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
  $('#app-shell').hidden = true;
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
  loadShares().then(() => showView(state.view));
}

async function loadShares() {
  const { shares } = await api('/api/shares');
  state.shares = shares;
  if (!state.shares.some((share) => share.id === state.shareId)) state.shareId = state.shares[0]?.id || '';
  for (const selector of ['#share-select', '#trash-share-select']) {
    const element = $(selector);
    element.replaceChildren(...state.shares.map((share) => {
      const option = document.createElement('option'); option.value = share.id; option.textContent = share.name; return option;
    }));
    element.value = state.shareId;
    element.disabled = state.shares.length === 0;
  }
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
  if (view === 'users' && state.user.role !== 'admin') view = 'files';
  state.view = view;
  const names = { files: '檔案管理', trash: '資源回收桶', users: '使用者與權限', network: '網路狀態' };
  $('#page-title').textContent = names[view];
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.view-panel').forEach((panel) => { panel.hidden = panel.id !== `view-${view}`; });
  if (view === 'files') loadFiles();
  if (view === 'trash') loadTrash();
  if (view === 'users') loadUsers();
  if (view === 'network') loadNetwork();
}

function renderBreadcrumb() {
  const container = $('#breadcrumb'); container.replaceChildren();
  const root = document.createElement('button'); root.type = 'button'; root.textContent = '主資料夾'; root.addEventListener('click', () => { state.path = ''; loadFiles(); }); container.append(root);
  const parts = state.path ? state.path.split('/') : [];
  let joined = '';
  for (let index = 0; index < parts.length; index += 1) {
    const sep = document.createElement('span'); sep.textContent = '›'; sep.setAttribute('aria-hidden', 'true'); container.append(sep);
    joined = joined ? `${joined}/${parts[index]}` : parts[index];
    const target = joined;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = parts[index]; button.addEventListener('click', () => { state.path = target; loadFiles(); }); container.append(button);
  }
}

async function loadFiles() {
  if (!state.shareId) { $('#file-list').replaceChildren(); $('#empty-files').hidden = false; renderBreadcrumb(); return; }
  try {
    const query = new URLSearchParams({ shareId: state.shareId, path: state.path });
    const { items, canWrite } = await api(`/api/files?${query}`);
    renderBreadcrumb();
    const body = $('#file-list'); body.replaceChildren();
    $('#empty-files').hidden = items.length !== 0;
    $('#new-folder').disabled = !canWrite; $('#file-input').disabled = !canWrite;
    for (const item of items) {
      const row = document.createElement('tr');
      const nameCell = document.createElement('td'); const wrapper = document.createElement('div'); wrapper.className = 'item-name';
      const icon = document.createElement('span'); icon.className = `item-icon${item.isDirectory ? ' folder' : ''}`; icon.setAttribute('aria-hidden', 'true'); icon.textContent = item.isDirectory ? '▰' : '▧';
      const open = document.createElement('button'); open.type = 'button'; open.textContent = item.name;
      if (item.isDirectory) open.addEventListener('click', () => { state.path = state.path ? `${state.path}/${item.name}` : item.name; loadFiles(); });
      else open.addEventListener('click', () => download(item.name));
      wrapper.append(icon, open); nameCell.append(wrapper);
      const dateCell = document.createElement('td'); dateCell.textContent = formatDate(item.modifiedAt);
      const sizeCell = document.createElement('td'); sizeCell.textContent = item.isDirectory ? '資料夾' : formatSize(item.size);
      const actionCell = document.createElement('td');
      if (canWrite) { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-action danger'; remove.textContent = '移至回收桶'; remove.addEventListener('click', () => deleteItem(item.name)); actionCell.append(remove); }
      row.append(nameCell, dateCell, sizeCell, actionCell); body.append(row);
    }
  } catch (error) { notify(error.message, true); }
}

function joinedPath(name) { return state.path ? `${state.path}/${name}` : name; }

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

async function loadNetwork() {
  try { const result = await api('/api/network'); $('#network-endpoint').textContent = `http://${result.host}:${result.port}`; const list = $('#interface-list'); list.replaceChildren(); for (const item of result.interfaces) { const row = document.createElement('li'); const name = document.createElement('span'); name.textContent = item.name; const address = document.createElement('span'); address.className = 'ip'; address.textContent = `${item.address} · ${item.family}`; row.append(name, address); list.append(row); } if (!result.interfaces.length) list.textContent = '目前沒有可用的網路介面卡。'; }
  catch (error) { notify(error.message, true); }
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = new FormData(event.currentTarget); const mode = event.currentTarget.dataset.mode; const errorBox = $('#auth-error'); errorBox.hidden = true;
  try { const result = await api(mode === 'setup' ? '/api/setup' : '/api/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }); state.user = result.user; event.currentTarget.reset(); showApp(); }
  catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
});

$('#logout-button').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); state.user = null; state.path = ''; showAuth(false); });
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('#share-select').addEventListener('change', (event) => { state.shareId = event.target.value; state.path = ''; loadFiles(); });
$('#trash-share-select').addEventListener('change', (event) => { state.shareId = event.target.value; $('#share-select').value = state.shareId; loadTrash(); });
$('#new-folder').addEventListener('click', async () => { const name = prompt('請輸入資料夾名稱'); if (!name) return; try { await api('/api/folders', { method: 'POST', body: JSON.stringify({ shareId: state.shareId, path: state.path, name }) }); loadFiles(); } catch (error) { notify(error.message, true); } });
$('#file-input').addEventListener('change', async (event) => { const files = [...event.target.files]; for (const file of files) { const query = new URLSearchParams({ shareId: state.shareId, path: state.path, name: file.name }); try { await api(`/api/upload?${query}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }); } catch (error) { notify(`${file.name}：${error.message}`, true); } } event.target.value = ''; loadFiles(); });
$('#user-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const permissions = state.shares.flatMap((share) => { const read = event.currentTarget.elements[`read-${share.id}`].checked; const write = event.currentTarget.elements[`write-${share.id}`].checked; return read ? [{ shareId: share.id, canRead: read, canWrite: write }] : []; }); const message = $('#user-message'); try { await api('/api/users', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password'), permissions }) }); event.currentTarget.reset(); message.textContent = '使用者已建立。'; message.classList.remove('error'); message.hidden = false; loadUsers(); } catch (error) { message.textContent = error.message; message.classList.add('error'); message.hidden = false; } });

start();
