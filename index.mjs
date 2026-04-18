import 'dotenv/config';

// Set process timezone from env (defaults to Asia/Karachi for PKT)
// This ensures new Date().setHours(0,0,0,0) = local midnight, not UTC midnight
process.env.TZ = process.env.TIMEZONE || 'Asia/Karachi';

import jwt from 'jsonwebtoken';

import express, { json } from 'express';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import xss from 'xss-clean';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

const app = express();
const port = process.env.PORT || 3000;

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load JWT keys from file paths specified in env
const publicKeyPath = path.resolve(__dirname, process.env.JWT_PUBLIC_KEY_PATH || './public.key');
const publicKey = fs.readFileSync(publicKeyPath, 'utf-8');

import mongoose from 'mongoose';

import adminRouter from './routes/admin.mjs';
import billRouter from './routes/bill.mjs';

import adminAuthRouter from './routes/adminAuth.mjs';

import businessTypeRouter from './routes/businessType.mjs';
import businessRouter from './routes/business.mjs';
import employeeRouter, { employeeAuthRouter } from './routes/employee.mjs';

// Inventory & Retail routes
import productRouter from './routes/product.mjs';
import customerRouter from './routes/customer.mjs';

// Expense routes
import expenseRouter from './routes/expense.mjs';

import vendorRouter from './routes/vendor.mjs';
import supplyRouter from './routes/supply.mjs';
import accessRouter from './routes/access.mjs';
import cashbookRouter from './routes/cashbook.mjs';

// Shared auth routes (refresh token, logout)
import authRouter from './routes/auth.mjs';

// RBAC middleware
import { authorize } from './middleware/rbac.mjs';

// Access control middleware (permission-based, cached)
import { accessControl } from './middleware/accessControl.mjs';

// MONGODB CONNECTIVITY with retry
const uri = process.env.MONGODB_URI;
const connectWithRetry = async () => {
    try {
        await mongoose.connect(uri);
        console.log('Database Connected');
    } catch (err) {
        console.error('Database connection failed, retrying in 5s...', err.message);
        setTimeout(connectWithRetry, 5000);
    }
};

mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected. Attempting reconnect...');
});

mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err.message);
});

await connectWithRetry();

// One-time counter migration: seed counters from existing data so atomic IDs don't collide
import Counter from './models/counter.mjs';
import Bill from './models/bill.mjs';
import Business from './models/business.mjs';
import Expense from './models/expense.mjs';
import Supply from './models/supply.mjs';

const initializeCounters = async () => {
    try {
        const businesses = await Business.find({}, '_id').lean();
        for (const biz of businesses) {
            const bid = biz._id.toString();

            // Bill number counter
            const billCounter = await Counter.findById(`billNumber:${bid}`);
            if (!billCounter) {
                const maxBill = await Bill.findOne({ business: biz._id })
                    .sort({ billNumber: -1 }).select('billNumber').lean();
                if (maxBill?.billNumber) {
                    await Counter.initializeCounter('billNumber', bid, maxBill.billNumber);
                }
            }

            // Expense number counter
            const expenseCounter = await Counter.findById(`expenseNumber:${bid}`);
            if (!expenseCounter) {
                const maxExpense = await Expense.findOne({ business: biz._id })
                    .sort({ expenseNumber: -1 }).select('expenseNumber').lean();
                if (maxExpense?.expenseNumber) {
                    await Counter.initializeCounter('expenseNumber', bid, maxExpense.expenseNumber);
                }
            }

            // Supply number counter
            const supplyCounter = await Counter.findById(`supplyNumber:${bid}`);
            if (!supplyCounter) {
                const maxSupply = await Supply.findOne({ business: biz._id })
                    .sort({ supplyNumber: -1 }).select('supplyNumber').lean();
                if (maxSupply?.supplyNumber) {
                    await Counter.initializeCounter('supplyNumber', bid, maxSupply.supplyNumber);
                }
            }
        }
        console.log('Counters initialized for', businesses.length, 'businesses');
    } catch (err) {
        console.error('Counter initialization error:', err.message);
    }
};

await initializeCounters();

// JWT verification middleware
const jwtAuth = (req, res, next) => {
    try {
        const authHeader = req.get("Authorization");
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        const token = authHeader.split('Bearer ')[1];
        const decoded = jwt.verify(token, publicKey);

        // Accept both admin and employee tokens
        if (decoded.adminId || decoded.email || decoded.employeeId || decoded.id) {
            req.user = {
                id: decoded.id || decoded.adminId,
                name: decoded.name || null,
                email: decoded.email,
                adminId: decoded.adminId,
                employeeId: decoded.employeeId,
                businessId: decoded.businessId,
                role: decoded.role || (decoded.adminId ? 'admin' : 'employee')
            };
            next();
        } else {
            res.status(401).json({ message: 'Invalid token' });
        }
    } catch (error) {
        console.log('[Auth Middleware] JWT Error:', error.name, '-', error.message);
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token expired', code: 'TOKEN_EXPIRED' });
        }
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ message: 'Invalid token', code: 'TOKEN_INVALID' });
        }
        res.status(401).json({ message: 'Authentication failed' });
    }
};

// CORS configuration - restrict origins
const allowedOrigins = (process.env.CORS_ORIGINS || '*').split(',').map(o => o.trim());
const corsOptions = {
    origin: process.env.NODE_ENV === 'production'
        ? (origin, callback) => {
            // Allow requests with no origin (Electron, mobile apps, server-to-server)
            if (!origin) return callback(null, true);
            // Allow all if wildcard is configured
            if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            callback(new Error('Not allowed by CORS'));
        }
        : true, // Allow all in development
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

// Global rate limiter
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests, please try again later.' }
});

// Stricter rate limiter for auth routes
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many login attempts, please try again later.' }
});

// Middleware stack
app.use(cors(corsOptions));
app.use(json({ limit: process.env.BODY_SIZE_LIMIT || '1mb' }));
app.use(mongoSanitize());
app.use(hpp());
app.use(xss());
app.use(limiter);
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));

// Request logger (testing only — remove before production)
app.use((req, res, next) => {
    const start = Date.now();
    const body = req.method !== 'GET' && req.body ? JSON.stringify(req.body, null, 2) : null;
    res.on('finish', () => {
        console.log(`\n[${req.method}] ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
        if (body) console.log('Body:', body);
    });
    next();
});

// Health check endpoint
app.get('/health', (req, res) => {
    const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        database: dbStatus,
        timestamp: new Date().toISOString()
    });
});

// Public auth routes (with stricter rate limiting)
app.use("/adminAuth", authLimiter, adminAuthRouter);
app.use("/employeeAuth", authLimiter, employeeAuthRouter);
app.use("/auth", authLimiter, authRouter);

// Public routes (no auth required - GET only)
app.use("/business-types", businessTypeRouter);
app.use("/business", businessRouter);

// Protected routes (require JWT + access control)
app.use("/admin", jwtAuth, authorize('admin', 'owner'), adminRouter);
app.use("/bill", jwtAuth, accessControl, billRouter);
app.use("/employee", jwtAuth, accessControl, employeeRouter);

// Inventory & Retail routes
app.use("/product", jwtAuth, accessControl, productRouter);
app.use("/customer", jwtAuth, accessControl, customerRouter);

// Expense tracking routes
app.use("/expense", jwtAuth, accessControl, expenseRouter);
app.use("/vendor", jwtAuth, accessControl, vendorRouter);
app.use("/supply", jwtAuth, accessControl, supplyRouter);
app.use("/cashbook", jwtAuth, accessControl, cashbookRouter);

// Access control management (admin only, no accessControl middleware needed - uses RBAC)
app.use("/access", jwtAuth, accessRouter);

// Global error handler (catches malformed JSON, etc.)
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'Invalid JSON in request body' });
    }
    console.error('Unhandled error:', err.message);
    res.status(500).json({ message: 'Internal server error' });
});

// Dummy Socket.IO object — silently absorbs all emit calls (no-op for Vercel serverless)
export const io = {
    emit: () => {},
    to: () => ({ emit: () => {} }),
    in: () => ({ emit: () => {} })
};

// Graceful error handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Inventory Server is Running at 0.0.0.0:${port}`);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    try {
        await mongoose.connection.close();
        console.log('Database connection closed');
    } catch (err) {
        console.error('Error closing database connection:', err);
    }
    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
