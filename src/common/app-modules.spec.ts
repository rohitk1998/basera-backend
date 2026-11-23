import 'reflect-metadata';
import { AppModule } from '../app.module';
import { FinanceAdminModule } from '../finance/finance-admin.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { CrmModule } from '../crm/crm.module';
import { ClaimsModule } from '../claims/claims.module';
import { InquiriesModule } from '../inquiries/inquiries.module';
import { AutomationModule } from '../automation/automation.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AdminBookingsModule } from '../admin-bookings/admin-bookings.module';
import { AdminLookupsModule } from '../admin-lookups/admin-lookups.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { HealthModule } from '../health/health.module';

/** A module that is imported at the top of app.module.ts but never listed is silently dead (its routes and
 *  cron jobs never mount). This caught FinanceAdminModule once; keep every feature module pinned here. */
describe('AppModule mounts every feature module', () => {
  const mounted: unknown[] = Reflect.getMetadata('imports', AppModule) ?? [];
  const must = [
    FinanceAdminModule, DiscoveryModule, CrmModule, ClaimsModule, InquiriesModule, AutomationModule,
    AnalyticsModule, AdminBookingsModule, AdminLookupsModule, WhatsappModule, HealthModule,
  ];
  it.each(must.map((m) => [(m as { name: string }).name, m]))('%s is in AppModule.imports', (_name, mod) => {
    expect(mounted).toContain(mod);
  });
});
