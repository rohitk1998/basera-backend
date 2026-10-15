import { HP_DISTRICTS, tehsilsOf, type HpDistrict } from './hp-locations';

/** The pieces of an address the listing form has fields for. Any may be missing. */
export interface AddressParts {
  district?: HpDistrict;
  tehsil?: string;
  city?: string;
  locality?: string;
  pincode?: string;
  /** The readable address without the state, PIN and country the form has its own fields for. */
  street?: string;
}

type GoogleComponent = { long_name?: string; short_name?: string; types?: string[] };
type GoogleResult = { formatted_address?: string; address_components?: GoogleComponent[] };

/** "Lahaul & Spiti", "Sirmour District", "Ghumarwin Tehsil" -> letters only, lower-case. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(district|tehsil|tahsil|sub[- ]?division|sub[- ]?tehsil)\b/g, ' ')
    .replace(/[^a-z]/g, '');

// Spellings Google and OpenStreetMap use that differ from the official name.
const DISTRICT_ALIASES: Record<string, HpDistrict> = {
  lahulandspiti: 'Lahaul and Spiti',
  lahaulspiti: 'Lahaul and Spiti',
  lahulspiti: 'Lahaul and Spiti',
  lahaulandspiti: 'Lahaul and Spiti',
  sirmour: 'Sirmaur',
  sirmor: 'Sirmaur',
};

const DISTRICT_BY_NAME = new Map<string, HpDistrict>([
  ...HP_DISTRICTS.map((d) => [norm(d), d] as [string, HpDistrict]),
  ...Object.entries(DISTRICT_ALIASES),
]);

export function matchDistrict(name: string | undefined): HpDistrict | undefined {
  return name ? DISTRICT_BY_NAME.get(norm(name)) : undefined;
}

/** Exact tehsil name first; else a single tehsil that starts with (or is started by) the name. */
export function matchTehsil(district: HpDistrict, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const wanted = norm(name);
  if (wanted.length < 3) return undefined;
  const tehsils = tehsilsOf(district);
  const exact = tehsils.find((t) => norm(t) === wanted);
  if (exact) return exact;
  if (wanted.length < 4) return undefined;
  const loose = tehsils.filter((t) => norm(t).startsWith(wanted) || wanted.startsWith(norm(t)));
  return loose.length === 1 ? loose[0] : undefined; // "Shimla" fits both Shimla Urban and Shimla Rural: leave it to the host
};

/** An Open Location Code ("V77G+3Q"), which Google returns as a street when it has nothing better. */
const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,}\b\s*/i;

/** Drops ", India" and the "Himachal Pradesh 174021" segment: the form has fields for those. */
export function streetFrom(formatted: string | undefined, drop: (string | undefined)[] = []): string | undefined {
  if (!formatted) return undefined;
  const dropped = new Set(drop.filter(Boolean).map((s) => s!.trim().toLowerCase()));
  const kept = formatted
    .split(',')
    .map((s) => s.trim().replace(PLUS_CODE, ''))
    .filter(
      (s) =>
        s &&
        !/^india$/i.test(s) &&
        !/^himachal pradesh\b/i.test(s) &&
        !/^\d{6}$/.test(s) &&
        !dropped.has(s.toLowerCase()),
    );
  return kept.length ? kept.join(', ') : undefined;
}

function finish(
  districtCandidates: (string | undefined)[],
  tehsilCandidates: (string | undefined)[],
  rest: Omit<AddressParts, 'district' | 'tehsil'>,
): AddressParts {
  const district = districtCandidates.map(matchDistrict).find(Boolean);
  const tehsil = district ? tehsilCandidates.map((c) => matchTehsil(district, c)).find(Boolean) : undefined;
  const parts: AddressParts = { ...rest };
  if (district) parts.district = district;
  if (tehsil) parts.tehsil = tehsil;
  // Never echo the same name into "City" and "Area".
  if (parts.locality && parts.city && norm(parts.locality) === norm(parts.city)) delete parts.locality;
  // The street must not repeat what the City, Area and District fields already say.
  if (parts.street) {
    // Nothing left (a bare Plus Code, or only names the other fields hold): fall back to the locality, never the code.
    parts.street =
      streetFrom(parts.street, [parts.locality, parts.city, parts.district, 'Himachal Pradesh']) ??
      (PLUS_CODE.test(parts.street.trim()) ? parts.locality ?? parts.city : parts.street);
  }
  return Object.fromEntries(Object.entries(parts).filter(([, v]) => v)) as AddressParts;
}

/**
 * Google's address components for the best result (the PIN code is taken from a
 * later result when the first has none). Only values that match the official
 * district and tehsil lists are returned for those two fields, so the form's
 * dropdowns never receive a name they do not contain.
 */
export function partsFromGoogle(results: GoogleResult[] | undefined): AddressParts {
  const first = results?.[0];
  if (!first) return {};
  const of = (r: GoogleResult | undefined, type: string) =>
    r?.address_components?.find((c) => c.types?.includes(type))?.long_name;
  const all = (type: string) =>
    (results ?? []).flatMap((r) => (r.address_components ?? []).filter((c) => c.types?.includes(type)).map((c) => c.long_name));

  const pin = (results ?? []).map((r) => of(r, 'postal_code')).find((p) => p && /^\d{6}$/.test(p));

  return finish(
    [...all('administrative_area_level_2'), ...all('administrative_area_level_3')],
    [
      ...all('administrative_area_level_3'),
      ...all('administrative_area_level_4'),
      ...all('locality'),
      ...all('sublocality_level_1'),
    ],
    {
      street: streetFrom(first.formatted_address),
      city: of(first, 'locality') ?? of(first, 'sublocality_level_1') ?? of(first, 'administrative_area_level_3'),
      locality: of(first, 'sublocality_level_1') ?? of(first, 'neighborhood') ?? of(first, 'sublocality_level_2'),
      pincode: pin,
    },
  );
}

/** The same, from Nominatim's `address` object (used when Google is unavailable). */
export function partsFromNominatim(address: Record<string, string> | undefined, displayName?: string): AddressParts {
  if (!address) return { street: streetFrom(displayName) };
  const pin = address.postcode && /^\d{6}$/.test(address.postcode.replace(/\s/g, '')) ? address.postcode.replace(/\s/g, '') : undefined;
  return finish(
    [address.state_district, address.county, address.district],
    [address.county, address.subdistrict, address.state_district, address.village, address.town, address.city, address.suburb],
    {
      street: streetFrom(displayName),
      city: address.village ?? address.town ?? address.city ?? address.hamlet,
      locality: address.suburb ?? address.neighbourhood ?? address.hamlet,
      pincode: pin,
    },
  );
}
