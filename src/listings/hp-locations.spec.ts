import {
  HP_DISTRICTS,
  HP_LOCATIONS,
  distanceKm,
  districtCentre,
  isInsideHimachal,
  isTehsilOf,
  tehsilsOf,
} from './hp-locations';

describe('Himachal Pradesh location data', () => {
  it('has the 12 districts, each with tehsils and no duplicates', () => {
    expect(HP_DISTRICTS).toHaveLength(12);
    for (const d of HP_DISTRICTS) {
      const t = HP_LOCATIONS[d].tehsils;
      expect(t.length).toBeGreaterThanOrEqual(3);
      expect(new Set(t).size).toBe(t.length);
      expect([...t]).toEqual([...t].sort((a, b) => a.localeCompare(b)));
    }
  });

  it('knows which tehsil belongs to which district', () => {
    expect(isTehsilOf('Kangra', 'Dharamshala')).toBe(true);
    expect(isTehsilOf('Kullu', 'Manali')).toBe(true);
    expect(isTehsilOf('Lahaul and Spiti', 'Kaza')).toBe(true);
    expect(isTehsilOf('Kullu', 'Dharamshala')).toBe(false);
    expect(isTehsilOf('Atlantis', 'Manali')).toBe(false);
    expect(isTehsilOf('Kullu', undefined)).toBe(false);
    expect(tehsilsOf('nowhere')).toEqual([]);
  });

  it('opens every district on a point that is inside Himachal Pradesh', () => {
    for (const d of HP_DISTRICTS) {
      const c = districtCentre(d)!;
      expect({ d, inside: isInsideHimachal(c.lat, c.lng) }).toEqual({ d, inside: true });
    }
    expect(districtCentre('nowhere')).toBeNull();
  });

  describe('outline of the state', () => {
    it.each([
      ['Shimla', 31.1048, 77.1734],
      ['Manali', 32.2432, 77.1892],
      ['Dharamshala', 32.219, 76.3234],
      ['Kaza (Spiti)', 32.2276, 78.071],
      ['Kibber (Spiti)', 32.33, 78.0],
      ['Keylong (Lahaul)', 32.5715, 77.023],
      ['Killar (Pangi, far north)', 33.1, 76.42],
      ['Chitkul (Kinnaur, far east)', 31.3496, 78.437],
      ['Shipki La (Tibet border)', 31.8, 78.73],
      ['Paonta Sahib (far south)', 30.44, 77.6],
      ['Nahan', 30.559, 77.467],
      ['Una', 31.4685, 76.2708],
      ['Amb (Una)', 31.7, 76.11],
      ['Nurpur (west Kangra)', 32.3, 75.89],
      ['Dalhousie', 32.5387, 75.971],
      ['Baddi', 30.957, 76.79],
      ['Parwanoo (Solan border)', 30.84, 76.96],
      ['Nalagarh', 31.04, 76.72],
    ])('accepts %s', (_name, lat, lng) => {
      expect(isInsideHimachal(lat, lng)).toBe(true);
    });

    it.each([
      ['Chandigarh', 30.7333, 76.7794],
      ['Panchkula', 30.69, 76.86],
      ['Ambala', 30.38, 76.78],
      ['Pathankot', 32.2643, 75.6421],
      ['Amritsar', 31.634, 74.872],
      ['Jammu', 32.7266, 74.857],
      ['Dehradun', 30.3165, 78.0322],
      ['Mussoorie', 30.4598, 78.0644],
      ['Leh', 34.1526, 77.5771],
      ['Delhi', 28.6139, 77.209],
      ['Null Island', 0, 0],
    ])('refuses %s', (_name, lat, lng) => {
      expect(isInsideHimachal(lat, lng)).toBe(false);
    });

    it('refuses non-numbers', () => {
      expect(isInsideHimachal(NaN, 77)).toBe(false);
      expect(isInsideHimachal(32, Infinity)).toBe(false);
    });
  });

  it('measures distance in kilometres', () => {
    expect(distanceKm({ lat: 32.219, lng: 76.3234 }, { lat: 32.219, lng: 76.3234 })).toBe(0);

    const d = distanceKm({ lat: 32.2432, lng: 77.1892 }, { lat: 32.219, lng: 76.3234 });
    expect(d).toBeGreaterThan(75);
    expect(d).toBeLessThan(95);
  });
});
