import express from 'express'
import {
    requestAccountDeletion,
    verifyDeletionToken,
    confirmAccountDeletion,
    getPublicInvitePreview
} from '../controllers/publicController.js'

const router = express.Router()

router.post('/request-account-deletion', requestAccountDeletion)
router.post('/verify-deletion-token', verifyDeletionToken)
router.post('/confirm-account-deletion', confirmAccountDeletion)
router.get('/invite/:code', getPublicInvitePreview)

export default router
