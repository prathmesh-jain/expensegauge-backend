import express from 'express'
import {
    changePassword,
    login,
    logout,
    refresh,
    requestPasswordResetOTP,
    resetPassword,
    signup,
    verifyAccess,
    googleAuth,
    updateProfile,
    upgradeToAdmin
} from '../controllers/userController.js'

const router = express.Router()

router.post('/signup', signup)
router.post('/login', login)
router.post("/google-login", googleAuth);
router.post('/logout', logout)
router.post('/changePassword', verifyAccess, changePassword)
router.post('/refresh', refresh)
router.post('/upgrade-to-admin', verifyAccess, upgradeToAdmin)
router.post('/forgotPassword/requestOtp', requestPasswordResetOTP);
router.post('/forgotPassword/reset', resetPassword);
router.put('/update-profile', verifyAccess, updateProfile);

export default router