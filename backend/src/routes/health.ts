import { Router } from "express";

const router = Router();

router.get("/health", (_req, res) => {
  // Minimal response — no uptime/version to prevent information disclosure
  res.json({ status: "ok", v: "graph-preseed-v1" });
});

export default router;
