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
  const secretStr = secret ?? process.env.JWT_SECRET ?? DEFAULT_SECRET;
  return new TextEncoder().encode(secretStr);
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
