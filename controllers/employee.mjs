import Employee from '../models/employee.mjs';
import Business from '../models/business.mjs';
import Access from '../models/access.mjs';
import bcrypt from 'bcrypt';

// Get business prefix for employee ID (businessname@)
const getBusinessPrefix = async (businessId) => {
    const business = await Business.findById(businessId);
    if (business?.name) {
        // Remove spaces, lowercase, take first 20 chars max
        return business.name.toLowerCase().replace(/\s+/g, '').substring(0, 20);
    }
    return 'emp';
};

// Check if employeeId is unique for this business
const isEmployeeIdUnique = async (employeeId, businessId, excludeId = null) => {
    const query = { employeeId: employeeId.toLowerCase(), business: businessId };
    if (excludeId) {
        query._id = { $ne: excludeId };
    }
    const existing = await Employee.findOne(query);
    return !existing;
};

// Generate unique employee ID suggestion
const generateUniqueEmployeeId = async (businessId, username) => {
    const prefix = await getBusinessPrefix(businessId);
    let baseId = `${prefix}@${username.toLowerCase().replace(/\s+/g, '')}`;

    // Check if base ID is unique
    if (await isEmployeeIdUnique(baseId, businessId)) {
        return baseId;
    }

    // Add numbers until unique
    let counter = 1;
    while (counter < 100) {
        const newId = `${baseId}${counter}`;
        if (await isEmployeeIdUnique(newId, businessId)) {
            return newId;
        }
        counter++;
    }

    // Fallback with timestamp
    return `${baseId}${Date.now()}`;
};

// Get all employees for the logged-in user's business
export const getAllEmployees = async (req, res) => {
    try {
        const employees = await Employee.find({ business: req.user.businessId })
            .select('-password -token')
            .sort({ name: 1 });

        res.status(200).json(employees);
    } catch (error) {
        console.error('Error fetching employees:', error);
        res.status(500).json({ message: 'Failed to fetch employees' });
    }
};

// Get single employee
export const getEmployeeById = async (req, res) => {
    try {
        const { id } = req.params;
        const employee = await Employee.findOne({ _id: id, business: req.user.businessId })
            .select('-password -token');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        res.status(200).json(employee);
    } catch (error) {
        console.error('Error fetching employee:', error);
        res.status(500).json({ message: 'Failed to fetch employee' });
    }
};

// Get business prefix - endpoint for frontend
export const getBusinessPrefixForEmployee = async (req, res) => {
    try {
        const prefix = await getBusinessPrefix(req.user.businessId);
        res.json({ prefix: `${prefix}@` });
    } catch (error) {
        console.error('Error getting prefix:', error);
        res.status(500).json({ message: 'Failed to get business prefix' });
    }
};

// Check if employee ID is available
export const checkEmployeeIdAvailable = async (req, res) => {
    try {
        const { employeeId } = req.query;
        if (!employeeId) {
            return res.status(400).json({ message: 'Employee ID is required' });
        }

        const isUnique = await isEmployeeIdUnique(employeeId, req.user.businessId);
        res.json({ available: isUnique });
    } catch (error) {
        console.error('Error checking employee ID:', error);
        res.status(500).json({ message: 'Failed to check employee ID' });
    }
};

// Create new employee
export const createEmployee = async (req, res) => {
    try {
        const {
            name,
            password,
            requirePasswordChange,
            employeeId: providedEmployeeId,
            username,
            ...otherData
        } = req.body;

        if (!name || !password) {
            return res.status(400).json({ message: 'Name and password are required' });
        }

        if (password.length < 4) {
            return res.status(400).json({ message: 'Password must be at least 4 characters' });
        }

        // Check for duplicate employee name within the same business
        const existingName = await Employee.findOne({
            name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
            business: req.user.businessId
        });
        if (existingName) {
            return res.status(400).json({ message: `An employee named "${name.trim()}" already exists` });
        }

        // Get or generate employee ID
        let employeeId;
        if (providedEmployeeId) {
            // Use provided employee ID, check if unique
            const isUnique = await isEmployeeIdUnique(providedEmployeeId, req.user.businessId);
            if (!isUnique) {
                // Suggest an alternative
                const suggested = await generateUniqueEmployeeId(req.user.businessId, username || name);
                return res.status(400).json({
                    message: 'Employee ID already taken',
                    suggestedId: suggested
                });
            }
            employeeId = providedEmployeeId.toLowerCase();
        } else {
            // Auto-generate from username or name
            employeeId = await generateUniqueEmployeeId(req.user.businessId, username || name);
        }

        // Hash password
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const employee = new Employee({
            name,
            employeeId,
            password: hashedPassword,
            requirePasswordChange: requirePasswordChange !== false,
            ...otherData,
            business: req.user.businessId
        });

        const savedEmployee = await employee.save();

        // Auto-create default access permissions for the new employee
        try {
            await Access.create({
                employee: savedEmployee._id,
                business: req.user.businessId
            });
        } catch (accessErr) {
            // Don't fail employee creation if access creation fails
            console.error('Auto-create access failed:', accessErr.message);
        }

        res.status(201).json({
            success: true,
            employee: {
                id: savedEmployee._id,
                name: savedEmployee.name,
                employeeId: savedEmployee.employeeId,
                requirePasswordChange: savedEmployee.requirePasswordChange,
                role: savedEmployee.role,
                status: savedEmployee.status
            },
            message: `Employee created with ID: ${employeeId}`
        });
    } catch (error) {
        console.error('Error creating employee:', error);
        res.status(500).json({ message: 'Failed to create employee', error: error.message });
    }
};

// Update employee
export const updateEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        const { password, employeeId, ...updates } = req.body;

        // Don't allow updating password or employeeId through this endpoint
        const employee = await Employee.findOneAndUpdate(
            { _id: id, business: req.user.businessId },
            updates,
            { new: true }
        ).select('-password -token');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        res.status(200).json(employee);
    } catch (error) {
        console.error('Error updating employee:', error);
        res.status(500).json({ message: 'Failed to update employee' });
    }
};

// Reset employee password (admin function)
export const resetEmployeePassword = async (req, res) => {
    try {
        const { id } = req.params;
        const { newPassword, requirePasswordChange } = req.body;

        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ message: 'New password must be at least 4 characters' });
        }

        const employee = await Employee.findOne({ _id: id, business: req.user.businessId });

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const saltRounds = 10;
        employee.password = await bcrypt.hash(newPassword, saltRounds);
        employee.requirePasswordChange = requirePasswordChange !== false;
        await employee.save();

        res.status(200).json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error('Error resetting password:', error);
        res.status(500).json({ message: 'Failed to reset password' });
    }
};

// Delete employee (soft delete — marks inactive, preserves audit trail)
export const deleteEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        const employee = await Employee.findOneAndUpdate(
            { _id: id, business: req.user.businessId },
            { status: 'inactive' },
            { new: true }
        ).select('-password -token');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        res.status(200).json({ message: 'Employee deactivated successfully', employee });
    } catch (error) {
        console.error('Error deactivating employee:', error);
        res.status(500).json({ message: 'Failed to deactivate employee' });
    }
};

// Reactivate employee
export const reactivateEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        const employee = await Employee.findOneAndUpdate(
            { _id: id, business: req.user.businessId, status: 'inactive' },
            { status: 'active' },
            { new: true }
        ).select('-password -token');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found or already active' });
        }

        res.status(200).json({ message: 'Employee reactivated successfully', employee });
    } catch (error) {
        console.error('Error reactivating employee:', error);
        res.status(500).json({ message: 'Failed to reactivate employee' });
    }
};

// Get active employee count
export const getEmployeeCount = async (req, res) => {
    try {
        const count = await Employee.countDocuments({
            business: req.user.businessId,
            status: 'active'
        });

        res.status(200).json({ count });
    } catch (error) {
        console.error('Error counting employees:', error);
        res.status(500).json({ message: 'Failed to count employees' });
    }
};

// Update employee work status (for shift tracking - Active/On Break/Busy)
export const updateWorkStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { workStatus } = req.body;

        const validStatuses = ['active', 'on_break', 'busy', 'offline'];
        if (!validStatuses.includes(workStatus)) {
            return res.status(400).json({ message: 'Invalid work status' });
        }

        const employee = await Employee.findOneAndUpdate(
            { _id: id, business: req.user.businessId },
            { workStatus },
            { new: true }
        ).select('-password -token');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        res.status(200).json({
            success: true,
            workStatus: employee.workStatus,
            message: `Status updated to ${workStatus}`
        });
    } catch (error) {
        console.error('Error updating work status:', error);
        res.status(500).json({ message: 'Failed to update work status' });
    }
};
