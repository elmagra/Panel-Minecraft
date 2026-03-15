const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
    const fileListBody = $('fileListBody');
    const breadcrumbContainer = $('breadcrumbContainer');
    const fileUploadInput = $('fileUploadInput');
    const uploadModal = $('uploadModal');
    const uploadProgressBar = $('uploadProgressBar');
    const uploadStatusText = $('uploadStatusText');
    const editorModal = $('editorModal');
    const fileEditorTextArea = $('fileEditorTextArea');
    const editorFileName = $('editorFileName');
    const saveFileBtn = $('saveFileBtn');

    let currentPath = '/';
    let allFiles = []; // Cache para búsqueda

    function updateBreadcrumbs() {
        breadcrumbContainer.innerHTML = '';
        const parts = currentPath.split('/').filter(p => p !== '');
        
        const rootSpan = document.createElement('span');
        rootSpan.className = 'breadcrumb-item';
        rootSpan.innerHTML = '<i class="fa-solid fa-house" style="font-size: 0.8rem;"></i> root';
        rootSpan.onclick = () => navigateTo('/');
        breadcrumbContainer.appendChild(rootSpan);

        let pathAccumulator = '';
        parts.forEach((part) => {
            const separator = document.createElement('span');
            separator.textContent = ' / ';
            separator.style.opacity = '0.3';
            breadcrumbContainer.appendChild(separator);

            pathAccumulator += '/' + part;
            const partSpan = document.createElement('span');
            partSpan.className = 'breadcrumb-item';
            partSpan.textContent = part;
            const targetPath = pathAccumulator;
            partSpan.onclick = () => navigateTo(targetPath);
            breadcrumbContainer.appendChild(partSpan);
        });
    }

    async function fetchFiles() {
        try {
            const res = await fetch(`/api/files?path=${encodeURIComponent(currentPath)}`);
            allFiles = await res.json();
            renderFiles(allFiles);
        } catch (e) { console.error("Error fetching files:", e); }
    }

    function renderFiles(files) {
        fileListBody.innerHTML = '';
        
        // Ordenar: Carpetas primero, luego archivos, ambos alfabéticamente
        files.sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'folder' ? -1 : 1;
        });

        // Botón Atrás
        if (currentPath !== '/') {
            const backTr = document.createElement('tr');
            backTr.className = 'file-row';
            backTr.style.cursor = 'pointer';
            backTr.innerHTML = `
                <td colspan="3" style="padding-left: 20px; color: #3b82f6; font-weight: 600;">
                    <i class="fa-solid fa-arrow-turn-up" style="transform: rotate(-90deg); margin-right: 10px;"></i> Volver atrás
                </td>
            `;
            backTr.onclick = () => {
                const parts = currentPath.split('/').filter(p => p !== '');
                parts.pop();
                navigateTo('/' + parts.join('/'));
            };
            fileListBody.appendChild(backTr);
        }

        files.forEach(file => {
            const tr = document.createElement('tr');
            tr.className = 'file-row';
            
            const isFolder = file.type === 'folder';
            // Regex más amplio para archivos de texto de Minecraft
            const isText = /\.(txt|json|yml|yaml|properties|log|sh|bat|cmd|conf|cfg|list)$/.test(file.name.toLowerCase());
            
            const icon = isFolder ? '<i class="fa-solid fa-folder folder-icon"></i>' : 
                         (isText ? '<i class="fa-solid fa-file-lines file-icon-generic" style="color: #3b82f6;"></i>' : 
                         (file.name.endsWith('.jar') ? '<i class="fa-solid fa-file-code file-icon-jar"></i>' : '<i class="fa-solid fa-file file-icon-generic"></i>'));

            tr.style.cursor = 'pointer';
            tr.onclick = (e) => {
                const fullP = currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name;
                if (isFolder) navigateTo(fullP);
                else openEditor(fullP); // Intentar abrir cualquier archivo que no sea carpeta
            };

            tr.innerHTML = `
                <td style="padding-left: 20px;">
                    <div style="display: flex; align-items: center; gap: 12px; cursor: pointer;" class="file-link">
                        <span class="file-icon">${icon}</span>
                        <span style="font-weight: 500;">${file.name}</span>
                    </div>
                </td>
                <td style="color: #64748b; font-size: 0.9rem;">${file.size}</td>
                <td style="text-align: right; padding-right: 20px;">
                    <div style="display: flex; gap: 5px; justify-content: flex-end;">
                        ${!isFolder ? `<button class="action-btn edit" title="Editar"><i class="fa-solid fa-pen-to-square"></i></button>` : ''}
                        <button class="action-btn delete" title="Eliminar"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </td>
            `;

            const fullPath = currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name;
            
            if (!isFolder) {
                const editBtn = tr.querySelector('.edit');
                if (editBtn) editBtn.onclick = (e) => { e.stopPropagation(); openEditor(fullPath); };
            }
            
            tr.querySelector('.delete').onclick = async (e) => {
                e.stopPropagation();
                e.stopPropagation();
                if (confirm(`¿Estás seguro de que quieres eliminar "${file.name}"?`)) {
                    await fetch('/api/files/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: fullPath })
                    });
                    fetchFiles();
                }
            };

            fileListBody.appendChild(tr);
        });
    }

    function navigateTo(path) {
        currentPath = path === '' ? '/' : path;
        updateBreadcrumbs();
        fetchFiles();
    }

    let isOpening = false;
    async function openEditor(path) {
        if (isOpening) return;
        isOpening = true;
        
        try {
            const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || 'Servidor no respondió correctamente');
            }
            const data = await res.json();
            editorFileName.textContent = path.split('/').pop();
            fileEditorTextArea.value = data.content || '';
            editorModal.style.display = 'flex';
            
            saveFileBtn.onclick = async () => {
                saveFileBtn.disabled = true;
                saveFileBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> GUARDANDO...';
                await fetch('/api/files/content', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, content: fileEditorTextArea.value })
                });
                saveFileBtn.disabled = false;
                saveFileBtn.innerHTML = '<i class="fa-solid fa-save"></i> GUARDAR CAMBIOS';
                editorModal.style.display = 'none';
            };
        } catch(e) { 
            alert('Error al abrir archivo: ' + e.message); 
        } finally {
            isOpening = false;
        }
    }

    async function uploadFiles(fileList) {
        uploadModal.classList.add('active');
        uploadProgressBar.style.width = '0%';
        try {
            const formData = new FormData();
            for (let i = 0; i < fileList.length; i++) formData.append('file', fileList[i]);
            await fetch(`/api/upload?path=${encodeURIComponent(currentPath)}`, { method: 'POST', body: formData });
            uploadProgressBar.style.width = '100%';
            uploadStatusText.innerText = '¡Carga completada!';
        } catch (e) { uploadStatusText.innerText = 'Error al subir'; }
        setTimeout(() => { uploadModal.classList.remove('active'); fetchFiles(); }, 1000);
    }

    fileUploadInput.onchange = (e) => { if (e.target.files.length > 0) uploadFiles(e.target.files); };

    navigateTo('/');
});
