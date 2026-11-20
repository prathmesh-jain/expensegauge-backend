import express from 'express'
import {
  addMember,
  createGroup,
  getGroup,
  joinGroup,
  leaveGroup,
  listGroups,
  listInvitations,
  lookupEmail,
  respondToInvitation,
  previewInvite,
  removeMember,
  rotateInviteCode,
  setGroupNotifications,
  updateGroup,
} from '../controllers/groupController.js'
import {
  addGroupExpense,
  deleteGroupExpense,
  updateGroupExpense,
} from '../controllers/groupExpenseController.js'
import {
  addSettlement,
  deleteSettlement,
  getActivity,
  getGroupSummary,
  getSettlePlan,
} from '../controllers/settlementController.js'

const router = express.Router()

router.get('/', listGroups)
router.post('/', createGroup)
// Fixed paths before /:id
router.get('/invite/:code', previewInvite)
router.post('/join', joinGroup)
router.post('/lookup-email', lookupEmail)
router.get('/invitations', listInvitations)
router.post('/:id/invitation', respondToInvitation)
router.get('/:id', getGroup)
router.patch('/:id', updateGroup)
router.post('/:id/members', addMember)
router.delete('/:id/members/:memberId', removeMember)
router.post('/:id/invite/rotate', rotateInviteCode)
router.patch('/:id/notifications', setGroupNotifications)
router.post('/:id/leave', leaveGroup)
router.post('/:id/expenses', addGroupExpense)
router.patch('/:id/expenses/:expenseId', updateGroupExpense)
router.delete('/:id/expenses/:expenseId', deleteGroupExpense)
router.get('/:id/activity', getActivity)
router.get('/:id/settle-plan', getSettlePlan)
router.get('/:id/summary', getGroupSummary)
router.post('/:id/settlements', addSettlement)
router.delete('/:id/settlements/:settlementId', deleteSettlement)

export default router
