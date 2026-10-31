/**
 * Reasons for a manual stock adjustment (PATCH /product/:id/stock).
 * `operation` = the only operation the reason allows (null = any).
 * No money moves for any of these — they only change stock and record why.
 */
export const ADJUSTMENT_REASONS = {
    transfer_out:     { label: 'Transferred to another branch', operation: 'subtract' },
    transfer_in:      { label: 'Received from another branch',  operation: 'add' },
    count_correction: { label: 'Stock count correction',        operation: null },
    other:            { label: 'Other',                         operation: null },
};

export const ADJUSTMENT_REASON_CODES = Object.keys(ADJUSTMENT_REASONS);

export const NOTE_MAX_LENGTH = 200;

/** Readable line stored on the movement, e.g. "Transferred to another branch — Branch 2". */
export const adjustmentReasonText = (reason, note) => {
    const label = ADJUSTMENT_REASONS[reason]?.label || reason;
    return note ? `${label} — ${note}` : label;
};
