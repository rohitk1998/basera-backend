import { BadRequestException } from '@nestjs/common';
import { HP_DISTRICTS, districtCentre, isInsideHimachal, isTehsilOf } from './hp-locations';

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

export function assertLocationIsValid(
  d: { district: string; tehsil: string; lat: number; lng: number },
  opts: { skipPinRegion?: boolean } = {},
): void {
  if (!(HP_DISTRICTS as readonly string[]).includes(d.district)) {
    throw new BadRequestException('Choose a district in Himachal Pradesh.');
  }
  if (!isTehsilOf(d.district, d.tehsil)) {
    throw new BadRequestException(`Choose a tehsil that belongs to ${d.district} district.`);
  }

  if (!opts.skipPinRegion && !isInsideHimachal(d.lat, d.lng)) {
    throw new BadRequestException(
      'The pin is outside Himachal Pradesh. Move it onto the property, or use "Find on map".',
    );
  }
}

export async function assertLocationAgrees(
  d: { district: string; pincode: string; lat: number; lng: number },
  reverseCheck: (lat: number, lng: number) => Promise<{ district?: string; pincode?: string } | null>,
  opts: { skip?: boolean } = {},
): Promise<void> {
  if (opts.skip) return;
  const found = await reverseCheck(d.lat, d.lng);
  if (!found) return;
  if (found.district && found.district !== d.district) {
    throw new BadRequestException(`The pin is in ${found.district} district, but you chose ${d.district}. Move the pin or change the district.`);
  }
  if (found.pincode && found.pincode !== d.pincode) {
    throw new BadRequestException(`The pin is in PIN code area ${found.pincode}, but you entered ${d.pincode}. Check the PIN code.`);
  }
}

export function fallbackPin(district: string): { lat: number; lng: number } | null {
  return districtCentre(district);
}
