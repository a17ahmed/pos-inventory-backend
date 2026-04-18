import NodeCache from 'node-cache';
import Access from '../models/access.mjs';

// Cache access docs for 10 minutes, check for expired keys every 2 minutes
const accessCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

/**
 * Get access permissions for an employee, with caching.
 */
export const getAccessForEmployee = async (employeeId, businessId) => {
    const cacheKey = `access:${employeeId}:${businessId}`;

    let permissions = accessCache.get(cacheKey);
    if (permissions !== undefined) {
        return permissions;
    }

    const accessDoc = await Access.findOne({
        employee: employeeId,
        business: businessId
    }).lean();

    permissions = accessDoc?.permissions || null;
    accessCache.set(cacheKey, permissions);
    return permissions;
};

/**
 * Invalidate cached access for an employee.
 * Call this whenever access/permissions are updated.
 */
export const invalidateAccessCache = (employeeId, businessId) => {
    const cacheKey = `access:${employeeId}:${businessId}`;
    accessCache.del(cacheKey);
};

/**
 * Invalidate all cached access entries for a business.
 */
export const invalidateBusinessAccessCache = (businessId) => {
    const keys = accessCache.keys();
    const toDelete = keys.filter(k => k.endsWith(`:${businessId}`));
    if (toDelete.length > 0) {
        accessCache.del(toDelete);
    }
};

// ─── Route → Permission mapping ─────────────────────────────────
// Maps: baseRoute → method → subPath pattern → { module, action }
// Sub-paths use simple patterns: '*' matches any single segment
const ROUTE_PERMISSIONS = {
    '/product': {
        GET:   { _default: { module: 'products', action: 'view' } },
        POST:  {
            _default:     { module: 'products', action: 'create' },
            '/bulk-stock': { module: 'products', action: 'updateStock' }
        },
        PATCH: {
            _default:     { module: 'products', action: 'edit' },
            '/*/stock':   { module: 'products', action: 'updateStock' }
        },
        DELETE: { _default: { module: 'products', action: 'delete' } }
    },

    '/vendor': {
        GET:    { _default: { module: 'vendors', action: 'view' } },
        POST:   {
            _default:  { module: 'vendors', action: 'create' },
            '/*/pay':  { module: 'vendors', action: 'pay' }
        },
        PATCH:  { _default: { module: 'vendors', action: 'edit' } },
        DELETE: { _default: { module: 'vendors', action: 'delete' } }
    },

    '/supply': {
        GET:   { _default: { module: 'supplies', action: 'view' } },
        POST:  {
            _default:      { module: 'supplies', action: 'create' },
            '/*/return':   { module: 'supplies', action: 'processReturn' }
        },
        PATCH: {
            _default:  { module: 'supplies', action: 'edit' },
            '/*/pay':  { module: 'supplies', action: 'recordPayment' }
        },
        DELETE: { _default: { module: 'supplies', action: 'delete' } }
    },

    '/expense': {
        GET:    { _default: { module: 'expenses', action: 'view' } },
        POST:   {
            _default:       { module: 'expenses', action: 'create' },
            '/*/approve':   { module: 'expenses', action: 'approve' },
            '/*/reject':    { module: 'expenses', action: 'approve' }
        },
        PATCH:  { _default: { module: 'expenses', action: 'edit' } },
        DELETE: { _default: { module: 'expenses', action: 'delete' } }
    },

    '/customer': {
        GET:    {
            _default:  { module: 'customers', action: 'view' },
            '/search': { module: 'pos',       action: 'create' }
        },
        POST:   {
            _default:     { module: 'customers', action: 'create' },
            '/*/collect': { module: 'customers', action: 'edit' }
        },
        PATCH:  { _default: { module: 'customers', action: 'edit' } },
        DELETE: { _default: { module: 'customers', action: 'delete' } }
    },

    '/employee': {
        GET:    { _default: { module: 'employees', action: 'view' } },
        POST:   {
            _default:              { module: 'employees', action: 'create' },
            '/*/reset-password':   { module: 'employees', action: 'resetPassword' }
        },
        PATCH:  { _default: { module: 'employees', action: 'edit' } },
        DELETE: { _default: { module: 'employees', action: 'delete' } }
    },

    '/cashbook': {
        GET:   { _default: { module: 'cashbook', action: 'view' } },
        POST:  { _default: { module: 'cashbook', action: 'manage' } },
    },

    '/bill': {
        GET: {
            _default:    { module: 'pos', action: 'view' },
            '/hold':     { module: 'pendingBills', action: 'view' },
            '/returns':  { module: 'returns', action: 'view' },
            '/returns/*': { module: 'returns', action: 'view' },
            '/returns/receipt/*': { module: 'returns', action: 'view' },
            '/returns/product/*': { module: 'returns', action: 'create' },
            '/stats':    { module: 'dashboard', action: 'view' },
            '/top-products': { module: 'reports', action: 'view' },
            '/report/*': { module: 'reports', action: 'view' }
        },
        POST: {
            _default:     { module: 'pos', action: 'create' },
            '/hold':      { module: 'pendingBills', action: 'create' },
            '/*/return':  { module: 'returns', action: 'create' },
            '/returns/standalone': { module: 'returns', action: 'standalone' },
            '/*/payment': { module: 'pos', action: 'create' }
        },
        PATCH: {
            '/*/resume':              { module: 'pendingBills', action: 'resume' },
            '/*/cancel':              { module: 'pendingBills', action: 'cancel' },
            '/*/return/*/cancel':     { module: 'returns', action: 'cancel' },
            _default:                 { module: 'pos', action: 'create' }
        },
        DELETE: { _default: { module: 'pos', action: 'view' } }
    }
};


const matchPattern = (subPath, pattern) => {
    const pathParts = subPath.split('/').filter(Boolean);
    const patternParts = pattern.split('/').filter(Boolean);

    if (pathParts.length !== patternParts.length) return false;

    return patternParts.every((part, i) => part === '*' || part === pathParts[i]);
};

/**
 * Resolve the permission { module, action } for a given base route, method, and sub-path.
 */
const resolvePermission = (baseRoute, method, subPath) => {
    const routeConfig = ROUTE_PERMISSIONS[baseRoute];
    if (!routeConfig) return null;

    const methodConfig = routeConfig[method];
    if (!methodConfig) return null;

    // Normalise sub-path
    const normalised = subPath === '' || subPath === '/' ? '' : subPath;

    // Try specific pattern matches first (longest pattern first)
    if (normalised) {
        const patterns = Object.keys(methodConfig).filter(k => k !== '_default');
        // Sort by specificity (more segments = more specific)
        patterns.sort((a, b) => b.split('/').length - a.split('/').length);

        for (const pattern of patterns) {
            if (matchPattern(normalised, pattern)) {
                return methodConfig[pattern];
            }
        }
    }

    return methodConfig._default || null;
};

/**
 * Global access control middleware.
 * Place AFTER jwtAuth. Admins bypass all checks.
 * Routes not in ROUTE_PERMISSIONS pass through (no restriction).
 */
export const accessControl = async (req, res, next) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        // Admins always pass
        if (req.user.adminId) {
            return next();
        }

        // Find which base route this request belongs to
        const url = req.originalUrl.split('?')[0]; // strip query string
        let baseRoute = null;
        let subPath = '';

        const knownRoutes = Object.keys(ROUTE_PERMISSIONS);
        for (const route of knownRoutes) {
            if (url === route || url.startsWith(route + '/')) {
                baseRoute = route;
                subPath = url.slice(route.length);
                break;
            }
        }

        // Route not mapped — let it through (e.g. /auth, /health)
        if (!baseRoute) {
            return next();
        }

        const permission = resolvePermission(baseRoute, req.method, subPath);

        // No permission mapping for this specific method/path — let it through
        if (!permission) {
            return next();
        }

        const employeeId = req.user.id || req.user.employeeId;
        if (!employeeId) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const permissions = await getAccessForEmployee(employeeId, req.user.businessId);

        if (!permissions) {
            return res.status(403).json({
                message: 'No permissions assigned. Contact your admin.'
            });
        }

        const modulePerms = permissions[permission.module];
        if (!modulePerms || !modulePerms[permission.action]) {
            return res.status(403).json({
                message: `You don't have permission to ${permission.action} ${permission.module}`
            });
        }

        next();
    } catch (error) {
        console.error('[AccessControl] Error:', error.message);
        res.status(500).json({ message: 'Permission check failed' });
    }
};

export { accessCache };
