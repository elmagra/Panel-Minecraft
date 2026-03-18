function $(id) {
  return document.getElementById(id);
}

function formatUptime(ms) {
    if (!ms || ms < 0) return "00:00:00";
    let totalSeconds = Math.floor(ms / 1000);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    return (
        String(hours).padStart(2, "0") + ":" +
        String(minutes).padStart(2, "0") + ":" +
        String(seconds).padStart(2, "0")
    );
}

async function sendCommandToBackend(command) {
    try {
        await fetch('/api/server/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command })
        });
    } catch (e) { console.error("Error enviando comando:", e); }
}

async function initDashboard() {
    const bindClick = (id, url) => {
        const btn = $(id);
        if (btn) {
            btn.addEventListener("click", async () => {
                btn.disabled = true;
                const oldText = btn.innerHTML;
                btn.innerHTML = '<span>⏳</span>...';
                try {
                    await fetch(url, { method: 'POST' });
                } catch(e) {}
                setTimeout(() => {
                    btn.disabled = false;
                    btn.innerHTML = oldText;
                }, 2000);
            });
        }
    };

    bindClick("startBtn", "/api/server/start");
    bindClick("stopBtn", "/api/server/stop");
    bindClick("restartBtn", "/api/server/restart");

    setInterval(updateStatus, 1500);
}

let lastLogCount = 0;
async function updateStatus() {
    try {
        const res = await fetch('/api/server/status');
        if (!res.ok) return;
        const data = await res.json();

        // UI Status
        const statusText = $("serverStatusText");
        const dot = $("statusDot");
        
        if (data.status === 'online') {
            if (statusText) statusText.textContent = "En línea";
            if (dot) dot.style.background = "#22c55e";
            if ($("startBtn")) $("startBtn").style.display = "none";
            if ($("stopBtn")) $("stopBtn").style.display = "inline-block";
            if ($("restartBtn")) $("restartBtn").style.display = "inline-block";
        } else if (data.status === 'starting') {
            if (statusText) statusText.textContent = "Iniciando...";
            if (dot) dot.style.background = "#eab308";
            if ($("startBtn")) $("startBtn").style.display = "none";
            if ($("stopBtn")) $("stopBtn").style.display = "none";
            if ($("restartBtn")) $("restartBtn").style.display = "none";
        } else {
            if (statusText) statusText.textContent = "Apagado";
            if (dot) dot.style.background = "#ef4444";
            if ($("startBtn")) $("startBtn").style.display = "inline-block";
            if ($("stopBtn")) $("stopBtn").style.display = "none";
            if ($("restartBtn")) $("restartBtn").style.display = "none";
        }

        // Stats & Version
        if ($("serverVersion")) {
            const ver = data.version && data.version !== '...' ? data.version : '';
            const soft = data.software && data.software !== 'Detectando...' ? data.software : (ver ? 'Vanilla' : '...');
            $("serverVersion").textContent = ver ? `${soft} ${ver}` : soft;
        }

        if ($("worldSize")) $("worldSize").textContent = data.worldSize || '0 MB';

        if ($("cpuUsage")) {
            $("cpuUsage").textContent = (data.cpu || 0) + "%";
            $("cpuBar").style.width = (data.cpu || 0) + "%";
        }
        if ($("ramUsage")) {
            $("ramUsage").textContent = (data.ramUsedGB || 0) + " GB / " + (data.ramTotalGB || 0) + " GB";
            $("ramBar").style.width = (data.ram || 0) + "%";
        }
        if ($("playerCount")) {
            const onlineCount = data.players ? data.players.filter(p => p.online).length : 0;
            const maxP = data.maxPlayers || 20;
            $("playerCount").textContent = onlineCount + " / " + maxP;
        }
        
        // Cronómetro Local Frontend
        if (data.status === 'online' || data.status === 'starting') {
            if (!window.localUptimeStart) {
                window.localUptimeStart = Date.now();
                // Si el servidor ya estaba online hace tiempo, intentamos estimar desde el backend una vez
                if (data.uptimeMs && data.uptimeMs > 5000) {
                    window.localUptimeStart = Date.now() - data.uptimeMs;
                }
            }
            if ($("uptime")) {
                const elapsed = Date.now() - window.localUptimeStart;
                $("uptime").textContent = formatUptime(elapsed);
            }
        } else {
            window.localUptimeStart = null;
            if ($("uptime")) $("uptime").textContent = "00:00:00";
        }

        // Console
        if (data.logs.length !== lastLogCount) {
            const out = $("consoleOutput");
            if (out) {
                if (data.logs.length < lastLogCount) out.innerHTML = "";
                const newLogs = data.logs.slice(lastLogCount);
                newLogs.forEach(msg => {
                    const line = document.createElement("div");
                    line.className = "log-line";
                    line.textContent = msg;
                    out.appendChild(line);
                });
                out.scrollTop = out.scrollHeight;
            }
            lastLogCount = data.logs.length;
        }

    } catch (e) { console.error("Update failed:", e); }
}

const MC_COMMANDS = [
    "advancement", "attribute", "ban", "ban-ip", "banlist", "bossbar", "clear", "clone", "data", "datapack", 
    "debug", "defaultgamemode", "deop", "difficulty", "effect", "enchant", "execute", "experience", "fill", 
    "forceload", "function", "gamemode", "gamerule", "give", "help", "item", "jfr", "kick", "kill", "list", 
    "locate", "loot", "me", "msg", "op", "pardon", "pardon-ip", "particle", "perf", "place", "playsound", 
    "recipe", "reload", "save-all", "save-off", "save-on", "say", "schedule", "scoreboard", "seed", 
    "setblock", "setidletimeout", "setworldspawn", "spawnpoint", "spectate", "spreadplayers", "stop", 
    "stopsound", "summon", "tag", "team", "teammsg", "teleport", "tell", "tellraw", "tick", "time", 
    "title", "trigger", "weather", "whitelist", "worldborder", "xp"
].sort();

function initConsole() {
  const form = $("consoleForm");
  const input = $("consoleCommand");
  const suggestionsBox = $("commandSuggestions");
  if (!form || !input || !suggestionsBox) return;

  let currentFocus = -1;

  input.addEventListener("input", function() {
    const val = this.value;
    suggestionsBox.innerHTML = "";
    currentFocus = -1;
    
    if (!val || !val.startsWith("/")) {
        suggestionsBox.style.display = "none";
        return;
    }

    const query = val.substring(1).toLowerCase();
    const filtered = MC_COMMANDS.filter(cmd => cmd.startsWith(query));

    if (filtered.length > 0) {
        filtered.forEach((cmd, index) => {
            const item = document.createElement("div");
            item.className = "suggestion-item";
            item.innerHTML = `<span>/</span>${cmd}`;
            item.addEventListener("click", () => {
                input.value = "/" + cmd + " ";
                suggestionsBox.style.display = "none";
                input.focus();
            });
            suggestionsBox.appendChild(item);
        });
        suggestionsBox.style.display = "block";
    } else {
        suggestionsBox.style.display = "none";
    }
  });

  input.addEventListener("keydown", function(e) {
    const items = suggestionsBox.getElementsByClassName("suggestion-item");
    if (e.keyCode === 40) { // DOWN
        currentFocus++;
        addActive(items);
    } else if (e.keyCode === 38) { // UP
        currentFocus--;
        addActive(items);
    } else if (e.keyCode === 13) { // ENTER
        if (currentFocus > -1) {
            if (items) items[currentFocus].click();
            e.preventDefault();
        }
    } else if (e.keyCode === 27) { // ESC
        suggestionsBox.style.display = "none";
    }
  });

  function addActive(items) {
    if (!items) return false;
    removeActive(items);
    if (currentFocus >= items.length) currentFocus = 0;
    if (currentFocus < 0) currentFocus = items.length - 1;
    items[currentFocus].classList.add("active");
    items[currentFocus].scrollIntoView({ block: "nearest" });
  }

  function removeActive(items) {
    for (let i = 0; i < items.length; i++) {
        items[i].classList.remove("active");
    }
  }

  document.addEventListener("click", (e) => {
    if (e.target !== input) suggestionsBox.style.display = "none";
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var command = input.value.trim();
    if (command === "") return;
    sendCommandToBackend(command);
    input.value = "";
    suggestionsBox.style.display = "none";
  });
}

document.addEventListener("DOMContentLoaded", function () {
  initDashboard();
  initConsole();
  fetch('/api/current-server')
    .then(res => res.json())
    .then(data => { if ($('serverName')) $('serverName').innerText = data.name; });
});