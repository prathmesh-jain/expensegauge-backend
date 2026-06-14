import express from 'express';
import { getAccounts, createAccount, updateAccount, setDefaultAccount, deleteAccount } from '../controllers/accountController.js';

const router = express.Router();

router.get('/', getAccounts);
router.post('/', createAccount);
router.patch('/:id', updateAccount);
router.patch('/:id/set-default', setDefaultAccount);
router.delete('/:id', deleteAccount);

export default router;
