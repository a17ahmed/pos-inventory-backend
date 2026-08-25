import express from "express";
import { validate } from "../middleware/validate.mjs";
import { createClosingSchema } from "../middleware/validationSchemas.mjs";
import {
    getLastClosing,
    previewClosing,
    createClosing,
    getClosings,
    getClosingById,
} from "../controllers/closing.mjs";

const closingRouter = express.Router();

// ─── Static paths before /:id ──────────────────────────────────
closingRouter.get("/last", getLastClosing);
closingRouter.get("/preview", previewClosing);
closingRouter.get("/", getClosings);
closingRouter.post("/", validate(createClosingSchema), createClosing);
closingRouter.get("/:id", getClosingById);

export default closingRouter;
