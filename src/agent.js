import { db } from "./database.js";
import { sendMessage } from "./whatsapp.js";
import { checkListingAbuse, blockMessage } from "./spamGuard.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

const APP_NAME        = process.env.APP_NAME        || "Roommate Finder";
const APP_TAGLINE     = process.env.APP_TAGLINE     || "Find your perfect roommate anywhere in the world.";
const CURRENCY        = process.env.CURRENCY        || "USD";
const CURRENCY_SYMBOL = process.env.CURRENCY_SYMBOL || "$";
const COMMUNITY_CTX   = process.env.COMMUNITY_VALUES || "";

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a helpful WhatsApp assistant for "${APP_NAME}" — a roommate-finding service anywhere in the world.

${APP_TAGLINE}
${COMMUNITY_CTX ? `\nContext about this community: ${COMMUNITY_CTX}\n` : ""}

Your role:
1. Help users POST a room vacancy
2. Help users SEARCH for a room
3. MATCH seekers with listings using smart criteria including community identity
4. Keep replies SHORT and conversational — this is WhatsApp, not email
5. Be warm, friendly, and respectful of all cultural/religious backgrounds

COMMUNITY IDENTITY FIELDS — always ask about these naturally:
- religion: e.g. Muslim, Hindu, Christian, Jewish, Sikh, Buddhist, None, Any
- ethnicity: e.g. Indian, Pakistani, Bangladeshi, Arab, Nigerian, Mexican, Chinese, Any
- diet: e.g. Halal, Vegetarian, Vegan, Jain, Kosher, No restrictions
- languages: e.g. Hindi, Urdu, Arabic, Punjabi, Spanish, English
- lifestyle: e.g. prayers 5x daily, no alcohol, no smoking, quiet hours, early riser

PREFERENCE STRENGTH — when someone states a community preference, also ask:
"Is [preference] required, or would you also consider others?"
Store this as preferenceStrength: "required" | "preferred" | "open"

Examples:
- "I want Indian roommates only" → ethnicity: Indian, preferenceStrength: required
- "I prefer Muslim roommates" → religion: Muslim, preferenceStrength: preferred  
- "I'm fine with anyone" → all community fields: any, preferenceStrength: open

Currency: default ${CURRENCY} (${CURRENCY_SYMBOL}), accept any the user mentions.

LISTING fields to collect:
city, country, neighborhood, rent (number), currency, roomType (private/shared/entire place),
availableDate, genderPref (any/male/female/couples/families),
religion (preferred religion of household), ethnicity (preferred ethnicity),
diet (household diet), languages (spoken in house), lifestyle (household lifestyle),
preferenceStrength (required/preferred/open — how strictly they want community match),
petsAllowed (bool), smokingAllowed (bool), amenities, name, phone, description

SEEKER fields to collect:
city, country, maxBudget, currency, gender, moveInDate, familyStatus (single/couple/family),
religion (their religion), ethnicity (their ethnicity / who they want to live with),
diet (their diet), languages, lifestyle,
preferenceStrength (required/preferred/open — how important community match is to them),
petsOwned (bool), smoker (bool), occupation, name, phone, notes

Keep responses under 300 characters. Plain text only, no markdown.

When you have collected minimum info (city + rent/budget + at least one community field),
output EXACTLY ONE of these commands with NO other text:

SAVE_LISTING:{"city":"","country":"","neighborhood":"","rent":0,"currency":"USD","roomType":"private","availableDate":"","genderPref":"any","religion":"any","ethnicity":"any","diet":"no restrictions","languages":"","lifestyle":"","preferenceStrength":"open","petsAllowed":false,"smokingAllowed":false,"amenities":"","name":"","phone":"","description":""}

SAVE_SEEKER:{"city":"","country":"","maxBudget":0,"currency":"USD","gender":"any","moveInDate":"","familyStatus":"single","religion":"","ethnicity":"","diet":"","languages":"","lifestyle":"","preferenceStrength":"open","petsOwned":false,"smoker":false,"occupation":"","name":"","phone":"","notes":""}

SHOW_MATCHES:{}
REMOVE_LISTING:{}
RESET:{}

When user says "show listings" / "browse" / "what's available" → SHOW_MATCHES:{}
When user says "remove listing" / "I found a place" → REMOVE_LISTING:{}
When user says "reset" / "start over" → RESET:{}`;

// ── Claude API call ───────────────────────────────────────────────────────────
async function callClaude(history, userMessage) {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: userMessage },
      ],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

// ── Community identity matching ───────────────────────────────────────────────
// Returns: 1 (match), 0 (neutral/unknown), -1 (hard block)
function communityMatch(listingVal, seekerVal, listingStrength, seekerStrength) {
  const lv = (listingVal || "any").toLowerCase().trim();
  const sv = (seekerVal  || "any").toLowerCase().trim();
  const ls = (listingStrength || "open").toLowerCase();
  const ss = (seekerStrength  || "open").toLowerCase();

  // Both "any" or unknown → neutral
  if (lv === "any" || sv === "any" || !lv || !sv) return 0;

  const isMatch = lv === sv || lv.includes(sv) || sv.includes(lv);

  if (isMatch) return 1; // ✅ Match

  // No match — how strict are each side?
  if (ls === "required" || ss === "required") return -1; // 🚫 Hard block
  if (ls === "preferred" || ss === "preferred") return -0.5; // ⚠️ Soft penalty
  return 0; // open on both sides → neutral
}

// ── Main scoring engine ───────────────────────────────────────────────────────
function scoreMatch(listing, seeker) {
  let score = 0;

  // ── Location (max 50) ────────────────────────────────────────────────────
  const lCity    = (listing.city    || "").toLowerCase().trim();
  const sCity    = (seeker.city     || "").toLowerCase().trim();
  const lCountry = (listing.country || "").toLowerCase().trim();
  const sCountry = (seeker.country  || "").toLowerCase().trim();

  if (lCity && sCity) {
    if (lCity === sCity) score += 40;
    else if (lCity.includes(sCity) || sCity.includes(lCity)) score += 20;
  }
  if (lCountry && sCountry && lCountry === sCountry) score += 10;

  // ── Budget (max 30) ──────────────────────────────────────────────────────
  if (listing.rent && seeker.maxBudget) {
    const sameCurrency =
      !listing.currency || !seeker.currency ||
      listing.currency.toUpperCase() === seeker.currency.toUpperCase();
    if (sameCurrency) {
      if (listing.rent <= seeker.maxBudget)        score += 30;
      else if (listing.rent <= seeker.maxBudget * 1.1) score += 10;
      else if (listing.rent > seeker.maxBudget * 1.3)  return -1; // over budget
    } else {
      score += 15; // different currencies, can't compare
    }
  }

  // ── Gender preference (hard block or +15) ────────────────────────────────
  const gp = (listing.genderPref || "any").toLowerCase();
  const sg = (seeker.gender      || "any").toLowerCase();
  if (gp === "any" || sg === "any") {
    score += 15;
  } else if (
    (gp === "male"    && sg === "male")   ||
    (gp === "female"  && sg === "female") ||
    (gp === "couples" && seeker.familyStatus === "couple") ||
    (gp === "families"&& seeker.familyStatus === "family") ||
    gp === sg
  ) {
    score += 15;
  } else {
    return -1; // hard incompatibility
  }

  // ── Community identity scoring (each up to +20, can hard-block) ──────────
  // Religion
  const religionScore = communityMatch(
    listing.religion, seeker.religion,
    listing.preferenceStrength, seeker.preferenceStrength
  );
  if (religionScore === -1) return -1;
  score += religionScore * 20;

  // Ethnicity
  const ethnicityScore = communityMatch(
    listing.ethnicity, seeker.ethnicity,
    listing.preferenceStrength, seeker.preferenceStrength
  );
  if (ethnicityScore === -1) return -1;
  score += ethnicityScore * 20;

  // Diet
  const dietScore = communityMatch(
    listing.diet, seeker.diet,
    listing.preferenceStrength, seeker.preferenceStrength
  );
  if (dietScore === -1) return -1;
  score += dietScore * 15;

  // Language (can speak multiple — check overlap)
  if (listing.languages && seeker.languages) {
    const ll = listing.languages.toLowerCase().split(/[,;]/);
    const sl = seeker.languages.toLowerCase().split(/[,;]/);
    const overlap = ll.filter((l) => sl.some((s) => s.trim().includes(l.trim()) || l.trim().includes(s.trim())));
    score += overlap.length * 8;
  }

  // Lifestyle tags overlap
  if (listing.lifestyle && seeker.lifestyle) {
    const ll = listing.lifestyle.toLowerCase().split(/[,;]/);
    const sl = seeker.lifestyle.toLowerCase().split(/[,;]/);
    const overlap = ll.filter((l) => sl.some((s) => s.trim().includes(l.trim()) || l.trim().includes(s.trim())));
    score += overlap.length * 5;
  }

  // ── Hard lifestyle incompatibilities ─────────────────────────────────────
  if (!listing.smokingAllowed && seeker.smoker)  return -1;
  if (!listing.petsAllowed    && seeker.petsOwned) score -= 5;

  return Math.round(score);
}

// ── Find top matches ──────────────────────────────────────────────────────────
function findMatches(profile, type) {
  const items = type === "seeker" ? db.getListings() : db.getSeekers();
  return items
    .map((item) => ({
      item,
      score: type === "seeker"
        ? scoreMatch(item, profile)
        : scoreMatch(profile, item),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.item);
}

// ── Score label for display ───────────────────────────────────────────────────
function matchLabel(listing, seeker) {
  const s = scoreMatch(listing, seeker);
  if (s >= 100) return "⭐⭐⭐ Excellent match";
  if (s >= 70)  return "⭐⭐ Great match";
  if (s >= 40)  return "⭐ Good match";
  return "Possible match";
}

// ── Formatters ────────────────────────────────────────────────────────────────
function communityTags(obj) {
  return [
    obj.religion  && obj.religion  !== "any" ? `🕌 ${obj.religion}`  : null,
    obj.ethnicity && obj.ethnicity !== "any" ? `🌍 ${obj.ethnicity}` : null,
    obj.diet      && obj.diet !== "no restrictions" ? `🍽️ ${obj.diet}` : null,
    obj.languages ? `🗣️ ${obj.languages}` : null,
    obj.lifestyle ? `✨ ${obj.lifestyle.slice(0, 40)}` : null,
  ].filter(Boolean).join("\n");
}

function formatListing(l, seeker = null) {
  const loc  = [l.neighborhood, l.city, l.country].filter(Boolean).join(", ");
  const rent = l.rent ? `${l.currency || CURRENCY_SYMBOL}${l.rent}/mo` : "Rent TBD";
  const tags = communityTags(l);
  const matchLine = seeker ? `\n${matchLabel(l, seeker)}` : "";

  return (
    `🏠 ${loc}\n` +
    `💰 ${rent} | ${l.roomType || "room"}\n` +
    (l.genderPref && l.genderPref !== "any" ? `👥 ${l.genderPref} only\n` : "") +
    (tags ? tags + "\n" : "") +
    `📅 From: ${l.availableDate || "Now"}\n` +
    `📞 ${l.phone || "Contact via agent"}` +
    matchLine
  );
}

function formatSeeker(s) {
  const loc    = [s.city, s.country].filter(Boolean).join(", ");
  const budget = s.maxBudget ? `${s.currency || CURRENCY_SYMBOL}${s.maxBudget}/mo` : "Budget TBD";
  const tags   = communityTags(s);
  return (
    `👤 ${s.name || "Seeker"} | ${s.gender || "Any"}\n` +
    `📍 ${loc} | Max: ${budget}\n` +
    `🗓️ ${s.moveInDate || "Flexible"}\n` +
    (tags ? tags + "\n" : "") +
    `📞 ${s.phone || "Contact via agent"}`
  );
}

// ── Parse action commands from Claude reply ───────────────────────────────────
function parseAction(reply) {
  const trimmed = reply.trim();
  const prefixes = ["SAVE_LISTING:", "SAVE_SEEKER:", "SHOW_MATCHES:", "REMOVE_LISTING:", "RESET:"];
  for (const prefix of prefixes) {
    if (trimmed.includes(prefix)) {
      try {
        const type    = prefix.replace(":", "");
        const jsonStr = trimmed.split(prefix)[1].trim();
        const data    = jsonStr.startsWith("{") ? JSON.parse(jsonStr) : {};
        return { type, data };
      } catch (e) {
        console.warn("Failed to parse action:", e.message);
      }
    }
  }
  return null;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function handleIncomingMessage({ from, text, phoneNumberId }) {
  const conv = db.getConversation(from);

  // Welcome new users
  if (conv.history.length === 0) {
    const greeting =
      `👋 Welcome to ${APP_NAME}!\n\n` +
      `I help you find roommates who share your background & lifestyle.\n\n` +
      `1️⃣ Post a room\n` +
      `2️⃣ Find a room\n` +
      `3️⃣ Browse listings\n\n` +
      `What would you like to do?`;
    await sendMessage({ phoneNumberId, to: from, text: greeting });
    db.addMessage(from, "assistant", greeting);
    return;
  }

  db.addMessage(from, "user", text);
  const updatedConv = db.getConversation(from);

  try {
    const reply  = await callClaude(updatedConv.history.slice(0, -1), text);
    const action = parseAction(reply);

    if (action?.type === "SAVE_LISTING") {
      const listingData = { ...action.data, phone: action.data.phone || from };

      // Check listing abuse before saving
      const abuseCheck = checkListingAbuse(from, db.getListings());
      if (abuseCheck.blocked) {
        const msg = blockMessage(abuseCheck);
        await sendMessage({ phoneNumberId, to: from, text: msg });
        db.addMessage(from, "assistant", msg);
        return;
      }

      const id = db.addListing(listingData);
      const msg =
        `✅ Room posted! (ID: ${id})\n\n` +
        `I'll notify seekers who match your community preferences.\n\n` +
        `Say "my listing" to view it, or "remove listing" when filled.`;
      await sendMessage({ phoneNumberId, to: from, text: msg });
      db.addMessage(from, "assistant", msg);
      await notifyMatchingSeekers(listingData, id, phoneNumberId);

    } else if (action?.type === "SAVE_SEEKER") {
      const seekerData = { ...action.data, phone: action.data.phone || from };
      const id      = db.addSeeker(seekerData);
      const matches = findMatches(seekerData, "seeker");

      let msg = `✅ You're registered as a seeker! (ID: ${id})\n\n`;
      if (matches.length > 0) {
        msg += `🎉 ${matches.length} matching room(s):\n\n`;
        msg += matches.map((l) => formatListing(l, seekerData)).join("\n──────────\n");
      } else {
        msg += `No matches yet — I'll notify you when a compatible room is posted! 🔔`;
      }
      await sendMessage({ phoneNumberId, to: from, text: msg });
      db.addMessage(from, "assistant", msg);

    } else if (action?.type === "SHOW_MATCHES") {
      const listings = db.getListings();
      if (listings.length === 0) {
        const msg = "No listings right now. Post one, or register as a seeker to be notified!";
        await sendMessage({ phoneNumberId, to: from, text: msg });
        db.addMessage(from, "assistant", msg);
      } else {
        const msg =
          `📋 ${listings.length} active listing(s):\n\n` +
          listings.slice(0, 5).map((l) => formatListing(l)).join("\n──────────\n") +
          (listings.length > 5 ? `\n\n…+${listings.length - 5} more. Search by city or community!` : "");
        await sendMessage({ phoneNumberId, to: from, text: msg });
        db.addMessage(from, "assistant", msg);
      }

    } else if (action?.type === "REMOVE_LISTING") {
      const userListings = db.getListings().filter((l) => l.phone === from);
      if (userListings.length > 0) {
        userListings.forEach((l) => db.deactivateListing(l.id));
        await sendMessage({ phoneNumberId, to: from, text: "✅ Listing removed. Good luck with your new roommate! 🏡" });
      } else {
        await sendMessage({ phoneNumberId, to: from, text: "No active listing found for your number." });
      }

    } else if (action?.type === "RESET") {
      db.setConversation(from, { state: "IDLE", data: {}, history: [] });
      await sendMessage({ phoneNumberId, to: from, text: "Starting fresh! Post a room or find one?" });

    } else {
      await sendMessage({ phoneNumberId, to: from, text: reply });
      db.addMessage(from, "assistant", reply);
    }

  } catch (err) {
    console.error("Agent error:", err);
    await sendMessage({ phoneNumberId, to: from, text: "Sorry, something went wrong. Please try again. 🙏" });
  }
}

// ── Notify seekers when a new listing is posted ───────────────────────────────
async function notifyMatchingSeekers(listing, listingId, phoneNumberId) {
  for (const seeker of db.getSeekers()) {
    const score = scoreMatch(listing, seeker);
    if (score > 30) {
      const msg =
        `🔔 New room posted that matches your preferences!\n\n` +
        formatListing({ ...listing, id: listingId }, seeker) +
        `\n\nReply "interested" to connect with the poster.`;
      try {
        await sendMessage({ phoneNumberId, to: seeker.phone, text: msg });
      } catch (e) {
        console.warn(`Could not notify ${seeker.phone}:`, e.message);
      }
    }
  }
}
