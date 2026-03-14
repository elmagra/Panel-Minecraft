document.addEventListener('DOMContentLoaded', () => {
  const fileListBody = document.getElementById('fileListBody');
  const breadcrumbContainer = document.getElementById('breadcrumbContainer');
  const fileUploadInput = document.getElementById('fileUploadInput');
  const uploadModal = document.getElementById('uploadModal');
  const uploadProgressBar = document.getElementById('uploadProgressBar');
  const uploadStatusText = document.getElementById('uploadStatusText');

  // Server Path settings
  let currentPath = '/';

  function updateBreadcrumbs() {
    breadcrumbContainer.innerHTML = '';
    const parts = currentPath.split('/').filter(p => p !== '');
    
    const rootSpan = document.createElement('span');
    rootSpan.className = 'breadcrumb-item';
    rootSpan.textContent = '/';
    rootSpan.onclick = () => navigateTo('/');
    breadcrumbContainer.appendChild(rootSpan);

    let pathAccumulator = '';
    parts.forEach((part, index) => {
      const separator = document.createElement('span');
      separator.textContent = ' / ';
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

  async function renderFiles() {
    fileListBody.innerHTML = '';
    
    try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(currentPath)}`);
        const displayFiles = await res.json();

        if (currentPath !== '/') {
            const backTr = document.createElement('tr');
            backTr.className = 'file-row';
            backTr.innerHTML = `<td><div class="file-name-cell"><span class="file-icon folder-icon">📁</span><span>..</span></div></td><td>-</td><td>-</td><td></td>`;
            backTr.onclick = () => {
                const parts = currentPath.split('/').filter(p => p !== '');
                parts.pop();
                navigateTo('/' + parts.join('/'));
            };
            fileListBody.appendChild(backTr);
        }

        if (currentPath === '/mods') {
            const hintTr = document.createElement('tr');
            hintTr.innerHTML = `<td colspan="4" style="text-align: center; color: #60a5fa; background: rgba(59, 130, 246, 0.1); font-size: 13px; padding: 10px;">
                💡 Sube aquí tus archivos <b>.jar</b> para instalar mods en el servidor.
            </td>`;
            fileListBody.appendChild(hintTr);
        }

        displayFiles.forEach(file => {
          const tr = document.createElement('tr');
          tr.className = 'file-row';
          
          const isFolder = file.type === 'folder';
          const isJar = file.name.endsWith('.jar');
          const icon = isFolder ? '📁' : (isJar ? '☕' : '📄');
          const iconClass = isFolder ? 'folder-icon' : (isJar ? 'file-icon-jar' : 'file-icon-generic');

          tr.innerHTML = `
            <td>
              <div class="file-name-cell">
                <span class="file-icon ${iconClass}">${icon}</span>
                <span>${file.name}</span>
              </div>
            </td>
            <td>${file.size}</td>
            <td>${file.date}</td>
            <td>
              <button class="action-dots" title="Más opciones">⋮</button>
            </td>
          `;

          tr.onclick = (e) => {
            if (e.target.tagName !== 'BUTTON') {
              if (isFolder) {
                navigateTo(currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name);
              }
            }
          };

          fileListBody.appendChild(tr);
        });
    } catch (e) {
        console.error("Error fetching files:", e);
    }
  }

  function navigateTo(path) {
    if (path === '') path = '/';
    currentPath = path;
    updateBreadcrumbs();
    renderFiles();
  }

  async function uploadFiles(fileList) {
    uploadModal.classList.add('active');
    uploadProgressBar.style.width = '0%';
    uploadStatusText.innerText = 'Subiendo...';
    
    try {
        const formData = new FormData();
        for (let i = 0; i < fileList.length; i++) {
            formData.append('file', fileList[i]);
        }

        const res = await fetch(`/api/upload?path=${encodeURIComponent(currentPath)}`, {
            method: 'POST',
            body: formData
        });

        if (res.ok) {
            uploadProgressBar.style.width = '100%';
            uploadStatusText.innerText = '¡Carga completada!';
        } else {
            uploadStatusText.innerText = 'Error al subir';
        }
    } catch (e) {
        console.error(e);
        uploadStatusText.innerText = 'Error de red';
    }

    setTimeout(() => {
        uploadModal.classList.remove('active');
        renderFiles();
    }, 1500);
  }

  fileUploadInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        uploadFiles(e.target.files);
    }
  });

  // Initial render
  navigateTo('/');
});
