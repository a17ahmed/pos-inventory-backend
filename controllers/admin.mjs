import Admin from '../models/admin.mjs';
import Business from '../models/business.mjs';
import bcrypt from 'bcrypt';

// GET ADMIN - only the admin's own profile
const getAdmin = async (req, res) => {
    try {
        const id = req.params.id;

        // Admin can only view their own profile unless they match the requested ID
        if (req.user.adminId && req.user.adminId.toString() !== id) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const admin = await Admin.findById(id).select('-password -token -otp -otpExpiry').exec();
        if (!admin) {
            return res.status(404).json({ message: 'Admin not found' });
        }
        res.json(admin);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching admin' });
    }
};

// GET ADMIN by email - restricted to own email
const getAdminEmail = async (req, res) => {
    try {
        const adminEmail = req.params.email;

        // Only allow fetching own admin profile by email
        if (req.user.email !== adminEmail) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const admin = await Admin.findOne({ email: adminEmail })
            .select('-password -token -otp -otpExpiry')
            .exec();

        if (!admin) {
            return res.status(404).json({ message: 'Admin not found' });
        }
        res.json(admin);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching admin' });
    }
};

// PATCH(UPDATE) ADMIN - only own profile
const patchAdmin = async (req, res) => {
    try {
        const id = req.params.id;

        // Admin can only update their own profile
        if (req.user.adminId && req.user.adminId.toString() !== id) {
            return res.status(403).json({ message: 'Access denied' });
        }

        // Prevent updating sensitive fields directly
        const { password, token, otp, otpExpiry, role, business, ...safeUpdates } = req.body;

        const doc = await Admin.findOneAndUpdate(
            { _id: id },
            safeUpdates,
            { new: true }
        ).select('-password -token -otp -otpExpiry');

        if (!doc) {
            return res.status(404).json({ message: 'Admin not found' });
        }
        res.json(doc);
    } catch (err) {
        res.status(400).json({ message: 'Error updating admin' });
    }
};

// DELETE ADMIN - disabled for safety, should be handled via a super-admin flow
const deleteAdmin = async (req, res) => {
    return res.status(403).json({
        message: 'Admin deletion is not supported via API. Contact system administrator.'
    });
};

// UPDATE BUSINESS SETTINGS - only own business
const updateBusinessSettings = async (req, res) => {
    try {
        const { settings, cashTaxRate, cardTaxRate, taxLabel } = req.body;
        const businessId = req.user?.businessId;

        if (!businessId) {
            return res.status(400).json({ message: 'Business ID not found' });
        }

        // Build update object
        const updateData = {};
        if (settings) {
            updateData.settings = settings;
        }
        if (cashTaxRate !== undefined) {
            updateData.cashTaxRate = cashTaxRate;
        }
        if (cardTaxRate !== undefined) {
            updateData.cardTaxRate = cardTaxRate;
        }
        if (taxLabel !== undefined) {
            updateData.taxLabel = taxLabel;
        }

        const business = await Business.findByIdAndUpdate(
            businessId,
            { $set: updateData },
            { new: true }
        );

        if (!business) {
            return res.status(404).json({ message: 'Business not found' });
        }

        res.json(business);
    } catch (error) {
        console.error('Error updating business settings:', error);
        res.status(500).json({ message: 'Failed to update settings' });
    }
};

// GET BUSINESS SETTINGS - only own business
const getBusinessSettings = async (req, res) => {
    try {
        const businessId = req.user?.businessId;

        if (!businessId) {
            return res.status(400).json({ message: 'Business ID not found' });
        }

        const business = await Business.findById(businessId).select('settings');

        if (!business) {
            return res.status(404).json({ message: 'Business not found' });
        }

        res.json(business.settings || {});
    } catch (error) {
        console.error('Error fetching business settings:', error);
        res.status(500).json({ message: 'Failed to fetch settings' });
    }
};

// CHANGE PASSWORD - admin changes their own password
const changePassword = async (req, res) => {
    try {
        const id = req.user.adminId;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Current and new password are required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ message: 'New password must be at least 8 characters' });
        }

        const admin = await Admin.findById(id);
        if (!admin) {
            return res.status(404).json({ message: 'Admin not found' });
        }

        const isMatch = await bcrypt.compare(currentPassword, admin.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Current password is incorrect' });
        }

        admin.password = await bcrypt.hash(newPassword, 10);
        await admin.save();

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error changing password' });
    }
};

export { getAdmin, getAdminEmail, patchAdmin, deleteAdmin, updateBusinessSettings, getBusinessSettings, changePassword };
