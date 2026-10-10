import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { AdminController } from '../admin/admin.controller';
import { AdminAttractionsController } from '../attractions/admin-attractions.controller';
import { AuthController } from '../auth/auth.controller';
import { BookingsController } from '../bookings/bookings.controller';
import { ConversationsController } from '../conversations/conversations.controller';
import { HostListingsController } from '../listings/host-listings.controller';
import { ListingsController } from '../listings/listings.controller';
import { NotificationsController } from '../notifications/notifications.controller';
import { PaymentsController } from '../payments/payments.controller';
import { ReviewsController } from '../reviews/reviews.controller';
import { StorageController } from '../storage/storage.controller';
import { UserController } from '../user/user.controller';
import { VerificationController } from '../verification/verification.controller';
import { RESPONSE_MESSAGE } from './decorators/response-message.decorator';

const CONTROLLERS = [
  AdminController,
  AdminAttractionsController,
  AuthController,
  BookingsController,
  ConversationsController,
  HostListingsController,
  ListingsController,
  NotificationsController,
  PaymentsController,
  ReviewsController,
  StorageController,
  UserController,
  VerificationController,
];

const METHOD_NAME = { [RequestMethod.POST]: 'POST', [RequestMethod.PUT]: 'PUT', [RequestMethod.PATCH]: 'PATCH', [RequestMethod.DELETE]: 'DELETE' } as Record<number, string>;

/** Every route handler that changes something, as "POST BookingsController.approve". */
function mutatingHandlers() {
  const found: { label: string; handler: Function }[] = [];
  for (const controller of CONTROLLERS) {
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as any)[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata('method', handler);
      if (method === undefined || !(method in METHOD_NAME)) continue;
      found.push({ label: `${METHOD_NAME[method]} ${controller.name}.${name}`, handler });
    }
  }
  return found;
}

describe('response contract', () => {
  const handlers = mutatingHandlers();

  it('finds the create/update/delete endpoints (guards against this test silently checking nothing)', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(57);
  });

  it('every POST / PUT / PATCH / DELETE handler declares a success message', () => {
    const missing = handlers.filter((h) => Reflect.getMetadata(RESPONSE_MESSAGE, h.handler) === undefined).map((h) => h.label);
    expect(missing).toEqual([]);
  });

  it('every message is non-empty text or a function', () => {
    for (const h of handlers) {
      const spec = Reflect.getMetadata(RESPONSE_MESSAGE, h.handler);
      expect(typeof spec === 'function' || (typeof spec === 'string' && spec.trim().length > 0)).toBe(true);
    }
  });
});
