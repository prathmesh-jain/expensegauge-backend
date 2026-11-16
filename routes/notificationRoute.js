import express from 'express'
import {
  getNotificationSettings,
  registerPushToken,
  unregisterPushToken,
  updateNotificationSettings,
} from '../controllers/notificationController.js'

const router = express.Router()

router.post('/register', registerPushToken)
router.post('/unregister', unregisterPushToken)
router.get('/settings', getNotificationSettings)
router.patch('/settings', updateNotificationSettings)

export default router
