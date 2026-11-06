import { jwtVerify, SignJWT } from 'jose';
import { AppError } from './errors';

export type UserRole = 'RIDER' | 'DRIVER' | 'ADMIN';

export interface AuthTokenPayload {
  userId: string;
  role: UserRole;
  email: string;
}

const DEFAULT_SECRET = 'hexdispatch_dev_jwt_secret_key_at_least_32_chars_long!';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';

function getSecretKey(secret?: string): Uint8Array {
  const configured = secret ?? process.env.JWT_SECRET;
  if (!configured && process.env.NODE_ENV === 'production') {
    // Never fall back to the public dev secret in production: anyone could mint admin tokens.
    throw new Error('JWT_SECRET is required when NODE_ENV=production');
  }
  if (configured && process.env.NODE_ENV === 'production' && configured.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }
  return new TextEncoder().encode(configured ?? DEFAULT_SECRET);
}

export async function signAccessToken(payload: AuthTokenPayload, secret?: string): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setSubject(payload.userId)
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(getSecretKey(secret));
}

export async function signRefreshToken(
  payload: AuthTokenPayload,
  secret?: string,
): Promise<string> {
  return new SignJWT({ ...payload, tokenType: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setSubject(payload.userId)
    .setExpirationTime(REFRESH_TOKEN_EXPIRY)
    .sign(getSecretKey(secret));
}

export async function verifyToken(token: string, secret?: string): Promise<AuthTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(secret));
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.role !== 'string'
    ) {
      throw AppError.unauthorized('Invalid token payload');
    }
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role as UserRole,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.unauthorized('Invalid or expired token');
  }
}

/** Call at boot so a misconfigured production deploy fails immediately, not on first login. */
export function assertJwtSecretConfigured(): void {
  getSecretKey();
}
