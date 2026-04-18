/**
 * Role-Based Access Control (RBAC) Middleware
 *
 * Usage:
 *   authorize('admin', 'owner')         - only admin/owner roles
 *   authorize('admin', 'manager')       - admin or manager
 *   authorize('admin', 'manager', 'employee') - any authenticated employee
 */

// Role hierarchy - higher roles inherit lower role permissions
const ROLE_HIERARCHY = {
    owner: 5,
    admin: 4,
    manager: 3,
    senior: 2,
    head_chef: 2,
    chef: 1,
    waiter: 1,
    employee: 0
};

/**
 * Middleware that checks if the authenticated user has one of the allowed roles.
 * Must be used AFTER jwtAuth middleware.
 *
 * @param  {...string} allowedRoles - Roles that are permitted to access the route
 */
export const authorize = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        const userRole = req.user.role;

        // Admin tokens (from admin login) always have admin/owner access
        if (req.user.adminId) {
            if (allowedRoles.includes('admin') || allowedRoles.includes('owner')) {
                return next();
            }
        }

        // Check if user's role is in the allowed list
        if (allowedRoles.includes(userRole)) {
            return next();
        }

        // Check role hierarchy - if a higher role is not explicitly listed,
        // but the user has a role with higher level than the minimum allowed
        const userLevel = ROLE_HIERARCHY[userRole] ?? -1;
        const minAllowedLevel = Math.min(
            ...allowedRoles.map(r => ROLE_HIERARCHY[r] ?? Infinity)
        );

        if (userLevel >= minAllowedLevel) {
            return next();
        }

        return res.status(403).json({
            message: 'Access denied. Insufficient permissions.'
        });
    };
};

/**
 * Middleware to ensure user can only access their own business data.
 * Checks req.params.businessId or req.body.businessId against token.
 */
export const requireOwnBusiness = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ message: 'Authentication required' });
    }

    const requestedBusinessId =
        req.params.businessId ||
        req.body.businessId ||
        req.query.businessId;

    // If no specific business is requested, let the controller handle filtering
    if (!requestedBusinessId) {
        return next();
    }

    if (req.user.businessId && requestedBusinessId !== req.user.businessId.toString()) {
        return res.status(403).json({
            message: 'Access denied. Cannot access another business\'s data.'
        });
    }

    next();
};
