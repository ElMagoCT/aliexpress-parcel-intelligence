import { describe, expect, it } from 'vitest';
import { bodyHasPageIndex, buildMtopRequest, classifyUrl, detectPageParam, looksLoggedOut, lookupCode, md5, normalizeOrderStatus, orderIdFromUrl, parseDate, parseMoney, parsePayload, promiseDaysFromText, resignMtopUrl, shouldCaptureUrl, withBodyPage, withDataField, withPage } from '@/adapters/aliexpress';
import { parseCainiao } from '@/adapters/cainiao';

const orderListPayload = {
  api: 'mtop.aliexpress.buyer.order.list', v: '1.0', ret: ['SUCCESS::调用成功'],
  data: {
    hasMore: true, totalPage: 12, currentPage: 1,
    orderList: [
      {
        tradeOrderId: '3040123456789012', orderStatus: 'WAIT_BUYER_ACCEPT_GOODS', gmtCreate: '2026-08-30 14:22:10',
        storeInfo: { storeName: 'Shenzhen Tech Store', storeId: 1102938 },
        orderAmount: { currency: 'USD', value: 23.47, formatedAmount: 'US $23.47' },
        shippingFee: { currency: 'USD', value: 2.99 }, discountAmount: 'US $1.50',
        deliveryDate: 'Sep 12 - Sep 25',
        subOrders: [
          { productId: 1005006123456, title: 'ESP32-S3 DevKit N16R8', skuAttr: 'Color: Black', quantity: 2, unitPrice: { currency: 'USD', value: 6.42 }, productImage: '//ae01.alicdn.com/kf/abc.jpg', logisticsNo: 'LP00123456789CN', logisticsServiceName: 'AliExpress Standard Shipping', shipFromCountry: 'CN' },
          { productId: 1005006123457, title: 'USB-C Cable 2m', quantity: 1, unitPrice: 'US $3.15', logisticsNo: 'LP00123456789CN' },
        ],
      },
      { orderId: '3040123456789999', status: 'FINISH', orderDate: 1755000000000, sellerName: 'Yiwu Crafts', totalAmount: { currencyCode: 'EUR', cent: 1234 }, itemList: [{ itemId: 99, productName: 'Guitar capo', qty: 1, price: '€ 12,34', trackingNumber: 'RB123456789SG' }] },
    ],
  },
};

describe('AliExpress adapter', () => {
  it('captures the right URL shapes', () => {
    expect(shouldCaptureUrl('https://acs.aliexpress.com/h5/mtop.aliexpress.buyer.order.list/1.0/?jsv=2.7.2')).toBe(true);
    expect(shouldCaptureUrl('https://www.aliexpress.com/p/order/index.html')).toBe(false); // page, not data
    expect(shouldCaptureUrl('https://ae01.alicdn.com/kf/order.png')).toBe(false);
    expect(classifyUrl('https://acs.aliexpress.com/h5/mtop.aliexpress.logistics.trackingdetail/1.0/')).toBe('tracking');
    expect(shouldCaptureUrl('https://acs.aliexpress.com/h5/mtop.ae.ld.querydetail/1.0/?jsv=2.5.1&api=mtop.ae.ld.querydetail')).toBe(true);
    expect(classifyUrl('https://acs.aliexpress.com/h5/mtop.ae.ld.querydetail/1.0/')).toBe('tracking');
    expect(shouldCaptureUrl('https://acs.aliexpress.com/h5/mtop.aliexpress.trade.buyer.order.list/1.0/?x')).toBe(true);
    expect(classifyUrl('https://acs.aliexpress.com/h5/mtop.aliexpress.buyer.order.list/1.0/')).toBe('orderList');
  });

  it('parses orders, items, parcels structurally', () => {
    const b = parsePayload('https://acs.aliexpress.com/h5/mtop.aliexpress.buyer.order.list/1.0/', JSON.stringify(orderListPayload));
    expect(b.orders).toHaveLength(2);
    const o = b.orders[0];
    expect(o.orderId).toBe('3040123456789012');
    expect(o.status).toBe('SHIPPED');
    expect(o.sellerName).toBe('Shenzhen Tech Store');
    expect(o.orderTotal).toBe(23.47);
    expect(o.shippingCost).toBe(2.99);
    expect(o.discount).toBe(1.5);
    expect(o.currency).toBe('USD');
    expect(o.trackingNos).toEqual(['LP00123456789CN']);
    expect(o.promisedDeliveryAt).not.toBeNull();
    expect(o.placedAt).not.toBeNull();
    expect(b.items.filter((i) => i.orderId === o.orderId)).toHaveLength(2);
    expect(b.items[0].imageUrl).toBe('https://ae01.alicdn.com/kf/abc.jpg');
    expect(b.items[0].qty).toBe(2);
    expect(b.items[1].unitPrice).toBe(3.15);
    const p = b.parcels.find((x) => x.trackingNo === 'LP00123456789CN');
    expect(p?.logisticsService).toBe('AliExpress Standard Shipping');
    expect(p?.shipFromRegion).toBe('CN');
    const o2 = b.orders[1];
    expect(o2.status).toBe('COMPLETED');
    expect(o2.currency).toBe('EUR');
    expect(o2.orderTotal).toBe(12.34);
    expect(o2.trackingNos).toEqual(['RB123456789SG']);
    expect(b.hasMore).toBe(true);
    expect(b.totalPages).toBe(12);
  });

  it('handles JSONP wrapper and login markers', () => {
    const b = parsePayload('https://acs.aliexpress.com/h5/mtop.x/1.0/?callback=mtopjsonp1', `mtopjsonp1(${JSON.stringify(orderListPayload)})`);
    expect(b.orders).toHaveLength(2);
    const l = parsePayload('https://acs.aliexpress.com/h5/mtop.x/1.0/', JSON.stringify({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session expired'] }));
    expect(l.loginRequired).toBe(true);
    expect(looksLoggedOut('https://login.aliexpress.com/?return=...', 200, '')).toBe(true);
  });

  it('degrades gracefully on garbage', () => {
    expect(parsePayload('https://x/mtop.order', 'not json').orders).toEqual([]);
    expect(parsePayload('https://x/mtop.order', '').orders).toEqual([]);
    expect(parsePayload('https://x/mtop.order', '{"data":{"orderList":[{"orderId":"123"}]}}').orders).toEqual([]);
  });

  it('parses money and dates in many shapes', () => {
    expect(parseMoney('US $12.34')).toEqual({ amount: 12.34, currency: 'USD' });
    expect(parseMoney('€ 1.234,56')).toEqual({ amount: 1234.56, currency: 'EUR' });
    expect(parseMoney({ currency: 'GBP', cent: 999 })).toEqual({ amount: 9.99, currency: 'GBP' });
    expect(parseDate(1755000000)).toBe(1755000000000);
    expect(parseDate('2026-08-30 14:22:10')).toBeGreaterThan(0);
    expect(parseDate('May 13, 2026')).toBeGreaterThan(0);
    expect(normalizeOrderStatus('Awaiting delivery')).toBe('SHIPPED');
    expect(normalizeOrderStatus('IN_CANCEL')).toBe('CLOSED');
  });

  it('learns pagination params and re-signs mtop URLs', () => {
    const url = 'https://acs.aliexpress.com/h5/mtop.aliexpress.buyer.order.list/1.0/?appKey=12574478&t=1700000000000&sign=abc&data=%7B%22pageNo%22%3A1%2C%22pageSize%22%3A10%7D&type=jsonp&callback=mtopjsonp2';
    expect(detectPageParam(url)).toBe('data.pageNo');
    const p3 = withPage(url, 'data.pageNo', 3)!;
    expect(JSON.parse(new URL(p3).searchParams.get('data')!).pageNo).toBe(3);
    const signed = new URL(resignMtopUrl(p3, 'tokentoken', 1700000001234));
    expect(signed.searchParams.get('t')).toBe('1700000001234');
    expect(signed.searchParams.get('sign')).toHaveLength(32);
    expect(signed.searchParams.get('type')).toBe('originaljson');
    expect(signed.searchParams.has('callback')).toBe(false);
    expect(md5('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
});

describe('Cainiao adapter', () => {
  const payload = { success: true, module: [{ mailNo: 'LP00123456789CN', status: 'TRANSIT', statusDesc: 'In transit', originCountry: 'CN', destCountry: 'US', detailList: [
    { time: 1756900000000, timeStr: '2026-09-03 10:00:00', desc: 'Arrived at destination country', standerdDesc: 'Arrived at destination country', group: { nodeCode: 'ARRIVED_AT_DEST_COUNTRY' }, actionCode: 'LH_ARRIVE' },
    { time: 1756500000000, timeStr: '2026-08-29 22:00:00', desc: 'Departed from country of origin', actionCode: 'LH_DEPART' },
    { time: 1756400000000, timeStr: '2026-08-28 18:00:00', desc: 'Received by logistics company [Shenzhen]', actionCode: 'GOT' },
  ] }] };
  it('parses plain JSON and JSONP, oldest first, with code milestones', () => {
    const r = parseCainiao('LP00123456789CN', JSON.stringify(payload));
    expect(r.ok).toBe(true);
    expect(r.events).toHaveLength(3);
    expect(r.events[0].codeMilestone).toBe('ORIGIN_ACCEPTED');
    expect(r.events[2].codeMilestone).toBe('ARRIVED_DEST_COUNTRY');
    expect(r.destCountry).toBe('US');
    const j = parseCainiao('LP00123456789CN', `jsonp_aepi(${JSON.stringify(payload)});`);
    expect(j.events).toHaveLength(3);
  });
  it('reports failure shapes', () => {
    expect(parseCainiao('X', '<html>nope</html>').ok).toBe(false);
    expect(parseCainiao('X', JSON.stringify({ success: false, errorMsg: 'rate limited' })).error).toBe('rate limited');
  });
});
