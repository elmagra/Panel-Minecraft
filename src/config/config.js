const path = require('path');

module.exports = {
    PORT: process.env.PORT || 3000,
    SERVERS_ROOT: path.join(__dirname, '../../data/servers'),
    PANEL_ROOT: path.join(__dirname, '../../')
};
