import { describe, expect, it } from 'vitest';
import { applyTime, parseCarrierPage, parseLooseDate } from '@/adapters/carrierPage';

/**
 * Verbatim text of a real UPS tracking page (2026-09-22), with the tracking number and destination
 * replaced. The shape — a status chip, a bare weekday+month date, the description, a separate time
 * line, a "Delivered To:" field, then undated milestone chips — is what the parser has to survive.
 */
const UPS_DELIVERED = `Skip to Main Content
Find Closest UPS Location
1
Service Alerts
United States - English

Support

Shipping
Tracking
Products & Services
The UPS Store
Log In
Log In
Hello there!
Create a profile and receive access to:
Personalized discounts up to 83% off
Tracking notifications
Saved addresses for faster shipping
Tracking Details
arrow_circle_right
Tracking No. or Delivery Notice
Delivered check_circle
1Z999AA10123456784
content_copy
Copy Tracking Number
check
close

Tracking number copied to clipboard.

Wednesday, September 16
Left at the Security Gate
at
6:02 P.M.

Delivered To:

SPRINGFIELD, IL US

Label Created
completed
Dropped off at The UPS Store by Customer
completed
We Have Your Package
completed
On the Way
completed
Out for Delivery
completed
Delivered
active
Show Details keyboard_arrow_down
Proof of Deliverychevron_right
File a Claimchevron_right
lock

Stay Safe - Avoid Fraud and Scams

Shipment Details

Delivered To

SPRINGFIELD, IL US

Service

UPS Ground

Shipment Category

Package

Shipped / Billed On

09/10/2026

Support
Help and Support Center`;

/** USPS-style page: dated scan rows, each with a place. */
const USPS_IN_TRANSIT = `USPS Tracking
Tracking Number: 9405511899223197428490
In Transit to Next Facility
Expected Delivery by
Friday, September 25, 2026
Tracking History
September 21, 2026, 8:14 pm
Arrived at USPS Regional Facility
CHICAGO IL DISTRIBUTION CENTER
September 20, 2026, 11:02 am
Departed USPS Regional Facility
LOS ANGELES CA DISTRIBUTION CENTER
September 18, 2026, 6:30 am
Accepted at USPS Origin Facility
LOS ANGELES, CA 90001`;

const NOT_FOUND = `UPS
Tracking Details
We could not locate the shipment details for this tracking number.
Please check the number and try again.`;

const now = Date.parse('2026-09-22T12:00:00Z');

describe('carrier tracking page', () => {
  it('reads a delivered UPS page, including the exact delivery time', () => {
    const r = parseCarrierPage({ url: 'https://www.ups.com/track', title: 'Tracking | UPS', text: UPS_DELIVERED }, now);
    expect(r.usable).toBe(true);
    expect(r.trackingNo).toBe('1Z999AA10123456784');
    expect(r.delivered).toBe(true);
    expect(r.service).toBe('UPS Ground');
    expect(r.lastLocation).toBe('SPRINGFIELD, IL US');
    // "Wednesday, September 16" + "6:02 P.M." with no year on the page
    const d = new Date(r.deliveredAt!);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(18);
    expect(d.getMinutes()).toBe(2);
    expect(r.shippedAt).toBe(new Date(2026, 8, 10, 12).getTime());
    // The undated milestone chips still tell us the journey it completed.
    const ms = r.scans.map((s) => s.milestone);
    expect(ms).toContain('DELIVERED');
  });

  it('reads dated scan rows with their places', () => {
    const r = parseCarrierPage({ url: 'https://tools.usps.com/go/TrackConfirmAction', title: 'USPS', text: USPS_IN_TRANSIT }, now);
    expect(r.usable).toBe(true);
    expect(r.delivered).toBe(false);
    expect(r.scans.length).toBeGreaterThanOrEqual(3);
    const arrived = r.scans.find((s) => /Arrived at USPS Regional/.test(s.rawText))!;
    expect(arrived).toBeDefined();
    expect(arrived.milestone).toBe('IN_TRANSIT_LOCAL');
    expect(arrived.locationText).toMatch(/CHICAGO/);
    expect(new Date(arrived.timestamp!).getDate()).toBe(21);
    expect(new Date(arrived.timestamp!).getHours()).toBe(20); // 8:14 pm
    // An expected-delivery date must not be mistaken for a scan.
    expect(r.scans.some((s) => /Expected Delivery/i.test(s.rawText))).toBe(false);
  });

  it('says so when the carrier has no record, instead of inventing one', () => {
    const r = parseCarrierPage({ url: 'https://www.ups.com/track', title: 'UPS', text: NOT_FOUND }, now);
    expect(r.usable).toBe(false);
    expect(r.scans).toHaveLength(0);
    expect(r.deliveredAt).toBeNull();
  });

  it('parses the date formats carriers actually use', () => {
    expect(new Date(parseLooseDate('09/10/2026', now)!).getMonth()).toBe(8);
    expect(new Date(parseLooseDate('2026-09-10', now)!).getDate()).toBe(10);
    expect(new Date(parseLooseDate('September 21, 2026, 8:14 pm', now)!).getDate()).toBe(21);
    expect(parseLooseDate('no date here', now)).toBeNull();
    // A month with no year never resolves into the future.
    expect(parseLooseDate('December 28', now)!).toBeLessThan(now);
    expect(new Date(applyTime(Date.parse('2026-09-16T12:00:00'), '6:02 P.M.')).getHours()).toBe(18);
    expect(new Date(applyTime(Date.parse('2026-09-16T12:00:00'), '12:30 a.m.')).getHours()).toBe(0);
  });
});
