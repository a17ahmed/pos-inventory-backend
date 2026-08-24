/**
 * Shared date helpers — all operations use the server's process.env.TZ timezone.
 * TZ is set at app startup in index.mjs (defaults to Asia/Karachi).
 */

/** Start of today in local timezone (00:00:00.000) */
export const startOfToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};

/** Start of a given month in local timezone */
export const startOfMonth = (date = new Date()) => {
    return new Date(date.getFullYear(), date.getMonth(), 1);
};

/** Start of the week (Sunday) in local timezone */
export const startOfWeek = (date = new Date()) => {
    const d = new Date(date);
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
};

/**
 * End of day for a plain date string — sets to 23:59:59.999 local time.
 * Plain date strings ("YYYY-MM-DD") are parsed as UTC by JS spec, so they're
 * split and reconstructed to ensure local timezone interpretation.
 *
 * Full datetime strings (anything with a "T" time component, e.g.
 * "2026-04-17T14:30:00" or "2026-04-17T14:30:00.000Z") are passed straight
 * to `new Date()` and returned as-is — the exact time is respected rather
 * than being overridden to end-of-day. Per the JS Date spec, ISO datetime
 * strings with no timezone offset are parsed as local time (matching
 * process.env.TZ set at startup), so a frontend sending its local
 * wall-clock time with no "Z" suffix lines up correctly here.
 */
export const endOfDay = (dateStr) => {
    const str = String(dateStr);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        const [y, m, day] = str.split('-').map(Number);
        const d = new Date(y, m - 1, day);
        d.setHours(23, 59, 59, 999);
        return d;
    }
    return new Date(str);
};

/**
 * Start of day for a plain date string — sets to 00:00:00.000 local time.
 * See endOfDay() above for the full-datetime-string behavior.
 */
export const startOfDay = (dateStr) => {
    const str = String(dateStr);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        const [y, m, day] = str.split('-').map(Number);
        const d = new Date(y, m - 1, day);
        d.setHours(0, 0, 0, 0);
        return d;
    }
    return new Date(str);
};

/** Format a Date as "YYYY-MM-DD" in local timezone */
export const toLocalDateString = (date = new Date()) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

/** Format a Date as "HH:MM:SS" in local timezone */
export const toLocalTimeString = (date = new Date()) => {
    return date.toLocaleTimeString('en-GB', { hour12: false });
};

/**
 * Get the IANA timezone string for MongoDB $dateToString.
 * Uses process.env.TZ which is set at startup.
 */
export const getTimezone = () => process.env.TZ || 'Asia/Karachi';
