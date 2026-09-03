export interface AuthUser {
  userId: string;
  phone?: string;
}

// Express Request augmentation so `req.user` is typed after AuthGuard runs.
declare module 'express' {
  interface Request {
    user?: AuthUser;
  }
}
