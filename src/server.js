const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const os = require('os');
const osUtils = require('os-utils');
const { spawn, exec } = require('child_process');

const config = require('./config/config');
const { downloadFile } = require('./utils/utils');
const { getJarUrl } = require('./services/jarService');
const nbt = require('prismarine-nbt');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(config.PANEL_ROOT));

// --- REAL STATE ---
let creationStatus = { steps: [], progress: 0, status: 'idle', name: 'world' };
let mcProcess = null;
let serverState = {
    status: 'offline',
    logs: [],
    ram: 0,
    cpu: 0,
    startTime: null,
    players: [],
    version: '...',
    software: 'Detectando...',
    worldSize: '0 MB',
    ramUsedGB: 0,
    ramTotalGB: 0
};

const propMapping = { 'whitelist': 'white-list' };

// Mapa nombre -> IP para saber quién está baneado por IP (Minecraft no guarda nombre en banned-ips.json)
let banIpByName = {};

const BAN_IP_CACHE_FILENAME = 'ban-ip-cache.json';
const PLAYER_LAST_IP_FILENAME = 'player-last-ip.json';

async function getFirstServerPath() {
    const folders = await fs.readdir(config.SERVERS_ROOT);
    return folders.length ? path.join(config.SERVERS_ROOT, folders[0]) : null;
}

async function loadBanIpCache() {
    try {
        const serverPath = await getFirstServerPath();
        if (!serverPath) return;
        const cachePath = path.join(serverPath, BAN_IP_CACHE_FILENAME);
        if (await fs.pathExists(cachePath)) {
            const data = await fs.readJson(cachePath).catch(() => ({}));
            if (data && typeof data === 'object') Object.assign(banIpByName, data);
        }
    } catch (e) {}
}

async function saveBanIpCache() {
    try {
        const serverPath = await getFirstServerPath();
        if (!serverPath) return;
        await fs.writeJson(path.join(serverPath, BAN_IP_CACHE_FILENAME), banIpByName, { spaces: 2 });
    } catch (e) {}
}

let playerLastIp = {};

async function loadPlayerLastIp() {
    try {
        const serverPath = await getFirstServerPath();
        if (!serverPath) return;
        const f = path.join(serverPath, PLAYER_LAST_IP_FILENAME);
        if (await fs.pathExists(f)) {
            const data = await fs.readJson(f).catch(() => ({}));
            if (data && typeof data === 'object') playerLastIp = data;
        }
    } catch (e) {}
}

async function savePlayerLastIp() {
    try {
        const serverPath = await getFirstServerPath();
        if (!serverPath) return;
        await fs.writeJson(path.join(serverPath, PLAYER_LAST_IP_FILENAME), playerLastIp, { spaces: 2 });
    } catch (e) {}
}

function addCreationStep(msg) {
    const time = new Date().toLocaleTimeString();
    creationStatus.steps.push({ time, msg });
    if (creationStatus.steps.length > 200) creationStatus.steps.shift();
}

async function createWorldFromRequest(payload) {
    try {
        const type = (payload.type || 'Vanilla').toString();
        const version = (payload.version || '1.20.1').toString();
        const levelName = (payload.levelName || 'world').toString().trim().replace(/[^a-zA-Z0-9_\- ]/g, '') || 'world';
        // Si el usuario no pone semilla, se deja vacía → Minecraft la genera aleatoriamente
        const levelSeed = (payload.levelSeed || '').toString().trim();
        const levelType = (payload.levelType || 'default').toString();
        // Semilla: si está vacía, NO ponemos nada → Minecraft genera una aleatoria por sí solo
        const maxWorldSize = payload.maxWorldSize && !isNaN(Number(payload.maxWorldSize))
            ? Number(payload.maxWorldSize)
            : 29999984;

        creationStatus = { steps: [], progress: 0, status: 'running', name: levelName };
        addCreationStep(`🚀 Preparando mundo "${levelName}" · ${type} ${version}`);
        addCreationStep(`🌱 Semilla: ${levelSeed !== '' ? levelSeed : 'aleatoria (generada por Minecraft)'}  |  Tipo: ${levelType}`);

        // 1) Apagar servidor si está encendido
        if (mcProcess) {
            addCreationStep('⛔ Deteniendo servidor actual...');
            await stopProcessSync();
            addCreationStep('✅ Servidor detenido.');
        }
        creationStatus.progress = 5;

        // 2) Asegurar que el directorio raíz existe
        const root = config.SERVERS_ROOT;
        await fs.ensureDir(root);

        // 3) Eliminar carpetas de servidores anteriores
        const folders = await fs.readdir(root).catch(() => []);
        for (const f of folders) {
            const full = path.join(root, f);
            const stat = await fs.stat(full).catch(() => null);
            if (stat && stat.isDirectory()) {
                addCreationStep(`🗑️ Eliminando servidor anterior: ${f}`);
                await fs.remove(full).catch(err => {
                    console.warn('[CREATE-WORLD] No se pudo eliminar', full, err.message);
                });
            }
        }
        creationStatus.progress = 15;

        // 4) Crear nueva carpeta de servidor
        const serverPath = path.join(root, levelName);
        await fs.ensureDir(serverPath);
        addCreationStep(`📁 Carpeta del mundo creada: .../${levelName}`);
        creationStatus.progress = 20;

        // 5) Resolver URL del JAR
        addCreationStep(`🔍 Buscando JAR de ${type} ${version}...`);
        const jarUrl = await getJarUrl(type, version);
        if (!jarUrl) throw new Error(`No se pudo obtener la URL del JAR para ${type} ${version}.`);
        addCreationStep(`🔗 URL resuelta. Iniciando descarga...`);
        creationStatus.progress = 25;

        // 6) Descargar JAR
        const jarDest = path.join(serverPath, 'server.jar');
        await downloadFile(jarUrl, jarDest, (p) => {
            creationStatus.progress = 25 + Math.round((p / 100) * 45);
            // Log cada 25%
            const pct = Math.round(p);
            if (pct === 25 || pct === 50 || pct === 75 || pct === 100) {
                addCreationStep(`📥 Descargando server.jar... ${pct}%`);
            }
        });
        addCreationStep('✅ server.jar descargado correctamente.');
        creationStatus.progress = 72;

        // 7) Escribir eula.txt
        await fs.writeFile(path.join(serverPath, 'eula.txt'), 'eula=true\n');
        addCreationStep('📄 EULA aceptada automáticamente.');
        creationStatus.progress = 78;

        // 8) Escribir server.properties
        const props = [
            `# Generado por Marcternos Panel el ${new Date().toISOString()}`,
            `level-name=${levelName}`,
            // Solo escribir level-seed si el usuario proporcionó una; si no, Minecraft genera la suya
            ...(levelSeed !== '' ? [`level-seed=${levelSeed}`] : []),
            `level-type=${levelType}`,
            `max-world-size=${maxWorldSize}`,
            'motd=\u00a76\u00a7lMarcternos \u00a7r\u00a77- Servidor Minecraft',
            'online-mode=true',
            'enable-command-block=false',
            'pvp=true',
            'difficulty=normal',
            'gamemode=survival',
            'spawn-protection=16',
            'max-players=20',
            'view-distance=10',
            'simulation-distance=10'
        ];
        const propPath = path.join(serverPath, 'server.properties');
        await fs.writeFile(propPath, props.join('\n') + '\n', 'utf-8');
        addCreationStep('⚙️ server.properties configurado.');
        creationStatus.progress = 88;

        // 9) Inicializar archivos JSON necesarios
        const emptyJson = JSON.stringify([], null, 2);
        await fs.writeFile(path.join(serverPath, 'ops.json'), emptyJson);
        await fs.writeFile(path.join(serverPath, 'whitelist.json'), emptyJson);
        await fs.writeFile(path.join(serverPath, 'banned-players.json'), emptyJson);
        await fs.writeFile(path.join(serverPath, 'banned-ips.json'), emptyJson);
        addCreationStep('📋 Archivos de configuración inicializados.');
        creationStatus.progress = 95;

        // 10) Resetear estado global del servidor
        serverState.worldName = levelName;
        serverState.version = version;
        serverState.software = type;
        serverState.status = 'offline';
        serverState.players = [];
        serverState.logs = [];
        serverState.startTime = null;
        serverState.worldSize = '0 MB';
        banIpByName = {};
        playerLastIp = {};

        addCreationStep(`🎉 ¡Mundo "${levelName}" listo! Puedes encenderlo desde el Dashboard.`);
        creationStatus.progress = 100;
        creationStatus.status = 'done';

    } catch (e) {
        console.error('[CREATE-WORLD]', e);
        addCreationStep(`❌ Error: ${e.message}`);
        creationStatus.status = 'error';
    }
}

// Monitor de recursos
setInterval(() => {
    osUtils.cpuUsage((v) => { serverState.cpu = Math.round(v * 100); });
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    serverState.ram = Math.round(((totalMem - freeMem) / totalMem) * 100);
    serverState.ramUsedGB = ((totalMem - freeMem) / (1024 * 1024 * 1024)).toFixed(1);
    serverState.ramTotalGB = (totalMem / (1024 * 1024 * 1024)).toFixed(0);
    
    // Update world size periodically
    updateWorldSize();

}, 6000);

async function loadWorldName() {
    try {
        const serverPath = await getFirstServerPath();
        if (!serverPath) return;
        const propPath = path.join(serverPath, 'server.properties');
        if (await fs.pathExists(propPath)) {
            const content = await fs.readFile(propPath, 'utf-8');
            const match = content.match(/level-name=(.+)/);
            if (match) serverState.worldName = match[1].trim();
            else serverState.worldName = 'world';
        } else {
            serverState.worldName = 'world';
        }
    } catch (e) {
        serverState.worldName = 'world';
    }
}

async function peekLogsForMetadata() {
    try {
        const serverPath = await getFirstServerPath();
        if (!serverPath) return;
        const logPath = path.join(serverPath, 'logs', 'latest.log');
        if (await fs.pathExists(logPath)) {
            const content = await fs.readFile(logPath, 'utf-8');
            const lines = content.split('\n').reverse().slice(0, 500); // Last 500 lines
            
            for (const line of lines) {
                if (line.includes('Starting minecraft server version')) {
                    const match = line.match(/version\s+([0-9.a-zA-Z_-]+)/);
                    if (match && serverState.version === '...') serverState.version = match[1];
                }
                if (line.includes('This server is running')) {
                    if (line.includes('Paper')) serverState.software = 'Paper';
                    else if (line.includes('Spigot')) serverState.software = 'Spigot';
                    else if (line.includes('Forge')) serverState.software = 'Forge';
                }
                if (line.includes('Fabric Loader')) serverState.software = 'Fabric';
                if (line.toLowerCase().includes('mohist')) serverState.software = 'Mohist';
                if (line.toLowerCase().includes('purpur')) serverState.software = 'Purpur';
            }
        }
    } catch (e) {}
}

async function getDirSize(dirPath) {
    let size = 0;
    const files = await fs.readdir(dirPath).catch(() => []);
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath).catch(() => null);
        if (!stats) continue;
        if (stats.isDirectory()) size += await getDirSize(filePath);
        else size += stats.size;
    }
    return size;
}

let lastWorldSizeUpdate = 0;
async function updateWorldSize() {
    // Solo actualizar cada 60 segundos
    if (Date.now() - lastWorldSizeUpdate < 60000) return;
    lastWorldSizeUpdate = Date.now();

    try {
        const serverPath = await getFirstServerPath();
        if (!serverPath) return;
        if (serverState.worldName === 'Cargando...') await loadWorldName();
        
        const worldPath = path.join(serverPath, serverState.worldName);
        let sizeBytes = 0;
        
        if (await fs.pathExists(worldPath)) {
            sizeBytes = await getDirSize(worldPath);
        }
        
        // Si no existe el mundo o pesa 0, medimos toda la carpeta del servidor
        if (sizeBytes === 0) {
            sizeBytes = await getDirSize(serverPath);
        }

        if (sizeBytes > 1024 * 1024 * 1024) serverState.worldSize = (sizeBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
        else serverState.worldSize = (sizeBytes / (1024 * 1024)).toFixed(1) + ' MB';
    } catch(e) {}
}

function resetPlayersOnlineStatus() {
    serverState.players.forEach(p => { p.online = false; });
}

// REFRESH PLAYER DATA & DISCOVER DISCONNECTED/BANNED PLAYERS
async function refreshAllPlayers() {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        if (folders.length === 0) return;
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);

        if (Object.keys(banIpByName).length === 0) await loadBanIpCache();
        if (Object.keys(playerLastIp).length === 0) await loadPlayerLastIp();

        // 1. Discover
        const filesToScan = [
            { path: 'banned-players.json', key: 'name' },
            { path: 'whitelist.json', key: 'name' },
            { path: 'ops.json', key: 'name' },
            { path: 'usercache.json', key: 'name' }
        ];

        for (const file of filesToScan) {
            const filePath = path.join(serverPath, file.path);
            if (await fs.pathExists(filePath)) {
                const data = await fs.readJson(filePath).catch(() => []);
                data.forEach(entry => {
                    const name = entry[file.key];
                    if (name && !serverState.players.find(p => p.name.toLowerCase() === name.toLowerCase())) {
                        serverState.players.push({
                            id: name.toLowerCase(),
                            name: name,
                            online: false,
                            dimension: 'Overworld',
                            location: { x: 0, y: 0, z: 0 },
                            gamemode: 'Survival',
                            ip: '0.0.0.0'
                        });
                    }
                });
            }
        }

        // 2. Update
        for (let player of serverState.players) {
            const info = await getPlayerExtendedInfo(player.name);
            Object.assign(player, info);
            if ((!player.ip || player.ip === '0.0.0.0') && playerLastIp[player.name.toLowerCase()]) {
                player.ip = playerLastIp[player.name.toLowerCase()];
            }
        }
    } catch (e) {}
}

setInterval(refreshAllPlayers, 2000);

async function loadRealTimeMetadata() {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        if (folders.length > 0) {
            serverState.worldName = folders[0];
            const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
            const propPath = path.join(serverPath, 'server.properties');
            if (await fs.pathExists(propPath)) {
                const content = await fs.readFile(propPath, 'utf-8');
                const maxMatch = content.match(/max-players=(\d+)/);
                if (maxMatch) serverState.maxPlayers = parseInt(maxMatch[1]);
            }
        }
    } catch (e) {}
}
loadRealTimeMetadata();

async function getPlayerExtendedInfo(name) {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        if (folders.length === 0) return {};
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        
        let op = false, whitelisted = false, uuid = 'Desconocido', bannedIp = false, bannedUuid = false;

        const cachePath = path.join(serverPath, 'usercache.json');
        if (await fs.pathExists(cachePath)) {
            const cache = await fs.readJson(cachePath).catch(() => []);
            const entry = cache.find(c => c.name && c.name.toLowerCase() === name.toLowerCase());
            if (entry) uuid = entry.uuid;
        }

        const opsPath = path.join(serverPath, 'ops.json');
        if (await fs.pathExists(opsPath)) {
            const ops = await fs.readJson(opsPath).catch(() => []);
            op = ops.some(o => o.name && o.name.toLowerCase() === name.toLowerCase());
        }

        const wlPath = path.join(serverPath, 'whitelist.json');
        if (await fs.pathExists(wlPath)) {
            const wl = await fs.readJson(wlPath).catch(() => []);
            whitelisted = wl.some(w => w.name && w.name.toLowerCase() === name.toLowerCase());
        }

        const banPath = path.join(serverPath, 'banned-players.json');
        if (await fs.pathExists(banPath)) {
            const bans = await fs.readJson(banPath).catch(() => []);
            bannedUuid = bans.some(b => b.name && b.name.toLowerCase() === name.toLowerCase());
        }

        const banIpPath = path.join(serverPath, 'banned-ips.json');
        if (await fs.pathExists(banIpPath)) {
            const bansIp = await fs.readJson(banIpPath).catch(() => []);
            const playerObj = serverState.players.find(p => p.name.toLowerCase() === name.toLowerCase());
            const ipFromMap = banIpByName[name.toLowerCase()];
            bannedIp = bansIp.some(b => 
                (b.name && b.name.toLowerCase() === name.toLowerCase()) || 
                (playerObj && playerObj.ip !== '0.0.0.0' && playerObj.ip === b.ip) ||
                (ipFromMap && bansIp.some(b2 => b2.ip === ipFromMap))
            );
        }

        const locInfo = await getPlayerLocationFromNbt(name);
        return { op, whitelisted, uuid, bannedIp, bannedUuid, ...locInfo };
    } catch (e) { return {}; }
}

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    serverState.logs.push(`[${time}] ${msg}`);
    if (serverState.logs.length > 500) serverState.logs.shift();

    if (msg.includes('Starting minecraft server version')) {
        const parts = msg.split('version');
        if (parts.length > 1) serverState.version = parts[1].trim();
    }
    if (msg.includes('This server is running')) {
        if (msg.includes('Paper')) serverState.software = 'Paper';
        else if (msg.includes('Spigot')) serverState.software = 'Spigot';
        else if (msg.includes('Forge')) serverState.software = 'Forge';
    }
    if (msg.includes('Fabric Loader')) serverState.software = 'Fabric';
    if (msg.toLowerCase().includes('mohist')) serverState.software = 'Mohist';
    if (msg.toLowerCase().includes('purpur')) serverState.software = 'Purpur';

    const joinMatch = msg.match(/\[Server thread\/INFO\]: (.*?)(\[.*\])? joined the game/);
    if (joinMatch) {
        const name = joinMatch[1].trim();
        getPlayerExtendedInfo(name).then(info => {
            let p = serverState.players.find(x => x.name.toLowerCase() === name.toLowerCase());
            if (p) {
                p.online = true;
                Object.assign(p, info);
            } else {
                serverState.players.push({ 
                    id: name.toLowerCase(),
                    name, online: true, dimension: 'Overworld', location: {x:0, y:64, z:0},
                    gamemode: 'Survival', health: 20, hunger: 20, ip: '127.0.0.1', ...info
                });
            }
        });
    }

    const gameProfileMatch = msg.match(/com\.mojang\.authlib\.GameProfile@.*?\[id=(.*?),name=(.*?),.*?\] \(\/(.*?):\d+\)/);
    if (gameProfileMatch) {
        const nameVal = gameProfileMatch[2];
        const ipVal = gameProfileMatch[3];
        let p = serverState.players.find(x => x.name.toLowerCase() === nameVal.toLowerCase());
        if (p) {
            p.uuid = gameProfileMatch[1];
            p.ip = ipVal;
        }
        if (ipVal && ipVal !== '0.0.0.0') {
            playerLastIp[nameVal.toLowerCase()] = ipVal;
            savePlayerLastIp();
        }
    }

    const leaveMatch = msg.match(/\[Server thread\/INFO\]: (.*?)(\[.*\])? left the game/);
    if (leaveMatch) {
        const name = leaveMatch[1].trim();
        let p = serverState.players.find(x => x.name.toLowerCase() === name.toLowerCase());
        if (p) p.online = false;
    }
}


function cleanupLingeringJava() {
    return new Promise((resolve) => {
        const cmd = 'wmic process where "name=\'java.exe\' and commandline like \'%server.jar%\'" get processid';
        exec(cmd, (err, stdout) => {
            if (stdout) {
                const pids = stdout.split('\n').map(l => l.trim()).filter(l => l && !isNaN(l) && l !== 'ProcessId');
                pids.forEach(pid => exec(`taskkill /f /pid ${pid} /t`));
                setTimeout(resolve, 2000);
            } else resolve();
        });
    });
}

function stopProcessSync() {
    return new Promise(async (resolve) => {
        if (!mcProcess) { await cleanupLingeringJava(); return resolve(); }
        try { mcProcess.stdin.write('stop\n'); } catch(e) { }
        let timer = setTimeout(async () => {
            if (mcProcess) {
                exec(`taskkill /f /pid ${mcProcess.pid} /t`);
                mcProcess = null;
                serverState.status = 'offline';
                resolve();
            }
        }, 8000);
        mcProcess.on('close', () => {
            clearTimeout(timer);
            mcProcess = null;
            serverState.status = 'offline';
            resolve();
        });
    });
}

app.get('/api/server/status', (req, res) => {
    const data = { ...serverState };
    data.uptimeMs = serverState.startTime ? (Date.now() - serverState.startTime) : 0;
    res.json(data);
});

app.get('/api/current-server', (req, res) => {
    res.json({ name: serverState.worldName || 'world' });
});

app.post('/api/create-world', async (req, res) => {
    if (creationStatus.status === 'running') {
        return res.status(400).json({ error: 'Ya hay una creación de mundo en curso.' });
    }
    createWorldFromRequest(req.body || {});
    res.json({ message: 'OK' });
});

app.get('/api/creation-status', (req, res) => {
    res.json(creationStatus);
});

async function getPlayerLocationFromNbt(playerName) {
    try {
        const serverPath = await getFirstServerPath();
        if (!serverPath) return null;
        const usercachePath = path.join(serverPath, 'usercache.json');
        if (!(await fs.pathExists(usercachePath))) return null;
        const cache = await fs.readJson(usercachePath);
        const entry = cache.find(c => c.name && c.name.toLowerCase() === playerName.toLowerCase());
        if (!entry || !entry.uuid) return null;
        const uuid = entry.uuid;
        const undashedUuid = uuid.replace(/-/g, '');
        const serverWorldName = serverState.worldName || 'world';
        
        // --- MULTI-PATH & MULTI-UUID SEARCH ---
        const possibleFiles = [uuid + '.dat', undashedUuid + '.dat'];
        const possibleDirs = [
            path.join(serverPath, serverWorldName, 'playerdata'),
            path.join(serverPath, 'playerdata'),
            path.join(serverPath, 'world', 'playerdata')
        ];

        let playerdataPath = null;
        for (const dir of possibleDirs) {
            for (const file of possibleFiles) {
                const fullPath = path.join(dir, file);
                if (await fs.pathExists(fullPath)) {
                    playerdataPath = fullPath;
                    break;
                }
            }
            if (playerdataPath) break;
        }

        if (!playerdataPath) {
            return { location: {x:0,y:0,z:0}, dimension: 'minecraft:overworld' };
        }

        const buf = await fs.readFile(playerdataPath);
        const { parsed } = await nbt.parse(buf);
        const simple = nbt.simplify(parsed);
        
        const toNum = (v) => (v && typeof v === 'object' && 'value' in v) ? Number(v.value) : Number(v);
        const toStr = (v) => (v && typeof v === 'object' && 'value' in v) ? String(v.value) : String(v);

        const location = { x: 0, y: 0, z: 0 };
        if (simple.Pos && Array.isArray(simple.Pos)) {
            location.x = Math.floor(toNum(simple.Pos[0]));
            location.y = Math.floor(toNum(simple.Pos[1]));
            location.z = Math.floor(toNum(simple.Pos[2]));
        }

        let dimension = 'minecraft:overworld';
        // Extreme search for dimension info in common NBT tags
        const dimKeys = ['Dimension', 'dimension', 'World', 'world', 'Dim', 'dim', 'MapDimension'];
        let foundDim = null;
        for (const key of dimKeys) {
            if (simple[key] !== undefined) {
                foundDim = toStr(simple[key]);
                break;
            }
        }

        if (foundDim !== null) {
            const val = foundDim.toLowerCase();
            if (val.includes('nether') || val === '-1') dimension = 'minecraft:the_nether';
            else if (val.includes('end') || val === '1') dimension = 'minecraft:the_end';
            else if (val.includes('overworld') || val === '0') dimension = 'minecraft:overworld';
            else dimension = foundDim; // Fallback for custom dimensions
        }

        const spawn = { x: 0, y: 0, z: 0 };
        if (simple.SpawnX != null) {
            spawn.x = toNum(simple.SpawnX);
            spawn.y = toNum(simple.SpawnY ?? 0);
            spawn.z = toNum(simple.SpawnZ ?? 0);
        }

        let lastDeath = null;
        let lastDeathDimension = 'minecraft:overworld';

        const ld = simple.LastDeathPos || simple.LastDeathLocation;
        if (ld) {
            if (Array.isArray(ld)) {
                // Formato antiguo: array puro [x, y, z] — sin dimensión guardada
                lastDeath = { x: Math.floor(toNum(ld[0])), y: Math.floor(toNum(ld[1])), z: Math.floor(toNum(ld[2])) };
            } else if (ld.pos && Array.isArray(ld.pos)) {
                // Formato 1.17+: { dimension: "minecraft:the_nether", pos: [x, y, z] }
                lastDeath = { x: Math.floor(toNum(ld.pos[0])), y: Math.floor(toNum(ld.pos[1])), z: Math.floor(toNum(ld.pos[2])) };
                if (ld.dimension) {
                    const dimRaw = toStr(ld.dimension).toLowerCase();
                    if (dimRaw.includes('nether')) lastDeathDimension = 'minecraft:the_nether';
                    else if (dimRaw.includes('end')) lastDeathDimension = 'minecraft:the_end';
                    else lastDeathDimension = toStr(ld.dimension);
                }
            } else if (ld.X !== undefined || ld.x !== undefined) {
                lastDeath = { x: Math.floor(toNum(ld.X ?? ld.x)), y: Math.floor(toNum(ld.Y ?? ld.y)), z: Math.floor(toNum(ld.Z ?? ld.z)) };
                if (ld.dimension) {
                    const dimRaw = toStr(ld.dimension).toLowerCase();
                    if (dimRaw.includes('nether')) lastDeathDimension = 'minecraft:the_nether';
                    else if (dimRaw.includes('end')) lastDeathDimension = 'minecraft:the_end';
                    else lastDeathDimension = toStr(ld.dimension);
                }
            }
        }
        
        return { location, dimension, spawn, lastDeath, lastDeathDimension };
    } catch (e) { 
        return { location: {x:0,y:0,z:0}, dimension: 'minecraft:overworld' }; 
    }
}

app.get('/api/server/player/:name/location', async (req, res) => {
    try {
        const name = (req.params.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Falta el nombre' });
        const loc = await getPlayerLocationFromNbt(name);
        
        if (loc) {
            let p = serverState.players.find(x => x.name.toLowerCase() === name.toLowerCase());
            if (p) {
                p.location = loc.location || p.location;
                p.dimension = loc.dimension || p.dimension;
            }
        }

        if (!loc) return res.json({ location: null, dimension: 'minecraft:overworld', spawn: null, lastDeath: null });
        res.json(loc);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/server/start', async (req, res) => {
    if (mcProcess) return res.status(400).json({ error: 'Ya encendido' });
    await cleanupLingeringJava();
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        serverState.logs = [];
        serverState.status = 'starting';
        mcProcess = spawn('java', ['-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: serverPath, shell: false });
        mcProcess.stdout.on('data', data => {
            data.toString().split('\n').forEach(line => {
                if (line.trim()) {
                    addLog(line.trim());
                    // Status Detection
                    if (line.includes('Done') || line.includes('For help, type "help"')) {
                        serverState.status = 'online';
                        if (!serverState.startTime) serverState.startTime = Date.now();
                    }
                    // Version Detection
                    if (line.includes('Starting minecraft server version')) {
                        const match = line.match(/version\s+([0-9.]+)/);
                        if (match) serverState.version = match[1];
                    }
                    // Software Detection
                    if (line.includes('This server is running')) {
                        if (line.includes('Paper')) serverState.software = 'Paper';
                        else if (line.includes('Spigot')) serverState.software = 'Spigot';
                        else if (line.includes('Forge')) serverState.software = 'Forge';
                    }
                    if (line.includes('Fabric Loader')) serverState.software = 'Fabric';
                    if (line.toLowerCase().includes('mohist')) serverState.software = 'Mohist';
                    if (line.toLowerCase().includes('purpur')) serverState.software = 'Purpur';

                }
            });
        });
        mcProcess.on('close', () => { 
            serverState.status = 'offline'; 
            mcProcess = null; 
            serverState.startTime = null;
            resetPlayersOnlineStatus();
        });
        // Set start time immediately when spawning as fallback
        serverState.startTime = Date.now();
        res.json({ message: 'OK' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/server/stop', async (req, res) => { await stopProcessSync(); res.json({ message: 'OK' }); });
app.post('/api/server/restart', async (req, res) => {
    await stopProcessSync();
    setTimeout(async () => {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        serverState.logs = [];
        serverState.status = 'starting';
        mcProcess = spawn('java', ['-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: serverPath, shell: false });
        mcProcess.stdout.on('data', data => {
            data.toString().split('\n').forEach(line => {
                if (line.trim()) {
                    addLog(line.trim());
                    if (line.includes('Done') || line.includes('For help, type "help"')) {
                        serverState.status = 'online';
                        if (!serverState.startTime) serverState.startTime = Date.now();
                    }
                    if (line.includes('Starting minecraft server version')) {
                        const match = line.match(/version\s+([0-9.]+)/);
                        if (match) serverState.version = match[1];
                    }
                    if (line.includes('This server is running')) {
                        if (line.includes('Paper')) serverState.software = 'Paper';
                        else if (line.includes('Spigot')) serverState.software = 'Spigot';
                        else if (line.includes('Forge')) serverState.software = 'Forge';
                    }
                    if (line.includes('Fabric Loader')) serverState.software = 'Fabric';
                    if (line.toLowerCase().includes('mohist')) serverState.software = 'Mohist';
                    if (line.toLowerCase().includes('purpur')) serverState.software = 'Purpur';


                }
            });
        });
        mcProcess.on('close', () => { 
            serverState.status = 'offline'; 
            mcProcess = null; 
            serverState.startTime = null;
            resetPlayersOnlineStatus();
        });
        serverState.startTime = Date.now();
    }, 1000);
    res.json({ message: 'OK' });
});

app.post('/api/server/ban-ip', async (req, res) => {
    try {
        const { name, ip } = req.body || {};
        if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Falta el nombre del jugador' });
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const banIpPath = path.join(serverPath, 'banned-ips.json');
        const clientIp = (ip && typeof ip === 'string' && ip.includes('.') && ip !== '0.0.0.0') ? ip : null;

        await loadPlayerLastIp();
        const targetIp = clientIp || playerLastIp[name.toLowerCase()] || null;
        if (!targetIp) return res.status(400).json({ error: 'Servidor apagado o IP no encontrada. Necesitas la IP del jugador (que se haya conectado alguna vez).' });

        if (mcProcess) {
            mcProcess.stdin.write(`ban-ip ${targetIp}\n`);
            // Cacheamos la IP sospechosa inmediatamente para que la UI no parpadee
            banIpByName[name.toLowerCase()] = targetIp;
            saveBanIpCache();
            // Refrescamos después de un tiempo para confirmar lo que Minecraft escribió
            setTimeout(refreshAllPlayers, 2500);
            return res.json({ message: 'OK' });
        }


        let bans = await fs.pathExists(banIpPath) ? await fs.readJson(banIpPath).catch(() => []) : [];
        if (bans.some(b => (b.ip || '') === targetIp)) return res.json({ message: 'OK' });
        bans.push({
            ip: targetIp,
            created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000',
            source: 'Server',
            expires: 'forever',
            reason: 'Banned by an operator.'
        });
        await fs.writeJson(banIpPath, bans, { spaces: 2 });
        banIpByName[name.toLowerCase()] = targetIp;
        saveBanIpCache();
        refreshAllPlayers();
        res.json({ message: 'OK' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/server/pardon-ip', async (req, res) => {
    try {
        const { name, ip } = req.body || {};
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const banIpPath = path.join(serverPath, 'banned-ips.json');
        let targetIp = ip;

        if (!targetIp && name) {
            if (name.includes('.')) targetIp = name;
            else {
                const player = serverState.players.find(p => p.name && p.name.toLowerCase() === name.toLowerCase());
                if (player && player.ip && player.ip.includes('.') && player.ip !== '0.0.0.0') targetIp = player.ip;
                if (!targetIp) { await loadPlayerLastIp(); targetIp = playerLastIp[name.toLowerCase()] || null; }
            }
            if (!targetIp && await fs.pathExists(banIpPath)) {
                const bans = await fs.readJson(banIpPath);
                const byName = bans.find(b => b.name && b.name.toLowerCase() === name.toLowerCase());
                if (byName && byName.ip) targetIp = byName.ip;
                else if (bans.length === 1 && bans[0].ip) targetIp = bans[0].ip;
            }
        }

        if (!targetIp || !targetIp.includes('.')) return res.status(400).json({ error: 'No se pudo resolver la IP' });

        if (mcProcess) {
            mcProcess.stdin.write(`pardon-ip ${targetIp}\n`);
            // Limpiar cache hoy mismo
            for (const k of Object.keys(banIpByName)) { if (banIpByName[k] === targetIp) delete banIpByName[k]; }
            if (name) delete banIpByName[name.toLowerCase()];
            saveBanIpCache();
            setTimeout(refreshAllPlayers, 2000);
            return res.json({ message: 'OK' });
        }

        if (await fs.pathExists(banIpPath)) {
            let bans = await fs.readJson(banIpPath);
            const before = bans.length;
            bans = bans.filter(b => (b.ip || '').toString() !== targetIp);
            if (bans.length < before) {
                await fs.writeJson(banIpPath, bans, { spaces: 2 });
                if (name) delete banIpByName[name.toLowerCase()];
                saveBanIpCache();
                refreshAllPlayers();
                return res.json({ message: 'OK' });
            }
        }
        res.status(404).json({ error: 'IP no encontrada en la lista de baneos' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/server/ban', async (req, res) => {
    try {
        const { name } = req.body || {};
        if (!name) return res.status(400).json({ error: 'Falta el nombre' });
        
        if (mcProcess) {
            mcProcess.stdin.write(`ban ${name}\n`);
            setTimeout(refreshAllPlayers, 2000);
            return res.json({ message: 'OK' });
        }

        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const banPath = path.join(serverPath, 'banned-players.json');
        const cachePath = path.join(serverPath, 'usercache.json');

        // Intentar obtener UUID del cache
        let uuid = null;
        if (await fs.pathExists(cachePath)) {
            const cache = await fs.readJson(cachePath).catch(() => []);
            const entry = cache.find(c => c.name && c.name.toLowerCase() === name.toLowerCase());
            if (entry) uuid = entry.uuid;
        }

        if (!uuid) return res.status(400).json({ error: 'No se encontró el UUID del jugador. El servidor debe estar encendido o el jugador haber entrado antes.' });

        let bans = await fs.pathExists(banPath) ? await fs.readJson(banPath).catch(() => []) : [];
        if (bans.some(b => b.uuid === uuid)) return res.json({ message: 'OK' });

        bans.push({
            uuid: uuid,
            name: name,
            created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000',
            source: 'Server',
            expires: 'forever',
            reason: 'Banned by an operator.'
        });

        await fs.writeJson(banPath, bans, { spaces: 2 });
        refreshAllPlayers();
        res.json({ message: 'OK' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/server/pardon', async (req, res) => {
    try {
        const { name } = req.body || {};
        if (!name) return res.status(400).json({ error: 'Falta el nombre' });

        if (mcProcess) {
            mcProcess.stdin.write(`pardon ${name}\n`);
            setTimeout(refreshAllPlayers, 2000);
            return res.json({ message: 'OK' });
        }

        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const banPath = path.join(serverPath, 'banned-players.json');

        if (await fs.pathExists(banPath)) {
            let bans = await fs.readJson(banPath);
            const before = bans.length;
            bans = bans.filter(b => b.name && b.name.toLowerCase() !== name.toLowerCase());
            if (bans.length < before) {
                await fs.writeJson(banPath, bans, { spaces: 2 });
                refreshAllPlayers();
                return res.json({ message: 'OK' });
            }
        }
        res.status(404).json({ error: 'Jugador no encontrado en la lista de baneos' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/server/command', async (req, res) => {
    let command = req.body.command;
    
    // OFFLINE SUPPORT FOR BASIC OPERATIONS
    if (!mcProcess) {
        try {
            const folders = await fs.readdir(config.SERVERS_ROOT);
            const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
            
            const handleList = async (cmdList, addAction, removeAction, file) => {
                const args = command.split(' ');
                if (cmdList.includes(args[0])) {
                    const isAdd = args[0] === addAction || (args[0] === cmdList[0] && args[1] === 'add');
                    const target = args[0] === 'op' || args[0] === 'deop' ? args[1] : args[2];
                    
                    if (target) {
                        const filePath = path.join(serverPath, file);
                        let list = await fs.pathExists(filePath) ? await fs.readJson(filePath).catch(()=>[]) : [];
                        const cachePath = path.join(serverPath, 'usercache.json');
                        let uuid = "Desconocido";
                        if (await fs.pathExists(cachePath)) {
                            const cache = await fs.readJson(cachePath).catch(()=>[]);
                            const entry = cache.find(c => c.name && c.name.toLowerCase() === target.toLowerCase());
                            if (entry) uuid = entry.uuid;
                        }
                        const before = list.length;
                        if (isAdd) {
                            if (!list.some(x => x.name && x.name.toLowerCase() === target.toLowerCase())) {
                                if (file === 'ops.json') list.push({ uuid, name: target, level: 4, bypassesPlayerLimit: false });
                                else list.push({ uuid, name: target });
                            }
                        } else {
                            list = list.filter(x => !(x.name && x.name.toLowerCase() === target.toLowerCase()));
                        }
                        
                        await fs.writeJson(filePath, list, { spaces: 2 });
                        setTimeout(refreshAllPlayers, 500);
                        return res.json({ message: 'OK' });
                    }
                }
                return false;
            };

            if (command.startsWith('whitelist ')) {
                if (await handleList(['whitelist'], 'add', 'remove', 'whitelist.json')) return;
            } else if (command.startsWith('op ') || command.startsWith('deop ')) {
                if (await handleList(['op', 'deop'], 'op', 'deop', 'ops.json')) return;
            }

            return res.status(400).json({ error: 'Apagado' });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }

    if (command.startsWith('pardon-ip ')) {
        const target = (command.split(' ')[1] || '').trim();
        if (target && !target.includes('.')) {
            try {
                const folders = await fs.readdir(config.SERVERS_ROOT);
                const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
                const banIpPath = path.join(serverPath, 'banned-ips.json');
                let resolvedIp = null;

                if (await fs.pathExists(banIpPath)) {
                    const bans = await fs.readJson(banIpPath);
                    const byName = bans.find(b => b.name && b.name.toLowerCase() === target.toLowerCase());
                    if (byName && byName.ip) resolvedIp = byName.ip;
                }
                if (!resolvedIp) {
                    const player = serverState.players.find(p => p.name && p.name.toLowerCase() === target.toLowerCase());
                    if (player && player.ip && player.ip.includes('.') && player.ip !== '0.0.0.0') resolvedIp = player.ip;
                }
                if (!resolvedIp && await fs.pathExists(banIpPath)) {
                    const bans = await fs.readJson(banIpPath);
                    if (bans.length === 1 && bans[0].ip) resolvedIp = bans[0].ip;
                }
                if (resolvedIp) command = `pardon-ip ${resolvedIp}`;
            } catch(e) {}
        }
    }

    mcProcess.stdin.write(command + '\n');
    setTimeout(refreshAllPlayers, 1000); 
    res.json({ message: 'Enviado' });
});

app.post('/api/server/properties', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const propPath = path.join(config.SERVERS_ROOT, folders[0], 'server.properties');
        
        // Cargar existentes para no borrarlas si no están en el UI
        let existingProps = {};
        if (await fs.pathExists(propPath)) {
            const content = await fs.readFile(propPath, 'utf-8');
            content.split('\n').forEach(line => {
                if (line.trim() && !line.startsWith('#')) {
                    const [key, ...val] = line.split('=');
                    if (key) existingProps[key.trim()] = val.join('=').trim();
                }
            });
        }

        // Mergear con las que vienen del UI
        for (let [key, val] of Object.entries(req.body)) {
            const realKey = propMapping[key] || key;
            existingProps[realKey] = val;
        }

        let content = "# MC props\n";
        for (let [key, val] of Object.entries(existingProps)) {
            content += `${key}=${val}\n`;
        }
        await fs.writeFile(propPath, content);
        loadRealTimeMetadata();
        res.json({ message: 'OK' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/server/properties', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const propPath = path.join(config.SERVERS_ROOT, folders[0], 'server.properties');
        const content = await fs.readFile(propPath, 'utf-8');
        const props = {};
        content.split('\n').forEach(line => {
            if (line.trim() && !line.startsWith('#')) {
                const [key, ...val] = line.split('=');
                const uiKey = Object.keys(propMapping).find(k => propMapping[k] === key.trim()) || key.trim();
                props[uiKey] = val.join('=').trim();
            }
        });
        res.json(props);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        if (folders.length === 0) return res.json([]);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const subPath = (req.query.path || '/').replace(/^\//, '');
        const targetDir = path.normalize(path.join(serverPath, subPath));

        if (!(await fs.pathExists(targetDir))) {
            console.error(`[FILES] Dir not found: ${targetDir}`);
            return res.status(404).json({ error: 'Ruta no encontrada' });
        }

        const items = await fs.readdir(targetDir);
        const result = [];

        for (const item of items) {
            const fullPath = path.join(targetDir, item);
            let stats;
            try { stats = await fs.stat(fullPath); } catch(e) { continue; }
            
            let sizeStr = '-';
            if (!stats.isDirectory()) {
                const s = stats.size;
                if (s === 0) sizeStr = '0 B';
                else if (s < 1024) sizeStr = s + ' B';
                else if (s < 1024 * 1024) sizeStr = (s / 1024).toFixed(1) + ' KB';
                else if (s < 1024 * 1024 * 1024) sizeStr = (s / (1024 * 1024)).toFixed(1) + ' MB';
                else sizeStr = (s / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
            }

            result.push({
                name: item,
                type: stats.isDirectory() ? 'folder' : 'file',
                size: sizeStr,
                date: stats.mtime.toISOString().replace(/T/, ' ').substring(0, 16)
            });
        }
        res.json(result);
    } catch (e) { 
        console.error(`[FILES] Error listing path:`, e);
        res.status(500).json({ error: e.message }); 
    }
});

const { IncomingForm } = require('formidable');

app.post('/api/upload', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const subPath = (req.query.path || '/').replace(/^\//, '');
        const targetDir = path.join(serverPath, subPath);

        const form = new IncomingForm({ uploadDir: targetDir, keepExtensions: true, multiples: true });
        form.parse(req, async (err, fields, files) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const fileArray = Array.isArray(files.file) ? files.file : [files.file];
            for (const f of fileArray) {
                if (!f) continue;
                const newPath = path.join(targetDir, f.originalFilename);
                await fs.move(f.filepath, newPath, { overwrite: true });
            }
            res.json({ message: 'OK' });
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files/download', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const subPath = (req.query.path || '').replace(/^\//, '');
        const targetFile = path.join(serverPath, subPath);

        if (!(await fs.pathExists(targetFile))) return res.status(404).json({ error: 'Archivo no encontrado' });
        res.download(targetFile);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/files/delete', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const { path: subPath } = req.body;
        const target = path.join(serverPath, (subPath || '').replace(/^\//, ''));

        if (!(await fs.pathExists(target))) return res.status(404).json({ error: 'No existe' });
        await fs.remove(target);
        res.json({ message: 'OK' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/files/rename', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const { oldPath, newPath } = req.body;
        
        const oldTarget = path.join(serverPath, (oldPath || '').replace(/^\//, ''));
        const newTarget = path.join(serverPath, (newPath || '').replace(/^\//, ''));

        if (!(await fs.pathExists(oldTarget))) return res.status(404).json({ error: 'No existe' });
        await fs.move(oldTarget, newTarget);
        res.json({ message: 'OK' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/files/create-folder', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const { path: subPath, name } = req.body;
        const target = path.join(serverPath, (subPath || '').replace(/^\//, ''), name);

        await fs.ensureDir(target);
        res.json({ message: 'OK' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files/content', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT).catch(() => []);
        if (folders.length === 0) return res.status(404).json({ error: 'Servidor no encontrado' });
        
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const subPath = (req.query.path || '').replace(/^\//, '');
        const target = path.normalize(path.join(serverPath, subPath));

        if (!(await fs.pathExists(target))) {
            console.error(`[FILES-CONTENT] Not found: ${target}`);
            return res.status(404).json({ error: 'El archivo no existe en el disco' });
        }
        
        const stats = await fs.stat(target);
        if (stats.isDirectory()) return res.status(400).json({ error: 'No se puede editar una carpeta' });
        if (stats.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'Archivo demasiado grande para el editor (máximo 2MB)' });

        const content = await fs.readFile(target, 'utf-8');
        res.json({ content });
    } catch (e) { 
        console.error(`[FILES-CONTENT] Error:`, e);
        res.status(500).json({ error: 'Error del sistema al leer: ' + e.message }); 
    }
});

app.post('/api/files/content', async (req, res) => {
    try {
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        const { path: subPath, content } = req.body;
        const target = path.join(serverPath, (subPath || '').replace(/^\//, ''));

        await fs.writeFile(target, content, 'utf-8');
        res.json({ message: 'OK' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Iniciar caches y arrancar
(async () => {
    await loadBanIpCache();
    await loadPlayerLastIp();
    await loadWorldName();
    await peekLogsForMetadata();
    app.listen(config.PORT, () => console.log(`[MARCTERNOS-API] Ready on ${config.PORT}`));
})();

