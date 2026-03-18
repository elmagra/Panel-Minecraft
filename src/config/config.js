const path = require('path');

module.exports = {
    PORT: process.env.PORT || 3000,
    SERVERS_ROOT: path.join(__dirname, '../../data/servers'),
    PANEL_ROOT: path.join(__dirname, '../../'),
    JAVA_PATH: 'C:\\Program Files\\Microsoft\\jdk-21.0.10.7-hotspot\\bin\\java.exe' // Ruta instalada con winget
};
