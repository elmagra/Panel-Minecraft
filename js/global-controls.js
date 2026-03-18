function $g(id) { return document.getElementById(id); }

async function handleGlobalAction(url, btnId) {
    const btn = $g(btnId);
    if (!btn) return;
    btn.disabled = true;
    const oldText = btn.innerHTML;
    btn.innerHTML = '...';
    try {
        await fetch(url, { method: 'POST' });
    } catch(e) { console.error(e); }
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = oldText;
    }, 2000);
}

async function updateGlobalStatus() {
    try {
        const res = await fetch('/api/server/status');
        if (!res.ok) return;
        const data = await res.json();

        const dot = $g("globalStatusDot");
        const text = $g("globalStatusText");

        if (dot && text) {
            dot.className = "status-dot";
            if (data.status === 'online') {
                dot.classList.add("dot-online");
                if (dot.style) dot.style.background = "#22c55e"; // En caso de que se use el style inline de index
                text.textContent = "En línea";
                if ($g("globalStartBtn")) $g("globalStartBtn").style.display = "none";
                if ($g("globalStopBtn")) $g("globalStopBtn").style.display = "inline-block";
                if ($g("globalRestartBtn")) $g("globalRestartBtn").style.display = "inline-block";
            } else if (data.status === 'starting') {
                dot.classList.add("dot-starting");
                if (dot.style) dot.style.background = "#eab308";
                text.textContent = "Iniciando...";
                if ($g("globalStartBtn")) $g("globalStartBtn").style.display = "none";
                if ($g("globalStopBtn")) $g("globalStopBtn").style.display = "none";
                if ($g("globalRestartBtn")) $g("globalRestartBtn").style.display = "none";
            } else {
                dot.classList.add("dot-offline");
                if (dot.style) dot.style.background = "#ef4444";
                text.textContent = "Apagado";
                if ($g("globalStartBtn")) $g("globalStartBtn").style.display = "inline-block";
                if ($g("globalStopBtn")) $g("globalStopBtn").style.display = "none";
                if ($g("globalRestartBtn")) $g("globalRestartBtn").style.display = "none";
            }
        }
    } catch(e) {}
}

document.addEventListener("DOMContentLoaded", () => {
    const startBtn = $g("globalStartBtn");
    const stopBtn = $g("globalStopBtn");
    const restartBtn = $g("globalRestartBtn");

    if (startBtn) startBtn.onclick = () => handleGlobalAction("/api/server/start", "globalStartBtn");
    if (stopBtn) stopBtn.onclick = () => handleGlobalAction("/api/server/stop", "globalStopBtn");
    if (restartBtn) restartBtn.onclick = () => handleGlobalAction("/api/server/restart", "globalRestartBtn");

    updateGlobalStatus();
    setInterval(updateGlobalStatus, 3000);
});
