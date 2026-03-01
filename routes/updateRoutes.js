import express from 'express';
import * as updateController from '../controllers/updateController.js';

const router = express.Router();

router.get('/check', updateController.checkUpdate);

export default router;
