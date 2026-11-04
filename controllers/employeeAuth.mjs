import Employee from '../models/employee.mjs';
import RefreshToken from '../models/refreshToken.mjs';
import { SHOP_HIDDEN_BUSINESS_FIELDS } from '../models/business.mjs';
import { getBusinessStatus, blockedResponse } from '../middleware/businessStatus.mjs';
import { recordUsage } from '../middleware/usageTracker.mjs';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const privateKey = fs.readFileSync(path.resolve(__dirname, '../private.key'), 'utf-8');

// Employee Login
export const employeeLogin = async (req, res) => {
    try {
        const { employeeId, password } = req.body;

        if (!employeeId || !password) {
            return res.status(400).json({ message: 'Employee ID and password are required' });
        }

        const employee = await Employee.findOne({ employeeId: employeeId.toLowerCase() })
            .populate('business', SHOP_HIDDEN_BUSINESS_FIELDS);

        if (!employee) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (employee.status !== 'active') {
            return res.status(401).json({ message: 'Account is not active' });
        }

        const isValidPassword = await bcrypt.compare(password, employee.password);

        if (!isValidPassword) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Business blocked by the platform (e.g. unpaid) → no token
        const status = await getBusinessStatus(employee.business?._id);
        if (status?.status === 'blocked') {
            recordUsage(employee.business._id, { blockedRequests: 1 });
            return res.status(403).json(blockedResponse(status));
        }

        const token = jwt.sign({
            id: employee._id,
            name: employee.name,
            employeeId: employee.employeeId,
            businessId: employee.business._id,
            role: employee.role
        }, privateKey, {
            algorithm: 'RS256',
            expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRY || '8h'
        });

        employee.token = token;
        employee.lastLoginAt = new Date();
        await employee.save();
        recordUsage(employee.business._id, { logins: 1 }, { userId: employee._id });

        // Issue refresh token
        const refreshTokenData = await RefreshToken.createToken({
            userId: employee._id,
            userType: 'employee',
            businessId: employee.business._id,
        });

        res.json({
            token,
            refreshToken: refreshTokenData.token,
            requirePasswordChange: employee.requirePasswordChange,
            employee: {
                id: employee._id,
                name: employee.name,
                employeeId: employee.employeeId,
                role: employee.role
            },
            business: employee.business
        });
    } catch (error) {
        console.error('Employee login error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Employee Change Password
export const employeeChangePassword = async (req, res) => {
    try {
        const { employeeId, currentPassword, newPassword } = req.body;

        if (!employeeId || !currentPassword || !newPassword) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ message: 'New password must be at least 8 characters' });
        }

        const employee = await Employee.findOne({ employeeId: employeeId.toLowerCase() });

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const isValidPassword = await bcrypt.compare(currentPassword, employee.password);

        if (!isValidPassword) {
            return res.status(401).json({ message: 'Current password is incorrect' });
        }

        const saltRounds = 10;
        employee.password = await bcrypt.hash(newPassword, saltRounds);
        employee.requirePasswordChange = false;
        await employee.save();

        // Revoke all refresh tokens for this employee (security: invalidate all sessions)
        await RefreshToken.revokeAllForUser(employee._id);

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};
