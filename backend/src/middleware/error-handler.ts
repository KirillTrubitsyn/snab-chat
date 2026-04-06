import { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error("[error-handler]", err);

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    error: "Внутренняя ошибка сервера",
  });
}
