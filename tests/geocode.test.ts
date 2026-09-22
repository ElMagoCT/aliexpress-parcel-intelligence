import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }, permissions: { contains: async () => false } });
import { extractLocationFromText, gazetteerLookup } from '@/background/geocode';

describe('gazetteer', () => {
  it('resolves hubs, aliases and noisy strings without network', () => {
    expect(gazetteerLookup('Shenzhen')).toMatchObject({ lat: 22.5431 });
    expect(gazetteerLookup('ISC LOS ANGELES CA (USPS)')).toMatchObject({ lat: 34.0522 });
    expect(gazetteerLookup('Liège, Belgium')?.lat).toBeCloseTo(50.63, 1);
    expect(gazetteerLookup('Guangzhou sorting center')?.lng).toBeCloseTo(113.26, 1);
    expect(gazetteerLookup('Hong Kong International Airport')?.lat).toBeCloseTo(22.32, 1);
    expect(gazetteerLookup('Nowhereville')).toBeNull();
  });
  it('extracts a location from scan text', () => {
    expect(extractLocationFromText('[Shenzhen] Departed from sorting center')).toBe('Shenzhen');
    expect(extractLocationFromText('Processed Through Facility ISC CHICAGO IL (USPS)')).toMatch(/ISC CHICAGO IL/);
  });
});
