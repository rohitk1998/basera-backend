/**
 * Himachal Pradesh districts and the tehsils / sub-tehsils under each, as
 * published by the district administrations (hp<district>.nic.in). A host picks
 * a district, then a tehsil, then describes the exact spot; the map pin is
 * found from that, or placed directly on the map anywhere inside the state.
 *
 * Plain data module (no 'use client') so it can be imported from client
 * components, server code and the backend alike. The backend
 * (src/listings/hp-locations.ts) and the Expo app (src/api/hp-locations.ts)
 * keep byte-identical copies, like the other shared listing schemas.
 *
 * Tehsils and sub-tehsils are listed together: to a host they are the same
 * thing — "the administrative area my village falls under".
 */

export const HP_DISTRICTS = [
  'Bilaspur',
  'Chamba',
  'Hamirpur',
  'Kangra',
  'Kinnaur',
  'Kullu',
  'Lahaul and Spiti',
  'Mandi',
  'Shimla',
  'Sirmaur',
  'Solan',
  'Una',
] as const;

export type HpDistrict = (typeof HP_DISTRICTS)[number];

type DistrictInfo = {
  /** Where the map opens, and the last-resort pin when nothing more exact is found. */
  centre: { lat: number; lng: number };
  tehsils: readonly string[];
};

const RAW_LOCATIONS: Record<HpDistrict, DistrictInfo> = {
  Bilaspur: {
    centre: { lat: 31.3393, lng: 76.7609 },
    tehsils: ['Bharari', 'Bilaspur', 'Ghumarwin', 'Jhandutta', 'Kalol', 'Namhol', 'Shri Naina Devi'],
  },
  Chamba: {
    centre: { lat: 32.5534, lng: 76.1258 },
    tehsils: [
      'Bhalei', 'Bharmour', 'Chamba', 'Chowari', 'Churah', 'Dalhousie', 'Dharwala', 'Holi', 'Kakira',
      'Pangi', 'Pukhri', 'Saach', 'Saho', 'Salooni', 'Sihunta', 'Telka',
    ],
  },
  Hamirpur: {
    centre: { lat: 31.6862, lng: 76.5213 },
    tehsils: [
      'Bamson at Tauni Devi', 'Barsar', 'Bhota', 'Bhoranj', 'Dhatwal at Bijhari', 'Galore', 'Hamirpur',
      'Kangoo', 'Lambloo', 'Nadaun', 'Sujanpur Tihra',
    ],
  },
  Kangra: {
    centre: { lat: 32.1, lng: 76.27 },
    tehsils: [
      'Alampur', 'Baijnath', 'Baroh', 'Bhadoli', 'Bhawarna', 'Chachiyan', 'Chadhiar', 'Dadasiba', 'Darini',
      'Dehra', 'Dharamshala', 'Dheera', 'Fatehpur', 'Gangath', 'Haripur', 'Harchakiyan', 'Indora',
      'Jaisinghpur', 'Jasawn', 'Jawali', 'Jawalamukhi', 'Kangra', 'Khundian', 'Kotla', 'Lagru', 'Majheen',
      'Multhan', 'Nagrota Bagwan', 'Nagrota Surian', 'Nurpur', 'Palampur', 'Panchrukhi', 'Pragpur',
      'Raja ka Talab', 'Rakkar', 'Rey', 'Sadwan', 'Shahpur', 'Sullah', 'Thakurdwara', 'Thural',
    ],
  },
  Kinnaur: {
    centre: { lat: 31.5376, lng: 78.2718 },
    tehsils: ['Hangrang', 'Kalpa', 'Moorang', 'Nichar', 'Pooh', 'Sangla', 'Tapri'],
  },
  Kullu: {
    centre: { lat: 31.9592, lng: 77.1089 },
    tehsils: ['Anni', 'Banjar', 'Bhuntar', 'Jari', 'Kullu', 'Manali', 'Nirmand', 'Nither', 'Sainj'],
  },
  'Lahaul and Spiti': {
    centre: { lat: 32.5715, lng: 77.023 },
    tehsils: ['Kaza', 'Lahaul', 'Udaipur'],
  },
  Mandi: {
    centre: { lat: 31.7081, lng: 76.9319 },
    tehsils: [
      'Ashla', 'Aut', 'Bagachanaugi', 'Bagshad', 'Balchowki', 'Baldwara', 'Balh', 'Bhadrota', 'Chaachiot',
      'Chhatri', 'Dehar', 'Dhalwan', 'Dharampur', 'Joginder Nagar', 'Karsog', 'Kataula', 'Kotli',
      'Ladbharol', 'Makriri', 'Mandap', 'Mandi Sadar', 'Nihari', 'Padhar', 'Pangna', 'Rewalsar',
      'Sandhol', 'Sarkaghat', 'Sunder Nagar', 'Thachi', 'Thunag', 'Tihra', 'Tikken',
    ],
  },
  Shimla: {
    centre: { lat: 31.1048, lng: 77.1734 },
    tehsils: [
      'Chirgaon', 'Chopal', 'Deha', 'Dhami', 'Dhamwari', 'Dodra-Kawar', 'Jalog', 'Jangla', 'Jubbal', 'Junga',
      'Kalbog', 'Kotgarh', 'Kotkhai', 'Kumarsain', 'Kupvi', 'Nankhari', 'Nerwa', 'Rampur', 'Rohru',
      'Sarahan', 'Saraswati Nagar', 'Shimla Rural', 'Shimla Urban', 'Sunni', 'Tacklech', 'Theog', 'Tikkar',
    ],
  },
  Sirmaur: {
    centre: { lat: 30.559, lng: 77.467 },
    tehsils: [
      'Dadahu', 'Haripurdhar', 'Kamrau', 'Majra', 'Nahan', 'Narag', 'Nohradhar', 'Pachhad', 'Pajohta',
      'Paonta Sahib', 'Rajgarh', 'Renukaji', 'Ronhat', 'Shillai',
    ],
  },
  Solan: {
    centre: { lat: 30.9045, lng: 77.0967 },
    tehsils: [
      'Arki', 'Baddi', 'Darlaghat', 'Kandaghat', 'Kasauli', 'Krishnagarh', 'Kunihar', 'Loharghat',
      'Mamligh', 'Nalagarh', 'Panjehra', 'Parwanoo', 'Ramshehar', 'Solan',
    ],
  },
  Una: {
    centre: { lat: 31.4685, lng: 76.2708 },
    tehsils: [
      'Amb', 'Bangana', 'Bharwain', 'Bihrukalan', 'Dulehar', 'Gagret at Kaloh', 'Ghanari', 'Haroli', 'Ispur',
      'Jol', 'Mehatpur at Basdehra', 'Una',
    ],
  },
};

/** The same data with every tehsil list in alphabetical order, so a dropdown is easy to scan. */
export const HP_LOCATIONS: Record<HpDistrict, DistrictInfo> = Object.fromEntries(
  HP_DISTRICTS.map((d) => [
    d,
    { centre: RAW_LOCATIONS[d].centre, tehsils: [...RAW_LOCATIONS[d].tehsils].sort((a, b) => a.localeCompare(b)) },
  ]),
) as unknown as Record<HpDistrict, DistrictInfo>;

export function tehsilsOf(district: string | undefined | null): readonly string[] {
  return district && district in HP_LOCATIONS ? HP_LOCATIONS[district as HpDistrict].tehsils : [];
}

export function isTehsilOf(district: string | undefined | null, tehsil: string | undefined | null): boolean {
  return !!tehsil && tehsilsOf(district).includes(tehsil);
}

export function districtCentre(district: string | undefined | null): { lat: number; lng: number } | null {
  return district && district in HP_LOCATIONS ? HP_LOCATIONS[district as HpDistrict].centre : null;
}

/**
 * A deliberately generous outline of Himachal Pradesh, [lat, lng] going
 * clockwise from the south-west. It is wider than the real border by design:
 * it exists to refuse pins that are plainly in another state (Chandigarh,
 * Pathankot, Jammu, Dehradun, Leh), never to reject a real HP address near the
 * edge — border towns on the wrong side of a line are better accepted than a
 * host in Kaza or Parwanoo being turned away.
 */
const HP_OUTLINE: readonly (readonly [number, number])[] = [
  [30.35, 77.15], [30.35, 77.75], [30.7, 78.0], [31.0, 78.35], [31.3, 78.75], [31.75, 78.95],
  [32.25, 79.15], [32.7, 78.85], [33.05, 78.4], [33.05, 77.3], [33.3, 76.95], [33.3, 76.35],
  [33.05, 76.0], [32.8, 75.8], [32.45, 75.8], [32.25, 75.7], [31.95, 75.6], [31.65, 75.8],
  [31.35, 76.1], [31.05, 76.55], [30.85, 76.8], [30.65, 77.05],
];

/** True when the point falls inside the (generous) outline of Himachal Pradesh. */
export function isInsideHimachal(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  let inside = false;
  for (let i = 0, j = HP_OUTLINE.length - 1; i < HP_OUTLINE.length; j = i++) {
    const [latI, lngI] = HP_OUTLINE[i];
    const [latJ, lngJ] = HP_OUTLINE[j];
    const crosses = lngI > lng !== lngJ > lng && lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Distance between two points in kilometres (haversine). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
