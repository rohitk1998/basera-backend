import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DisputeBookingDto } from './dispute-booking.dto';

const check = (plain: Record<string, unknown>) => validate(plainToInstance(DisputeBookingDto, plain));
const base = { description: 'I need to leave before move-out.', leavingOn: '2026-10-16' };

describe('DisputeBookingDto', () => {
  it('accepts early_departure without a requested amount', async () => {
    expect(await check({ ...base, category: 'early_departure' })).toHaveLength(0);
  });

  it('accepts early_departure with an amount', async () => {
    expect(await check({ ...base, category: 'early_departure', requestedAmount: 500 })).toHaveLength(0);
  });

  it('rejects an early_departure amount below 1', async () => {
    expect(await check({ ...base, category: 'early_departure', requestedAmount: 0 })).not.toHaveLength(0);
  });

  it('still requires an amount for other categories', async () => {
    expect(await check({ ...base, category: 'cleanliness' })).not.toHaveLength(0);
  });

  it('requires a reason of at least 10 characters', async () => {
    expect(await check({ category: 'early_departure', description: 'short' })).not.toHaveLength(0);
  });

  it('requires a leaving date for early_departure', async () => {
    expect(await check({ category: 'early_departure', description: base.description })).not.toHaveLength(0);
    expect(await check({ ...base, category: 'early_departure', leavingOn: 'tomorrow' })).not.toHaveLength(0);
  });

  it('does not require a leaving date for other categories', async () => {
    expect(await check({ description: base.description, category: 'cleanliness', requestedAmount: 500 })).toHaveLength(0);
  });
});
