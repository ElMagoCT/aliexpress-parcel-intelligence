import { describe, expect, it } from 'vitest';
import { bodyHasPageIndex, buildMtopRequest, lookupCode, mtopTimeZone, orderIdFromUrl, parseDetailMoney, parsePayload, parsePriceBlock, promiseDaysFromText, synthesizeMtopGet, withBodyPage, withDataField } from '@/adapters/aliexpress';

/** Shapes observed on the live site on 2026-09-20 (values synthetic). */
const ULTRON_ORDER_LIST = {
  api: 'mtop.aliexpress.trade.buyer.order.list', v: '1.0', ret: ['SUCCESS::调用成功'],
  data: {
    container: { data: [] }, endpoint: { protocolVersion: '3.0', ultronage: 'true' }, reload: 'true',
    data: {
      pc_om_list_body_2001: { fields: { hasMore: 'true', hasMoreText: 'View orders', mergePayLimit: '20', pageIndex: '1', pageSize: '10' }, id: '2001', tag: 'pc_om_list_body', type: 'pc_om_list_body' },
      pc_om_list_order_8000222333270000: {
        fields: {
          baseCurrency: 'CNY', currencyCode: 'USD', formatPriceInfo: '$25.66|25|66', orderDateText: 'Sep 13, 2026', orderDetailUrl: 'https://www.aliexpress.com/p/order/detail.html?orderId=8000222333270000',
          orderId: '8000222333270000', orderLineSize: '1', paymentOutId: '3040000000000001', statusText: 'Awaiting delivery', storeName: 'Example Electronics Store', storePageUrl: '//www.aliexpress.com/store/1103', totalPriceText: '$25.66',
          buttons: [{ type: 'CONFIRM_GOODS', text: 'Confirm received' }, { type: 'TRACKING', text: 'Track status', href: 'https://www.aliexpress.com/p/tracking/index.html?_addShare=no&_login=yes&tradeOrderId=8000222333270000' }],
          orderLines: [{ currencyCode: 'USD', formatPriceInfo: '$26.72|26|72', itemDetailUrl: '//www.aliexpress.com/item/3250000000000001.html', itemImgUrl: '//ae-pic-a1.aliexpress-media.com/kf/S1.jpg_220x220.jpg', itemPriceText: '$26.72', itemTitle: 'Buck-Boost Converter Module 5V-50V 10A', orderLineId: '8000222333290000', productId: '3250000000000001', quantity: '1', skuAttrKeys: '14:691', skuAttrs: [{ id: '14', name: 'Color', text: 'Module', vid: '691' }], skuId: '12000000000000001' }],
          utParams: { args: { orderId: '8000222333270000', orderStatus: '8' } },
        }, id: '8000222333270000', tag: 'pc_om_list_order', type: 'pc_om_list_order',
      },
      pc_om_list_order_8000555444700000: {
        fields: { currencyCode: 'USD', orderDateText: 'Sep 13, 2026', orderId: '8000555444700000', statusText: 'Completed', storeName: 'Example Tools Store', totalPriceText: '$3.84', orderLines: [{ itemTitle: 'Soldering Iron Tips Set T245', productId: '1005001', quantity: '1', itemPriceText: '$3.88', skuId: '12000000000000002' }], utParams: { args: { orderId: '8000555444700000', orderStatus: '9' } } },
        id: '8000555444700000', tag: 'pc_om_list_order', type: 'pc_om_list_order',
      },
    },
  },
};

const QUERYDETAIL = {
  api: 'mtop.ae.ld.querydetail', v: '1.0', ret: ['SUCCESS::调用成功'],
  data: {
    result: 'true',
    module: {
      isTrackingV2: 'true',
      fastDeliveryInfoDTO: { fdTitle: 'Fast delivery', fdContentList: ['Apply for $1.00 coupon code if delayed by Sep 26, 2026', 'Refund if no delivery before Oct 15, 2026', 'Refund if items damaged', 'Refund if package lost'] },
      logisticsReceiverInfo: { address: '1 Main St', city: 'Springfield', province: 'Illinois', country: 'United States', zipCode: '62701', contactName: 'M**r' },
      trackingDetailLineList: [{
        blockMailNo: 'false', displayQuantity: '2', logisticsCarrierName: 'AliExpress Selection Standard', mailNo: 'SWX100200300400500600', originMailNo: 'SWX100200300400500600', packageMinCreateTime: 1789800000000,
        etaInfo: { beginEtaTime: 1790000000000, endEtaTime: 1790400000000, etaSceneCode: 'FULFILLLMENT_PROMISE_ETA', etaTimeStamp: 1790400000000, etaTimeText: 'Sep 21 - 26' },
        packageItemList: [{ count: '1', itemId: '3250000000000001', itemPic: '//img', itemTitle: 'Buck-Boost Converter Module', skuDesc: 'Color:Module', skuId: '12000000000000001' }],
        detailList: [
          { fulfillStage: '1400', time: 1789960000000, timeText: 'Sat | Sep. 19 18:46', trackingDetailDesc: 'Your package arrived at local airport', trackingName: 'In transit', trackingPrimaryCode: 'AE_LH_ARRIVE', trackingSecondCode: 'AE_LH_ARRIVE_SUCCESS' },
          { fulfillStage: '1300', time: 1789880000000, timeText: 'Fri | Sep. 18 22:43', trackingDetailDesc: 'Package leaving origin country/region.', trackingName: 'In transit', trackingPrimaryCode: 'AE_LH_DEPART', trackingSecondCode: 'AE_LH_DEPART_SUCCESS' },
          { fulfillStage: '1100', time: 1789800000000, timeText: 'Thu | Sep. 17 10:00', trackingDetailDesc: 'Package received by carrier', trackingName: 'Shipped', trackingPrimaryCode: 'AE_GOT', trackingSecondCode: 'AE_GOT_SUCCESS' },
        ],
      }],
    },
  },
};

const QD_URL = 'https://acs.aliexpress.com/h5/mtop.ae.ld.querydetail/1.0/?jsv=2.5.1&appKey=12574478&t=1&sign=x&api=mtop.ae.ld.querydetail&v=1.0&type=jsonp&dataType=jsonp&callback=mtopjsonp3&data=' + encodeURIComponent(JSON.stringify({ tradeOrderId: '8000222333270000', tradeOrderLineId: '', terminalType: 'PC', needPageDisplayInfo: true, timeZone: 'GMT-07:00', _lang: 'en_US', _currency: 'USD' }));

describe('live 2026 shapes', () => {
  it('parses the ultron order list (fields per component)', () => {
    const b = parsePayload('https://acs.aliexpress.com/h5/mtop.aliexpress.trade.buyer.order.list/1.0/?api=mtop.aliexpress.trade.buyer.order.list', JSON.stringify(ULTRON_ORDER_LIST));
    expect(b.kind).toBe('orderList');
    expect(b.orders.map((o) => o.orderId).sort()).toEqual(['8000222333270000', '8000555444700000']);
    const o = b.orders.find((x) => x.orderId === '8000222333270000')!;
    expect(o.status).toBe('SHIPPED');
    expect(o.sellerName).toBe('Example Electronics Store');
    expect(o.currency).toBe('USD');
    expect(o.orderTotal).toBe(25.66);
    expect(o.placedAt).toBe(Date.parse('Sep 13, 2026'));
    const it = b.items.find((i) => i.orderId === o.orderId)!;
    expect(it.title).toMatch(/Buck-Boost/);
    expect(it.productId).toBe('3250000000000001');
    expect(it.unitPrice).toBe(26.72);
    expect(it.imageUrl).toBe('https://ae-pic-a1.aliexpress-media.com/kf/S1.jpg_220x220.jpg');
    expect(it.sku).toBe('Color:Module');
    expect(b.orders.find((x) => x.orderId === '8000555444700000')!.status).toBe('COMPLETED');
    expect(b.hasMore).toBe(true);
    expect(b.page).toBe(1);
    // no tracking numbers in the list payload — they come from querydetail
    expect(o.trackingNos).toEqual([]);
  });

  it('parses querydetail: parcel, events with AE_ codes, ETA, protection deadline, receiver', () => {
    const b = parsePayload(QD_URL, `mtopjsonp3(${JSON.stringify(QUERYDETAIL)})`);
    expect(b.kind).toBe('tracking');
    expect(b.contextOrderId).toBe('8000222333270000');
    expect(b.parcels).toHaveLength(1);
    const p = b.parcels[0];
    expect(p.trackingNo).toBe('SWX100200300400500600');
    expect(p.orderId).toBe('8000222333270000');
    expect(p.logisticsService).toBe('AliExpress Selection Standard');
    expect(p.productIds).toEqual(['3250000000000001']);
    expect(p.promisedAt).toBe(1790400000000);
    expect(b.events).toHaveLength(3);
    const codes = b.events.map((e) => e.codeMilestone);
    expect(codes).toContain('ARRIVED_DEST_COUNTRY');
    expect(codes).toContain('DEPARTED_ORIGIN_COUNTRY');
    expect(codes).toContain('ORIGIN_ACCEPTED');
    expect(b.events.every((e) => e.trackingNo === 'SWX100200300400500600' || e.trackingNo === null)).toBe(true);
    expect(b.protectionEndsAt).toBe(Date.parse('Oct 15, 2026'));
    expect(b.receiver?.city).toBe('Springfield');
    expect(lookupCode('AE_CC_IM_SUCCESS')).toBe('IMPORT_CUSTOMS');
    expect(lookupCode('AE_SIGNED')).toBe('DELIVERED');
  });

  it('replays learned templates: order id substitution, POST page rewrite, signing', () => {
    expect(orderIdFromUrl(QD_URL)).toBe('8000222333270000');
    const swapped = withDataField(QD_URL, 'tradeOrderId', '8000555444700000')!;
    expect(orderIdFromUrl(swapped)).toBe('8000555444700000');
    const body = 'data=' + encodeURIComponent(JSON.stringify({ params: JSON.stringify({ data: JSON.stringify({ pc_om_list_body_1: { fields: { hasMore: true, pageIndex: 3, pageSize: 10 }, strategy: 'append' } }) }) }));
    expect(bodyHasPageIndex(body)).toBe(true);
    const p7 = withBodyPage(body, 7);
    expect(decodeURIComponent(p7)).toMatch(/pageIndex\\+":7/);
    expect(decodeURIComponent(p7)).not.toMatch(/pageIndex\\+":3/);
    const req = buildMtopRequest({ urlTemplate: 'https://acs.aliexpress.com/h5/mtop.aliexpress.trade.buyer.order.list/1.0/?jsv=2.5.1&appKey=12574478&t=1&sign=old&api=x&v=1.0&type=originaljson&dataType=json&post=1', method: 'POST', bodyTemplate: p7 }, 'tok', 1790000000000);
    const u = new URL(req.url);
    expect(u.searchParams.get('t')).toBe('1790000000000');
    expect(u.searchParams.get('sign')).not.toBe('old');
    expect(req.init.method).toBe('POST');
    expect(req.init.body).toBe(p7);
    expect((req.init.headers as Record<string, string>)['content-type']).toMatch(/x-www-form-urlencoded/);
  });

  it('reads the AliExpress promise from listing text', () => {
    const now = Date.parse('Sep 20, 2026');
    expect(promiseDaysFromText('Delivery: Sep. 26 - Oct. 01 (78.2% ≤ 10 days)', now)).toBe(10);
    expect(promiseDaysFromText('Delivery: Sep. 26 - Oct. 01', now)).toBe(11);
    expect(promiseDaysFromText('Estimated delivery in 12-25 days', now)).toBe(25);
  });
});

/** Order detail (`mtop.aliexpress.trade.buyer.order.detail`) as observed 2026-09-21. */
const ORDER_DETAIL = {
  api: 'mtop.aliexpress.trade.buyer.order.detail', v: '1.0', ret: ['SUCCESS::调用成功'],
  data: {
    data: {
      detail_order_status_block_1: { tag: 'detail_order_status_block', fields: { orderId: '8000222333270000', title: 'Awaiting delivery', baseCurrency: 'CNY' } },
      detail_order_price_block_2: {
        tag: 'detail_order_price_block',
        fields: {
          priceDetails: [
            { title: 'Subtotal', value: '$26.72' },
            { hide: 'true', title: 'Shipping', value: 'Free shipping' },
            { hide: 'true', title: 'Coins', value: '-$0.27', valueColor: '#ff472e' },
            { hide: 'true', title: 'Multi-store coupon', value: '-$2.93', valueColor: '#ff472e' },
            { hide: 'true', title: 'Additional charges', value: '$2.14', tipData: { title: 'Tax: $2.14' } },
          ],
          totalPrice: { currencyCode: 'USD', formatPriceInfo: '$25.66|25|66', title: 'Total', value: '$25.66' },
        },
      },
      detail_simple_order_info_3: { tag: 'detail_simple_order_info_component', fields: { tradeOrderId: '8000222333270000', orderCreatTime: 'Sep 13, 2026', payTime: 'Sep 13, 2026', paymentMethod: 'Google Pay' } },
    },
  },
};

describe('order detail price block', () => {
  it('extracts shipping, coupons and tax that the order list never carries', () => {
    const b = parsePayload('https://acs.aliexpress.com/h5/mtop.aliexpress.trade.buyer.order.detail/1.0/?api=mtop.aliexpress.trade.buyer.order.detail', JSON.stringify(ORDER_DETAIL));
    expect(b.kind).toBe('orderDetail');
    const o = b.orders.find((x) => x.pricingDetailed)!;
    expect(o).toBeDefined();
    expect(o.orderId).toBe('8000222333270000');
    expect(o.itemsSubtotal).toBe(26.72);
    expect(o.shippingCost).toBe(0); // "Free shipping" is zero, not unknown
    expect(o.discount).toBeCloseTo(3.2, 5); // 0.27 coins + 2.93 coupon
    expect(o.tax).toBe(2.14);
    expect(o.orderTotal).toBe(25.66);
    expect(o.currency).toBe('USD');
    expect(o.paymentMethod).toBe('Google Pay');
    expect(o.placedAt).toBe(Date.parse('Sep 13, 2026'));
  });

  it('reads a paid shipping line', () => {
    expect(parsePriceBlock({ priceDetails: [{ title: 'Shipping', value: '$4.21' }], totalPrice: { value: '$9.00', currencyCode: 'USD' } }).shippingCost).toBe(4.21);
    expect(parseDetailMoney('Free shipping')).toBe(0);
    expect(parseDetailMoney('-$2.93')).toBe(-2.93);
    expect(parseDetailMoney('')).toBeNull();
  });

  it('synthesises a signed order-detail GET from any learned mtop URL', () => {
    const base = 'https://acs.aliexpress.com/h5/mtop.aliexpress.trade.buyer.order.list/1.0/?jsv=2.5.1&appKey=12574478&t=1&sign=old&api=mtop.aliexpress.trade.buyer.order.list&v=1.0&type=jsonp&dataType=jsonp&callback=mtopjsonp2&post=1&data=%7B%7D';
    const url = synthesizeMtopGet(base, 'mtop.aliexpress.trade.buyer.order.detail', { tradeOrderId: '8000222333270000', _lang: 'en_US' })!;
    const u = new URL(url);
    expect(u.pathname).toBe('/h5/mtop.aliexpress.trade.buyer.order.detail/1.0/');
    expect(u.searchParams.get('api')).toBe('mtop.aliexpress.trade.buyer.order.detail');
    expect(u.searchParams.get('appKey')).toBe('12574478'); // reused from the learned request
    expect(u.searchParams.has('callback')).toBe(false);
    expect(u.searchParams.has('post')).toBe(false);
    expect(JSON.parse(u.searchParams.get('data')!).tradeOrderId).toBe('8000222333270000');
    expect(mtopTimeZone(new Date())).toMatch(/^GMT[+-]\d{4}$/);
  });
});
