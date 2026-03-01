import mongoose from 'mongoose';

const updateSchema = new mongoose.Schema({
    platform: {
        type: String,
        required: true,
        enum: ['android', 'ios'],
    },
    latestAppVersion: {
        type: String,
        required: true,
    },
    minAppVersion: {
        type: String,
        required: true,
    },
    latestOtaVersion: {
        type: String,
        required: true,
    },
    forceUpdate: {
        type: Boolean,
        default: false,
    },
    updateType: {
        type: String,
        enum: ['OTA', 'APK', 'PlayStore', 'none'],
        default: 'none',
    },
    apkUrl: String,
    playStoreUrl: String,
}, { timestamps: true });

export default mongoose.model('Update', updateSchema);
