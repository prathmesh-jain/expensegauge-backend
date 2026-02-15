import express from 'express'
import { assignBalance, deleteUser, edituserExpense, getAllUsers, getUserExpenses, registerUser, removeUserExpense } from '../controllers/adminController.js'
import { getMonthlyStats } from '../controllers/statsController.js'

const router = express.Router()

router.get('/users', getAllUsers)
router.post('/stats/user', getMonthlyStats) // Re-using the same controller, it expects body.userId 
router.get('/expenses/:userId', getUserExpenses)
router.post('/registeruser', registerUser)
router.delete('/delete/:userId', deleteUser)
router.delete('/expense/:userId/:id', removeUserExpense)
router.patch('/expense/:userId/:id', edituserExpense)
router.post('/assignBalance/:userId', assignBalance)

export default router