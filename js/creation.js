// ============================================================
// SELECCIÓN DE VERSIÓN / SOFTWARE
// ============================================================
let selectedSoftware = 'Vanilla';

// Función global (llamada desde onclick en el HTML)
function selectVersion(card) {
    document.querySelectorAll('.version-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedSoftware = card.querySelector('.version-name').textContent.trim();
}

// También soporte via addEventListener por si se usa así
document.querySelectorAll('.version-card').forEach(card => {
    card.addEventListener('click', () => selectVersion(card));
});

// ============================================================
// SEMILLA ALEATORIA
// ============================================================
const seedInput = document.getElementById('level-seed');
const randomSeedBtn = document.getElementById('btn-random-seed');

if (randomSeedBtn && seedInput) {
    randomSeedBtn.addEventListener('click', () => {
        // Semilla aleatoria entre -9999999999 y 9999999999 (rango Minecraft)
        const seed = Math.floor(Math.random() * 19999999999) - 9999999999;
        seedInput.value = seed;
    });
}

// ============================================================
// BOTÓN CREAR MUNDO
// ============================================================
const btnCreate = document.getElementById('btnCreateWorld');
const progressBar = document.getElementById('inlineProgressBar');
const progressText = document.getElementById('inlinePercentage');
const logContainer = document.getElementById('inlineLog');

btnCreate.addEventListener('click', async () => {
    const levelName = (document.getElementById('level-name').value.trim()) || 'world';
    const levelSeed = seedInput ? seedInput.value.trim() : '';
    const levelType = document.getElementById('level-type').value;
    const mcVersion = document.getElementById('mc-version').value;

    // Validar nombre
    if (!/^[a-zA-Z0-9_\- ]+$/.test(levelName)) {
        alert('El nombre del mundo solo puede contener letras, números, guiones y guiones bajos.');
        return;
    }

    const data = {
        type: selectedSoftware,
        version: mcVersion,
        levelName: levelName,
        levelSeed: levelSeed,
        levelType: levelType
    };

    // UI Feedback inmediato
    btnCreate.disabled = true;
    btnCreate.innerText = '⏳ Instalando...';
    logContainer.innerHTML = '<div class="log-entry"><span class="log-msg">🚀 Iniciando proceso de creación...</span></div>';
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.innerText = '0%';

    try {
        const res = await fetch('/api/create-world', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Error en el servidor');
        }

        pollStatus();

    } catch (e) {
        btnCreate.disabled = false;
        btnCreate.innerText = '✨ Crear y Generar Mundo';
        logContainer.innerHTML += `<div class="log-entry" style="color:#ef4444">[Error] ${e.message}</div>`;
    }
});

// ============================================================
// POLLING DE ESTADO
// ============================================================
let pollInterval;
function pollStatus() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/creation-status');
            const data = await res.json();

            // Barra de progreso
            if (progressBar) progressBar.style.width = (data.progress || 0) + '%';
            if (progressText) progressText.innerText = Math.round(data.progress || 0) + '%';

            // Logs
            if (logContainer && data.steps && data.steps.length > 0) {
                logContainer.innerHTML = '';
                data.steps.forEach(step => {
                    const icon = step.msg.toLowerCase().includes('error') ? '❌' :
                                 step.msg.toLowerCase().includes('descarg') ? '📥' :
                                 step.msg.toLowerCase().includes('listo') || step.msg.toLowerCase().includes('completa') ? '✅' :
                                 step.msg.toLowerCase().includes('elimin') ? '🗑️' :
                                 '🔧';
                    logContainer.innerHTML += `
                        <div class="log-entry">
                            <span class="log-time">${step.time}</span>
                            <span class="log-msg">${icon} ${step.msg}</span>
                        </div>
                    `;
                });
                logContainer.scrollTop = logContainer.scrollHeight;
            }

            if (data.status === 'done') {
                clearInterval(pollInterval);
                btnCreate.innerText = '✅ ¡Listo!';
                setTimeout(() => {
                    window.location.href = 'index.html';
                }, 2000);

            } else if (data.status === 'error') {
                clearInterval(pollInterval);
                btnCreate.disabled = false;
                btnCreate.innerText = '❌ Reintentar';
            }

        } catch (e) {
            console.error('Error de polling:', e);
        }
    }, 800);
}
