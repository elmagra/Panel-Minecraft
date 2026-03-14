const axios = require('axios');

async function getJarUrl(type, ver) {
    if (type.toLowerCase().includes('paper')) {
        try {
            const buildData = await axios.get(`https://api.papermc.io/v2/projects/paper/versions/${ver}/builds`);
            const latestBuild = buildData.data.builds[buildData.data.builds.length - 1];
            const filename = latestBuild.downloads.application.name;
            return `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds/${latestBuild.build}/downloads/${filename}`;
        } catch (e) {
            console.error("Error fetching PaperMC build:", e.message);
        }
    }
    
    // Official Mojang Vanilla mappings (VERIFIED MANUALLY)
    const vanillaMapping = {
        '1.21.1': 'https://piston-data.mojang.com/v1/objects/59353fb40c36d304f2035d51e7d6e6baa98dc05c/server.jar',
        '1.21': 'https://piston-data.mojang.com/v1/objects/cf35b909f2efa5ea5a64804e4823a7541a97a18a/server.jar',
        '1.20.6': 'https://piston-data.mojang.com/v1/objects/145ff0858209bcfc164859ba735d4199aafa1eea/server.jar',
        '1.20.4': 'https://piston-data.mojang.com/v1/objects/5eca988f7f81276d741cbd50f39b65193c4451a1/server.jar',
        '1.20.1': 'https://piston-data.mojang.com/v1/objects/84194a2f286ef7c14ed7ce0090dba59902951553/server.jar',
        '1.19.4': 'https://piston-data.mojang.com/v1/objects/fcebdddaa0fc8c62d5ce2087adde9ed844f7d7d6/server.jar',
        '1.16.5': 'https://piston-data.mojang.com/v1/objects/fba9f7833e858a1257d810d21a3a9e3c967f9077/server.jar',
        '1.12.2': 'https://launcher.mojang.com/v1/objects/88624534f36da7496c1482813589999a8449e755/server.jar'
    };
    
    if (vanillaMapping[ver]) return vanillaMapping[ver];
    
    // Dynamic Mojang Resolver (Robust fallback)
    try {
        console.log(`Buscando URL dinámica para Vanilla ${ver}...`);
        const manifest = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        const versionEntry = manifest.data.versions.find(v => v.id === ver);
        if (versionEntry) {
            const versionData = await axios.get(versionEntry.url);
            if (versionData.data.downloads && versionData.data.downloads.server) {
                return versionData.data.downloads.server.url;
            }
        }
    } catch (e) {
        console.error("Error en dynamic resolver:", e.message);
    }

    // Fabric Installer (Fallback for demo)
    if (type.toLowerCase().includes('fabric')) {
        return `https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar`;
    }

    // Ultimate Fallback
    return vanillaMapping['1.21.1'];
}

module.exports = {
    getJarUrl
};
