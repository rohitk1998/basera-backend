import { DESTINATION_CENTERS } from '../discovery/discovery.constants';
import { deriveDiscoveredLocation } from './discovered-location.util';
import { HP_LOCATIONS, tehsilsOf } from './hp-locations';
import { PLACE_ALIASES } from './place-aliases';

const at = (key: string) => DESTINATION_CENTERS[key];

describe('deriveDiscoveredLocation', () => {
  it.each([
    ['manali', 'Manali', 'Kullu', 'Manali'],
    ['kasol', 'Kasol', 'Kullu', 'Bhuntar'],
    ['bir', 'Bir', 'Kangra', 'Baijnath'],
    ['dharamshala', 'Dharamshala', 'Kangra', 'Dharamshala'],
    ['jibhi', 'Jibhi', 'Kullu', 'Banjar'],
    ['tirthan valley', 'Tirthan Valley', 'Kullu', 'Banjar'],
  ])('%s resolves to %s -> %s / %s', (key, dest, district, tehsil) => {
    const c = at(key);
    const r = deriveDiscoveredLocation(c.lat, c.lng, dest);
    expect(r).toEqual({ district, tehsil, lat: c.lat, lng: c.lng });
  });

  it('is case/space tolerant on the destination', () => {
    const c = at('tirthan valley');
    expect(deriveDiscoveredLocation(c.lat, c.lng, '  TIRTHAN   Valley ')?.district).toBe('Kullu');
  });

  it('a point beyond twice the destination radius falls back to nearestDistrict with a null tehsil', () => {
    // Manali radius 12 km -> 24 km limit. Shimla-ish point is far away but inside Himachal.
    const r = deriveDiscoveredLocation(31.1048, 77.1734, 'Manali');
    expect(r).not.toBeNull();
    expect(r!.tehsil).toBeNull();
    expect(r!.district).toBe('Shimla');
  });

  it('an unknown destination uses nearestDistrict and never invents a tehsil', () => {
    const r = deriveDiscoveredLocation(32.2396, 77.1887, 'Atlantis');
    expect(r?.tehsil).toBeNull();
    expect(r?.district).toBe('Kullu');
    expect(deriveDiscoveredLocation(32.2396, 77.1887, null)?.tehsil).toBeNull();
    expect(deriveDiscoveredLocation(32.2396, 77.1887, undefined)?.tehsil).toBeNull();
  });

  it('returns null outside Himachal or without usable coordinates', () => {
    expect(deriveDiscoveredLocation(28.6139, 77.209, 'Manali')).toBeNull(); // Delhi
    expect(deriveDiscoveredLocation(null, 77.1, 'Manali')).toBeNull();
    expect(deriveDiscoveredLocation(32.2, undefined, 'Manali')).toBeNull();
    expect(deriveDiscoveredLocation(NaN, 77.1, 'Manali')).toBeNull();
    expect(deriveDiscoveredLocation(32.2, Infinity, 'Manali')).toBeNull();
  });

  it('tehsil and district spellings always match HP_LOCATIONS', () => {
    for (const key of Object.keys(DESTINATION_CENTERS)) {
      const c = DESTINATION_CENTERS[key];
      const r = deriveDiscoveredLocation(c.lat, c.lng, key)!;
      expect(r).not.toBeNull();
      expect(Object.keys(HP_LOCATIONS)).toContain(r.district);
      if (r.tehsil) expect(tehsilsOf(r.district)).toContain(r.tehsil);
    }
  });

  it('the new jibhi / tirthan valley aliases point at a real Kullu tehsil', () => {
    expect(PLACE_ALIASES['jibhi']).toEqual({ district: 'Kullu', tehsil: 'Banjar' });
    expect(PLACE_ALIASES['tirthan valley']).toEqual({ district: 'Kullu', tehsil: 'Banjar' });
    expect(tehsilsOf('Kullu')).toContain('Banjar');
  });
});
