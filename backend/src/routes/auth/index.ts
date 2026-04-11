import { Router } from "express";
import loginRouter from "./login.js";
import passwordRouter from "./password.js";
import twoFactorRouter from "./two-factor.js";

const router = Router();

router.use(loginRouter);
router.use(passwordRouter);
router.use(twoFactorRouter);

export default router;
