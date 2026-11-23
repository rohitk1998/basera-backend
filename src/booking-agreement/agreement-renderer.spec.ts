import { hashAgreement, renderAgreement, type AgreementInput } from './agreement-renderer';

const base: AgreementInput = {
  listingTitle: 'Sunny room in Indiranagar',
  hostFirstName: 'Asha',
  guestFirstName: 'Ravi',
  moveIn: '2026-12-01',
  moveOut: '2027-03-01',
  months: 3,
  monthlyRent: 15000,
  deposit: 30000,
  dueAtMoveIn: 45000,
};

describe('renderAgreement', () => {
  it('renders core terms with first names only', () => {
    const text = renderAgreement(base);
    expect(text).toContain('Host: Asha');
    expect(text).toContain('Guest: Ravi');
    expect(text).toContain('2026-12-01 to 2027-03-01');
    expect(text).toContain('Rs. 15,000');
    expect(text).toContain('24 hours after check-in');
    expect(text).toContain('not an escrow');
    expect(text).not.toContain('House rules');
    expect(text).not.toContain('cancellation policy');
  });

  it('includes house rules and cancellation policy when present', () => {
    const text = renderAgreement({ ...base, pets: false, smoking: true, cancellationPolicy: 'moderate' });
    expect(text).toContain('Pets: not allowed');
    expect(text).toContain('Smoking: allowed');
    expect(text).toContain('cancellation policy: moderate');
  });

  it('is deterministic and the hash changes with the text', () => {
    expect(hashAgreement(renderAgreement(base))).toBe(hashAgreement(renderAgreement(base)));
    expect(hashAgreement(renderAgreement(base))).not.toBe(
      hashAgreement(renderAgreement({ ...base, monthlyRent: 16000 })),
    );
    expect(hashAgreement('x')).toHaveLength(64);
  });
});
