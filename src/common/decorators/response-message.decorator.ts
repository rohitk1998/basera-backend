import { SetMetadata } from '@nestjs/common';

export const RESPONSE_MESSAGE = 'response:message';

export type ResponseMessageSpec = string | ((result: any, req: any) => string);

export const ResponseMessage = (spec: ResponseMessageSpec) => SetMetadata(RESPONSE_MESSAGE, spec);
