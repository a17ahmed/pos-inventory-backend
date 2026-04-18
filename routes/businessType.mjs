import express from 'express';
import { getBusinessTypes, getBusinessTypeByCode, createBusinessType } from '../controllers/businessType.mjs';

const businessTypeRouter = express.Router();

// Public routes (no auth required for fetching types)
businessTypeRouter.get('/', getBusinessTypes);
businessTypeRouter.get('/:code', getBusinessTypeByCode);

// Protected route — POST is disabled in production (types are seeded)
// To add new types, use the database seeder or enable this with proper auth
// businessTypeRouter.post('/', createBusinessType);

export default businessTypeRouter;
