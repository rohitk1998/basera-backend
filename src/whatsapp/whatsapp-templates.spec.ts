import { WHATSAPP_TEMPLATES } from './whatsapp-templates';

const NEW_KEYS = ['stay_request_received', 'stay_request_admin_alert', 'stay_request_sent_to_owner', 'stay_dates_unavailable'] as const;
const defs = WHATSAPP_TEMPLATES as Record<string, any>;

describe('stay-request WhatsApp templates', () => {
  it.each(NEW_KEYS)('%s is registered under its own name, UTILITY, English, snake_case', (k) => {
    const d = defs[k];
    expect(d).toBeDefined();
    expect(d.name).toBe(k);
    expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(d.category).toBe('UTILITY');
    expect(d.language).toBe('en');
  });

  it.each(NEW_KEYS)('%s has one bodyParam per {{n}}, numbered 1..n in order', (k) => {
    const d = defs[k];
    const vars = [...d.suggestedBody.matchAll(/\{\{(\d+)\}\}/g)].map((m: RegExpMatchArray) => Number(m[1]));
    expect(vars.length).toBe(d.bodyParams.length);
    expect(vars).toEqual(d.bodyParams.map((_: string, i: number) => i + 1));
    expect(new Set(d.bodyParams).size).toBe(d.bodyParams.length);
  });

  it.each(NEW_KEYS)('%s body neither starts nor ends with a variable and is single-line', (k) => {
    const body: string = defs[k].suggestedBody;
    expect(body.trim()).toBe(body);
    expect(body).not.toMatch(/^\{\{/);
    expect(body).not.toMatch(/\}\}[.!?]?$/);
    expect(body).not.toMatch(/\n/);
    expect(body).not.toMatch(/escrow/i);
  });

  it.each(NEW_KEYS)('%s has matching sample values when the registry carries them', (k) => {
    const d = defs[k];
    const samples = d.samples ?? d.sampleValues ?? d.exampleParams;
    if (!samples) return; // samples live in the docs when the registry has no field for them
    const list = Array.isArray(samples) ? samples : d.bodyParams.map((p: string) => samples[p]);
    expect(list.length).toBe(d.bodyParams.length);
    for (const s of list) {
      expect(typeof s).toBe('string');
      expect(s).not.toMatch(/\n|\t/);
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it('exposes the exact param order from the spec', () => {
    expect(defs.stay_request_received.bodyParams).toEqual(['guest_name', 'property_name', 'check_in_date', 'check_out_date']);
    expect(defs.stay_request_admin_alert.bodyParams).toEqual(['admin_name', 'request_ref', 'guest_name', 'property_name', 'check_in_date', 'check_out_date']);
    expect(defs.stay_request_sent_to_owner.bodyParams).toEqual(['guest_name', 'property_name', 'check_in_date', 'check_out_date', 'bookings_url']);
    expect(defs.stay_dates_unavailable.bodyParams).toEqual(['guest_name', 'property_name', 'check_in_date', 'check_out_date', 'stays_url']);
  });

  it('leaves the existing templates untouched', () => {
    expect(defs.booking_confirmed.bodyParams).toEqual(['guest_name', 'listing_title', 'check_in_date']);
    expect(defs.host_invitation.category).toBe('MARKETING');
  });
});
