function $(id) {
  return document.getElementById(id);
}

function getAvatarUrl(name) {
  return "https://mc-heads.net/avatar/" + encodeURIComponent(name) + "/96";
}

function renderBadge(text, type) {
  return "<span class='mini-status " + type + "'>" + text + "</span>";
}

let activeFilter = 'all';
let allCachedPlayers = [];

async function fetchAndRenderPlayers() {
  const grid = $("playersGrid");
  if (!grid) return;

  try {
    const res = await fetch('/api/server/status');
    const data = await res.json();
    allCachedPlayers = data.players || [];
    applyFilterAndRender();
  } catch (e) { console.error("Error:", e); }
}

function applyFilterAndRender() {
  const grid = $("playersGrid");
  if (!grid) return;

  let filtered = allCachedPlayers;
  if (activeFilter === 'whitelist') filtered = allCachedPlayers.filter(p => p.whitelisted);
  if (activeFilter === 'ban-ip') filtered = allCachedPlayers.filter(p => p.bannedIp);
  if (activeFilter === 'ban-uuid') filtered = allCachedPlayers.filter(p => p.bannedUuid);

  grid.innerHTML = "";
  if (filtered.length === 0) {
    grid.innerHTML = `<div class='empty-state-card'><h3>No se encontraron jugadores</h3></div>`;
    return;
  }

  filtered.forEach(player => {
    const card = document.createElement("a");
    card.href = "player.html?id=" + player.id;
    const isBanned = (player.bannedUuid || player.bannedIp);
    card.className = "player-card compact" + (player.op ? " player-op" : "") + (player.online ? "" : " player-offline") + (isBanned ? " player-banned-card" : "");

    card.innerHTML = `
      <div class="player-card-top compact">
        <img class="player-avatar-card" src="${getAvatarUrl(player.name)}" alt="skin" style="filter: ${player.online ? 'none' : 'grayscale(100%)'}">
        <div class="player-card-head-text">
          <div class="player-name-row">
            <h3 class="player-card-name">${player.name}</h3>
            <span class="player-online-dot ${player.online ? 'dot-online' : 'dot-offline'}"></span>
          </div>
          <div class="player-card-badges">
            ${player.op ? renderBadge("OP", "op-badge") : ""}
            ${player.whitelisted ? renderBadge("Whitelist", "whitelist-badge") : ""}
            ${player.bannedIp ? renderBadge("Ban IP", "ban-ip") : ""}
            ${player.bannedUuid ? renderBadge("Ban UUID", "ban-uuid") : ""}
          </div>
        </div>
      </div>
      <div class="player-card-info compact">
        <div class="player-card-row compact">
          <span>Coordenadas</span>
          ${(() => {
            const loc = (player.location && (player.location.x !== 0 || player.location.z !== 0)) ? player.location : (player.spawn && (player.spawn.x !== 0 || player.spawn.z !== 0) ? player.spawn : {x:0, y:64, z:0});
            return renderBadge(`${Math.floor(loc.x)} ${Math.floor(loc.y)} ${Math.floor(loc.z)}`, "coords");
          })()}
        </div>
        <div class="player-card-row compact" style="margin-top: 4px;">
          <span>Dimensión</span>
          <span style="font-size: 13px; color: var(--text-dim);">${player.dimension || 'Overworld'}</span>
        </div>
      </div>`;
    grid.appendChild(card);
  });
}

function setupFilters() {
    const buttons = {
        'showAllPlayersBtn': 'all',
        'showWhitelistBtn': 'whitelist',
        'showBanIpBtn': 'ban-ip',
        'showBanUuidBtn': 'ban-uuid'
    };

    Object.keys(buttons).forEach(id => {
        const btn = $(id);
        if (!btn) return;
        btn.onclick = () => {
            Object.keys(buttons).forEach(bid => {
                const b = $(bid);
                if (b) b.classList.remove('filter-active');
            });
            btn.classList.add('filter-active');
            activeFilter = buttons[id];
            applyFilterAndRender();
        };
    });
}

document.addEventListener("DOMContentLoaded", function () {
  setupFilters();
  fetchAndRenderPlayers();
  setInterval(fetchAndRenderPlayers, 2000); // Refresco rápido
});