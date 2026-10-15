import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Response } from 'express';

const GENERIC_SERVER_ERROR = 'Something went wrong. Please try again.';
const TOO_MANY_REQUESTS = 'Too many requests. Please wait a moment and try again.';

/**
 * Every failure answers the same shape:
 *
 *   { success: false, statusCode, message, error }
 *
 * `message` is always ONE readable string. `error` carries the same text, not
 * Nest's default status name ("Bad Request"): much of the frontend reads
 * `body.error` first and was showing that bare status name to users. Validation
 * failures, which Nest reports as an array, are joined into the message and
 * also kept as `errors: string[]`. Unexpected crashes never leak internals —
 * they are logged and answered with a generic 500.
 *
 * It also absorbs one harmless case: Multer throws a bare `Request aborted`
 * when a client disconnects mid-upload. There is nobody left to answer, so it
 * is logged quietly instead of as a 500.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiException');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const res = host.switchToHttp().getResponse<Response>();

    if (!(exception instanceof HttpException) && exception instanceof Error && exception.message === 'Request aborted') {
      this.logger.warn('Upload aborted by client before it finished — no response sent.');
      if (!res.headersSent) res.destroy();
      return;
    }
    if (res.headersSent) return;

    const { status, message, errors } = this.describe(exception);
    // A deliberate 429 (e.g. the check-in lockout) can say how long to wait:
    // sent as the standard Retry-After header and as a body field.
    const retryAfterSeconds = this.retryAfterSeconds(exception);
    if (retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(status).json({
      success: false,
      statusCode: status,
      message,
      error: message,
      ...(errors ? { errors } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }

  private retryAfterSeconds(exception: unknown): number | undefined {
    if (!(exception instanceof HttpException)) return undefined;
    const response = exception.getResponse();
    const value = typeof response === 'object' ? (response as { retryAfterSeconds?: unknown }).retryAfterSeconds : undefined;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private describe(exception: unknown): { status: number; message: string; errors?: string[] } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Only the rate limiter's own 429 is reworded; a 429 we raised on purpose keeps its specific message.
      if (exception instanceof ThrottlerException) return { status, message: TOO_MANY_REQUESTS };

      const response = exception.getResponse();
      const raw = typeof response === 'string' ? response : (response as { message?: unknown }).message;
      if (Array.isArray(raw)) {
        const errors = raw.map(String);
        return { status, message: errors.join('. '), errors };
      }
      const message = typeof raw === 'string' && raw.trim() ? raw : exception.message;
      if (status >= 500) this.logger.error(`${status}: ${message}`);
      return { status, message: message || GENERIC_SERVER_ERROR };
    }

    // Errors raised before Nest routes the request (oversized or malformed
    // bodies) carry their own 4xx status.
    const http = exception as { status?: number; statusCode?: number; type?: string; message?: string } | null;
    const code = http?.status ?? http?.statusCode;
    if (typeof code === 'number' && code >= 400 && code < 500) {
      const message = http?.type === 'entity.too.large' ? 'That request is too large.' : http?.message || 'The request could not be processed.';
      return { status: code, message };
    }

    this.logger.error('Unhandled error', exception instanceof Error ? exception.stack : String(exception));
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: GENERIC_SERVER_ERROR };
  }
}
