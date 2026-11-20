/** Original, dependency-free management UI. Credentials live only in page memory. */
export function dashboardHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Jimmy Remote Commander</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1422;color:#eaf2fa;font-size:15px;line-height:1.5;--muted:#a7b8cc;--line:#2a3b50;--panel:#111f30;--teal:#79e5d0;--danger:#ffb5b5}
    *{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{cursor:pointer;border:1px solid var(--line);border-radius:9px;background:#1b3046;color:#edf5fc;padding:10px 15px;font-weight:600}button:hover:not(:disabled){background:#26425d}button:disabled{cursor:wait;opacity:.55}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid var(--teal);outline-offset:3px}.primary{background:var(--teal);border-color:var(--teal);color:#072b28}.primary:hover:not(:disabled){background:#a0f0e1}.quiet{background:transparent}.danger{color:var(--danger);border-color:#704044}.danger:hover:not(:disabled){background:#412735}[hidden]{display:none!important}
    .shell{max-width:1440px;min-height:100vh;margin:auto;display:grid;grid-template-columns:240px 1fr}.rail{padding:34px 24px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:38px;background:#0d1929}.brand{display:flex;gap:12px;align-items:center;font-weight:700;line-height:1.25;letter-spacing:-.02em}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#173d43;color:var(--teal);flex-shrink:0}.mark svg{width:25px;height:25px}.brand small{display:block;color:var(--muted);font-weight:400;font-size:12px;letter-spacing:.06em;margin-top:5px}.rail-label,.eyebrow{font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--teal)}.nav-item{margin-top:12px;border:1px solid #31525c;background:#17303d;border-radius:10px;padding:12px 14px;font-weight:600}.rail-note{margin-top:auto;font-size:12px;color:var(--muted);line-height:1.7}.rail-note strong{display:block;color:#d0dfed;margin-bottom:6px;font-size:13px}
    main{padding:38px 40px 28px;min-width:0}.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:30px}h1{margin:6px 0 8px;font-size:clamp(27px,3vw,36px);line-height:1.2;letter-spacing:-.04em}h2{margin:0;font-size:19px;letter-spacing:-.02em}h3{font-size:15px;margin:0}.subtitle,.muted{color:var(--muted)}.subtitle{margin:0;max-width:620px}.connection{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:30px;padding:7px 12px}.dot{width:7px;height:7px;background:#899caf;border-radius:50%}.connection.connected .dot{background:var(--teal)}.session{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:5px}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:16px;overflow:hidden}.panel-head{padding:22px 24px;display:flex;justify-content:space-between;align-items:center;gap:18px;border-bottom:1px solid var(--line)}.panel-head p{font-size:13px;margin:5px 0 0;color:var(--muted)}.panel-body{padding:24px}.login{max-width:600px;margin:68px auto 32px}.login .panel-body{padding:30px}.login h2{font-size:25px;margin:10px 0}.login p{color:var(--muted)}label{display:block;margin:24px 0 8px;font-weight:600;font-size:13px}input{width:100%;background:#0b1624;color:#edf5fc;border:1px solid #445a72;border-radius:8px;padding:12px}input::placeholder{color:#8498ae}.login-actions{margin-top:20px;display:flex;align-items:center;gap:16px}.help{font-size:12px;color:var(--muted);margin:12px 0 0}.message{border:1px solid #704044;background:#34232f;color:#ffd5d5;border-radius:10px;padding:13px 16px;margin:0 0 20px;overflow-wrap:anywhere}.message.info{background:#12343c;border-color:#356268;color:#c0f5eb}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    .overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:24px}.stat{padding:19px 22px}.stat-label{font-size:12px;color:var(--muted)}.stat-value{display:block;margin-top:6px;font-size:30px;line-height:1.2;font-weight:650;letter-spacing:-.04em}.stat-value.accent{color:var(--teal)}.workspace{display:grid;gap:24px}.actions{display:flex;gap:8px;flex-wrap:wrap}.device-list{padding:0 24px}.device{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:16px;align-items:center;padding:20px 0}.device+.device{border-top:1px solid var(--line)}.device-icon{width:40px;height:40px;display:grid;place-items:center;border-radius:10px;border:1px solid var(--line);background:#172a40;font-size:11px;font-weight:700;color:#bad1e8}.device-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.device-name{font-weight:650;overflow-wrap:anywhere}.device-meta{font-size:12px;color:var(--muted);margin-top:5px;overflow-wrap:anywhere}.badge{display:inline-flex;align-items:center;gap:5px;border:1px solid #3d4f63;border-radius:30px;padding:2px 8px;font-size:11px;white-space:nowrap;color:#bfd0e1}.badge.online,.badge.completed{color:#a7f0df;border-color:#32675e;background:#143b38}.badge.revoked,.badge.failed{color:#ffc0c0;border-color:#734c55;background:#3b2632}.badge.unknown{color:#ffe0a4;border-color:#746447;background:#3a3224}.badge.running,.badge.queued{color:#b4d9ff;border-color:#41668b;background:#19334f}.empty{padding:36px 24px;text-align:center;color:var(--muted);font-size:13px}.empty strong{display:block;color:#dbe8f4;font-size:15px;margin-bottom:6px}.pairing{border:1px solid #396761;background:#12312f;border-radius:12px;padding:20px 22px;margin-bottom:24px}.pairing-top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.pairing p{font-size:13px;color:#c1ded9;margin:8px 0}.pairing-code{display:block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:clamp(17px,2.6vw,25px);letter-spacing:.03em;color:#d6fff5;overflow-wrap:anywhere;padding:14px 0}.pairing .expiry{font-size:12px;color:#a5d6cb}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600;padding:12px 24px;background:#102033}td{padding:15px 24px;border-top:1px solid var(--line);vertical-align:top}td.tool{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.time{white-space:nowrap;color:var(--muted)}.activity-device{max-width:220px;overflow-wrap:anywhere}.footnote{color:var(--muted);font-size:12px;margin:18px 1px 0;display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap}
    dialog{background:#142337;color:#eaf2fa;border:1px solid #47617c;border-radius:16px;padding:26px;max-width:440px;width:calc(100% - 32px);box-shadow:0 24px 90px #0008}dialog::backdrop{background:#050b16b8}dialog p{color:var(--muted);overflow-wrap:anywhere}.dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}
    @media(max-width:1050px){.shell{grid-template-columns:195px 1fr}.rail{padding:28px 20px}main{padding:30px 24px}.topbar{flex-direction:column;gap:12px}.session{padding:0}}@media(max-width:700px){.shell{display:block}.rail{padding:18px 20px;border-right:0;border-bottom:1px solid var(--line)}.rail nav,.rail-note{display:none}.brand small{display:inline;margin-left:8px}.brand br{display:none}main{padding:26px 16px}.login{margin-top:28px}.login .panel-body{padding:24px}.overview{gap:8px}.stat{padding:15px 13px}.stat-label{font-size:11px}.stat-value{font-size:25px}.panel-head{padding:19px 18px;align-items:flex-start;flex-wrap:wrap}.device-list{padding:0 18px}.device{grid-template-columns:32px minmax(0,1fr);gap:12px}.device-icon{width:32px;height:34px}.device>button{grid-column:2;justify-self:start;padding:7px 12px}.pairing{padding:18px}.pairing-top{gap:12px}th,td{padding-left:18px;padding-right:18px}.session{width:100%;justify-content:space-between}}
    @media(prefers-reduced-motion:no-preference){button{transition:background .15s,border-color .15s}}
  </style>
</head>
<body>
  <div class="shell">
    <aside class="rail" aria-label="Application">
      <div class="brand"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 9l3 2-3 2M13 13h4"/></svg></span><span>Jimmy Remote<br>Commander<small>PRIVATE CONTROL</small></span></div>
      <nav aria-label="Main navigation"><div class="rail-label">Workspace</div><div class="nav-item" aria-current="page">Device overview</div></nav>
      <div class="rail-note"><strong>Your machines. Your service.</strong>Manage enrolled computers and see the status of recent operations.</div>
    </aside>
    <main>
      <header class="topbar"><div><div class="eyebrow">Control center</div><h1>Your connected computers</h1><p class="subtitle">One place to manage access and keep track of remote work.</p></div><div class="session"><span id="connection" class="connection"><span class="dot" aria-hidden="true"></span><span id="connection-label">Signed out</span></span><button id="logout" class="quiet" hidden>Sign out</button></div></header>
      <div id="message" class="message" role="alert" hidden></div><div id="announcer" class="sr-only" role="status" aria-live="polite"></div>
      <section id="login-panel" class="panel login" aria-labelledby="login-title"><div class="panel-body"><div class="eyebrow">Owner access</div><h2 id="login-title">Open your workspace</h2><p>Enter the owner token created when you initialized this server.</p><form id="login-form"><label for="token">Owner token</label><input id="token" name="owner-token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required placeholder="Enter your owner token"><p class="help">Kept only in this page's memory. Refreshing or signing out clears it.</p><div class="login-actions"><button id="login-button" class="primary" type="submit">Connect</button><span id="login-status" class="muted" role="status"></span></div></form></div></section>
      <div id="workspace" hidden>
        <section class="overview" aria-label="Device totals"><div class="panel stat"><span class="stat-label">Enrolled devices</span><strong id="total-count" class="stat-value">0</strong></div><div class="panel stat"><span class="stat-label">Online now</span><strong id="online-count" class="stat-value accent">0</strong></div><div class="panel stat"><span class="stat-label">Offline</span><strong id="offline-count" class="stat-value">0</strong></div></section>
        <section id="pairing" class="pairing" aria-labelledby="pairing-title" hidden><div class="pairing-top"><div><h2 id="pairing-title">Connect a new computer</h2><p>Save this one-use code in a private pairing file on the computer you want to add.</p></div><button id="hide-pairing" class="quiet">Hide code</button></div><code id="pairing-code" class="pairing-code"></code><p>Run the enrollment command with that file, then start the agent. Keep the agent running while you use the computer remotely.</p><p class="expiry" id="pairing-expiry"></p></section>
        <div class="workspace">
          <section class="panel" aria-labelledby="devices-title"><div class="panel-head"><div><h2 id="devices-title">Devices</h2><p>Each computer connects through its own enrolled agent.</p></div><div class="actions"><button id="refresh" class="quiet">Refresh</button><button id="add-device" class="primary">Add device</button></div></div><div id="device-list" class="device-list"></div><div id="devices-empty" class="empty" hidden><strong>No computers enrolled yet</strong>Add a device to create its one-use pairing code.</div></section>
          <section class="panel" aria-labelledby="activity-title"><div class="panel-head"><div><h2 id="activity-title">Recent activity</h2><p>Tool names and outcomes, without command arguments or file contents.</p></div></div><div class="table-wrap"><table id="activity-table"><caption class="sr-only">Recent remote operations</caption><thead><tr><th scope="col">Operation</th><th scope="col">Computer</th><th scope="col">Outcome</th><th scope="col">Started</th><th scope="col">Duration</th></tr></thead><tbody id="activity-list"></tbody></table></div><div id="activity-empty" class="empty" hidden><strong>No activity yet</strong>Operations appear here when an MCP client uses a connected computer.</div></section>
        </div>
        <footer class="footnote"><span id="updated">Waiting for the first update.</span><span>Automatically refreshes every 10 seconds.</span></footer>
      </div>
    </main>
  </div>
  <dialog id="revoke-dialog" aria-labelledby="revoke-title" aria-describedby="revoke-description"><h2 id="revoke-title">Revoke this computer?</h2><p id="revoke-description"></p><p>Its agent will disconnect and these credentials will stop working. You can enroll the computer again with a new pairing code.</p><div class="dialog-actions"><button id="cancel-revoke" class="quiet">Cancel</button><button id="confirm-revoke" class="danger">Revoke access</button></div></dialog>
  <script>
    (() => {
      'use strict';
      const $ = (id) => document.getElementById(id);
      let ownerToken = '';
      let session = 0;
      let busy = false;
      let devices = [];
      let pairingExpiresAt = 0;
      let revokeTarget = null;
      const requests = new Set();
      const statuses = new Set(['online', 'offline', 'revoked', 'queued', 'running', 'completed', 'failed', 'unknown']);
      function announce(text) { $('announcer').textContent = text; }
      function showMessage(text, kind = 'error') {
        $('message').textContent = text;
        $('message').classList.toggle('info', kind === 'info');
        $('message').hidden = !text;
      }
      function setBusy(value) {
        busy = value;
        for (const id of ['refresh', 'add-device', 'login-button']) $(id).disabled = value;
        for (const button of $('device-list').querySelectorAll('button')) button.disabled = value;
        $('workspace').setAttribute('aria-busy', String(value));
      }
      function clearPairing() {
        pairingExpiresAt = 0;
        $('pairing-code').textContent = '';
        $('pairing-expiry').textContent = '';
        $('pairing').hidden = true;
      }
      function signOut(message = '') {
        session += 1;
        ownerToken = '';
        for (const controller of requests) controller.abort();
        requests.clear();
        devices = [];
        revokeTarget = null;
        $('revoke-dialog').close();
        clearPairing();
        $('token').value = '';
        $('device-list').replaceChildren();
        $('activity-list').replaceChildren();
        $('workspace').hidden = true;
        $('login-panel').hidden = false;
        $('logout').hidden = true;
        $('connection').classList.remove('connected');
        $('connection-label').textContent = 'Signed out';
        $('login-status').textContent = '';
        setBusy(false);
        showMessage(message);
        $('token').focus();
      }
      async function api(path, method = 'GET') {
        const controller = new AbortController();
        requests.add(controller);
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(path, {
            method,
            headers: { Authorization: 'Bearer ' + ownerToken, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
            body: method === 'POST' ? '{}' : undefined,
            credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal
          });
          if (!response.ok) {
            const error = new Error(response.status === 401 || response.status === 403 ? 'Access denied. Check the owner token and server address.' : response.status === 429 ? 'Too many requests. Wait a moment, then try again.' : 'The request failed (HTTP ' + response.status + '). Try refreshing.');
            error.status = response.status;
            throw error;
          }
          return await response.json();
        } catch (error) {
          if (error.name === 'AbortError') throw new Error('The server did not respond in time. Try again.');
          if (error instanceof TypeError) throw new Error('Cannot reach the server. Check the connection and try again.');
          throw error;
        } finally {
          clearTimeout(timeout);
          requests.delete(controller);
        }
      }
      function badge(status) {
        const el = document.createElement('span');
        el.className = 'badge ' + (statuses.has(status) ? status : '');
        el.textContent = status;
        return el;
      }
      function formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      }
      function renderDevices(items) {
        devices = items;
        const active = items.filter((device) => !device.revokedAt);
        const online = active.filter((device) => device.online).length;
        $('total-count').textContent = String(active.length);
        $('online-count').textContent = String(online);
        $('offline-count').textContent = String(active.length - online);
        $('devices-empty').hidden = items.length !== 0;
        const rows = items.map((device) => {
          const row = document.createElement('div'); row.className = 'device';
          const icon = document.createElement('span'); icon.className = 'device-icon'; icon.setAttribute('aria-hidden', 'true');
          icon.textContent = device.platform === 'darwin' ? 'MAC' : device.platform === 'win32' ? 'WIN' : device.platform === 'linux' ? 'LIN' : 'PC';
          const details = document.createElement('div');
          const heading = document.createElement('div'); heading.className = 'device-heading';
          const name = document.createElement('span'); name.className = 'device-name'; name.textContent = device.name;
          heading.append(name, badge(device.revokedAt ? 'revoked' : device.online ? 'online' : 'offline'));
          const meta = document.createElement('div'); meta.className = 'device-meta'; meta.textContent = device.platform + ' · ' + device.id;
          details.append(heading, meta); row.append(icon, details);
          if (!device.revokedAt) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet danger'; button.textContent = 'Revoke'; button.disabled = busy;
            button.setAttribute('aria-label', 'Revoke access for ' + device.name);
            button.addEventListener('click', () => {
              revokeTarget = { id: device.id, name: device.name };
              $('revoke-description').textContent = 'Access to ' + device.name + ' will be removed.';
              $('revoke-dialog').showModal(); $('cancel-revoke').focus();
            });
            row.append(button);
          }
          return row;
        });
        $('device-list').replaceChildren(...rows);
      }
      function renderActivity(items) {
        const names = new Map(devices.map((device) => [device.id, device.name]));
        $('activity-empty').hidden = items.length !== 0;
        $('activity-table').hidden = items.length === 0;
        const rows = items.map((item) => {
          const row = document.createElement('tr');
          const tool = document.createElement('td'); tool.className = 'tool'; tool.textContent = item.tool;
          const device = document.createElement('td'); device.className = 'activity-device'; device.textContent = names.get(item.deviceId) || item.deviceId;
          const status = document.createElement('td'); status.append(badge(item.status));
          const started = document.createElement('td'); started.className = 'time'; started.textContent = formatDate(item.startedAt);
          const duration = document.createElement('td'); duration.className = 'time'; duration.textContent = typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) ? (item.durationMs < 1000 ? Math.round(item.durationMs) + ' ms' : (item.durationMs / 1000).toFixed(1) + ' s') : '—';
          row.append(tool, device, status, started, duration);
          return row;
        });
        $('activity-list').replaceChildren(...rows);
      }
      async function refresh() {
        if (!ownerToken || busy) return;
        const current = session;
        setBusy(true);
        try {
          const [deviceResponse, activityResponse] = await Promise.all([api('/api/devices'), api('/api/activity')]);
          if (session !== current) return;
          if (!Array.isArray(deviceResponse.devices) || !Array.isArray(activityResponse.activity)) throw new Error('The server returned an unexpected response.');
          renderDevices(deviceResponse.devices);
          renderActivity(activityResponse.activity);
          $('login-panel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
          $('connection').classList.add('connected'); $('connection-label').textContent = 'Connected';
          $('login-status').textContent = '';
          $('updated').textContent = 'Last updated ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
          showMessage('');
        } catch (error) {
          if (session !== current) return;
          if (error.status === 401 || error.status === 403) { signOut(error.message); return; }
          $('connection').classList.remove('connected'); $('connection-label').textContent = 'Connection unavailable';
          $('login-status').textContent = '';
          showMessage(error.message);
        } finally {
          if (session === current) setBusy(false);
        }
      }
      $('login-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy) return;
        ownerToken = $('token').value.trim(); $('token').value = '';
        if (!ownerToken) { showMessage('Enter your owner token.'); return; }
        session += 1;
        $('login-status').textContent = 'Connecting…';
        await refresh();
      });
      $('logout').addEventListener('click', () => { signOut(); announce('Signed out. The token has been cleared.'); });
      $('refresh').addEventListener('click', () => { void refresh(); });
      $('hide-pairing').addEventListener('click', () => { clearPairing(); announce('Pairing code hidden. It remains valid until it is used or expires.'); });
      $('add-device').addEventListener('click', async () => {
        if (busy) return;
        const current = session; setBusy(true); showMessage(''); clearPairing();
        try {
          const result = await api('/api/pairings', 'POST');
          if (session !== current) return;
          const expiry = new Date(result.expiresAt).getTime();
          if (typeof result.code !== 'string' || !Number.isFinite(expiry)) throw new Error('The server returned an invalid pairing code.');
          pairingExpiresAt = expiry;
          $('pairing-code').textContent = result.code;
          $('pairing').hidden = false;
          updatePairingExpiry();
          announce('Pairing code created. Save it before closing this page.');
          $('hide-pairing').focus();
        } catch (error) {
          if (session === current) showMessage(error.message);
        } finally { if (session === current) setBusy(false); }
      });
      $('cancel-revoke').addEventListener('click', () => { revokeTarget = null; $('revoke-dialog').close(); });
      $('revoke-dialog').addEventListener('cancel', () => { revokeTarget = null; });
      $('confirm-revoke').addEventListener('click', async () => {
        if (!revokeTarget || busy) return;
        const target = revokeTarget; revokeTarget = null; $('revoke-dialog').close();
        const current = session; setBusy(true); showMessage('');
        try {
          await api('/api/devices/' + encodeURIComponent(target.id) + '/revoke', 'POST');
          if (session !== current) return;
          announce('Access revoked for ' + target.name + '.');
          setBusy(false);
          await refresh();
        } catch (error) {
          if (session === current) showMessage(error.message);
        } finally { if (session === current) setBusy(false); }
      });
      function updatePairingExpiry() {
        if (!pairingExpiresAt) return;
        const remaining = Math.ceil((pairingExpiresAt - Date.now()) / 1000);
        if (remaining <= 0) { clearPairing(); announce('The pairing code has expired. Create another code to add a computer.'); return; }
        $('pairing-expiry').textContent = 'Expires in ' + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0') + '. Closing or hiding this card will not revoke the code.';
      }
      setInterval(() => { if (ownerToken && !document.hidden) void refresh(); }, 10000);
      setInterval(updatePairingExpiry, 1000);
      window.addEventListener('pagehide', () => signOut());
    })();
  </script>
</body>
</html>`;
}
