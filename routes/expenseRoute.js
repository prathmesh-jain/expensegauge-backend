import express from 'express'
import { addExpense, editExpense, getExpenses, removeExpense } from '../controllers/expenseController.js'
import { generateReport } from '../controllers/reportController.js'
import { getExpenseAnalytics, getMonthlyStats } from '../controllers/statsController.js'

const router = express.Router()

router.post('/add', addExpense)
router.get('/get-expense/', getExpenses)
router.get('/stats/monthly', getMonthlyStats)
router.get('/stats/analytics', getExpenseAnalytics)
router.delete('/:id', removeExpense)
router.patch('/:id', editExpense)
router.post('/report/generate', generateReport)

export default router