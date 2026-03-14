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
    maxPlayers: 20,
    worldName: 'Cargando...',
    software: 'Detectando...',
    version: '...',
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

// Monitor de recursos
setInterval(() => {
    osUtils.cpuUsage((v) => { serverState.cpu = Math.round(v * 100); });
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    serverState.ram = Math.round(((totalMem - freeMem) / totalMem) * 100);
    serverState.ramUsedGB = ((totalMem - freeMem) / (1024 * 1024 * 1024)).toFixed(1);
    serverState.ramTotalGB = (totalMem / (1024 * 1024 * 1024)).toFixed(0);
}, 2000);

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
                const motdMatch = content.match(/motd=(.*)/);
                if (motdMatch) serverState.software = motdMatch[1].replace(/\\:/g, ':').replace(/§[0-9a-f-k-r]/g, '').trim();
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
        serverState.version = msg.split('version')[1]?.trim();
    }

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

app.get('/api/server/status', (req, res) => res.json(serverState));

app.get('/api/current-server', (req, res) => {
    res.json({ name: serverState.worldName || 'world' });
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
        const serverWorldName = serverState.worldName || 'world';
        let playerdataPath = path.join(serverPath, serverWorldName, 'playerdata', uuid + '.dat');
        
        if (!(await fs.pathExists(playerdataPath))) {
            playerdataPath = path.join(serverPath, 'playerdata', uuid + '.dat');
        }

        if (!(await fs.pathExists(playerdataPath))) return null;

        const buf = await fs.readFile(playerdataPath);
        const { parsed } = await nbt.parse(buf);
        const simple = nbt.simplify(parsed);
        
        const toNum = (v) => (v && typeof v === 'object' && 'value' in v) ? Number(v.value) : Number(v);
        
        const location = { x: 0, y: 0, z: 0 };
        if (simple.Pos && Array.isArray(simple.Pos)) {
            location.x = Math.floor(toNum(simple.Pos[0]));
            location.y = Math.floor(toNum(simple.Pos[1]));
            location.z = Math.floor(toNum(simple.Pos[2]));
        }

        const spawn = { x: 0, y: 0, z: 0 };
        if (simple.SpawnX != null) {
            spawn.x = toNum(simple.SpawnX);
            spawn.y = toNum(simple.SpawnY ?? 0);
            spawn.z = toNum(simple.SpawnZ ?? 0);
        }

        let lastDeath = null;
        const ld = simple.LastDeathPos || simple.LastDeathLocation;
        if (ld) {
            if (Array.isArray(ld)) {
                lastDeath = { x: Math.floor(toNum(ld[0])), y: Math.floor(toNum(ld[1])), z: Math.floor(toNum(ld[2])) };
            } else if (ld.pos && Array.isArray(ld.pos)) {
                lastDeath = { x: Math.floor(toNum(ld.pos[0])), y: Math.floor(toNum(ld.pos[1])), z: Math.floor(toNum(ld.pos[2])) };
            } else if (ld.X !== undefined || ld.x !== undefined) {
                lastDeath = { x: Math.floor(toNum(ld.X ?? ld.x)), y: Math.floor(toNum(ld.Y ?? ld.y)), z: Math.floor(toNum(ld.Z ?? ld.z)) };
            }
        }

        return { location, spawn, lastDeath };
    } catch (e) { 
        console.error("NBT Error:", e);
        return null; 
    }
}

app.get('/api/server/player/:name/location', async (req, res) => {
    try {
        const name = (req.params.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Falta el nombre' });
        const loc = await getPlayerLocationFromNbt(name);
        if (!loc) return res.json({ location: null, spawn: null, lastDeath: null });
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
                    if (line.includes('Done')) serverState.status = 'online';
                }
            });
        });
        mcProcess.on('close', () => { serverState.status = 'offline'; mcProcess = null; });
        res.json({ message: 'OK' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/server/stop', async (req, res) => { await stopProcessSync(); res.json({ message: 'OK' }); });
app.post('/api/server/restart', async (req, res) => {
    await stopProcessSync();
    setTimeout(async () => {
        // Ejecutamos la lógica de start manualmente o llamamos a una función
        const folders = await fs.readdir(config.SERVERS_ROOT);
        const serverPath = path.join(config.SERVERS_ROOT, folders[0]);
        serverState.logs = [];
        serverState.status = 'starting';
        mcProcess = spawn('java', ['-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: serverPath, shell: false });
        mcProcess.stdout.on('data', data => {
            data.toString().split('\n').forEach(line => {
                if (line.trim()) {
                    addLog(line.trim());
                    if (line.includes('Done')) serverState.status = 'online';
                }
            });
        });
        mcProcess.on('close', () => { serverState.status = 'offline'; mcProcess = null; });
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

        if (mcProcess) {
            mcProcess.stdin.write(`ban-ip ${name}\n`);
            // Cacheamos la IP sospechosa inmediatamente para que la UI no parpadee
            if (clientIp) {
                banIpByName[name.toLowerCase()] = clientIp;
                saveBanIpCache();
            }
            // Refrescamos después de un tiempo para confirmar lo que Minecraft escribió
            setTimeout(refreshAllPlayers, 2500);
            return res.json({ message: 'OK' });
        }

        await loadPlayerLastIp();
        const targetIp = clientIp || playerLastIp[name.toLowerCase()] || null;
        if (!targetIp) return res.status(400).json({ error: 'Servidor apagado. Necesitas la IP del jugador (conéctate al menos una vez o enciende el servidor).' });
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

app.post('/api/server/command', async (req, res) => {
    if (!mcProcess) return res.status(400).json({ error: 'Apagado' });
    let command = req.body.command;

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
        const targetDir = path.join(serverPath, subPath);

        if (!(await fs.pathExists(targetDir))) return res.status(404).json({ error: 'Ruta no encontrada' });

        const items = await fs.readdir(targetDir);
        const result = [];

        for (const item of items) {
            const fullPath = path.join(targetDir, item);
            const stats = await fs.stat(fullPath);
            result.push({
                name: item,
                type: stats.isDirectory() ? 'folder' : 'file',
                size: stats.isDirectory() ? '-' : (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
                date: stats.mtime.toISOString().replace(/T/, ' ').substring(0, 16)
            });
        }
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
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
            
            // Mover archivos a su nombre original
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

// Iniciar caches y arrancar
(async () => {
    await loadBanIpCache();
    await loadPlayerLastIp();
    app.listen(config.PORT, () => console.log(`[MARCTERNOS-API] Ready on ${config.PORT}`));
})();

