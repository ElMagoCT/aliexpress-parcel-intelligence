import type { Milestone } from '@/model/types';
import { MILESTONE_ORDER } from '@/model/types';

/**
 * Rules-based scan-text → milestone normalisation. Order matters: earlier rules win.
 * Covers common English + transliterated carrier phrasings (Cainiao, USPS, Royal Mail,
 * Canada Post, Australia Post, La Poste, PostNL, DHL, Yanwen, 4PX, ...).
 */
interface Rule { m: Milestone; re: RegExp }

const RULES: Rule[] = [
  // Returns first (they often contain "delivered"/"exception" wording)
  { m: 'RETURNED', re: /return(?:ed|ing)? to (?:the )?(?:sender|origin|shipper|seller)|being returned|return (?:initiated|in progress|shipment)|returned to (?:the )?(?:origin|seller)|parcel is being returned/i },
  // Delivered (guard against "delivered to local carrier")
  { m: 'HANDED_TO_LOCAL_CARRIER', re: /(?:delivered|handed(?: over)?|transferred|forwarded|passed) (?:over )?to (?:the )?(?:local|last[- ]mile|destination|final|domestic|national) (?:carrier|delivery|courier|post(?:al)?(?: service| operator)?|logistics|partner)/i },
  { m: 'DELIVERED', re: /\bdelivered\b(?! (?:to (?:the )?(?:local|destination|carrier|courier|customs|airline|warehouse|sorting|next|agent|forwarder)))|successfully delivered|delivery (?:completed|successful|success|confirmed)|\bsigned\b(?! for by carrier)|signature (?:obtained|received)|received by (?:the )?(?:recipient|customer|addressee|consignee)|collected by (?:the )?(?:recipient|customer|addressee)|picked up by (?:the )?(?:recipient|customer|addressee)|left (?:in|at|with) (?:the )?(?:mailbox|mail room|front|porch|reception|neighbou?r|safe place|parcel box|letterbox)|parcel (?:has been )?collected|delivery to (?:the )?(?:mailbox|address) completed|item delivered|package (?:was )?delivered/i },
  // Customs holds are customs, not exceptions
  { m: 'IMPORT_CUSTOMS', re: /held (?:by|at|in) customs|customs (?:hold|retention|inspection|detained)|detained (?:by|at) customs|awaiting customs/i },
  // Exceptions
  { m: 'EXCEPTION', re: /exception|\bfailed\b|unsuccessful|refused|damaged|\blost\b|unclaimed|undeliverable|incorrect address|address (?:issue|problem|incomplete|not found|unknown)|\bheld\b|abnormal|delay(?:ed)?\b|not delivered|unable to deliver|missing|seized|destroyed|no such (?:number|person)|recipient (?:not available|absent|moved)|attempted delivery.*(?:fail|no access)|delivery attempt(?:ed)? (?:fail|unsuccessful)|awaiting recipient action|on hold|detained|inspection required|contact (?:us|carrier)/i },
  // Out for delivery / pickup ready
  { m: 'OUT_FOR_DELIVERY', re: /out for delivery|on (?:its|the) way to (?:you|the recipient|delivery address)|with (?:the )?(?:delivery )?(?:courier|driver)|courier (?:is )?(?:delivering|assigned|dispatched)|ready for delivery|delivery attempt|available for (?:pick ?up|collection)|ready for (?:collection|pick ?up)|arrived at (?:the )?(?:pick ?up|collection|service) point|awaiting (?:collection|pick ?up)|delivered to (?:parcel )?(?:locker|pick ?up point|access point|collection point|pudo)|loaded (?:on|onto) (?:delivery )?vehicle|delivery (?:in progress|scheduled|today)|being delivered|dispatched for delivery|in (?:the )?delivery (?:vehicle|van|round)/i },
  // Handover to local carrier (more phrasings)
  { m: 'HANDED_TO_LOCAL_CARRIER', re: /hand(?:ed)? ?over to (?:the )?(?:usps|royal mail|canada post|australia post|la poste|colissimo|deutsche post|dhl|correos|inpost|bpost|postnl|hermes|evri|yodel|dpd|gls|poste italiane|ppl|ceska posta|posti|postnord|swiss post|an post|japan post|korea post|sf express|aramex|fastway|toll|nz post)|accepted by (?:usps|royal mail|canada post|australia post|dhl|la poste|correos|postnl|bpost|deutsche post|evri|hermes|yodel|gls|dpd)|shipment accepted|usps in possession of item|acceptance\b|accepted at (?:usps|post office|origin facility)|received by (?:the )?(?:local|destination|domestic|last[- ]mile) (?:carrier|post|courier|delivery)|item (?:received|accepted) by (?:the )?(?:local|delivery)|last[- ]mile (?:carrier|provider) (?:received|picked|accepted)|arrived at (?:the )?(?:local )?(?:carrier|courier) facility|processed by (?:local|last[- ]mile) (?:carrier|post)/i },
  // Customs (direction resolved later by context)
  { m: 'IMPORT_CUSTOMS', re: /import customs|inbound customs|customs clearance (?:complete|completed|released|finished) (?:in|at) (?:the )?destination|held (?:by|at|in) customs|customs (?:retention|inspection|hold|duty|tax)|clearance (?:in )?destination|destination customs|arrived at customs|customs clearance (?:in|at) (?:the )?(?:destination|dest)/i },
  { m: 'EXPORT_CUSTOMS', re: /export customs|customs clearance|cleared customs|customs (?:declaration|processing|released|release|export|clearance|cleared|check|inspection)|handed over to customs|declared to customs|under customs|customs (?:accepted|completed)/i },
  // Departed origin country
  { m: 'DEPARTED_ORIGIN_COUNTRY', re: /(?:departed|left|leaving|has left) (?:from )?(?:the )?(?:country|country\/region|region) of origin|departed (?:from )?(?:origin )?(?:airport|port|country)|(?:flight|aircraft|plane) (?:has )?(?:departed|taken off|left)|hand(?:ed)? ?over to (?:the )?airline|in transit to (?:the )?destination (?:country|region|country\/region)|left (?:the )?origin (?:country|country\/region|region)|international (?:shipment|transit|dispatch) (?:has )?(?:departed|left|release)|export (?:is )?cleared|shipment released by (?:export )?customs|departed (?:from )?(?:shenzhen|guangzhou|hong kong|shanghai|beijing|hangzhou|yiwu|dongguan|xiamen|nanjing|chengdu|zhengzhou|wuhan|changsha|hefei|tianjin|qingdao|ningbo|shenyang|kunming|xian|jinan|fuzhou|nanning|liege|liège|budapest|madrid|frankfurt|amsterdam|paris|london|incheon|tokyo|singapore|kuala lumpur|dubai|istanbul|moscow) (?:international )?(?:airport|port|hub|gateway)|departed from (?:origin|international) (?:hub|gateway|sorting|processing)|outbound (?:from|in) (?:origin|international|sorting)|left (?:the )?(?:origin|international) (?:hub|gateway|sorting|processing)|dispatched from (?:origin|international|overseas)|shipped from (?:overseas|origin) (?:hub|warehouse)|linehaul departed|departed (?:origin|hub) (?:country|region)|arrived at (?:the )?(?:transit|transfer) (?:country|hub|airport|port)|processed (?:through|at) (?:origin|origin post|export) (?:facility|sort)|origin post is preparing shipment|processed through facility(?! isc)/i },
  // Arrived destination country
  { m: 'ARRIVED_DEST_COUNTRY', re: /arrived (?:at|in) (?:the )?(?:destination|dest) (?:country|country\/region|region|airport|port|hub|facility)|arrived at (?:the )?(?:destination |inbound |international )?(?:isc|international service cent(?:er|re)|international (?:hub|gateway|exchange|mail|mail cent(?:er|re)|processing|sorting))|(?:landed|arrived) (?:at|in) (?:the )?destination|arrived in (?:the )?(?:united states|usa|u\.s\.a?|uk|united kingdom|canada|australia|germany|france|spain|italy|netherlands|poland|brazil|mexico|japan|korea|israel|ireland|sweden|norway|finland|denmark|belgium|switzerland|austria|portugal|greece|czech|hungary|romania|new zealand|south africa|chile|argentina|colombia|turkey|ukraine|russia)|processed through (?:isc|facility isc|international)|inbound (?:in|at|into) (?:destination|country|sorting)|customs clearance start(?:ed)?|arrived (?:at|in) (?:the )?(?:port|airport) of (?:entry|destination)|import (?:scan|received|arrived)|arrived at (?:the )?(?:local|destination) (?:international|airport|hub)|arrival at (?:inward|destination|international) (?:office|facility)|receive item from (?:abroad|overseas)|arrived (?:at|in) (?:the )?(?:local|destination) (?:sorting|processing) (?:center|centre|facility)|arrived at destination|(?:usa|united states) arrival/i },
  // Local transit
  { m: 'IN_TRANSIT_LOCAL', re: /arrived at (?:the )?(?:usps |royal mail |canada post |australia post |la poste |dhl |fedex |ups |postnl |dpd |gls |evri |hermes )?(?:local|regional|destination|delivery|post|usps|distribution|network|mail|processing) (?:facility|office|cent(?:er|re)|hub|depot|unit|station)|in transit to (?:next|the next|the|your local|delivery|destination) (?:facility|office|hub|depot|unit|station|post)|departed (?:from )?(?:usps|regional|post office|local|delivery|distribution|the) (?:facility|office|hub|depot|unit|cent(?:er|re)|station)|arrived at (?:post office|delivery (?:depot|office|unit|station|facility)|local (?:delivery|post|hub|depot)|regional (?:hub|depot|sorting))|at (?:the )?delivery (?:office|depot|station|unit)|processed at (?:destination|local|regional|network|delivery|the) (?:facility|hub|depot|sort|sorting|processing)|item (?:arrived|processed|received) at (?:delivery|local|regional|network|destination|post)|in transit(?:, arriving (?:on time|late))?$|in transit to next facility|sorting completed|package (?:in|is in) transit|arrived (?:at|in) (?:transit|hub|processing)(?: cent(?:er|re)| facility| hub)?$|shipment (?:in transit|on the way|moving)|departed (?:facility|hub|depot|sorting|processing|from facility)|transferred (?:to|between) (?:facility|depot|hub)|arrived at (?:a )?(?:carrier|courier) (?:facility|hub|depot)|domestic transit|forwarded to (?:the )?(?:delivery|local|destination)|redirected|departed (?:local|destination) (?:sorting|hub)|handed over to (?:the )?next (?:carrier|hub)|arrived at (?:the )?(?:facility|hub|depot)/i },
  // Origin departed
  { m: 'ORIGIN_DEPARTED', re: /departed (?:from )?(?:the )?(?:sorting|sort|origin|logistics|warehouse|facility|cent(?:er|re)|hub|seller|transit|processing|collection)|left (?:the )?(?:sorting|origin|warehouse|facility|logistics|seller|processing)|(?:dispatched|sent|shipped) (?:from|to) (?:the )?(?:sorting|warehouse|facility|logistics|hub|processing|export|international|airport|cent(?:er|re))|in transit to (?:the )?(?:next|export|airport|international|port|origin|sorting|processing|transit|hub|departure) (?:hub|facility|cent(?:er|re)|airport|port|station|country|warehouse)?|arrived at (?:the )?(?:export|departure|transit|international departure|origin airport|departure transport|transfer|trans(?:it|fer)) (?:hub|facility|cent(?:er|re)|airport|port|station|warehouse)|outbound (?:scan|from|in) (?:sorting|sort|warehouse|facility|hub)?|shipment (?:has )?(?:left|departed)|departed (?:origin|from origin)|left origin facility|hand(?:ed)? ?over to (?:the )?(?:linehaul|line haul|international|export|forwarder|carrier|airline agent|next)|linehaul (?:received|accepted|inbound|handover)|arrived at (?:the )?(?:linehaul|line haul|export|international) (?:hub|warehouse|facility|cent(?:er|re))|departure (?:from|scan)|in transit to (?:the )?airport|dispatched to (?:the )?airport|processed (?:at|through) (?:sorting|sort|origin) (?:cent(?:er|re)|facility)/i },
  // Origin accepted
  { m: 'ORIGIN_ACCEPTED', re: /picked ?up|accepted by (?:the )?(?:carrier|courier|logistics|shipping|forwarder|cainiao|warehouse|post)|received by (?:the )?(?:logistics|carrier|courier|warehouse|sorting|shipping|forwarder|cainiao|post|line ?haul|origin|consolidation)|arrived at (?:the )?(?:sorting|sort|origin|logistics|carrier'?s?|courier|consolidation|collection|cainiao|first|initial|shipping|origin sorting|seller'?s?) (?:cent(?:er|re)|facility|hub|warehouse|depot|station)|package (?:has been )?received|processing at (?:origin|sorting|the|logistics|carrier)|(?:parcel|package|shipment|item|goods) (?:has been |have been |was |were )?(?:collected|received|accepted|picked up|scanned)|received (?:by|at) (?:the )?(?:origin|sorting|warehouse|hub|facility|carrier)|arrived at (?:origin|sorting|warehouse|hub|facility|cent(?:er|re))|shipment (?:picked up|collected|received|accepted)|in warehouse|warehouse (?:received|scan|inbound|accepted)|inbound (?:scan|to|in) (?:sorting|warehouse|origin|hub|facility)?|arrived (?:at|in) (?:the )?(?:origin )?(?:warehouse|hub|sorting)|order picked|package (?:in|is in) (?:the )?(?:seller|logistics) (?:warehouse|company)|received by (?:the )?(?:logistics company|shipping company)|acceptance (?:scan|by carrier)|collected from (?:seller|sender|shipper)|sorting cent(?:er|re) (?:received|scan|inbound)|arrived at (?:the )?(?:cainiao|logistics) (?:warehouse|hub|facility)/i },
  // Seller shipped / info received
  { m: 'SELLER_SHIPPED', re: /shipment information received|label created|electronic (?:shipping )?information (?:has been )?received|logistics order (?:has been )?created|order information received|(?:seller|sender|shipper|merchant) (?:has |have )?(?:shipped|sent|dispatched|posted)|waiting for (?:pick ?up|collection|carrier)|shipment (?:created|registered|booked|confirmed)|package (?:info(?:rmation)? )?received(?: by carrier)?$|pre[- ]?shipment|shipping label|awaiting (?:pick ?up|collection|carrier|shipment)|information received|order (?:has been )?shipped|parcel (?:info(?:rmation)? )?(?:received|registered)|ready (?:for|to) (?:ship|be shipped|dispatch)|electronic info|item posted|posted by sender|manifest (?:received|created)|data received|shipping information received|consigned|shipment (?:has been )?(?:sent|dispatched|posted)|cainiao (?:has )?received (?:your )?order/i },
  // Bare "in transit" as a last resort maps to local transit (most common late in the journey)
  { m: 'IN_TRANSIT_LOCAL', re: /^in transit\b|\bin transit\b/i },
];

const PRE_SHIP = /order(?:'s| has| was| is)? (?:been )?(?:created|placed|paid|confirmed)|package is being prepared|being (?:prepared|packed)|ready to be shipped|processing in warehouse|payment (?:received|confirmed|successful)|awaiting shipment/i;

export function classifyText(rawText: string): Milestone | null {
  const t = rawText.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (PRE_SHIP.test(t)) return null;
  for (const r of RULES) if (r.re.test(t)) return r.m;
  return null;
}

/**
 * Resolve ambiguity that single-string rules cannot: customs direction, bare "in transit",
 * and out-of-order noise. Events must be chronologically sorted (oldest first).
 */
export function resolveSequence(events: { milestone: Milestone | null; rawText: string; locationText: string | null }[], destCountry: string | null): (Milestone | null)[] {
  const out: (Milestone | null)[] = events.map((e) => e.milestone);
  const dest = destCountry?.toLowerCase() ?? '';
  const destNames = destCountryAliases(dest);
  let reachedDest = false;
  let departedOrigin = false;
  for (let i = 0; i < events.length; i++) {
    const m = out[i];
    const loc = (events[i].locationText ?? '').toLowerCase();
    const inDest = destNames.length > 0 && destNames.some((n) => loc.includes(n) || events[i].rawText.toLowerCase().includes(n));
    if (m === 'DEPARTED_ORIGIN_COUNTRY') departedOrigin = true;
    if (m === 'ARRIVED_DEST_COUNTRY' || inDest) reachedDest = true;
    if (m === 'EXPORT_CUSTOMS' && (reachedDest || inDest)) out[i] = 'IMPORT_CUSTOMS';
    if (m === 'IMPORT_CUSTOMS' && !reachedDest && !departedOrigin && !inDest) out[i] = 'EXPORT_CUSTOMS';
    if (m === 'IN_TRANSIT_LOCAL' && !reachedDest && !departedOrigin && !inDest) out[i] = 'ORIGIN_DEPARTED';
    if (m === 'IN_TRANSIT_LOCAL' && departedOrigin && !reachedDest && !inDest) out[i] = 'DEPARTED_ORIGIN_COUNTRY'; // generic "shipment on the way" while in linehaul
    if ((m === 'ORIGIN_ACCEPTED' || m === 'ORIGIN_DEPARTED') && (reachedDest || inDest) && departedOrigin) out[i] = 'IN_TRANSIT_LOCAL';
    if (m === 'HANDED_TO_LOCAL_CARRIER' || m === 'IN_TRANSIT_LOCAL' || m === 'OUT_FOR_DELIVERY' || m === 'IMPORT_CUSTOMS') reachedDest = true;
  }
  return out;
}

function destCountryAliases(dest: string): string[] {
  if (!dest) return [];
  const table: Record<string, string[]> = {
    us: ['united states', 'usa', 'u.s.', ' us', 'america'], 'united states': ['united states', 'usa', 'u.s.', 'america'],
    gb: ['united kingdom', 'uk', 'england', 'britain'], 'united kingdom': ['united kingdom', 'uk', 'england', 'britain'],
    ca: ['canada'], au: ['australia'], de: ['germany', 'deutschland'], fr: ['france'], es: ['spain', 'españa'], it: ['italy', 'italia'], nl: ['netherlands', 'nederland'], pl: ['poland', 'polska'], br: ['brazil', 'brasil'],
  };
  return table[dest] ?? [dest];
}

export function milestoneIndex(m: Milestone | null): number {
  if (!m) return -1;
  return MILESTONE_ORDER.indexOf(m);
}

/** Highest journey milestone reached so far (ignoring EXCEPTION/RETURNED). */
export function furthestMilestone(ms: (Milestone | null)[]): Milestone | null {
  let best: Milestone | null = null;
  for (const m of ms) if (m && MILESTONE_ORDER.includes(m) && milestoneIndex(m) > milestoneIndex(best)) best = m;
  return best;
}
