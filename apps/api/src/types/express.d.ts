import type { AuthenticatedDevice } from '../auth/requireDevice';

declare global {
  namespace Express {
    interface Request {
      member?: import('../auth/requireMember').AuthenticatedMember;
      device?: AuthenticatedDevice;
    }
  }
}

export {};
