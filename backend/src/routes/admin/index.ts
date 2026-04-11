import { Router } from "express";
import activityRouter from "./activity.js";
import codesRouter from "./codes.js";
import conversationsRouter from "./conversations.js";

const router = Router();

router.use(activityRouter);
router.use(codesRouter);
router.use(conversationsRouter);

export default router;
