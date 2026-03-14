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
        } else if (data.status === 'starting') {
            if (statusText) statusText.textContent = "Iniciando...";
            if (dot) dot.style.background = "#eab308";
        } else {
            if (statusText) statusText.textContent = "Apagado";
            if (dot) dot.style.background = "#ef4444";
        }

        // Stats & Version
        if ($("serverVersion")) $("serverVersion").textContent = data.version || 'Detectando...';
        if ($("cpuUsage")) {
            $("cpuUsage").textContent = data.cpu + "%";
            $("cpuBar").style.width = data.cpu + "%";
        }
        if ($("ramUsage")) {
            $("ramUsage").textContent = (data.ramUsedGB || 0) + " GB / " + (data.ramTotalGB || 0) + " GB";
            $("ramBar").style.width = data.ram + "%";
        }
        if ($("playerCount")) {
            const onlineCount = data.players.filter(p => p.online).length;
            $("playerCount").textContent = onlineCount + " / " + (data.maxPlayers || 20);
        }
        if (data.startTime && $("uptime")) {
            $("uptime").textContent = formatUptime(Date.now() - data.startTime);
        } else if ($("uptime")) {
            $("uptime").textContent = "00:00:00";
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

function initConsole() {
  const form = $("consoleForm");
  const input = $("consoleCommand");
  if (!form || !input) return;

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var command = input.value.trim();
    if (command === "") return;
    sendCommandToBackend(command);
    input.value = "";
  });
}

document.addEventListener("DOMContentLoaded", function () {
  initDashboard();
  initConsole();
  fetch('/api/current-server')
    .then(res => res.json())
    .then(data => { if ($('serverName')) $('serverName').innerText = data.name; });
});