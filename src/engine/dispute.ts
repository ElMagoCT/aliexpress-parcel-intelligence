import type { Order, Parcel } from '@/model/types';
import { DAY } from '@/shared/util';

/**
 * Buyer-protection countdown. Uses AliExpress's own deadline when the payload exposed it;
 * otherwise estimates from shipping date with AliExpress's usual "delivery within 60 days"
 * protection window (75 for the longest economy lines) and labels the estimate as such.
 */
export interface DisputeWindow { deadline: number; daysLeft: number; estimated: boolean; urgency: 'none' | 'watch' | 'soon' | 'urgent' }

export function disputeWindow(order: Order | undefined, parcel: Parcel | null, now = Date.now()): DisputeWindow | null {
  if (!order) return null;
  if (order.status === 'COMPLETED' || order.status === 'CLOSED' || order.status === 'REFUNDED') return null;
  let deadline = order.protectionEndsAt;
  let estimated = false;
  if (!deadline) {
    const start = parcel?.shippedAt ?? order.placedAt;
    if (!start) return null;
    const economy = /economy|saver|china_post|yanwen|sunyou|super/i.test(parcel?.serviceKey ?? '');
    deadline = start + (economy ? 75 : 60) * DAY;
    estimated = true;
  }
  const daysLeft = (deadline - now) / DAY;
  const urgency = daysLeft <= 3 ? 'urgent' : daysLeft <= 7 ? 'soon' : daysLeft <= 14 ? 'watch' : 'none';
  return { deadline, daysLeft, estimated, urgency };
}
