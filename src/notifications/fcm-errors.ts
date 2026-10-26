export interface FcmErrorInfo {
  httpStatus: number;
  status: string;
  errorCode: string;
  message: string;
  tokenDead: boolean;
}

function redact(text: string): string {
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
    (status === 'INVALID_ARGUMENT' && /registration token/i.test(message));

  return { httpStatus, status, errorCode, message: redact(message), tokenDead };
}

export function describeFcmError(info: FcmErrorInfo): string {
  return `http=${info.httpStatus} status=${info.status || 'n/a'} code=${info.errorCode || 'n/a'}${
    info.message ? ` message="${info.message}"` : ''
  }`;
}
