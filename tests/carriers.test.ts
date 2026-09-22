import { describe, expect, it } from 'vitest';
import { CARRIERS, detectCarrier, findTrackingNumbers, s10Country } from '@/engine/carriers';
import { parsePriceText, parseShoppingPage, platformFromUrl, type PageHarvest } from '@/adapters/pageCapture';

describe('carrier detection', () => {
  const cases: [string, string][] = [
    ['1Z999AA10123456784', 'ups'],
    ['TBA305421997654', 'amazon'],
    ['LP00123456789CN', 'cainiao'],
    ['SWX100200300400500600', 'cainiao'],
    ['4PX3000123456789CN', 'fourpx'],
    ['YT2012345678901234', 'yunexpress'],
    ['SF1234567890123', 'sfexpress'],
    ['9405511899223197428490', 'usps'],
    ['123456789012', 'fedex'],
    ['1234567890', 'dhl'],
  ];
  for (const [tn, key] of cases) it(`${tn} → ${key}`, () => expect(detectCarrier(tn).carrier.key).toBe(key));

  it('reads the country out of a UPU/S10 number and picks that postal operator', () => {
    expect(s10Country('RB123456789SG')).toBe('SG');
    expect(detectCarrier('RC123456789GB').carrier.key).toBe('royalmail');
    expect(detectCarrier('CP123456789CN').carrier.key).toBe('chinapost');
    expect(detectCarrier('RR123456789FR').carrier.key).toBe('postal'); // no dedicated entry → generic
  });

  it('trusts a carrier name from the store over the number pattern', () => {
    // A plain 10-digit number would be read as DHL; the seller says otherwise.
    expect(detectCarrier('1234567890', 'Royal Mail Tracked 48').carrier.key).toBe('royalmail');
    expect(detectCarrier('X', 'AliExpress Standard Shipping').carrier.key).toBe('cainiao');
  });

  it('only AliExpress/Cainiao can be polled; everything else links out', () => {
    expect(CARRIERS.cainiao.pollable).toBe(true);
    expect(CARRIERS.usps.pollable).toBe(false);
    expect(CARRIERS.ups.url('1Z999AA10123456784')).toContain('1Z999AA10123456784');
    expect(CARRIERS.unknown.url('ABC123')).toContain('17track');
  });

  it('is not fooled by junk', () => {
    expect(detectCarrier('').carrier.key).toBe('unknown');
    expect(detectCarrier('HELLOWORLD').carrier.key).toBe('unknown');
    expect(detectCarrier('12345').carrier.key).toBe('unknown');
  });

  it('pulls tracking numbers out of page text', () => {
    const text = 'Your order shipped! Tracking: 1Z999AA10123456784 via UPS. Questions? Call 18005551234.';
    const found = findTrackingNumbers(text);
    expect(found).toContain('1Z999AA10123456784');
  });
});

describe('shopping page capture', () => {
  it('reads a JSON-LD product', () => {
    const h: PageHarvest = {
      url: 'https://www.amazon.com/dp/B000TEST', title: 'Amazon.com: Widget',
      metas: { 'og:image': 'https://img.example/w.jpg' },
      jsonLd: [{ '@context': 'https://schema.org', '@type': 'Product', name: 'Anker 65W Charger', image: ['https://img.example/a.jpg'], offers: { '@type': 'Offer', price: '24.99', priceCurrency: 'USD' } }],
      text: 'Anker 65W Charger $24.99', images: [],
    };
    const item = parseShoppingPage(h);
    expect(item.platform).toBe('amazon');
    expect(item.title).toBe('Anker 65W Charger');
    expect(item.price).toBe(24.99);
    expect(item.currency).toBe('USD');
    expect(item.imageUrl).toBe('https://img.example/a.jpg'); // JSON-LD beats og:image
  });

  it('falls back to OpenGraph, then to visible text', () => {
    const og = parseShoppingPage({ url: 'https://www.ebay.com/itm/123', title: 'x', metas: { 'og:title': 'Nixie Tube IN-14', 'product:price:amount': '41.50', 'product:price:currency': 'USD', 'og:image': '//img.example/n.jpg' }, jsonLd: [], text: '', images: [] });
    expect(og.platform).toBe('ebay');
    expect(og.title).toBe('Nixie Tube IN-14');
    expect(og.price).toBe(41.5);
    expect(og.imageUrl).toBe('https://img.example/n.jpg'); // protocol-relative is repaired

    const txt = parseShoppingPage({ url: 'https://shop.example.com/p/1', title: 'Cable ties', metas: {}, jsonLd: [], text: 'Cable ties, only US $8.75 today', images: ['https://img.example/c.jpg'] });
    expect(txt.platform).toBe('other');
    expect(txt.price).toBe(8.75);
    expect(txt.currency).toBe('USD');
    expect(txt.imageUrl).toBe('https://img.example/c.jpg');
  });

  it('finds tracking numbers and an order id on an order page', () => {
    const item = parseShoppingPage({
      url: 'https://www.amazon.com/gp/your-account/order-details?orderID=112-3456789',
      title: 'Order details', metas: {}, jsonLd: [],
      text: 'Order # 112-3456789012345 Arriving today Tracking ID: TBA305421997654',
      images: [],
    });
    expect(item.trackingNumbers).toContain('TBA305421997654');
    expect(item.orderId).toBeTruthy();
  });

  it('parses prices written in different conventions', () => {
    expect(parsePriceText('US $1,234.56')).toEqual({ price: 1234.56, currency: 'USD' });
    expect(parsePriceText('€ 1.234,56')).toEqual({ price: 1234.56, currency: 'EUR' });
    expect(parsePriceText('£9.99')).toEqual({ price: 9.99, currency: 'GBP' });
    expect(parsePriceText('1 234,50 PLN').price).toBe(1234.5);
    expect(parsePriceText('').price).toBeNull();
  });

  it('maps hostnames to stores', () => {
    expect(platformFromUrl('https://www.aliexpress.us/item/1.html')).toBe('aliexpress');
    expect(platformFromUrl('https://www.temu.com/x')).toBe('temu');
    expect(platformFromUrl('https://example.org')).toBe('other');
    expect(platformFromUrl('not a url')).toBe('other');
  });
});
