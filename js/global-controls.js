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
                text.textContent = "En línea";
            } else if (data.status === 'starting') {
                dot.classList.add("dot-starting");
                text.textContent = "Iniciando...";
            } else {
                dot.classList.add("dot-offline");
                text.textContent = "Apagado";
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
