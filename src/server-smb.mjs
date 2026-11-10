import { fail, json, readJson } from './http-utils.mjs';

export function createSmbRouter(ctx) {
  const {
    smbStatusProbe,
    collectWindowsExecutionState,
    listNetworkInterfaces,
    getPort,
    externalNetworkProbe,
    getLanStatus,
    setLanAccess,
    getSmbExperimentalEnabled = () => false,
    setSmbExperimentalEnabled = () => {},
  } = ctx;

  function experimentalSmbStatus(smb) {
    const supportedOs = smb.windowsVersion?.supportsExperimentalSmb === true;
    if (!supportedOs && getSmbExperimentalEnabled()) setSmbExperimentalEnabled(false);
    return {
      supportedOs,
      enabled: supportedOs && getSmbExperimentalEnabled(),
      serviceReady: false,
      minimumWindowsVersion: 'Windows 11 24H2',
    };
  }

  async function handleSmbRoute({ req, res, method, route, user, setAuditTarget }) {
    if (route === '/api/network' && method === 'GET') {
      json(res, 200, { host: '127.0.0.1', port: getPort(), localOnly: true, lan: getLanStatus(), interfaces: listNetworkInterfaces() });
      return true;
    }
    if (route === '/api/network/test' && method === 'POST') {
      const interfaces = listNetworkInterfaces();
      const external = await externalNetworkProbe();
      json(res, 200, {
        testedAt: new Date().toISOString(),
        internal: { status: interfaces.length ? 'available' : 'no-interface', host: '127.0.0.1', port: getPort(), localOnly: true, interfaces, lan: getLanStatus() },
        external,
      });
      return true;
    }
    if (route === '/api/network/lan' && method === 'POST') {
      if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以啟用或停用區域網路存取。');
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') throw fail(400, 'invalid_lan_settings', '區域網路啟用狀態不正確。');
      setAuditTarget?.(body.enabled ? `${body.address || ''}:${body.port || ''}` : '停用區域網路存取');
      const status = await setLanAccess(body);
      json(res, 200, { lan: status });
      return true;
    }
    if (route === '/api/smb/status' && method === 'GET') {
      if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以查看 SMB 伺服器狀態。');
      const [smb, execution] = await Promise.all([smbStatusProbe(), collectWindowsExecutionState()]);
      const experimentalSmb = experimentalSmbStatus(smb);
      json(res, 200, { ...smb, experimentalSmb, processElevated: execution.checked ? execution.isElevated : null, nanakoSmbReady: false });
      return true;
    }
    if (route === '/api/smb/experimental' && method === 'POST') {
      if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以變更實驗性 SMB 設定。');
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') throw fail(400, 'invalid_smb_settings', 'SMB 啟用狀態不正確。');
      const smb = await smbStatusProbe();
      const supportedOs = smb.windowsVersion?.supportsExperimentalSmb === true;
      if (!supportedOs) {
        setSmbExperimentalEnabled(false);
        if (body.enabled) throw fail(409, 'smb_os_not_supported', '實驗性 SMB 僅能在 Windows 11 24H2 以上版本啟用。');
      } else {
        setSmbExperimentalEnabled(body.enabled);
      }
      setAuditTarget?.(body.enabled ? '啟用實驗性 SMB' : '停用實驗性 SMB');
      json(res, 200, { experimentalSmb: experimentalSmbStatus(smb) });
      return true;
    }
    return false;
  }

  return { handleSmbRoute };
}
