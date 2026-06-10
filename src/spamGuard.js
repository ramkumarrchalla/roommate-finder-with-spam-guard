/**
 * spamGuard.js — Multi-layer spam & abuse protection
 *
 * Layers:
 *  1. Rate limiting        — messages per minute / hour / day per phone
 *  2. Message content      — suspicious URLs, bulk text, promo patterns
 *  3. Listing abuse        — duplicate listings, too many listings per user
 *  4. Flood detection      — identical or near-identical repeated messages
 *  5. Phone reputation     — strike system → warn → throttle → ban
 *  6. Prompt injection     — block attempts to hijack the AI system prompt
 */

// ── In-memory state (resets on restart; persist via db for production) ────────
const windowMap   = new Map(); // phone → { min: [], hour: [], day: [] }
const strikeMap   = new Map(); // phone → { strikes, bannedUntil, throttledUntil }
const recentMsgs  = new Map(); // phone → last N message hashes (flood detection)

// ── Configurable limits ────────────────────────────────────────────────────────
const LIMITS = {
  perMinute:       parseInt(process.env.SPAM_PER_MINUTE)       || 5,
  perHour:         parseInt(process.env.SPAM_PER_HOUR)         || 30,
  perDay:          parseInt(process.env.SPAM_PER_DAY)          || 100,
  maxListingsPerUser: parseInt(process.env.MAX_LISTINGS_USER)  || 2,
  maxStrikesWarn:  parseInt(process.env.SPAM_STRIKES_WARN)     || 2,
  maxStrikesBan:   parseInt(process.env.SPAM_STRIKES_BAN)      || 5,
  throttleMinutes: parseInt(process.env.SPAM_THROTTLE_MINUTES) || 30,
  banHours:        parseInt(process.env.SPAM_BAN_HOURS)        || 24,
  floodWindow:     parseInt(process.env.SPAM_FLOOD_WINDOW)     || 5,   // identical msgs in window
};

// ── Spam content patterns ─────────────────────────────────────────────────────
const SPAM_PATTERNS = [
  // Promotional / scam language
  /\b(earn|make)\s*\$?\d+[k]?\s*(per|a)\s*(day|week|hour|month)\b/i,
  /\b(work from home|wfh|passive income|financial freedom)\b/i,
  /\b(click here|visit now|limited offer|act now|don't miss)\b/i,
  /\b(crypto|bitcoin|forex|invest(ment)?|trading bot)\b/i,
  /\b(whatsapp group|telegram group|join (our|my) group)\b/i,
  /\b(100%\s*(free|guaranteed)|no\s*risk|risk.?free)\b/i,
  /\b(lottery|prize|winner|congratulations you (have|are))\b/i,

  // Bulk URL patterns
  /https?:\/\/[^\s]{40,}/i,                        // Very long URLs
  /(https?:\/\/[^\s]+\s+){2,}/i,                   // Multiple URLs in one message
  /bit\.ly|tinyurl|t\.co|short\.(gy|io)|rb\.gy/i,  // URL shorteners

  // Contact harvesting
  /\b(send me your (number|contact|email|whatsapp))\b/i,
  /\b(add (me|us) on whatsapp|save (my|our) number)\b/i,

  // Hate speech / slurs — rough pattern, extend as needed
  /\b(kaffir|infidel\s+pig|dirty\s+(muslim|hindu|jew|christian))\b/i,
];

// ── Prompt injection patterns ─────────────────────────────────────────────────
const INJECTION_PATTERNS = [
  /ignore (previous|above|all) instructions/i,
  /forget (everything|your|the) (above|previous|instructions|prompt)/i,
  /you are now|act as|pretend (to be|you are)/i,
  /new (system|instructions|prompt|persona|role):/i,
  /\[system\]|\[admin\]|\[override\]|\[jailbreak\]/i,
  /do anything now|dan mode|developer mode/i,
  /print (your|the) (system prompt|instructions|prompt)/i,
  /reveal (your|the) (instructions|system|prompt)/i,
  /override.*safety|bypass.*filter/i,
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function now() { return Date.now(); }

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h;
}

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── 1. Rate limiter ───────────────────────────────────────────────────────────
function checkRateLimit(phone) {
  const ts = now();
  if (!windowMap.has(phone)) {
    windowMap.set(phone, { min: [], hour: [], day: [] });
  }
  const w = windowMap.get(phone);

  // Slide windows
  w.min  = w.min.filter(t  => ts - t < 60_000);
  w.hour = w.hour.filter(t => ts - t < 3_600_000);
  w.day  = w.day.filter(t  => ts - t < 86_400_000);

  if (w.min.length  >= LIMITS.perMinute) return { blocked: true, reason: "rate_minute",  wait: "1 minute" };
  if (w.hour.length >= LIMITS.perHour)   return { blocked: true, reason: "rate_hour",    wait: "1 hour" };
  if (w.day.length  >= LIMITS.perDay)    return { blocked: true, reason: "rate_day",     wait: "24 hours" };

  w.min.push(ts); w.hour.push(ts); w.day.push(ts);
  return { blocked: false };
}

// ── 2. Content scanner ────────────────────────────────────────────────────────
function checkContent(text) {
  const normalized = normalizeText(text);

  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, reason: "spam_content", pattern: pattern.source.slice(0, 30) };
    }
  }

  // Excessive length (WhatsApp messages shouldn't be 2000+ chars)
  if (text.length > 1500) {
    return { blocked: true, reason: "message_too_long" };
  }

  // Excessive phone numbers / emails in one message (harvesting)
  const phoneMatches = text.match(/\+?\d[\d\s\-().]{8,}\d/g) || [];
  if (phoneMatches.length >= 4) {
    return { blocked: true, reason: "phone_harvesting" };
  }

  return { blocked: false };
}

// ── 3. Prompt injection detector ─────────────────────────────────────────────
function checkInjection(text) {
  const normalized = normalizeText(text);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return { blocked: true, reason: "prompt_injection" };
    }
  }
  return { blocked: false };
}

// ── 4. Flood / duplicate detector ────────────────────────────────────────────
function checkFlood(phone, text) {
  const hash = simpleHash(normalizeText(text));
  if (!recentMsgs.has(phone)) recentMsgs.set(phone, []);
  const history = recentMsgs.get(phone);

  const recent = history.filter(h => h.ts > now() - 60_000); // last 60s
  const dupeCount = recent.filter(h => h.hash === hash).length;

  if (dupeCount >= LIMITS.floodWindow) {
    return { blocked: true, reason: "flood_identical" };
  }

  recent.push({ hash, ts: now() });
  recentMsgs.set(phone, recent.slice(-20));
  return { blocked: false };
}

// ── 5. Strike / ban system ────────────────────────────────────────────────────
function getReputation(phone) {
  return strikeMap.get(phone) || { strikes: 0, bannedUntil: 0, throttledUntil: 0 };
}

function checkBanStatus(phone) {
  const rep = getReputation(phone);
  const ts  = now();

  if (rep.bannedUntil > ts) {
    const minsLeft = Math.ceil((rep.bannedUntil - ts) / 60_000);
    return { blocked: true, reason: "banned", minsLeft };
  }
  if (rep.throttledUntil > ts) {
    const minsLeft = Math.ceil((rep.throttledUntil - ts) / 60_000);
    return { blocked: true, reason: "throttled", minsLeft };
  }
  return { blocked: false };
}

export function addStrike(phone, reason) {
  const rep = getReputation(phone);
  rep.strikes += 1;
  rep.lastStrikeReason = reason;
  rep.lastStrikeAt = new Date().toISOString();

  if (rep.strikes >= LIMITS.maxStrikesBan) {
    rep.bannedUntil = now() + LIMITS.banHours * 3_600_000;
    console.warn(`🚫 BANNED ${phone} for ${LIMITS.banHours}h (${rep.strikes} strikes, last: ${reason})`);
  } else if (rep.strikes >= LIMITS.maxStrikesWarn) {
    rep.throttledUntil = now() + LIMITS.throttleMinutes * 60_000;
    console.warn(`⚠️ THROTTLED ${phone} for ${LIMITS.throttleMinutes}m (strike ${rep.strikes}: ${reason})`);
  }

  strikeMap.set(phone, rep);
  return rep;
}

export function clearStrikes(phone) {
  strikeMap.delete(phone);
}

// ── 6. Listing abuse check ────────────────────────────────────────────────────
export function checkListingAbuse(phone, activeListings) {
  const userListings = activeListings.filter(l => l.phone === phone);
  if (userListings.length >= LIMITS.maxListingsPerUser) {
    return {
      blocked: true,
      reason: "too_many_listings",
      count: userListings.length,
    };
  }
  return { blocked: false };
}

// ── Main guard — runs all checks ──────────────────────────────────────────────
export function runGuard(phone, text) {
  // Check ban/throttle status first
  const banCheck = checkBanStatus(phone);
  if (banCheck.blocked) return banCheck;

  // Injection check (highest priority after ban)
  const injectionCheck = checkInjection(text);
  if (injectionCheck.blocked) {
    addStrike(phone, "prompt_injection");
    return injectionCheck;
  }

  // Rate limit
  const rateCheck = checkRateLimit(phone);
  if (rateCheck.blocked) {
    addStrike(phone, rateCheck.reason);
    return rateCheck;
  }

  // Content
  const contentCheck = checkContent(text);
  if (contentCheck.blocked) {
    addStrike(phone, contentCheck.reason);
    return contentCheck;
  }

  // Flood
  const floodCheck = checkFlood(phone, text);
  if (floodCheck.blocked) {
    addStrike(phone, "flood");
    return floodCheck;
  }

  return { blocked: false };
}

// ── Human-readable block messages ────────────────────────────────────────────
export function blockMessage(result) {
  switch (result.reason) {
    case "banned":
      return `🚫 Your access has been suspended for ${result.minsLeft} more minutes due to policy violations. Contact support if you believe this is an error.`;
    case "throttled":
      return `⏳ You're sending too many messages. Please wait ${result.minsLeft} minute(s) before trying again.`;
    case "rate_minute":
      return `⏳ Please slow down — wait a moment before sending another message.`;
    case "rate_hour":
    case "rate_day":
      return `⏳ You've reached your message limit. Please try again in ${result.wait}.`;
    case "spam_content":
      return `⚠️ Your message was flagged as potential spam and wasn't sent. Please keep messages relevant to finding roommates.`;
    case "message_too_long":
      return `⚠️ Message too long. Please keep your message under 1500 characters.`;
    case "phone_harvesting":
      return `⚠️ Your message contains too many phone numbers and was blocked.`;
    case "prompt_injection":
      return `⚠️ That message was blocked. Please use this service only for finding roommates.`;
    case "flood_identical":
      return `⏳ You've sent the same message several times. Please wait before repeating.`;
    case "too_many_listings":
      return `⚠️ You already have ${result.count} active listing(s). Please remove an old one before posting a new one.`;
    default:
      return `⚠️ Your message was blocked. Please try again later.`;
  }
}

// ── Admin helpers ─────────────────────────────────────────────────────────────
export function getGuardStats() {
  const bans = [...strikeMap.entries()]
    .filter(([, v]) => v.bannedUntil > now())
    .map(([phone, v]) => ({ phone, bannedUntil: new Date(v.bannedUntil).toISOString(), strikes: v.strikes }));

  const throttled = [...strikeMap.entries()]
    .filter(([, v]) => v.throttledUntil > now() && v.bannedUntil <= now())
    .map(([phone, v]) => ({ phone, throttledUntil: new Date(v.throttledUntil).toISOString(), strikes: v.strikes }));

  return {
    totalTracked:    strikeMap.size,
    currentlyBanned: bans.length,
    currentlyThrottled: throttled.length,
    bans,
    throttled,
    limits: LIMITS,
  };
}
