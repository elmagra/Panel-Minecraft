const cards = document.querySelectorAll('.version-card');
let selectedSoftware = 'Vanilla';

cards.forEach(card => {
    card.addEventListener('click', () => {
        cards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedSoftware = card.querySelector('.version-name').textContent;
    });
});

const btnCreate = document.getElementById('btnCreateWorld');
// Nuevos elementos inline
const inlineContainer = document.getElementById('inlineLogContainer');
const progressBar = document.getElementById('inlineProgressBar');
const progressText = document.getElementById('inlinePercentage');
const logContainer = document.getElementById('inlineLog');

btnCreate.addEventListener('click', async () => {
    const levelNameInput = document.getElementById('level-name');
    const levelName = levelNameInput.value.trim() || 'world';

    const data = {
        type: selectedSoftware,
        version: document.getElementById('mc-version').value,
        levelName: levelName,
        levelSeed: document.getElementById('level-seed').value,
        levelType: document.getElementById('level-type').value
    };

    // UI Feedback inmediato
    btnCreate.disabled = true;
    btnCreate.innerText = "⏳ Instalando...";
    logContainer.innerHTML = '<div class="log-entry">Iniciando proceso...</div>';
    
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
        btnCreate.innerText = "✨ Crear y Generar Mundo";
        logContainer.innerHTML += `<div class="log-entry" style="color:#ef4444">[Error] ${e.message}</div>`;
    }
});

let pollInterval;
function pollStatus() {
    pollInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/creation-status');
            const data = await res.json();

            // Actualizar Progreso
            progressBar.style.width = data.progress + '%';
            progressText.innerText = Math.round(data.progress) + '%';
            
            // Sincronizar Logs
            logContainer.innerHTML = '';
            data.steps.forEach(step => {
                logContainer.innerHTML += `
                    <div class="log-entry">
                        <span class="log-time">${step.time}</span>
                        <span class="log-msg">${step.msg}</span>
                    </div>
                `;
            });
            logContainer.scrollTop = logContainer.scrollHeight;

            if (data.status === 'done') {
                clearInterval(pollInterval);
                btnCreate.innerText = "✅ ¡Listo!";
                setTimeout(() => {
                    window.location.href = 'index.html';
                }, 1500);
            } else if (data.status === 'error') {
                clearInterval(pollInterval);
                btnCreate.disabled = false;
                btnCreate.innerText = "❌ Reintentar";
            }

        } catch (e) {
            console.error("Error de polling:", e);
        }
    }, 800);
}
