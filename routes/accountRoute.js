import express from 'express';
import { getAccounts, createAccount, updateAccount, setDefaultAccount, deleteAccount, batchAddAccounts } from '../controllers/accountController.js';

const router = express.Router();

router.get('/', getAccounts);
router.post('/', createAccount);
router.post('/batch-add', batchAddAccounts);
router.patch('/:id', updateAccount);
router.patch('/:id/set-default', setDefaultAccount);
router.delete('/:id', deleteAccount);

export default router;
