import { SetMetadata } from '@nestjs/common';

export const RESPONSE_MESSAGE = 'response:message';

/**
 * What to tell the user when a create/update/delete endpoint succeeds. Either
 * fixed text, or a function of the handler's result and the request when the
 * wording depends on the outcome ("PAN verified." vs the reason it was not).
 *
 * The ResponseMessageInterceptor puts this in the response's `message` field.
 * Every non-GET handler must have one — a test enforces it.
 */
export type ResponseMessageSpec = string | ((result: any, req: any) => string);

export const ResponseMessage = (spec: ResponseMessageSpec) => SetMetadata(RESPONSE_MESSAGE, spec);
