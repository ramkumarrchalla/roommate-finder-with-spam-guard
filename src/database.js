import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../data/db.json");

// ── Default structure ─────────────────────────────────────────────────────────
const DEFAULT_DB = {
  listings: [],      // available rooms/spots
  seekers: [],       // people looking for rooms
  conversations: {}, // phone → { state, data, history }
};

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    }
  } catch (e) {
    console.warn("Could not load DB, starting fresh:", e.message);
  }
  return structuredClone(DEFAULT_DB);
}

function saveDB(data) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

let store = loadDB();

export const db = {
  // ── Conversations ───────────────────────────────────────────────────────────
  getConversation(phone) {
    return store.conversations[phone] || { state: "IDLE", data: {}, history: [] };
  },

  setConversation(phone, conv) {
    store.conversations[phone] = conv;
    saveDB(store);
  },

  addMessage(phone, role, content) {
    if (!store.conversations[phone]) {
      store.conversations[phone] = { state: "IDLE", data: {}, history: [] };
    }
    store.conversations[phone].history.push({ role, content, ts: Date.now() });
    // Keep last 20 messages to avoid token bloat
    if (store.conversations[phone].history.length > 20) {
      store.conversations[phone].history = store.conversations[phone].history.slice(-20);
    }
    saveDB(store);
  },

  // ── Listings (rooms available) ──────────────────────────────────────────────
  addListing(listing) {
    const id = `L${Date.now()}`;
    store.listings.push({ id, ...listing, createdAt: new Date().toISOString() });
    saveDB(store);
    return id;
  },

  getListings() {
    return store.listings.filter((l) => l.active !== false);
  },

  deactivateListing(id) {
    const l = store.listings.find((x) => x.id === id);
    if (l) { l.active = false; saveDB(store); }
  },

  // ── Seekers (looking for room) ──────────────────────────────────────────────
  addSeeker(seeker) {
    const id = `S${Date.now()}`;
    // Replace existing entry for same phone
    store.seekers = store.seekers.filter((s) => s.phone !== seeker.phone);
    store.seekers.push({ id, ...seeker, createdAt: new Date().toISOString() });
    saveDB(store);
    return id;
  },

  getSeekers() {
    return store.seekers.filter((s) => s.active !== false);
  },

  // ── Stats ───────────────────────────────────────────────────────────────────
  getStats() {
    return {
      activeListings: db.getListings().length,
      activeSeekers: db.getSeekers().length,
      totalUsers: Object.keys(store.conversations).length,
    };
  },

  getAllListings() {
    return { listings: store.listings, seekers: store.seekers };
  },
};
