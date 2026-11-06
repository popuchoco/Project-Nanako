import { fail, json } from './http-utils.mjs';

export function createSmbRouter(ctx) {
  const { smbStatusProbe, collectWindowsExecutionState, listNetworkInterfaces, getPort } = ctx;

  async function handleSmbRoute({ res, method, route, user }) {
    if (route === '/api/network' && method === 'GET') {
      json(res, 200, { host: '127.0.0.1', port: getPort(), localOnly: true, interfaces: listNetworkInterfaces() });
      return true;
    }
    if (route === '/api/smb/status' && method === 'GET') {
      if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以查看 SMB 伺服器狀態。');
      const [smb, execution] = await Promise.all([smbStatusProbe(), collectWindowsExecutionState()]);
      json(res, 200, { ...smb, processElevated: execution.checked ? execution.isElevated : null, nanakoSmbReady: false });
      return true;
    }
    return false;
  }

  return { handleSmbRoute };
}
