# 🏠 Roommate Finder — Global WhatsApp Agent

An AI-powered WhatsApp agent that helps people find roommates **anywhere in the world**. Fully configurable for any community, country, and currency.

---

## Features

- **Post a room** — guided conversation collects all details
- **Find a room** — AI matches against active listings globally
- **Smart matching** — scores by location, budget, gender, lifestyle, language, pets, smoking
- **Auto-notifications** — seekers notified when a matching room is posted
- **Fully customizable** — branding, currency, community values all via env vars
- **Multi-language ready** — Claude understands messages in any language

---

## Community Presets

Configure for any community via environment variables:

### General (default)
```env
APP_NAME=Roommate Finder
COMMUNITY_VALUES=
```

### Muslim Community
```env
APP_NAME=Muslim Roommates
COMMUNITY_VALUES=Halal household preferred, no alcohol, prayer-friendly environment, gender preferences respected
```

### Student Housing
```env
APP_NAME=Student Rooms
COMMUNITY_VALUES=Students preferred, quiet study environment, no parties
```

### Vegan/Eco Community
```env
APP_NAME=Green Roommates
COMMUNITY_VALUES=Vegan household, no meat cooking, eco-friendly lifestyle
```

### Any Country / Currency
```env
CURRENCY=GBP
CURRENCY_SYMBOL=£
```

---

## Setup Guide

### Step 1 — Meta Developer Setup

1. Go to https://developers.facebook.com → Create App → Add WhatsApp product
2. Go to **WhatsApp > API Setup**
3. Copy your **Access Token** and **Phone Number ID**
4. Under "To", add your test phone number and send a test message

### Step 2 — Deploy

#### Railway (recommended — free tier)
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

#### Render
1. Push this repo to GitHub
2. https://render.com → New Web Service → connect repo
3. Build: `npm install` | Start: `npm start`

#### Local + ngrok (testing)
```bash
npm install
cp .env.example .env
# Fill in .env
npm start

# New terminal:
ngrok http 3000
```

### Step 3 — Set Environment Variables

```env
WHATSAPP_TOKEN=        # From Meta
WHATSAPP_VERIFY_TOKEN= roommate_finder_verify
ANTHROPIC_API_KEY=     # From console.anthropic.com
APP_NAME=              # Your app name
COMMUNITY_VALUES=      # Optional community context
CURRENCY=USD
CURRENCY_SYMBOL=$
```

### Step 4 — Register Webhook

1. Meta Developer Console → WhatsApp → Configuration
2. **Webhook URL**: `https://your-server.com/webhook`
3. **Verify Token**: value of your `WHATSAPP_VERIFY_TOKEN`
4. Subscribe to `messages` field
5. Click Verify and Save

---

## Conversation Examples

### Posting a Room (London)
```
User: I have a room to rent
Bot:  Great! What city is the room in?
User: London, Hackney
Bot:  What's the monthly rent?
User: £900
Bot:  Private room or shared?
...
Bot:  ✅ Room posted! Matching seekers notified.
```

### Finding a Room (Dubai)
```
User: Need a room in Dubai
Bot:  What area of Dubai are you looking in?
User: Near downtown, max AED 3000
Bot:  Any preferences — gender, pets, smoking?
...
Bot:  🎉 Found 2 matching rooms: [listings]
```

### Browse All
```
User: Show me what's available
Bot:  📋 12 active listings: [top 5 shown]
```

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /webhook` | Meta webhook verification |
| `POST /webhook` | Incoming WhatsApp messages |
| `GET /health` | Server health + stats |
| `GET /listings` | All listings (admin) |
| `GET /listings/search?city=London&country=UK` | Filter listings |

---

## Architecture

```
User (WhatsApp)
      │
      ▼
Meta Cloud API
      │ POST /webhook
      ▼
Express Server
      ├── database.js   (JSON persistence → swap for Postgres/Mongo in prod)
      ├── agent.js      (Claude AI: conversation + intent + matching)
      └── whatsapp.js   (send replies back to user)
```

---

## Production Recommendations

- Replace JSON file DB with **Supabase** (free PostgreSQL)
- Add **rate limiting** (express-rate-limit)
- Add **listing expiry** (auto-remove after 60 days)
- Weekly **digest messages** to seekers with new matches
- Admin dashboard for listing moderation

---

Built to connect people with homes, wherever they are. 🌍
