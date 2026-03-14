function $(id) {
  return document.getElementById(id);
}

function getAvatarUrl(name) {
  return "https://mc-heads.net/avatar/" + encodeURIComponent(name) + "/128";
}

function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

// Bandera para bloquear el refresco y evitar que el botón "vuelva atrás"
let isUIBlocked = false;
let blockTimeout = null;

async function getPlayerData(id) {
  try {
    const res = await fetch('/api/server/status');
    const data = await res.json();
    return data.players.find(p => String(p.id) === String(id)) || null;
  } catch(e) { return null; }
}

async function sendPlayerCommand(playerName, cmd, switchEl = null, targetState = null) {
    if (switchEl && targetState !== null) switchEl.checked = targetState;
    isUIBlocked = true;
    if (blockTimeout) clearTimeout(blockTimeout);
    try {
        const res = await fetch('/api/server/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.error || 'Error al enviar el comando');
            if (switchEl) switchEl.checked = !targetState;
        }
        blockTimeout = setTimeout(() => { isUIBlocked = false; initPlayerProfile(true); }, 3000);
    } catch(e) {
        console.error(e);
        if (switchEl) switchEl.checked = !targetState;
        isUIBlocked = false;
    }
}

async function sendBanIp(playerName, playerIp, switchEl = null, targetState = null) {
    if (switchEl && targetState !== null) switchEl.checked = targetState;
    isUIBlocked = true;
    if (blockTimeout) clearTimeout(blockTimeout);
    try {
        const res = await fetch('/api/server/ban-ip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: playerName, ip: playerIp || undefined })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.error || 'No se pudo banear por IP');
            if (switchEl) switchEl.checked = false;
        }
        blockTimeout = setTimeout(() => { isUIBlocked = false; initPlayerProfile(true); }, 3000);
    } catch(e) {
        console.error(e);
        if (switchEl) switchEl.checked = false;
        isUIBlocked = false;
    }
}

async function sendPardonIp(playerName, switchEl = null, targetState = null) {
    if (switchEl && targetState !== null) switchEl.checked = targetState;
    isUIBlocked = true;
    if (blockTimeout) clearTimeout(blockTimeout);
    try {
        const res = await fetch('/api/server/pardon-ip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: playerName })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.error || 'No se pudo desbanear la IP');
            if (switchEl) switchEl.checked = true;
        }
        blockTimeout = setTimeout(() => { isUIBlocked = false; initPlayerProfile(true); }, 3000);
    } catch(e) {
        console.error(e);
        if (switchEl) switchEl.checked = true;
        isUIBlocked = false;
    }
}

function renderSwitch(checked, onchange) {
  return `<label class='switch'><input type='checkbox' ${checked ? "checked" : ""} onchange="${onchange}"><span class='slider'></span></label>`;
}

async function initPlayerProfile(force = false) {
  if (isUIBlocked && !force) return;

  const id = getQueryParam("id");
  const player = await getPlayerData(id);
  const container = $("playerProfile");
  
  if (!container) return;
  if (!player) {
    container.innerHTML = "<div class='card'><h3>Jugador no encontrado</h3></div>";
    return;
  }

  // Bind de eventos con inyección de el (elemento) para control inmediato
  window.handleOpChange = (el) => sendPlayerCommand(player.name, el.checked ? `op ${player.name}` : `deop ${player.name}`, el, el.checked);
  window.handleWhitelistChange = (el) => sendPlayerCommand(player.name, el.checked ? `whitelist add ${player.name}` : `whitelist remove ${player.name}`, el, el.checked);
  window.handleBanIp = (el) => {
    if (el.checked) {
      sendBanIp(player.name, player.ip, el, true);
    } else {
      sendPardonIp(player.name, el, false);
    }
  };
  window.handleBanUuid = (el) => sendPlayerCommand(player.name, el.checked ? `ban ${player.name}` : `pardon ${player.name}`, el, el.checked);
  
  window.handleGamemode = (val) => sendPlayerCommand(player.name, `gamemode ${val.toLowerCase()} ${player.name}`);
  window.tpToSpawn = (x, y, z) => sendPlayerCommand(player.name, `tp ${player.name} ${x} ${y} ${z}`);
  window.tpToPlayer = (targetName) => { if (targetName) sendPlayerCommand(player.name, `tp ${player.name} ${targetName}`); };
  window.playerKick = () => sendPlayerCommand(player.name, `kick ${player.name} Expulsado`);
  window.playerKill = () => sendPlayerCommand(player.name, `kill ${player.name}`);

  const isBanned = (player.bannedUuid || player.bannedIp);
  let currentLocation = player.location || { x: 0, y: 0, z: 0 };
  let spawn = { x: 0, y: 0, z: 0 };
  let lastDeath = null;
  let hasSpawn = false;
  let otherPlayers = [];
  try {
    const locRes = await fetch('/api/server/player/' + encodeURIComponent(player.name) + '/location').then(r => r.json()).catch(() => ({}));
    currentLocation = locRes.location || currentLocation;
    spawn = locRes.spawn || spawn;
    lastDeath = locRes.lastDeath || null;
    hasSpawn = spawn && (spawn.x !== 0 || spawn.y !== 0 || spawn.z !== 0);
    const statusRes = await fetch('/api/server/status').then(r => r.json()).catch(() => ({}));
    const playersList = statusRes.players || [];
    otherPlayers = playersList.filter(p => p.name && p.name.toLowerCase() !== player.name.toLowerCase());
  } catch (e) {}

  container.innerHTML = `
    <div class='player-page-layout'>
      <div class='card player-hero-card'>
        <div class='player-hero-left'>
          <img class='player-hero-avatar' src='${getAvatarUrl(player.name)}' alt='avatar' style="filter: ${player.online ? 'none' : 'grayscale(100%)'}">
        </div>
        <div class='player-hero-right'>
            <h3 class='player-hero-name'>
                ${player.name}
                <span class='player-online-dot hero-status-dot ${player.online ? "dot-online" : "dot-offline"}'></span>
                ${player.bannedIp ? "<span class='mini-status ban-ip' style='margin-left:8px'>Ban IP</span>" : ""}
                ${player.bannedUuid ? "<span class='mini-status ban-uuid' style='margin-left:6px'>Ban UUID</span>" : ""}
            </h3>
            <p class='muted-text'>UUID: ${player.uuid || '...'}</p>
        </div>
      </div>

      <div class='player-main-grid'>
        <div class='card'>
          <h3>Configuración</h3>
          <div class='info-list'>
            <div class='info-row switch-row'>
              <span>Operador</span>
              ${renderSwitch(player.op, "handleOpChange(this)")}
            </div>
            <div class='info-row switch-row'>
              <span>Whitelist</span>
              ${renderSwitch(player.whitelisted, "handleWhitelistChange(this)")}
            </div>
            <div class='player-ban-section'>
              <h4 class='player-ban-section-title'>Baneos</h4>
              <div class='info-list'>
                <div class='info-row switch-row switch-row--danger'>
                  <span>Banear IP</span>
                  ${renderSwitch(player.bannedIp, "handleBanIp(this)")}
                </div>
                <div class='info-row switch-row switch-row--danger'>
                  <span>Banear UUID</span>
                  ${renderSwitch(player.bannedUuid, "handleBanUuid(this)")}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class='card'>
          <h3>Acciones Rápidas</h3>
          
          <!-- Nueva Ubicación Premium -->
          <div class="location-hero">
            <div class="location-item">
              <span class="location-label">Ubicación Actual</span>
              <span class="location-value">${currentLocation.x}, ${currentLocation.y}, ${currentLocation.z}</span>
            </div>
            <span class="location-dim">${player.dimension || 'Overworld'}</span>
          </div>

          <div class="quick-actions-list">
            <div class="quick-action-row">
              <span class="quick-action-label">Spawn</span>
              <span class="quick-action-coords">${hasSpawn ? `${spawn.x} ${spawn.y} ${spawn.z}` : '—'}</span>
              <button class='btn primary btn-sm' ${!hasSpawn ? 'disabled' : ''} onclick="tpToSpawn(${spawn.x},${spawn.y},${spawn.z})">TP</button>
            </div>
            <div class="quick-action-row">
              <span class="quick-action-label">Última muerte</span>
              <span class="quick-action-coords">${lastDeath ? `${lastDeath.x} ${lastDeath.y} ${lastDeath.z}` : '—'}</span>
              <button class='btn primary btn-sm' ${!lastDeath ? 'disabled' : ''} onclick="tpToSpawn(${lastDeath ? lastDeath.x : 0},${lastDeath ? lastDeath.y : 0},${lastDeath ? lastDeath.z : 0})">TP</button>
            </div>
            <div class="quick-action-row">
              <span class="quick-action-label">TP a jugador</span>
              <select id="tpTargetSelect" class="tp-select">
                <option value="">— Elige jugador —</option>
                ${otherPlayers.map(p => `<option value="${p.name}">${p.name}</option>`).join('')}
              </select>
              <button class='btn primary btn-sm' onclick="tpToPlayer(document.getElementById('tpTargetSelect').value)">TP</button>
            </div>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px">
            <button class='btn warning' onclick="playerKick()">KICK</button>
            <button class='btn danger' onclick="playerKill()">KILL</button>
          </div>
        </div>
      </div>
    </div>`;
}

document.addEventListener("DOMContentLoaded", () => initPlayerProfile());
setInterval(() => initPlayerProfile(), 3000);