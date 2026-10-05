import express from 'express'
import {
    requestAccountDeletion,
    verifyDeletionToken,
    confirmAccountDeletion
} from '../controllers/publicController.js'

const router = express.Router()

router.post('/request-account-deletion', requestAccountDeletion)
router.post('/verify-deletion-token', verifyDeletionToken)
router.post('/confirm-account-deletion', confirmAccountDeletion)

export default router
