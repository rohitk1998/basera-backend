import { BadRequestException } from '@nestjs/common';
import { HP_DISTRICTS, districtCentre, isInsideHimachal, isTehsilOf } from './hp-locations';

/**
 * Before district + tehsil existed, a listing named one of 18 popular towns.
 * Older app builds still send only `town`, so those payloads are upgraded to
 * the closest district and tehsil rather than refused. These are the nearest
 * administrative units for each town, used only for that fallback.
 */
const LEGACY_PLACES: Record<string, { district: string; tehsil: string }> = {
  Manali: { district: 'Kullu', tehsil: 'Manali' },
  Shimla: { district: 'Shimla', tehsil: 'Shimla Urban' },
  Dharamshala: { district: 'Kangra', tehsil: 'Dharamshala' },
  McLeodganj: { district: 'Kangra', tehsil: 'Dharamshala' },
  Kasol: { district: 'Kullu', tehsil: 'Bhuntar' },
  Bir: { district: 'Kangra', tehsil: 'Baijnath' },
  Dalhousie: { district: 'Chamba', tehsil: 'Dalhousie' },
  Kullu: { district: 'Kullu', tehsil: 'Kullu' },
  Palampur: { district: 'Kangra', tehsil: 'Palampur' },
  'Spiti Valley': { district: 'Lahaul and Spiti', tehsil: 'Kaza' },
  Chamba: { district: 'Chamba', tehsil: 'Chamba' },
  Kufri: { district: 'Shimla', tehsil: 'Shimla Rural' },
  Manikaran: { district: 'Kullu', tehsil: 'Bhuntar' },
  Tosh: { district: 'Kullu', tehsil: 'Bhuntar' },
  Barot: { district: 'Mandi', tehsil: 'Joginder Nagar' },
  Chitkul: { district: 'Kinnaur', tehsil: 'Sangla' },
  Sarahan: { district: 'Shimla', tehsil: 'Rampur' },
  Narkanda: { district: 'Shimla', tehsil: 'Kumarsain' },
};

export const LEGACY_PLACE_NAMES = Object.keys(LEGACY_PLACES);

/**
 * Makes a location payload complete without overriding anything the client
 * did send: a legacy `town` gets its district and tehsil, and a payload with a
 * tehsil but no `town` gets `town = tehsil` (the name the public site groups,
 * filters and searches by).
 */
export function upgradeLegacyLocation<T>(body: T): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const d = { ...(body as Record<string, unknown>) };

  if (typeof d.town === 'string' && !d.district && LEGACY_PLACES[d.town]) {
    d.district = LEGACY_PLACES[d.town].district;
    d.tehsil = d.tehsil || LEGACY_PLACES[d.town].tehsil;
  }
  if (!d.town && typeof d.tehsil === 'string' && d.tehsil) {
    d.town = d.tehsil;
  }
  return d as T;
}

/**
 * The location rules a schema cannot express (the location schema is merged
 * into larger ones, which rules out wrapping it in a refinement): the tehsil
 * has to belong to the district, and the pin has to be inside Himachal
 * Pradesh. The pin is what the walkthrough video's GPS is checked against, so
 * it must be a real spot in the state.
 */
export function assertLocationIsValid(d: { district: string; tehsil: string; lat: number; lng: number }): void {
  if (!(HP_DISTRICTS as readonly string[]).includes(d.district)) {
    throw new BadRequestException('Choose a district in Himachal Pradesh.');
  }
  if (!isTehsilOf(d.district, d.tehsil)) {
    throw new BadRequestException(`Choose a tehsil that belongs to ${d.district} district.`);
  }
  if (!isInsideHimachal(d.lat, d.lng)) {
    throw new BadRequestException(
      'The pin is outside Himachal Pradesh. Move it onto the property, or use "Find on map".',
    );
  }
}

/** The pin to fall back on when a district is chosen but nothing more exact is known. */
export function fallbackPin(district: string): { lat: number; lng: number } | null {
  return districtCentre(district);
}
