import express from 'express'
import userRoute from './routes/userRoute.js'
import expenseRoute from './routes/expenseRoute.js'
import adminRoute from './routes/adminRoute.js'
import updateRoute from './routes/updateRoutes.js'
import cors from 'cors'
import { verifyAccess } from './controllers/userController.js'
import { connectDB } from './config/dbConnection.js'
import { verifyAdminAccess } from './controllers/adminController.js'

connectDB()
const app = express()
app.use(express.json())
const port = process.env.PORT || 3000

app.use(cors({
    origin: '*',
    credentials: true
}))

app.get('/api/v1/health', (req, res) => {
    res.send("ExpenseGauge server working fine")
})
app.use('/api/v1/update', updateRoute)
app.use('/api/v1/user', userRoute)
app.use('/api/v1/expense', verifyAccess, expenseRoute)
app.use('/api/v1/admin', verifyAdminAccess, adminRoute)
app.listen(port, "0.0.0.0", () => {
    console.log("server running on", port);
})

export default app