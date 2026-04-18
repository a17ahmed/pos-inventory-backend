import BusinessType from '../models/businessType.mjs';

// Get all active business types
export const getBusinessTypes = async (req, res) => {
    try {
        const businessTypes = await BusinessType.find({ isActive: true })
            .sort({ sortOrder: 1 })
            .select('name code icon description features');

        res.status(200).json(businessTypes);
    } catch (error) {
        console.error('Error fetching business types:', error);
        res.status(500).json({ message: 'Failed to fetch business types' });
    }
};

// Get single business type by code
export const getBusinessTypeByCode = async (req, res) => {
    try {
        const { code } = req.params;
        const businessType = await BusinessType.findOne({ code, isActive: true });

        if (!businessType) {
            return res.status(404).json({ message: 'Business type not found' });
        }

        res.status(200).json(businessType);
    } catch (error) {
        console.error('Error fetching business type:', error);
        res.status(500).json({ message: 'Failed to fetch business type' });
    }
};

// Create business type (admin only - for future use)
export const createBusinessType = async (req, res) => {
    try {
        const { name, code, icon, description, features, sortOrder } = req.body;

        const existingType = await BusinessType.findOne({ code });
        if (existingType) {
            return res.status(400).json({ message: 'Business type with this code already exists' });
        }

        const businessType = new BusinessType({
            name,
            code,
            icon,
            description,
            features,
            sortOrder
        });

        await businessType.save();
        res.status(201).json(businessType);
    } catch (error) {
        console.error('Error creating business type:', error);
        res.status(500).json({ message: 'Failed to create business type' });
    }
};
