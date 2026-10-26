export interface AuthUser {
  userId: string;
  phone?: string;
}

declare module 'express' {
  interface Request {
    user?: AuthUser;
  }
}
