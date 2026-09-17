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
}, { timestamps: true })

export default mongoose.model("users", userSchema)