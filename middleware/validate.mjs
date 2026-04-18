/**
 * Joi validation middleware factory.
 * Usage: validate(schema) as Express middleware
 */
const validate = (schema) => (req, res, next) => {
    const { error } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: false,
        allowUnknown: false,
    });

    if (error) {
        const errors = error.details.map((d) => ({
            field: d.path.join("."),
            message: d.message.replace(/"/g, ""),
        }));

        return res.status(400).json({
            message: "Validation failed",
            errors,
        });
    }

    next();
};

/**
 * Same as validate but allows unknown fields (for PATCH/update routes).
 */
const validateAllowUnknown = (schema) => (req, res, next) => {
    const { error } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: false,
        allowUnknown: true,
    });

    if (error) {
        const errors = error.details.map((d) => ({
            field: d.path.join("."),
            message: d.message.replace(/"/g, ""),
        }));

        return res.status(400).json({
            message: "Validation failed",
            errors,
        });
    }

    next();
};

export { validate, validateAllowUnknown };
