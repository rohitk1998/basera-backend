import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { RESPONSE_MESSAGE, ResponseMessageSpec } from '../decorators/response-message.decorator';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class ResponseMessageInterceptor implements NestInterceptor {
  private readonly logger = new Logger('ResponseMessage');

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    if (READ_ONLY_METHODS.has(req.method)) return next.handle();

    const spec = this.reflector.get<ResponseMessageSpec | undefined>(RESPONSE_MESSAGE, context.getHandler());

    return next.handle().pipe(
      map((body: unknown) => {
        if (body !== null && body !== undefined && (typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body))) {
          return body;
        }
        const { success, message, ...rest } = (body ?? {}) as Record<string, unknown>;
        return { success: success ?? true, message: this.resolve(spec, body, req, message), ...rest };
      }),
    );
  }

  private resolve(spec: ResponseMessageSpec | undefined, body: unknown, req: any, existing: unknown): string {
    if (typeof existing === 'string' && existing.trim()) return existing;
    if (typeof spec === 'string') return spec;
    if (typeof spec === 'function') {
      try {
        const text = spec(body ?? {}, req);
        if (text) return text;
      } catch (err) {
        this.logger.error(`@ResponseMessage for ${req.method} ${req.originalUrl} threw`, err as Error);
      }
    }
    this.logger.warn(`No @ResponseMessage on ${req.method} ${req.originalUrl} — sent a generic message.`);
    return 'Done.';
  }
}
