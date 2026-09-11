import type { NextFunction, Request, Response } from 'express';

export type RateLimitMiddleware = (req: Request, res: Response, next: NextFunction) => void;
