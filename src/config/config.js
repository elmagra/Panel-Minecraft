const path = require('path');

module.exports = {
    PORT: process.env.PORT || 3000,
    SERVERS_ROOT: path.join(__dirname, '../../data/servers'),
    PANEL_ROOT: path.join(__dirname, '../../'),
    JAVA_PATH: 'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe' // Ruta corregida según el sistema del usuario
};
