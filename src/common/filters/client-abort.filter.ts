import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Multer throws a bare `Error: Request aborted` (see
 * node_modules/multer/lib/make-middleware.js) when the client disconnects
 * mid-upload — the browser tab closed, the user navigated away, or the
 * connection dropped while streaming a photo/video to
 * media/photos|video. Nest's default handler treats that as an unhandled
 * 500 and logs a full stack trace, but there is no client left to receive
 * a response, and nothing actually went wrong server-side. This filter
 * recognises that one case, skips the response write (the socket is
 * already gone), and logs it at a much quieter level; every other
 * exception falls through to Nest's normal handling unchanged.
 */
@Catch()
export class ClientAbortFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ClientAbort');

  catch(exception: unknown, host: ArgumentsHost) {
    if (!(exception instanceof HttpException) && this.isClientAbort(exception)) {
      const res = host.switchToHttp().getResponse<Response>();
      this.logger.warn('Upload aborted by client before it finished — no response sent.');
      if (!res.headersSent) {
        res.destroy();
      }
      return;
    }
    super.catch(exception, host);
  }

  private isClientAbort(exception: unknown): boolean {
    return exception instanceof Error && exception.message === 'Request aborted';
  }
}
