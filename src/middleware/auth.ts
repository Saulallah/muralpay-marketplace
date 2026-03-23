import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Simple bearer token auth middleware.
 * If API_SECRET is not set, all requests pass through.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.apiSecret) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (token !== config.apiSecret) {
    res.status(401).json({ error: 'Unauthorized. Provide a valid Bearer token.' });
    return;
  }

  next();
}
