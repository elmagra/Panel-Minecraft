/* ── Gamerules page logic ─────────────────────────────── */

let serverOnline = false;

// ── Toast helper ─────────────────────────────────────────
function showToast(msg, type = 'ok') {
  const t = document.getElementById('grToast');
  t.textContent = msg;
  t.className = `show toast-${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3000);
}

// ── Send a gamerule command to the server ────────────────
async function applyGamerule(rule, value) {
  if (!serverOnline) {
    showToast('El servidor está apagado. Enciéndelo primero.', 'err');
    return false;
  }
  try {
    const res = await fetch('/api/server/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `gamerule ${rule} ${value}` })
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    showToast(`✅ ${rule} → ${value}`, 'ok');
    return true;
  } catch (e) {
    showToast(`❌ Error: ${e.message}`, 'err');
    return false;
  }
}

// ── Toggle (boolean gamerules) ───────────────────────────
async function applyToggle(rule, checkbox) {
  const value = checkbox.checked ? 'true' : 'false';
  const ok = await applyGamerule(rule, value);
  if (!ok) {
    // Revert the visual toggle
    checkbox.checked = !checkbox.checked;
  }
}

// ── Number/select gamerules ──────────────────────────────
async function applyNumber(rule) {
  const input = document.getElementById(rule);
  if (!input) return;
  const value = input.value.trim();
  if (value === '') { showToast('Introduce un valor', 'err'); return; }

  const btn = input.nextElementSibling;
  const prev = btn.textContent;
  btn.textContent = '...';
  btn.disabled = true;

  const ok = await applyGamerule(rule, value);
  btn.textContent = ok ? '✓' : '✗';
  btn.classList.toggle('ok', ok);
  btn.classList.toggle('err', !ok);
  setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove('ok', 'err');
    btn.disabled = false;
  }, 2000);
}

// ── Track server status to show/hide offline banner ──────
async function checkServerStatus() {
  try {
    const res = await fetch('/api/server/status');
    if (!res.ok) { serverOnline = false; return; }
    const data = await res.json();
    serverOnline = data.status === 'online';
    const banner = document.getElementById('offlineWarning');
    if (banner) banner.classList.toggle('visible', !serverOnline);
  } catch {
    serverOnline = false;
  }
}

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkServerStatus();
  setInterval(checkServerStatus, 4000);
});
