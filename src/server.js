import express from "express";
import { handleIncomingMessage } from "./agent.js";
import { db } from "./database.js";
import { runGuard, blockMessage, getGuardStats, clearStrikes } from "./spamGuard.js";

const app = express();
app.use(express.json());

const VERIFY_TOKEN  = process.env.WHATSAPP_VERIFY_TOKEN || "roommate_finder_verify";
const ADMIN_SECRET  = process.env.ADMIN_SECRET          || "";  // set this in env!
const APP_NAME      = process.env.APP_NAME              || "Roommate Finder";

// ── Webhook verification ──────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Incoming WhatsApp messages ────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately to avoid Meta retries

  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value?.messages?.length) continue;

      for (const message of value.messages) {
        if (message.type !== "text") continue;

        const from          = message.from;
        const text          = message.text.body.trim();
        const phoneNumberId = value.metadata.phone_number_id;

        // ── Spam / abuse guard ──────────────────────────────────────────────
        const guard = runGuard(from, text);
        if (guard.blocked) {
          console.warn(`🛡️ BLOCKED [${guard.reason}] from ${from}: "${text.slice(0, 60)}"`);
          // Send a polite block message (except for bans — stay silent to avoid engagement)
          if (guard.reason !== "banned") {
            const { sendMessage } = await import("./whatsapp.js");
            await sendMessage({ phoneNumberId, to: from, text: blockMessage(guard) });
          }
          continue;
        }

        console.log(`📩 [${APP_NAME}] From ${from}: ${text.slice(0, 80)}`);

        try {
          await handleIncomingMessage({ from, text, phoneNumberId });
        } catch (err) {
          console.error("Error handling message:", err);
        }
      }
    }
  }
});

// ── Admin middleware — protects management endpoints ──────────────────────────
function adminAuth(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ error: "Admin endpoints disabled. Set ADMIN_SECRET env var." });
  }
  const provided = req.headers["x-admin-secret"] || req.query.secret;
  if (provided !== ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Health check (public) ─────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", app: APP_NAME, ...db.getStats() });
});

// ── Admin: spam guard stats ───────────────────────────────────────────────────
app.get("/admin/spam", adminAuth, (req, res) => {
  res.json(getGuardStats());
});

// ── Admin: unban a phone number ───────────────────────────────────────────────
app.post("/admin/unban", adminAuth, (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  clearStrikes(phone);
  console.log(`✅ Admin unbanned ${phone}`);
  res.json({ ok: true, phone });
});

// ── Admin: all listings ───────────────────────────────────────────────────────
app.get("/admin/listings", adminAuth, (req, res) => {
  res.json(db.getAllListings());
});

// ── Admin: remove a listing manually ─────────────────────────────────────────
app.delete("/admin/listings/:id", adminAuth, (req, res) => {
  db.deactivateListing(req.params.id);
  res.json({ ok: true, id: req.params.id });
});

// ── Admin: search listings ────────────────────────────────────────────────────
app.get("/admin/listings/search", adminAuth, (req, res) => {
  const { city, country } = req.query;
  let listings = db.getListings();
  if (city)    listings = listings.filter(l => l.city?.toLowerCase().includes(city.toLowerCase()));
  if (country) listings = listings.filter(l => l.country?.toLowerCase().includes(country.toLowerCase()));
  res.json({ count: listings.length, listings });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏠 ${APP_NAME} running on port ${PORT}`);
  if (!ADMIN_SECRET) console.warn("⚠️  ADMIN_SECRET not set — admin endpoints disabled");
});
