import express from 'express';
import { getDashboardSummary } from '../controllers/dashboard.mjs';

const dashboardRouter = express.Router();

dashboardRouter.get('/summary', getDashboardSummary);

export default dashboardRouter;
