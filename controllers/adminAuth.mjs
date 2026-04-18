import 'dotenv/config';

import Admin from '../models/admin.mjs';
import RefreshToken from '../models/refreshToken.mjs';

import jwt from 'jsonwebtoken';

import bcrypt from "bcrypt";

import nodemailer from 'nodemailer';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const privateKey = fs.readFileSync(path.resolve(__dirname, '../private.key'), 'utf-8');

const createAdmin = async (req, res) => {
    const admin = new Admin(req.body);

    let token = jwt.sign({ email: req.body.email, role: 'admin' }, privateKey, {
        algorithm: 'RS256',
        expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRY || '8h'
    });

    const saltRounds = 10;
    const hash = await bcrypt.hash(req.body.password, saltRounds);

    admin.token = token;
    admin.password = hash;

    try {
        const savedUser = await admin.save();
        const { password: _, token: __, otp: ___, otpExpiry: ____, ...safeUser } = savedUser.toObject();
        res.status(201).json(safeUser);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: 'An account with this email already exists' });
        }
        res.status(500).json({ error: 'Error creating User' });
    }
};

//login
const login = async (req, res) => {
    try {
        const getAdmin = await Admin.findOne({ email: req.body.email })
            .populate({
                path: 'business',
                populate: {
                    path: 'businessType',
                    select: 'name code icon features'
                }
            })
            .exec();

        if (!getAdmin) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isAuthAdmin = await bcrypt.compare(req.body.password, getAdmin.password);

        if (isAuthAdmin) {
            let token = jwt.sign({
                email: req.body.email,
                adminId: getAdmin._id,
                businessId: getAdmin.business ? getAdmin.business._id : null,
                role: 'admin'
            }, privateKey, {
                algorithm: 'RS256',
                expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRY || '8h'
            });

            getAdmin.token = token;
            await getAdmin.save();

            // Issue refresh token
            const refreshTokenData = await RefreshToken.createToken({
                userId: getAdmin._id,
                userType: 'admin',
                businessId: getAdmin.business ? getAdmin.business._id : null,
            });

            // Build response with business info
            const response = {
                token,
                refreshToken: refreshTokenData.token,
                admin: {
                    id: getAdmin._id,
                    name: getAdmin.name,
                    email: getAdmin.email,
                    role: getAdmin.role
                }
            };

            // Include business info if available
            if (getAdmin.business) {
                response.business = getAdmin.business;
            }

            res.json(response);
        } else {
            res.status(401).json({ message: 'Invalid credentials' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

//Request Password Reset
const requestPasswordReset = async (req, res) => {
    const { email } = req.body;

    try {
        // Find the admin by email
        const admin = await Admin.findOne({ email }).exec();

        if (!admin) {
            return res.status(404).json({ error: 'Admin not found' });
        }

        // Generate a random OTP (e.g., a 6-digit number)
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Save the OTP and its expiry time in the admin document
        const otpExpiry = new Date();
        otpExpiry.setMinutes(otpExpiry.getMinutes() + 10); // OTP expires in 10 minutes

        // Update the admin with the reset token and expiry
        admin.otp = otp;
        admin.otpExpiry = otpExpiry;

        await admin.save();

        // Send the OTP to the user's email
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.NODEMAILER_EMAIL,
                pass: process.env.NODEMAILER_PASS,
            }
        });

        const mailOptions = {
            from: 'P2P Clouds',
            to: admin.email,
            subject: 'Password Reset OTP',
            text: `Your OTP for password reset is: ${otp}`,
        };

        await transporter.sendMail(mailOptions);

        res.status(200).json({ message: 'OTP sent successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error sending OTP' });
    }
};

//VERIFY OTP
const verifyingOTP = async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ error: 'Email and OTP are required' });
    }

    try {
        // Find the admin by email AND OTP to prevent cross-account verification
        const adminOTP = await Admin.findOne({ email, otp }).exec();

        if (!adminOTP) {
            return res.status(400).json({ error: 'OTP NOT VERIFIED' });
        }

        // Check if the OTP hasn't expired
        const currentTimestamp = new Date();
        if (adminOTP.otpExpiry > currentTimestamp) {
            return res.status(200).json({ message: 'OTP VERIFIED' });
        } else {
            // Clear expired OTP
            adminOTP.otp = undefined;
            adminOTP.otpExpiry = undefined;
            await adminOTP.save();
            return res.status(400).json({ error: 'OTP has expired' });
        }
    } catch (error) {
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}

// RESET THE PASSWORD
const resetPassword = async (req, res) => {
    const { email, otp, newPassword } = req.body;

    try {
        // Find the admin by email
        const admin = await Admin.findOne({ email }).exec();

        if (!admin) {
            return res.status(404).json({ error: 'Admin not found' });
        }

        // Check if the OTP matches and is still valid
        if (admin.otp !== otp || admin.otpExpiry < new Date()) {
            return res.status(400).json({ error: 'Invalid or expired OTP' });
        }

        // Hash the new password
        const saltRounds = 10;
        const hash = await bcrypt.hash(newPassword, saltRounds);

        // Update the admin's password and clear the OTP and expiry
        admin.password = hash;
        admin.otp = undefined;
        admin.otpExpiry = undefined;
        await admin.save();

        // Revoke all refresh tokens for this admin (security: invalidate all sessions)
        await RefreshToken.revokeAllForUser(admin._id);

        res.status(200).json({ message: 'Password reset successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error resetting password' });
    }
};


export { createAdmin, login, requestPasswordReset, verifyingOTP, resetPassword };