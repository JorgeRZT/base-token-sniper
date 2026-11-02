const API = "https://api.telegram.org";

/** Telegram needs a numeric id or "@channelname"; accept a bare channel username too. */
const chatId = () => {
  const c = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  return /^-?\d+$/.test(c) || c.startsWith("@") ? c : `@${c}`;
};

const credentials = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

/** TELEGRAM_ENABLED=true|false in .env (default true). Accepts true/false, 1/0, yes/no, on/off in any case. */
function switchOn() {
  const v = String(process.env.TELEGRAM_ENABLED ?? "true").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(v);
}

/** Alerts are sent only if credentials exist and the TELEGRAM_ENABLED switch is on. */
const enabled = () => credentials() && switchOn();

/** Escapes untrusted text (token names are attacker-controlled) for Telegram HTML parse mode. */
function esc(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 60)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Sends an HTML message. Returns true on success; never throws. `force` ignores the TELEGRAM_ENABLED switch (manual tests). */
async function sendTelegram(html, { force = false } = {}) {
  if (!(force ? credentials() : enabled())) return false;
  try {
    const r = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId(),
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      console.error(`Telegram error ${r.status}: ${body.description || ""}`); // never log the bot token
      return false;
    }
    return true;
  } catch (e) {
    console.error("Telegram request failed:", e.name);
    return false;
  }
}

module.exports = { enabled, credentials, esc, sendTelegram };
