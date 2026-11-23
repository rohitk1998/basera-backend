import { DESTINATION_CENTERS } from '../discovery/discovery.constants';
import { nearestDistrict } from '../attractions/attraction.util';
import { distanceKm, isInsideHimachal, tehsilsOf } from './hp-locations';
import { placeAliasFor } from './place-aliases';

export type DiscoveredLocation = { district: string; tehsil: string | null; lat: number; lng: number };

/**
 * Derives OUR OWN district/tehsil for a discovered point. Pure and offline: no Google data is used.
 * Returns null (row stays out of the grid) for missing coordinates or points outside Himachal.
 */
export function deriveDiscoveredLocation(
  lat: number | null | undefined,
  lng: number | null | undefined,
  destination: string | null | undefined,
): DiscoveredLocation | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!isInsideHimachal(lat, lng)) return null;
  const point = { lat, lng };

  const alias = placeAliasFor(destination);
  const key = destination ? destination.toLowerCase().replace(/\s+/g, ' ').trim() : '';
  const centre = Object.prototype.hasOwnProperty.call(DESTINATION_CENTERS, key) ? DESTINATION_CENTERS[key] : null;
  if (alias && centre && distanceKm(point, centre) <= (2 * centre.radiusM) / 1000) {
    const tehsil = tehsilsOf(alias.district).includes(alias.tehsil) ? alias.tehsil : null;
    return { district: alias.district, tehsil, lat, lng };
  }
  return { district: nearestDistrict(lat, lng), tehsil: null, lat, lng };
}
