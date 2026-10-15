/**
 * Parsing of FCM v1 / Google OAuth error bodies, for logging and for deciding
 * whether a device token is permanently dead.
 *
 * Nothing here ever returns the token, the private key or a bearer: only the
 * HTTP status, FCM's own status string (e.g. UNAUTHENTICATED) and error code
 * (e.g. UNREGISTERED), plus FCM's human message with any long opaque string
 * (which could be a registration token) redacted.
 */
export interface FcmErrorInfo {
  httpStatus: number;
  /** google.rpc status, e.g. INVALID_ARGUMENT, PERMISSION_DENIED, UNAUTHENTICATED. */
  status: string;
  /** FcmError.errorCode from details[], e.g. UNREGISTERED. Empty when absent. */
  errorCode: string;
  message: string;
  /** The token is permanently invalid and should be removed from the account. */
  tokenDead: boolean;
}

function redact(text: string): string {
  // Registration tokens and keys are long unbroken runs of token characters.
  return text.replace(/[A-Za-z0-9_:\-.]{40,}/g, '[redacted]').slice(0, 300);
}

export function parseFcmError(httpStatus: number, bodyText: string): FcmErrorInfo {
  let status = '';
  let errorCode = '';
  let message = '';
  try {
    const err = JSON.parse(bodyText)?.error;
    status = typeof err?.status === 'string' ? err.status : '';
    message = typeof err?.message === 'string' ? err.message : '';
    const details: unknown[] = Array.isArray(err?.details) ? err.details : [];
    for (const d of details) {
      const code = (d as { errorCode?: unknown })?.errorCode;
      if (typeof code === 'string') errorCode = code;
    }
  } catch {
    message = bodyText;
  }

  const tokenDead =
    errorCode === 'UNREGISTERED' ||
    status === 'NOT_FOUND' ||
    bodyText.includes('UNREGISTERED') ||
    bodyText.includes('NotRegistered') ||
    // INVALID_ARGUMENT also covers a bad payload; only the token variant means the token is dead.
    (status === 'INVALID_ARGUMENT' && /registration token/i.test(message));

  return { httpStatus, status, errorCode, message: redact(message), tokenDead };
}

export function describeFcmError(info: FcmErrorInfo): string {
  return `http=${info.httpStatus} status=${info.status || 'n/a'} code=${info.errorCode || 'n/a'}${
    info.message ? ` message="${info.message}"` : ''
  }`;
}
