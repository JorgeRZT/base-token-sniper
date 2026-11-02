// Usage: npm run telegram:test
// Sends a test message. If TELEGRAM_CHAT_ID is missing, lists the chats the bot has seen
// (send any message to the bot, or post in the channel where it is admin, then run this again).
require("dotenv").config();
const { sendTelegram } = require("../lib/telegram");

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
  if (!process.env.TELEGRAM_CHAT_ID) {
    const r = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
    const chats = new Map();
    for (const u of r.result || []) {
      const c = (u.message || u.channel_post || u.my_chat_member)?.chat;
      if (c) chats.set(c.id, c.title || c.username || c.first_name);
    }
    console.log(chats.size ? "Chats seen by the bot (use the id as TELEGRAM_CHAT_ID):" : "No chats found yet. Message the bot or add it as admin to your channel, then retry.");
    for (const [id, name] of chats) console.log(`  ${id}  ${name}`);
    return;
  }
  const ok = await sendTelegram("✅ <b>Token sniper</b>: Telegram alerts are working.", { force: true });
  console.log(ok ? "Test message sent." : "Failed to send (see error above).");
})().catch((e) => { console.error(e.message); process.exit(1); });
