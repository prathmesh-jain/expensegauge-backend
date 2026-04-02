import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import User from '../models/userModel.js'
import dotenv from 'dotenv'
import { sendEmail } from '../utils/emailService.js'
import { OAuth2Client } from "google-auth-library"
import crypto from 'crypto';
dotenv.config()
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);


export const signup = async (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) return res.status(403).send("Please enter all details")

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
        return res.status(400).send({ "message": "Password does not meet policy requirements" })
    }
    if (await User.findOne({ email })) {
        return res.status(400).send({ "message": "Email already exists" })
    }
    const saltrounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltrounds);
    const newuser = new User({
        name,
        email,
        password: hashedPassword,
        role
    })
    const accessToken = jwt.sign(
        { userId: newuser._id, role: role },
        process.env.ACCESS_SECRET,
        { "expiresIn": "1Hour" }
    )
    const refreshToken = jwt.sign(
        { userId: newuser._id },
        process.env.REFRESH_SECRET,
        { "expiresIn": "30days" }
    )
    newuser.refreshTokens.push({ token: refreshToken });
    await newuser.save();

    return res.status(200).send({ accessToken, refreshToken, name: newuser.name, email: newuser.email, role: newuser.role, profilePicture: newuser.profilePicture })
}

export const login = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(403).send("Please enter all details")


    const user = await User.findOne({ email })
    if (!user) {
        return res.status(404).send({ "message": "User does not exist" })
    }
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
        return res.status(401).send({ "code": "INVALID_PASSWORD", "message": "Invalid email or password" })
    }
    const accessToken = jwt.sign(
        { userId: user._id, role: user.role },
        process.env.ACCESS_SECRET,
        { "expiresIn": "1Hour" }
    )
    const refreshToken = jwt.sign(
        { userId: user._id },
        process.env.REFRESH_SECRET,
        { "expiresIn": "30days" }
    )
    user.refreshTokens.push({ token: refreshToken });
    if (user.refreshTokens.length > 5) {
        user.refreshTokens.shift(); // remove oldest
    }
    await user.save();

    return res.status(200).send({ accessToken, refreshToken, name: user.name, email: user.email, role: user.role, profilePicture: user.profilePicture })
}


export const upgradeToAdmin = async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).send({ message: 'User not found' });
        }

        if (user.admin) {
            return res.status(403).send({ message: 'Managed users cannot register as admin. Please create a new account to access admin privileges.' });
        }

        if (user.role === 'admin') {
            return res.status(200).send({
                message: 'Already an admin',
                name: user.name,
                email: user.email,
                role: user.role,
                profilePicture: user.profilePicture
            });
        }

        user.role = 'admin';

        const accessToken = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.ACCESS_SECRET,
            { expiresIn: '1h' }
        );

        const refreshToken = jwt.sign(
            { userId: user._id },
            process.env.REFRESH_SECRET,
            { expiresIn: '30d' }
        );

        user.refreshTokens.push({ token: refreshToken });
        if (user.refreshTokens.length > 5) {
            user.refreshTokens.shift();
        }

        await user.save();

        return res.status(200).send({
            message: 'Upgraded to admin',
            accessToken,
            refreshToken,
            name: user.name,
            email: user.email,
            role: user.role,
            profilePicture: user.profilePicture,
        });
    } catch (error) {
        console.error(error);
        return res.status(500).send({ message: 'Failed to upgrade to admin' });
    }
}

export const googleAuth = async (req, res) => {
    try {
        const { idToken } = req.body;

        if (!idToken)
            return res.status(400).json({ message: "Missing Google token" });

        // Verify Google token
        const ticket = await client.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        const email = payload.email;
        const name = payload.name;
        // Check for role in request body, default to "user"
        const requestedRole = req.body.role || "user";

        // Find or Create user
        let user = await User.findOne({ email });

        if (!user) {
            const fakePassword = crypto.randomBytes(32).toString("hex");
            const hashedPassword = await bcrypt.hash(fakePassword, 10);

            user = await User.create({
                name,
                email,
                password: hashedPassword, // required by schema
                role: requestedRole,
                provider: "google",
                profilePicture: payload.picture // Saving Google Avatar
            });
        }
        else {
            // Update existing user picture if from google
            if (user.provider === "google") {
                user.profilePicture = payload.picture;
                await user.save();
            }
        }

        // Generate Access Token
        const accessToken = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.ACCESS_SECRET,
            { expiresIn: "1h" }
        );

        // Generate Refresh Token
        const refreshToken = jwt.sign(
            { userId: user._id },
            process.env.REFRESH_SECRET,
            { expiresIn: "30d" }
        );

        user.refreshTokens.push({ token: refreshToken });
        if (user.refreshTokens.length > 5) {
            user.refreshTokens.shift(); // remove oldest
        }

        await user.save();

        res.status(200).json({
            accessToken,
            refreshToken,
            name: user.name,
            email: user.email,
            role: user.role,
            profilePicture: user.profilePicture
        });

    } catch (err) {
        console.error("GOOGLE AUTH ERROR:", err);
        res.status(401).json({ message: "Invalid Google token" });
    }
};


export const verifyAccess = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.sendStatus(401);

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.ACCESS_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        console.log(err);
        return res.sendStatus(401); // Token expired/invalid
    }
};

export const refresh = async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) return res.sendStatus(401);

    try {
        const decoded = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
        const user = await User.findById(decoded.userId)

        if (!user) return res.sendStatus(403);

        // Check if refreshToken exists in DB
        const tokenIndex = user.refreshTokens.findIndex(rt => rt.token === refreshToken);
        if (tokenIndex === -1) return res.sendStatus(403); // token reuse/invalid

        // Rotate: remove old, issue new
        user.refreshTokens.splice(tokenIndex, 1); // remove old
        const newRefreshToken = jwt.sign(
            { userId: user._id },
            process.env.REFRESH_SECRET,
            { expiresIn: '30d' }
        );
        user.refreshTokens.push({ token: newRefreshToken });

        await user.save();

        const newAccessToken = jwt.sign(
            { userId: user._id, role: user.role },
            process.env.ACCESS_SECRET,
            { expiresIn: '15m' }
        );

        res.status(200).json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
    } catch (err) {
        return res.sendStatus(403); // Token expired/invalid
    }
}

export const requestPasswordResetOTP = async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ message: 'Please provide an email.' });
    }

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'User with that email does not exist.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
        user.otp = otp;
        user.otpExpires = new Date(Date.now() + 10 * 60 * 1000); // OTP valid for 10 minutes
        await user.save();

        await sendEmail({
            to: user.email,
            subject: "ExpenseGauge Password Reset OTP",
            text: `Hello ${user.name},

            Your OTP for password reset is: ${otp}
            This OTP is valid for 10 minutes.

            If you did not request this, please ignore this email.

            Best regards,
            The ExpenseGauge Team`,
            html: `
            <div style="font-family: Arial, sans-serif; background-color: #f7f9fb; padding: 20px;">
                <div style="max-width: 500px; background: #ffffff; border-radius: 10px; margin: auto; box-shadow: 0 2px 6px rgba(0,0,0,0.1); overflow: hidden;">
                <div style="background-color: #3a6df0; padding: 20px; text-align: center;">
                    <img src="https://expensegauge.vercel.app/icon2.png" alt="ExpenseGauge Logo" width="80" height="auto" />
                    <h2 style="color: white; margin: 10px 0 0;">ExpenseGauge</h2>
                </div>
                <div style="padding: 25px; color: #333;">
                    <p>Hello <b>${user.name}</b>,</p>
                    <p>Your One-Time Password (OTP) for resetting your ExpenseGauge password is:</p>
                    <p style="font-size: 22px; color: #3a6df0; font-weight: bold; letter-spacing: 2px;">${otp}</p>
                    <p>This OTP is valid for <b>10 minutes</b>.</p>
                    <p>If you did not request this, please ignore this email.</p>
                    <p style="margin-top: 25px;">Best regards,<br><b>The ExpenseGauge Team</b></p>
                </div>
                <div style="background: #f0f3fa; text-align: center; padding: 10px; font-size: 12px; color: #777;">
                    © ${new Date().getFullYear()} ExpenseGauge. All rights reserved.
                </div>
                </div>
            </div>
  `,
        });
        res.status(200).json({ message: 'OTP sent to your email address.' });
    } catch (error) {
        console.error('Request password reset OTP error:', error);
        res.status(500).json({ message: 'Error sending OTP. Please try again later.' });
    }
};

export const resetPassword = async (req, res) => {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
        return res.status(400).json({ message: 'Please provide all required fields.' });
    }

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        if (user.otp !== otp || user.otpExpires < new Date()) {
            return res.status(400).json({ message: 'Invalid or expired OTP.' });
        }
        if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
            return res.status(400).json({ message: 'Password does not meet policy requirements.' });
        }

        const saltrounds = 10;
        user.password = await bcrypt.hash(newPassword, saltrounds);
        user.otp = undefined; // Clear OTP after successful reset
        user.otpExpires = undefined;
        await user.save();

        res.status(200).json({ message: 'Password reset successfully.' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
};

export const changePassword = async (req, res) => {
    try {

        const { oldPassword, newPassword } = req.body;
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).send({ "message": "User does not exist" })
        }
        const passwordMatch = await bcrypt.compare(oldPassword, user.password);
        if (!passwordMatch) {
            return res.status(401).send({ "code": "INVALID_CURRENT_PASSWORD", "message": "Invalid old password" })
        }
        const saltrounds = 10;
        const hashedNewPassword = await bcrypt.hash(newPassword, saltrounds);
        user.password = hashedNewPassword;
        await user.save();

        return res.status(200).json({ message: 'Password changed successfully' });
    } catch (error) {
        return res.status(500).json({ message: 'Internal server error' });
    }
}

export const updateProfile = async (req, res) => {
    try {
        const { name } = req.body;
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).send({ message: "User not found" });

        if (name) user.name = name;
        // Future: Handle image upload here if we support manual photo upload

        await user.save();
        res.status(200).json({ message: "Profile updated successfully", name: user.name, profilePicture: user.profilePicture });
    } catch (error) {
        res.status(500).json({ message: "Error updating profile" });
    }
}

export const logout = async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.sendStatus(400);

    try {
        const payload = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
        const user = await User.findById(payload.userId);
        if (!user) return res.sendStatus(403);

        user.refreshTokens = user.refreshTokens.filter(rt => rt.token !== refreshToken);
        await user.save();

        res.sendStatus(204);
    } catch (err) {
        res.sendStatus(403);
    }
};