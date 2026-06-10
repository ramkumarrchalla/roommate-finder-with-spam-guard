const WHATSAPP_API_URL = "https://graph.facebook.com/v19.0";

/**
 * Send a plain text WhatsApp message
 */
export async function sendMessage({ phoneNumberId, to, text }) {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) {
    console.error("❌ WHATSAPP_TOKEN not set");
    return;
  }

  const url = `${WHATSAPP_API_URL}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("WhatsApp send error:", err);
  } else {
    console.log(`✅ Sent to ${to}`);
  }
}

/**
 * Send an interactive list message (button menu)
 */
export async function sendMenu({ phoneNumberId, to, body, buttons }) {
  const token = process.env.WHATSAPP_TOKEN;
  const url = `${WHATSAPP_API_URL}/${phoneNumberId}/messages`;

  // WhatsApp supports max 3 quick-reply buttons; fall back to text list for more
  if (buttons.length <= 3) {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: {
            buttons: buttons.map((b, i) => ({
              type: "reply",
              reply: { id: `btn_${i}`, title: b },
            })),
          },
        },
      }),
    });
  } else {
    // Fallback: plain text with numbered options
    const numbered = buttons.map((b, i) => `${i + 1}. ${b}`).join("\n");
    await sendMessage({ phoneNumberId, to, text: `${body}\n\n${numbered}` });
  }
}
