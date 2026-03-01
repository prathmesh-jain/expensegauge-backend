import Update from '../models/updateModel.js';

export const checkUpdate = async (req, res) => {
    try {
        const clientAppVersion = req.headers['x-app-version'];
        const clientOtaVersion = req.headers['x-ota-version'];
        const platform = req.headers['x-platform'];

        if (!clientAppVersion || !platform) {
            return res.status(400).json({ message: 'Missing version headers' });
        }

        const config = await Update.findOne({ platform });

        if (!config) {
            return res.json({ updateAvailable: false });
        }

        // Check for Force Update / APK Update
        const isMinVersionMet = compareVersions(clientAppVersion, config.minAppVersion) >= 0;
        const isNewAppVersionAvailable = compareVersions(config.latestAppVersion, clientAppVersion) > 0;

        if (!isMinVersionMet || (config.forceUpdate && isNewAppVersionAvailable)) {
            return res.json({
                updateAvailable: true,
                updateType: config.updateType,
                forceUpdate: true,
                latestAppVersion: config.latestAppVersion,
                apkUrl: config.apkUrl,
                playStoreUrl: config.playStoreUrl,
                message: 'A critical update is required.',
            });
        }

        // Check for OTA Update
        if (config.latestOtaVersion && clientOtaVersion !== config.latestOtaVersion) {
            return res.json({
                updateAvailable: true,
                updateType: 'OTA',
                forceUpdate: false,
                latestOtaVersion: config.latestOtaVersion,
                message: 'A new background update is available.',
            });
        }

        // Normal APK Update (not forced)
        if (isNewAppVersionAvailable) {
            return res.json({
                updateAvailable: true,
                updateType: config.updateType,
                forceUpdate: false,
                latestAppVersion: config.latestAppVersion,
                apkUrl: config.apkUrl,
                playStoreUrl: config.playStoreUrl,
                message: 'A new version of the app is available.',
            });
        }

        return res.json({ updateAvailable: false });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Simple version comparison helper
// Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
function compareVersions(v1, v2) {
    const parts1 = (v1 || '0').split('.').map(Number);
    const parts2 = (v2 || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}
