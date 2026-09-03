import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

/**
 * All three endpoints in this module are mocked, same as the Next.js
 * originals — see basera-web AGENTS.md: the three trust layers (legal,
 * telemetry, banking) are mocked end to end, no real provider integration
 * yet. Passing the request shape is what "verified" means here.
 */
@Injectable()
export class MocksService {
  private readonly logger = new Logger(MocksService.name);

  constructor(private readonly subscriptions: SubscriptionsService) {}

  verifyUpi(_userId: string, _upiId: string) {
    // TODO: Integrate with Razorpay/Cashfree for UPI Penny Drop Verification.
    // This will send ₹1 to the UPI ID to fetch the registered name.
    const registeredName = 'MOCK USER NAME';
    return {
      success: true,
      nameAtBank: registeredName,
      message: 'UPI verified successfully.',
    };
  }

  /**
   * Deprecated alias — kept only so this route doesn't 404 for any existing
   * caller. New code should call POST /api/subscriptions/subscribe
   * directly. Unlike the old stub, this now performs a real (DB-simulated)
   * write via SubscriptionsService rather than doing nothing.
   */
  async subscribe(userId: string, planId: string, _listingId: string) {
    const subscription = await this.subscriptions.subscribe(userId, planId);
    const mockCheckoutUrl = 'https://razorpay.com/mock-checkout';
    return { success: true, checkoutUrl: mockCheckoutUrl, subscription };
  }

  verifyKyc(userId: string, documentType: string, documentNumber: string) {
    // TODO: Integrate with HyperVerge, Signzy, or Setu API.
    // const verificationResult = await fetch('https://api.signzy.com/verify-pan', { ... })
    this.logger.log(`Verifying ${documentType}: ${documentNumber} for user ${userId}`);
    const isVerified = true;
    return {
      success: true,
      verified: isVerified,
      message: 'Identity successfully verified with government database.',
    };
  }
}
