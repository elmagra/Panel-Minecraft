const axios = require('axios');
const fs = require('fs-extra');

/**
 * Downloads a file with progress tracking
 */
async function downloadFile(url, dest, onProgress) {
    const { data, headers } = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });

    const totalLength = headers['content-length'];
    let downloadedLength = 0;

    const writer = fs.createWriteStream(dest);

    return new Promise((resolve, reject) => {
        data.on('data', (chunk) => {
            downloadedLength += chunk.length;
            if (onProgress && totalLength) onProgress((downloadedLength / totalLength) * 100);
        });

        data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

module.exports = {
    downloadFile
};
