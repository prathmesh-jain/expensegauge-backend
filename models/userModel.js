import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    profilePicture: {
        type: String,
        default: ""
    },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        match: [/^\S+@\S+\.\S+$/, 'Please use a valid email address.']
    },
    password: {
        type: String,
        required: true,
    },
    admin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'users',
    },
    role: {
        type: String,
        required: true
    },
    netBalance: {
        type: Number,
        default: 0
    },
    refreshTokens: [{ token: String }],
    otp: String,
    otpExpires: Date,
    adminRequested: {
        type: Boolean,
        default: false
    },
    adminRequestedAt: Date,
    // Expo push tokens, one per device the user is signed in on
    pushTokens: [{ token: String, updatedAt: Date }],
    // Account-wide off switch for group pushes. Each group is still opt-in on its own (member.notify).
    notifyGroups: {
        type: Boolean,
        default: true
    },
}, { timestamps: true })

export default mongoose.model("users", userSchema)