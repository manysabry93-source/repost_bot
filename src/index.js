// ============================================================
// ربات ریپست محتوا از کانال‌های عمومی به کانال خودت
// Cloudflare Workers + KV
// ============================================================

const TG_API = (env) => `https://api.telegram.org/bot${env.BOT_TOKEN}`;

function getAdminIds(env) {
  return (env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

async function tg(env, method, params) {
  const res = await fetch(`${TG_API(env)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

// ------------------------------------------------------------
// Rubika (official Bot API: https://rubika.ir/botapi)
// Only active if env.RUBIKA_TOKEN is set.
// ------------------------------------------------------------
function rubikaEnabled(env) {
  return Boolean(env.RUBIKA_TOKEN);
}

async function rb(env, method, params) {
  const res = await fetch(
    `https://botapi.rubika.ir/v3/${env.RUBIKA_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params || {}),
    }
  );
  return res.json();
}

// Photos: Rubika requires a 3-step upload (requestSendFile -> upload -> sendFile).
// We attempt it, but fall back to text-only if anything about the upload fails,
// since this part of Rubika's contract couldn't be fully verified against live docs.
async function rubikaSendPhoto(env, chatId, photoUrl, caption) {
  try {
    const reqRes = await rb(env, "requestSendFile", { type: "Image" });
    const uploadUrl = reqRes?.data?.upload_url;
    if (!uploadUrl) throw new Error("no upload_url");

    const imgRes = await fetch(photoUrl);
    if (!imgRes.ok) throw new Error("could not fetch source image");
    const imgBlob = await imgRes.blob();

    const form = new FormData();
    form.append("file", imgBlob, "photo.jpg");
    const upRes = await fetch(uploadUrl, { method: "POST", body: form });
    const upJson = await upRes.json();
    const fileId = upJson?.data?.file_id;
    if (!fileId) throw new Error("no file_id from upload");

    await rb(env, "sendFile", { chat_id: chatId, file_id: fileId, text: caption });
    return true;
  } catch (e) {
    // fallback: text only, so the post isn't silently lost
    await rb(env, "sendMessage", { chat_id: chatId, text: caption });
    return false;
  }
}

// Generic version of the above: send any already-fetched Blob to a Rubika
// chat, tagged with Rubika's own type vocabulary (Image/Video/Gif/Music/Voice/File).
async function rubikaSendBlob(env, chatId, blob, rubikaType, caption, filename) {
  try {
    const reqRes = await rb(env, "requestSendFile", { type: rubikaType || "File" });
    const uploadUrl = reqRes?.data?.upload_url;
    if (!uploadUrl) throw new Error("no upload_url");

    const form = new FormData();
    form.append("file", blob, filename || "file");
    const upRes = await fetch(uploadUrl, { method: "POST", body: form });
    const upJson = await upRes.json();
    const fileId = upJson?.data?.file_id;
    if (!fileId) throw new Error("no file_id from upload");

    await rb(env, "sendFile", { chat_id: chatId, file_id: fileId, text: caption });
    return true;
  } catch (e) {
    await rb(env, "sendMessage", { chat_id: chatId, text: caption });
    return false;
  }
}

// Download media the bot received from an incoming Rubika message (given its
// file_id) so it can be re-hosted elsewhere. Rubika's own client libraries
// wrap a "getFile" call that returns a download URL for a file_id; the exact
// response field name isn't confirmed against live docs, so we try the
// plausible candidates and give up gracefully if none match.
async function rubikaDownloadFile(env, fileId) {
  try {
    const res = await rb(env, "getFile", { file_id: fileId });
    const url =
      res?.data?.download_url ||
      res?.data?.url ||
      res?.data?.file_url ||
      res?.data?.downloadUrl;
    if (!url) return null;
    const fileRes = await fetch(url);
    if (!fileRes.ok) return null;
    return await fileRes.blob();
  } catch (e) {
    return null;
  }
}

// Send an already-fetched Blob to Telegram via multipart upload (used for
// media pulled from Rubika, since we have raw bytes rather than a public URL).
async function tgSendMediaBlob(env, chatId, method, fieldName, blob, filename, caption, replyMarkup) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(fieldName, blob, filename);
  if (caption) form.append("caption", caption);
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  const res = await fetch(`${TG_API(env)}/${method}`, {
    method: "POST",
    body: form,
  });
  return res.json();
}

// Maps Rubika's file_inline "type" to the right Telegram send method/field.
function telegramMediaMethodFor(rubikaType) {
  switch (rubikaType) {
    case "Image":
      return { method: "sendPhoto", field: "photo" };
    case "Video":
      return { method: "sendVideo", field: "video" };
    case "Gif":
      return { method: "sendAnimation", field: "animation" };
    case "Music":
      return { method: "sendAudio", field: "audio" };
    case "Voice":
      return { method: "sendVoice", field: "voice" };
    default:
      return { method: "sendDocument", field: "document" };
  }
}

// ------------------------------------------------------------
// KV helpers
// ------------------------------------------------------------
async function getJSON(env, key, fallback) {
  const v = await env.BOT_KV.get(key);
  return v ? JSON.parse(v) : fallback;
}
async function setJSON(env, key, value) {
  await env.BOT_KV.put(key, JSON.stringify(value));
}

async function getSources(env) {
  return getJSON(env, "sources", []);
}
async function getDestinations(env) {
  return getJSON(env, "destinations", []);
}
async function getRubikaDestinations(env) {
  return getJSON(env, "rubika_destinations", []);
}
async function getRubikaSources(env) {
  return getJSON(env, "rubika_sources", []);
}
async function getReviewerChatId(env) {
  return env.BOT_KV.get("reviewer_chat_id");
}
async function getSecondaryDestinations(env) {
  return getJSON(env, "destinations_secondary", []);
}
async function getRubikaSecondaryDestinations(env) {
  return getJSON(env, "rubika_destinations_secondary", []);
}
function stripPlainText(text) {
  if (!text) return "";
  let s = text;
  s = s.replace(/https?:\/\/\S+/gi, "");
  s = s.replace(/t\.me\/\S+/gi, "");
  s = s.replace(/(^|\s)@[a-zA-Z0-9_]{3,}/g, "$1");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  return s.trim();
}
async function getRubikaDiscovered(env) {
  return getJSON(env, "rubika_discovered", []);
}
async function getFilterKeywords(env) {
  return getJSON(env, "filter_keywords", []); // [{word, mode: "skip"|"redact"}]
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Applies "skip" keywords first (whole post dropped if matched), then
// "redact" keywords (just that word/phrase removed, post still goes out).
function applyFilters(text, keywords) {
  if (!text) return { text: "", blocked: false };
  for (const kw of keywords) {
    if (kw.mode === "skip" && kw.word) {
      const re = new RegExp(escapeRegex(kw.word), "i");
      if (re.test(text)) return { text: "", blocked: true };
    }
  }
  let result = text;
  for (const kw of keywords) {
    if (kw.mode === "redact" && kw.word) {
      const re = new RegExp(escapeRegex(kw.word), "gi");
      result = result.replace(re, "");
    }
  }
  result = result.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { text: result, blocked: false };
}
async function getSignature(env) {
  const sig = await env.BOT_KV.get("signature");
  return sig !== null ? sig : DEFAULT_SIGNATURE;
}

const DEFAULT_SIGNATURE = `🌟 گروه مشاوره فراهوش

📌 اینستاگرام | تلگرام | روبیکا
@fara_hoosh99

🎁 رزرو مشاوره رایگان  و برنامه‌ریزی اختصاصی
@moshaver_fara_hoosh99
۰۹۳۶۲۴۳۱۳۹۶`;

// ------------------------------------------------------------
// Content cleaning
// ------------------------------------------------------------
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function htmlToPlainStripped(html) {
  if (!html) return "";
  let s = html;
  // line breaks
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // remove <a ...>...</a> entirely (links + @mentions + hashtags rendered as links)
  s = s.replace(/<a\b[^>]*>.*?<\/a>/gis, "");
  // remove tg-spoiler wrappers but keep inner text
  s = s.replace(/<tg-spoiler[^>]*>(.*?)<\/tg-spoiler>/gis, "$1");
  // strip any remaining tags (b, i, span, etc.) but keep inner text
  s = s.replace(/<\/?[^>]+>/g, "");
  s = decodeEntities(s);
  // fallback: remove bare urls / mentions that weren't wrapped in <a>
  s = s.replace(/https?:\/\/\S+/gi, "");
  s = s.replace(/t\.me\/\S+/gi, "");
  s = s.replace(/(^|\s)@[a-zA-Z0-9_]{4,}/g, "$1");
  // collapse extra blank lines/spaces left behind
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

// ------------------------------------------------------------
// Scrape https://t.me/s/<username>
// ------------------------------------------------------------
async function fetchChannelPage(username) {
  const url = `https://t.me/s/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; RepostBot/1.0)" },
  });
  if (!res.ok) return null;
  return res.text();
}

function parseMessages(html, username) {
  if (!html) return [];
  const marker = `data-post="${username}/`;
  const parts = html.split(marker);
  const messages = [];
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const idMatch = chunk.match(/^(\d+)"/);
    if (!idMatch) continue;
    const id = parseInt(idMatch[1], 10);

    // isolate this message's own html (up to the next message marker or a safe window)
    const nextIdx = chunk.indexOf(marker);
    const scope = nextIdx === -1 ? chunk : chunk.slice(0, nextIdx);

    // skip forwarded-only service placeholders (no text/photo/video) heuristically later
    const textMatch = scope.match(
      /tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/
    );
    const text = textMatch ? htmlToPlainStripped(textMatch[1]) : "";

    const photoMatch = scope.match(
      /tgme_widget_message_photo_wrap[^"]*"\s+style="[^"]*background-image:url\('([^']+)'\)/
    );
    const photoUrl = photoMatch ? photoMatch[1] : null;

    const hasVideo = /tgme_widget_message_video_player/.test(scope);

    if (!text && !photoUrl && !hasVideo) continue; // nothing usable

    messages.push({ id, text, photoUrl, hasVideo });
  }
  // ascending order (oldest first) so we post in correct sequence
  messages.sort((a, b) => a.id - b.id);
  return messages;
}

// ------------------------------------------------------------
// Send a cleaned post to all destination channels
// ------------------------------------------------------------
async function deliverToRubika(env, msg, finalText, rubikaTargets) {
  for (const chat of rubikaTargets) {
    try {
      if (msg.photoUrl) {
        await rubikaSendPhoto(env, chat.chat_id, msg.photoUrl, finalText);
      } else if (msg.hasVideo) {
        await rb(env, "sendMessage", {
          chat_id: chat.chat_id,
          text:
            finalText +
            "\n\n(⚠️ این پست ویدیو داشت که به‌صورت خودکار قابل بازنشر نبود)",
        });
      } else {
        await rb(env, "sendMessage", { chat_id: chat.chat_id, text: finalText });
      }
    } catch (e) {
      // swallow — a single failed Rubika destination shouldn't block others
    }
  }
}

async function deliverMessage(env, msg, signature, targets, rubikaTargets) {
  const finalText = [msg.text, signature].filter(Boolean).join("\n\n");
  if (rubikaTargets && rubikaTargets.length) {
    await deliverToRubika(env, msg, finalText, rubikaTargets);
  }
  const results = [];
  for (const chat of targets) {
    const chatId = chat.username ? `@${chat.username}` : chat.id;
    try {
      if (msg.photoUrl) {
        if (finalText.length <= 1000) {
          await tg(env, "sendPhoto", {
            chat_id: chatId,
            photo: msg.photoUrl,
            caption: finalText,
          });
        } else {
          await tg(env, "sendPhoto", { chat_id: chatId, photo: msg.photoUrl });
          await tg(env, "sendMessage", { chat_id: chatId, text: finalText });
        }
      } else if (msg.hasVideo) {
        // t.me/s/ preview rarely exposes a direct video file URL; send text
        // with a note so nothing silently disappears.
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text:
            finalText +
            "\n\n(⚠️ این پست ویدیو داشت که به‌صورت خودکار قابل بازنشر نبود)",
        });
      } else {
        await tg(env, "sendMessage", { chat_id: chatId, text: finalText });
      }
      results.push({ chat: chatId, ok: true });
    } catch (e) {
      results.push({ chat: chatId, ok: false, error: String(e) });
    }
  }
  return results;
}

// ------------------------------------------------------------
// Approval queue ("مشاور تایید")
// If a reviewer chat id is configured, new content is sent there with
// ✅ انتشار / 🚫 عدم انتشار / ↪️ کانال دوم buttons instead of being
// auto-published. If no reviewer is configured, behavior is unchanged
// (immediate publish) for backwards compatibility.
// ------------------------------------------------------------
function makePendingId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function reviewButtons(id) {
  return {
    inline_keyboard: [
      [
        { text: "✅ انتشار", callback_data: `rev_pub_${id}` },
        { text: "🚫 عدم انتشار", callback_data: `rev_rej_${id}` },
        { text: "↪️ کانال دوم", callback_data: `rev_alt_${id}` },
      ],
    ],
  };
}

async function loadPending(env, id) {
  const raw = await env.BOT_KV.get(`pending:${id}`);
  return raw ? JSON.parse(raw) : null;
}
async function deletePending(env, id) {
  await env.BOT_KV.delete(`pending:${id}`);
}

// pending.kind: "scraped" (text + optional photoUrl/hasVideo, e.g. from Telegram
// t.me/s/ scraping) or "rubika_file" (text + a Rubika file_id/type to re-download).
async function queueForReview(env, pendingData) {
  const id = makePendingId();
  const pending = { id, createdAt: new Date().toISOString(), ...pendingData };
  await env.BOT_KV.put(`pending:${id}`, JSON.stringify(pending), {
    expirationTtl: 60 * 60 * 24 * 7,
  });
  await sendForReview(env, pending);
}

async function sendForReview(env, pending) {
  const reviewerChatId = await getReviewerChatId(env);
  if (!reviewerChatId) return false;
  const label = "🕵️ مشاور تایید";
  const caption = `${label}\n\n${pending.text || ""}`.trim();
  const buttons = reviewButtons(pending.id);

  if (pending.kind === "rubika_file" && pending.rubikaFileId) {
    const blob = await rubikaDownloadFile(env, pending.rubikaFileId);
    if (blob) {
      const { method, field } = telegramMediaMethodFor(pending.rubikaMediaType);
      if (caption.length <= 900) {
        await tgSendMediaBlob(env, reviewerChatId, method, field, blob, "file", caption, buttons);
      } else {
        await tgSendMediaBlob(env, reviewerChatId, method, field, blob, "file");
        await tg(env, "sendMessage", { chat_id: reviewerChatId, text: caption, reply_markup: buttons });
      }
      return true;
    }
    // download failed — fall through to text-only preview below
  }

  if (pending.kind === "scraped" && pending.photoUrl) {
    if (caption.length <= 900) {
      await tg(env, "sendPhoto", {
        chat_id: reviewerChatId,
        photo: pending.photoUrl,
        caption,
        reply_markup: buttons,
      });
    } else {
      await tg(env, "sendPhoto", { chat_id: reviewerChatId, photo: pending.photoUrl });
      await tg(env, "sendMessage", { chat_id: reviewerChatId, text: caption, reply_markup: buttons });
    }
    return true;
  }

  const noteText = pending.hasVideo
    ? `${caption}\n\n(⚠️ پیش‌نمایش ویدیو پشتیبانی نمی‌شود، ولی با تایید، پست منتشر خواهد شد)`
    : pending.kind === "rubika_file"
    ? `${caption}\n\n(⚠️ دانلود فایل برای پیش‌نمایش موفق نشد، ولی با تایید دوباره امتحان می‌شود)`
    : caption;
  await tg(env, "sendMessage", { chat_id: reviewerChatId, text: noteText, reply_markup: buttons });
  return true;
}

async function publishPending(env, pending, useSecondary) {
  const signature = await getSignature(env);
  const telegramTargets = useSecondary
    ? await getSecondaryDestinations(env)
    : await getDestinations(env);
  const rubikaTargets = useSecondary
    ? await getRubikaSecondaryDestinations(env)
    : await getRubikaDestinations(env);

  if (pending.kind === "rubika_file" && pending.rubikaFileId) {
    const blob = await rubikaDownloadFile(env, pending.rubikaFileId);
    const finalText = [pending.text, signature].filter(Boolean).join("\n\n");
    if (blob) {
      const { method, field } = telegramMediaMethodFor(pending.rubikaMediaType);
      for (const chat of telegramTargets) {
        const chatIdTg = chat.username ? `@${chat.username}` : chat.id;
        try {
          if (finalText.length <= 900) {
            await tgSendMediaBlob(env, chatIdTg, method, field, blob, "file", finalText);
          } else {
            await tgSendMediaBlob(env, chatIdTg, method, field, blob, "file");
            await tg(env, "sendMessage", { chat_id: chatIdTg, text: finalText });
          }
        } catch (e) {
          // one bad destination shouldn't block the others
        }
      }
      for (const chat of rubikaTargets) {
        await rubikaSendBlob(env, chat.chat_id, blob, pending.rubikaMediaType, finalText, "file");
      }
      return;
    }
    // media couldn't be (re-)downloaded at publish time — send text so nothing is lost
    await deliverMessage(
      env,
      { text: pending.text, photoUrl: null, hasVideo: false },
      signature,
      telegramTargets,
      rubikaTargets
    );
    return;
  }

  await deliverMessage(
    env,
    { text: pending.text, photoUrl: pending.photoUrl || null, hasVideo: Boolean(pending.hasVideo) },
    signature,
    telegramTargets,
    rubikaTargets
  );
}

// ------------------------------------------------------------
// Cron: poll all sources
// ------------------------------------------------------------
async function pollSources(env) {
  const paused = (await env.BOT_KV.get("paused")) === "1";
  const testMode = (await env.BOT_KV.get("test_mode")) === "1";
  const sources = await getSources(env);
  const destinations = await getDestinations(env);
  const rubikaDestinations = rubikaEnabled(env)
    ? await getRubikaDestinations(env)
    : [];
  const signature = await getSignature(env);
  const adminIds = getAdminIds(env);

  const targets = testMode
    ? adminIds.map((id) => ({ id }))
    : destinations;
  const rubikaTargets = testMode ? [] : rubikaDestinations; // test mode only previews on Telegram
  const filterKeywords = await getFilterKeywords(env);
  const reviewerChatId = await getReviewerChatId(env);

  let totalSent = 0;

  for (const src of sources) {
    const lastIdKey = `last_id:${src.username}`;
    const lastId = parseInt((await env.BOT_KV.get(lastIdKey)) || "0", 10);

    const html = await fetchChannelPage(src.username);
    const messages = parseMessages(html, src.username);
    if (!messages.length) continue;

    const maxIdOnPage = Math.max(...messages.map((m) => m.id));

    if (lastId === 0) {
      // first time seeing this channel: baseline so we don't dump the backlog
      await env.BOT_KV.put(lastIdKey, String(maxIdOnPage));
      continue;
    }

    const fresh = messages
      .filter((m) => m.id > lastId)
      .map((m) => {
        const { text: filteredText, blocked } = applyFilters(
          m.text,
          filterKeywords
        );
        return blocked ? null : { ...m, text: filteredText };
      })
      .filter(Boolean);
    if (!fresh.length) continue;

    if (!paused) {
      for (const m of fresh) {
        if (reviewerChatId) {
          await queueForReview(env, {
            kind: "scraped",
            text: m.text,
            photoUrl: m.photoUrl || null,
            hasVideo: Boolean(m.hasVideo),
          });
        } else {
          await deliverMessage(env, m, signature, targets, rubikaTargets);
        }
        totalSent++;
      }
    }
    await env.BOT_KV.put(lastIdKey, String(maxIdOnPage));
  }

  if (totalSent > 0) {
    const total = parseInt((await env.BOT_KV.get("stats_total")) || "0", 10);
    await env.BOT_KV.put("stats_total", String(total + totalSent));
  }
  await env.BOT_KV.put("stats_last_run", new Date().toISOString());
}

// ------------------------------------------------------------
// Admin panel (Telegram side)
// ------------------------------------------------------------
function mainMenu(env) {
  const rows = [
    [{ text: "➕ افزودن کانال مبدا", callback_data: "add_src" }],
    [{ text: "📋 لیست / حذف کانال‌های مبدا", callback_data: "list_src" }],
    [{ text: "➕ افزودن کانال مقصد (تلگرام)", callback_data: "add_dst" }],
    [{ text: "📋 لیست / حذف مقصد تلگرام", callback_data: "list_dst" }],
  ];
  if (rubikaEnabled(env)) {
    rows.push([
      { text: "➕ افزودن مبدا روبیکا (GUID)", callback_data: "add_rbsrc" },
    ]);
    rows.push([
      { text: "📋 لیست / حذف مبدا روبیکا", callback_data: "list_rbsrc" },
    ]);
    rows.push([
      { text: "➕ افزودن مقصد روبیکا (GUID)", callback_data: "add_rb" },
    ]);
    rows.push([
      { text: "📋 لیست / حذف مقصد روبیکا", callback_data: "list_rb" },
    ]);
    rows.push([
      { text: "🔎 چت‌های روبیکا شناسایی‌شده", callback_data: "disc_rb" },
    ]);
  }
  rows.push([{ text: "🕵️ تنظیم آیدی مشاور تایید", callback_data: "set_reviewer" }]);
  rows.push([{ text: "➕ افزودن کانال دوم (تلگرام)", callback_data: "add_dst2" }]);
  rows.push([{ text: "📋 لیست / حذف کانال دوم تلگرام", callback_data: "list_dst2" }]);
  if (rubikaEnabled(env)) {
    rows.push([{ text: "➕ افزودن کانال دوم (روبیکا)", callback_data: "add_rb2" }]);
    rows.push([{ text: "📋 لیست / حذف کانال دوم روبیکا", callback_data: "list_rb2" }]);
  }
  rows.push([{ text: "✏️ ویرایش امضا", callback_data: "edit_sig" }]);
  rows.push([{ text: "🚫 افزودن کلمه (کل پست حذف شود)", callback_data: "add_filter_skip" }]);
  rows.push([{ text: "✂️ افزودن کلمه (فقط خودش حذف شود)", callback_data: "add_filter_redact" }]);
  rows.push([{ text: "📋 لیست / حذف کلمات فیلتر", callback_data: "list_filter" }]);
  rows.push([{ text: "🧪 حالت آزمایشی: تغییر وضعیت", callback_data: "toggle_test" }]);
  rows.push([{ text: "⏸ توقف / ▶️ شروع", callback_data: "toggle_pause" }]);
  rows.push([{ text: "📊 آمار", callback_data: "stats" }]);
  return { inline_keyboard: rows };
}

async function setState(env, adminId, state) {
  await setJSON(env, `state:${adminId}`, state);
}
async function getState(env, adminId) {
  return getJSON(env, `state:${adminId}`, null);
}
async function clearState(env, adminId) {
  await env.BOT_KV.delete(`state:${adminId}`);
}

function extractUsername(line) {
  let s = line.trim();
  s = s.replace(/^https?:\/\/t\.me\//i, "");
  s = s.replace(/^t\.me\//i, "");
  s = s.replace(/^@/, "");
  s = s.split(/[/?\s]/)[0];
  return s;
}

async function addChannels(env, rawText, list, isSourceList) {
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
  const added = [];
  const failed = [];
  for (const line of lines) {
    const username = extractUsername(line);
    if (!username) continue;
    const info = await tg(env, "getChat", { chat_id: `@${username}` });
    if (!info.ok) {
      failed.push(username);
      continue;
    }
    if (list.find((c) => c.username === username)) continue; // dedupe
    list.push({ username, title: info.result.title || username });
    added.push(info.result.title || username);
  }
  return { added, failed };
}

async function handleAdminMessage(env, msg) {
  const adminId = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/menu") {
    await clearState(env, adminId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🤖 پنل مدیریت ربات ریپست\nیکی از گزینه‌ها رو انتخاب کن:",
      reply_markup: mainMenu(env),
    });
    return;
  }

  const state = await getState(env, adminId);
  if (!state) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "برای شروع /start را بفرست.",
    });
    return;
  }

  if (state.action === "add_src" || state.action === "add_dst") {
    const isSrc = state.action === "add_src";
    const list = isSrc ? await getSources(env) : await getDestinations(env);
    const { added, failed } = await addChannels(env, text, list, isSrc);
    await setJSON(env, isSrc ? "sources" : "destinations", list);
    // baseline last_id for newly added source channels so we don't dump backlog
    if (isSrc) {
      for (const title of added) {
        const uname = list.find((c) => c.title === title)?.username;
        if (uname) {
          const html = await fetchChannelPage(uname);
          const messages = parseMessages(html, uname);
          if (messages.length) {
            const maxId = Math.max(...messages.map((m) => m.id));
            await env.BOT_KV.put(`last_id:${uname}`, String(maxId));
          }
        }
      }
    }
    let report = "";
    if (added.length) report += `✅ اضافه شد: ${added.join("، ")}\n`;
    if (failed.length)
      report += `❌ پیدا نشد (بررسی کن یوزرنیم درست و عمومی باشه): ${failed.join(
        "، "
      )}`;
    if (!report) report = "چیزی اضافه نشد.";
    await clearState(env, adminId);
    await tg(env, "sendMessage", { chat_id: chatId, text: report });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "منوی اصلی:",
      reply_markup: mainMenu(env),
    });
    return;
  }

  if (state.action === "add_filter_skip" || state.action === "add_filter_redact") {
    const mode = state.action === "add_filter_skip" ? "skip" : "redact";
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const list = await getFilterKeywords(env);
    const added = [];
    for (const w of lines) {
      if (!list.find((k) => k.word === w && k.mode === mode)) {
        list.push({ word: w, mode });
        added.push(w);
      }
    }
    await setJSON(env, "filter_keywords", list);
    await clearState(env, adminId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: added.length
        ? `✅ به لیست فیلتر (${mode === "skip" ? "حذف کل پست" : "حذف فقط کلمه"}) اضافه شد: ${added.join("، ")}`
        : "چیزی اضافه نشد.",
    });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "منوی اصلی:",
      reply_markup: mainMenu(env),
    });
    return;
  }

  if (state.action === "set_reviewer") {
    const id = text.trim();
    if (!/^-?\d+$/.test(id)) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "این یه آیدی عددی معتبر نیست. یه عدد بفرست (مثلاً آیدی خودت یا یه گروه/کانال بازبینی).",
      });
      return;
    }
    await clearState(env, adminId);
    if (id === "0") {
      await env.BOT_KV.delete("reviewer_chat_id");
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "✅ حالت تایید غیرفعال شد؛ محتوای جدید دوباره خودکار منتشر می‌شه.",
        reply_markup: mainMenu(env),
      });
      return;
    }
    await env.BOT_KV.put("reviewer_chat_id", id);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ از این به بعد محتوای جدید برای تایید به این آیدی فرستاده می‌شه: ${id}`,
      reply_markup: mainMenu(env),
    });
    return;
  }

  if (state.action === "add_dst2") {
    const list = await getSecondaryDestinations(env);
    const { added, failed } = await addChannels(env, text, list, false);
    await setJSON(env, "destinations_secondary", list);
    let report = "";
    if (added.length) report += `✅ اضافه شد: ${added.join("، ")}\n`;
    if (failed.length) report += `❌ پیدا نشد: ${failed.join("، ")}`;
    await clearState(env, adminId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: report || "چیزی اضافه نشد.",
      reply_markup: mainMenu(env),
    });
    return;
  }

  if (state.action === "add_rb2") {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const list = await getRubikaSecondaryDestinations(env);
    const added = [];
    for (const line of lines) {
      const [guid, ...rest] = line.split(/\s+/);
      if (!guid) continue;
      if (list.find((c) => c.chat_id === guid)) continue;
      const title = rest.join(" ") || guid;
      list.push({ chat_id: guid, title });
      added.push(title);
    }
    await setJSON(env, "rubika_destinations_secondary", list);
    await clearState(env, adminId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: added.length ? `✅ اضافه شد: ${added.join("، ")}` : "چیزی اضافه نشد.",
      reply_markup: mainMenu(env),
    });
    return;
  }

  if (state.action === "add_rbsrc") {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const list = await getRubikaSources(env);
    const added = [];
    for (const line of lines) {
      const [guid, ...rest] = line.split(/\s+/);
      if (!guid) continue;
      if (list.find((c) => c.chat_id === guid)) continue;
      const title = rest.join(" ") || guid;
      list.push({ chat_id: guid, title });
      added.push(title);
    }
    await setJSON(env, "rubika_sources", list);
    await clearState(env, adminId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: added.length
        ? `✅ اضافه شد: ${added.join("، ")}\nربات باید ادمین این کانال(ها) باشه تا پست‌هاشون رو دریافت کنه.`
        : "چیزی اضافه نشد.",
    });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "منوی اصلی:",
      reply_markup: mainMenu(env),
    });
    return;
  }

  if (state.action === "add_rb") {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const list = await getRubikaDestinations(env);
    const added = [];
    for (const line of lines) {
      // accept "GUID" or "GUID عنوان دلخواه"
      const [guid, ...rest] = line.split(/\s+/);
      if (!guid) continue;
      if (list.find((c) => c.chat_id === guid)) continue;
      const title = rest.join(" ") || guid;
      list.push({ chat_id: guid, title });
      added.push(title);
    }
    await setJSON(env, "rubika_destinations", list);
    await clearState(env, adminId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: added.length
        ? `✅ اضافه شد: ${added.join("، ")}`
        : "چیزی اضافه نشد.",
    });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "منوی اصلی:",
      reply_markup: mainMenu(env),
    });
    return;
  }

  if (state.action === "edit_sig") {
    await env.BOT_KV.put("signature", text);
    await clearState(env, adminId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "✅ امضای جدید ذخیره شد.",
      reply_markup: mainMenu(env),
    });
    return;
  }
}

async function handleCallback(env, cq) {
  const adminId = cq.from.id;
  const chatId = cq.message.chat.id;
  const data = cq.data;

  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  if (data.startsWith("rev_pub_") || data.startsWith("rev_rej_") || data.startsWith("rev_alt_")) {
    const id = data.replace(/^rev_(pub|rej|alt)_/, "");
    const action = data.startsWith("rev_pub_")
      ? "pub"
      : data.startsWith("rev_rej_")
      ? "rej"
      : "alt";
    const pending = await loadPending(env, id);
    try {
      await tg(env, "editMessageReplyMarkup", {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (e) {}
    if (!pending) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "این محتوا قبلاً پردازش شده یا منقضی شده.",
      });
      return;
    }
    await deletePending(env, id);
    if (action === "pub") {
      await publishPending(env, pending, false);
      await tg(env, "sendMessage", { chat_id: chatId, text: "✅ منتشر شد." });
    } else if (action === "alt") {
      await publishPending(env, pending, true);
      await tg(env, "sendMessage", { chat_id: chatId, text: "↪️ به کانال دوم ارسال شد." });
    } else {
      await tg(env, "sendMessage", { chat_id: chatId, text: "🚫 منتشر نشد." });
    }
    return;
  }

  if (data === "set_reviewer") {
    await setState(env, adminId, { action: "set_reviewer" });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "آیدی عددی چتی که می‌خوای محتوای جدید برای تایید بهش فرستاده بشه رو بفرست (مثلاً آیدی خودت). برای غیرفعال‌کردنِ این حالت و برگشتن به انتشار خودکار، عدد 0 رو بفرست.",
    });
    return;
  }
  if (data === "add_dst2") {
    await setState(env, adminId, { action: "add_dst2" });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "یوزرنیم یا لینک کانال(های) «دوم» تلگرام رو بفرست (ربات باید ادمین اونجا باشه). هر خط یک کانال:",
    });
    return;
  }
  if (data === "list_dst2") {
    const list = await getSecondaryDestinations(env);
    if (!list.length) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "لیست خالی است." });
      return;
    }
    const buttons = list.map((c) => [
      { text: `🗑 ${c.title} (@${c.username})`, callback_data: `rm_dst2_${c.username}` },
    ]);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "برای حذف روی کانال بزن:",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }
  if (data.startsWith("rm_dst2_")) {
    const username = data.replace("rm_dst2_", "");
    let list = await getSecondaryDestinations(env);
    list = list.filter((c) => c.username !== username);
    await setJSON(env, "destinations_secondary", list);
    await tg(env, "sendMessage", { chat_id: chatId, text: `✅ @${username} حذف شد.` });
    return;
  }
  if (data === "add_rb2") {
    await setState(env, adminId, { action: "add_rb2" });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "GUID کانال «دوم» روبیکا رو بفرست (ربات باید ادمین اونجا باشه). هر خط یک کانال:",
    });
    return;
  }
  if (data === "list_rb2") {
    const list = await getRubikaSecondaryDestinations(env);
    if (!list.length) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "لیست خالی است." });
      return;
    }
    const buttons = list.map((c) => [
      { text: `🗑 ${c.title}`, callback_data: `rm_rb2_${c.chat_id}` },
    ]);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "برای حذف روی مورد بزن:",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }
  if (data.startsWith("rm_rb2_")) {
    const guid = data.replace("rm_rb2_", "");
    let list = await getRubikaSecondaryDestinations(env);
    list = list.filter((c) => c.chat_id !== guid);
    await setJSON(env, "rubika_destinations_secondary", list);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ حذف شد." });
    return;
  }

  if (data === "add_src") {
    await setState(env, adminId, { action: "add_src" });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "یوزرنیم یا لینک کانال(های) مبدا رو بفرست. هر کانال در یک خط جدا (می‌تونی چند تا رو با هم بفرستی):\n\n@channel1\nhttps://t.me/channel2",
    });
    return;
  }
  if (data === "add_dst") {
    await setState(env, adminId, { action: "add_dst" });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "یوزرنیم یا لینک کانال(های) مقصد رو بفرست (باید ربات ادمین اونجا باشه). هر کانال در یک خط جدا:",
    });
    return;
  }
  if (data === "add_filter_skip") {
    await setState(env, adminId, { action: "add_filter_skip" });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "کلمه یا عبارت(های) رو بفرست، هر کدوم در یک خط. اگه متن پست (یا کپشن عکس/ویدیو) شامل هر کدوم از این‌ها باشه، کل اون پست منتشر نمی‌شه:",
    });
    return;
  }
  if (data === "add_filter_redact") {
    await setState(env, adminId, { action: "add_filter_redact" });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "کلمه یا عبارت(های) رو بفرست، هر کدوم در یک خط. هرجای متن پست که این‌ها دیده بشه فقط خودشون حذف می‌شن، بقیه‌ی پست عادی منتشر می‌شه:",
    });
    return;
  }
  if (data === "list_filter") {
    const list = await getFilterKeywords(env);
    if (!list.length) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "لیست خالی است." });
      return;
    }
    const buttons = list.map((kw, i) => [
      {
        text: `🗑 ${kw.word} (${kw.mode === "skip" ? "حذف کل پست" : "حذف فقط کلمه"})`,
        callback_data: `rm_filter_${i}`,
      },
    ]);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "برای حذف روی مورد بزن:",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }
  if (data.startsWith("rm_filter_")) {
    const idx = parseInt(data.replace("rm_filter_", ""), 10);
    let list = await getFilterKeywords(env);
    const removed = list[idx];
    list = list.filter((_, i) => i !== idx);
    await setJSON(env, "filter_keywords", list);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: removed ? `✅ «${removed.word}» حذف شد.` : "پیدا نشد.",
    });
    return;
  }
  if (data === "add_rbsrc") {
    await setState(env, adminId, { action: "add_rbsrc" });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "GUID کانال(های) روبیکا که می‌خوای به‌عنوان مبدا اضافه بشه رو بفرست (ربات باید ادمین اون کانال باشه). هر خط یک کانال؛ می‌تونی یک عنوان دلخواه هم بعدش بنویسی:\n\nb0XXXXXXXXXXXXXXXXXXXXXXX عنوان دلخواه\n\nاگه GUID رو نداری، از بخش «چت‌های روبیکا شناسایی‌شده» استفاده کن.",
    });
    return;
  }
  if (data === "list_rbsrc") {
    const list = await getRubikaSources(env);
    if (!list.length) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "لیست خالی است." });
      return;
    }
    const buttons = list.map((c) => [
      { text: `🗑 ${c.title}`, callback_data: `rm_rbsrc_${c.chat_id}` },
    ]);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "برای حذف روی مورد بزن:",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }
  if (data.startsWith("rm_rbsrc_")) {
    const guid = data.replace("rm_rbsrc_", "");
    let list = await getRubikaSources(env);
    list = list.filter((c) => c.chat_id !== guid);
    await setJSON(env, "rubika_sources", list);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ حذف شد." });
    return;
  }
  if (data === "add_rb") {
    await setState(env, adminId, { action: "add_rb" });
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "GUID کانال روبیکا رو بفرست (ربات باید ادمین اون کانال باشه). هر خط یک کانال؛ می‌تونی یک عنوان دلخواه هم بعدش بنویسی:\n\nb0XXXXXXXXXXXXXXXXXXXXXXX عنوان دلخواه\n\nاگه GUID رو نداری، از بخش «چت‌های روبیکا شناسایی‌شده» در منو استفاده کن.",
    });
    return;
  }
  if (data === "list_rb") {
    const list = await getRubikaDestinations(env);
    if (!list.length) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "لیست خالی است." });
      return;
    }
    const buttons = list.map((c) => [
      { text: `🗑 ${c.title}`, callback_data: `rm_rb_${c.chat_id}` },
    ]);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "برای حذف روی مورد بزن:",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }
  if (data.startsWith("rm_rb_")) {
    const guid = data.replace("rm_rb_", "");
    let list = await getRubikaDestinations(env);
    list = list.filter((c) => c.chat_id !== guid);
    await setJSON(env, "rubika_destinations", list);
    await tg(env, "sendMessage", { chat_id: chatId, text: "✅ حذف شد." });
    return;
  }
  if (data === "disc_rb") {
    const discovered = await getRubikaDiscovered(env);
    if (!discovered.length) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text:
          "هنوز چتی شناسایی نشده. باید حداقل یک پیام/رویداد از طرف کانال روبیکا (که ربات توش ادمینه) دریافت شده باشه تا این‌جا لیست بشه.",
      });
      return;
    }
    const buttons = discovered.map((d) => [
      { text: `➕ مبدا: ${d.chat_id}`, callback_data: `use_disc_src_${d.chat_id}` },
      { text: `➕ مقصد: ${d.chat_id}`, callback_data: `use_disc_${d.chat_id}` },
    ]);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "چت‌های شناسایی‌شده — بزن تا به‌عنوان مبدا یا مقصد اضافه بشه:",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }
  if (data.startsWith("use_disc_src_")) {
    const guid = data.replace("use_disc_src_", "");
    const list = await getRubikaSources(env);
    if (!list.find((c) => c.chat_id === guid)) {
      list.push({ chat_id: guid, title: guid });
      await setJSON(env, "rubika_sources", list);
    }
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ ${guid} به مبدأهای روبیکا اضافه شد.`,
    });
    return;
  }
  if (data.startsWith("use_disc_")) {
    const guid = data.replace("use_disc_", "");
    const list = await getRubikaDestinations(env);
    if (!list.find((c) => c.chat_id === guid)) {
      list.push({ chat_id: guid, title: guid });
      await setJSON(env, "rubika_destinations", list);
    }
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ ${guid} به مقصدهای روبیکا اضافه شد.`,
    });
    return;
  }
  if (data === "edit_sig") {
    await setState(env, adminId, { action: "edit_sig" });
    const current = await getSignature(env);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `متن فعلی امضا:\n\n${current}\n\nمتن جدید رو بفرست تا جایگزین بشه:`,
    });
    return;
  }
  if (data === "list_src" || data === "list_dst") {
    const isSrc = data === "list_src";
    const list = isSrc ? await getSources(env) : await getDestinations(env);
    if (!list.length) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "لیست خالی است.",
      });
      return;
    }
    const buttons = list.map((c) => [
      {
        text: `🗑 ${c.title} (@${c.username})`,
        callback_data: `rm_${isSrc ? "src" : "dst"}_${c.username}`,
      },
    ]);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "برای حذف روی کانال بزن:",
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }
  if (data.startsWith("rm_src_") || data.startsWith("rm_dst_")) {
    const isSrc = data.startsWith("rm_src_");
    const username = data.replace(isSrc ? "rm_src_" : "rm_dst_", "");
    const key = isSrc ? "sources" : "destinations";
    let list = await getJSON(env, key, []);
    list = list.filter((c) => c.username !== username);
    await setJSON(env, key, list);
    if (isSrc) await env.BOT_KV.delete(`last_id:${username}`);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ @${username} حذف شد.`,
    });
    return;
  }
  if (data === "toggle_test") {
    const cur = (await env.BOT_KV.get("test_mode")) === "1";
    await env.BOT_KV.put("test_mode", cur ? "0" : "1");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `حالت آزمایشی الان: ${!cur ? "روشن ✅" : "خاموش"}`,
    });
    return;
  }
  if (data === "toggle_pause") {
    const cur = (await env.BOT_KV.get("paused")) === "1";
    await env.BOT_KV.put("paused", cur ? "0" : "1");
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `ربات الان: ${!cur ? "متوقف ⏸" : "فعال ▶️"}`,
    });
    return;
  }
  if (data === "stats") {
    const total = (await env.BOT_KV.get("stats_total")) || "0";
    const lastRun = (await env.BOT_KV.get("stats_last_run")) || "هنوز اجرا نشده";
    const sources = await getSources(env);
    const destinations = await getDestinations(env);
    const dest2 = await getSecondaryDestinations(env);
    const rubikaSrc = rubikaEnabled(env) ? await getRubikaSources(env) : [];
    const rubikaDest = rubikaEnabled(env) ? await getRubikaDestinations(env) : [];
    const rubikaDest2 = rubikaEnabled(env) ? await getRubikaSecondaryDestinations(env) : [];
    const reviewer = await getReviewerChatId(env);
    let text = `📊 آمار:\nپست‌های منتشرشده: ${total}\nآخرین بررسی: ${lastRun}\nکانال‌های مبدا (تلگرام): ${sources.length}\nمقصد تلگرام: ${destinations.length}\nکانال دوم تلگرام: ${dest2.length}\nمشاور تایید: ${reviewer ? `فعال (${reviewer})` : "غیرفعال"}`;
    if (rubikaEnabled(env)) {
      text += `\nمبدا روبیکا: ${rubikaSrc.length}\nمقصد روبیکا: ${rubikaDest.length}\nکانال دوم روبیکا: ${rubikaDest2.length}`;
    }
    await tg(env, "sendMessage", { chat_id: chatId, text });
    return;
  }
}

// ------------------------------------------------------------
// Update router
// ------------------------------------------------------------
async function handleUpdate(env, update) {
  const adminIds = getAdminIds(env);

  if (update.message) {
    const fromId = update.message.from?.id;
    if (adminIds.includes(fromId)) {
      await handleAdminMessage(env, update.message);
    }
    return;
  }
  if (update.callback_query) {
    const fromId = update.callback_query.from?.id;
    if (adminIds.includes(fromId)) {
      await handleCallback(env, update.callback_query);
    }
    return;
  }
}

// ------------------------------------------------------------
// Rubika webhook: register any chat_id we see so the admin can
// pick it from "چت‌های شناسایی‌شده" without needing to hunt for
// the GUID manually. Also: if the update comes from a configured
// Rubika SOURCE channel, clean it and repost it everywhere.
// ------------------------------------------------------------
function findChatId(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.chat_id === "string") return obj.chat_id;
  for (const key of Object.keys(obj)) {
    const found = findChatId(obj[key]);
    if (found) return found;
  }
  return null;
}

function extractField(obj, fieldName) {
  if (!obj || typeof obj !== "object") return null;
  if (fieldName in obj) return obj[fieldName];
  for (const key of Object.keys(obj)) {
    const found = extractField(obj[key], fieldName);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}

async function processRubikaSourceMessage(env, chatId, body) {
  const newMessage =
    body?.update?.new_message || extractField(body, "new_message") || {};
  const messageId =
    newMessage.message_id || extractField(body, "message_id") || null;

  if (messageId) {
    const seenKey = `seen_rb:${chatId}:${messageId}`;
    const already = await env.BOT_KV.get(seenKey);
    if (already) return; // duplicate delivery from Rubika, skip
    await env.BOT_KV.put(seenKey, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  }

  const rawText = newMessage.text || extractField(body, "text") || "";
  const cleaned = stripPlainText(rawText);

  const fileInline = newMessage.file_inline || extractField(body, "file_inline");
  const fileId = fileInline?.file_id || extractField(body, "file_id") || null;
  const rubikaMediaType = fileInline?.type || null; // "Image" | "Video" | "Gif" | "Music" | "Voice" | "File"
  const hasMedia = Boolean(fileId || extractField(body, "sticker"));

  if (!cleaned && !hasMedia) return; // nothing usable (e.g. a reaction/edit event)

  const filterKeywords = await getFilterKeywords(env);
  const filterResult = applyFilters(cleaned, filterKeywords);
  if (filterResult.blocked) return;
  const filteredCleaned = filterResult.text;

  const paused = (await env.BOT_KV.get("paused")) === "1";
  const testMode = (await env.BOT_KV.get("test_mode")) === "1";
  if (paused) return;

  const reviewerChatId = await getReviewerChatId(env);

  if (reviewerChatId) {
    if (fileId) {
      await queueForReview(env, {
        kind: "rubika_file",
        text: filteredCleaned,
        rubikaFileId: fileId,
        rubikaMediaType,
      });
    } else {
      await queueForReview(env, { kind: "scraped", text: filteredCleaned, photoUrl: null, hasVideo: false });
    }
    const total = parseInt((await env.BOT_KV.get("stats_total")) || "0", 10);
    await env.BOT_KV.put("stats_total", String(total + 1));
    await env.BOT_KV.put("stats_last_run", new Date().toISOString());
    return;
  }

  const signature = await getSignature(env);
  const adminIds = getAdminIds(env);
  const destinations = testMode ? [] : await getDestinations(env);
  const telegramTargets = testMode
    ? adminIds.map((id) => ({ id }))
    : destinations;
  const rubikaDestinations = await getRubikaDestinations(env);
  // never echo a source channel's own post back into itself if it's also listed as a destination
  const rubikaTargets = testMode
    ? []
    : rubikaDestinations.filter((d) => d.chat_id !== chatId);

  const finalText = [filteredCleaned, signature].filter(Boolean).join("\n\n");

  // Try to actually fetch the media so it can be re-hosted with full fidelity.
  let blob = null;
  if (fileId) {
    blob = await rubikaDownloadFile(env, fileId);
  }

  if (blob) {
    const { method, field } = telegramMediaMethodFor(rubikaMediaType);
    for (const chat of telegramTargets) {
      const chatIdTg = chat.username ? `@${chat.username}` : chat.id;
      try {
        if (finalText.length <= 900) {
          await tgSendMediaBlob(env, chatIdTg, method, field, blob, "file", finalText);
        } else {
          await tgSendMediaBlob(env, chatIdTg, method, field, blob, "file");
          await tg(env, "sendMessage", { chat_id: chatIdTg, text: finalText });
        }
      } catch (e) {
        // one bad destination shouldn't block the others
      }
    }
    for (const chat of rubikaTargets) {
      await rubikaSendBlob(env, chat.chat_id, blob, rubikaMediaType, finalText, "file");
    }
  } else {
    // no media, or the download couldn't be verified against live docs — send text,
    // flagging it only if we know a file was actually attached and dropped.
    // deliverMessage appends the signature itself, so pass the un-signed text here.
    const msgNoSig = {
      text: hasMedia
        ? `${filteredCleaned}\n\n(⚠️ این پیام فایل داشت که دانلود/بازنشرش موفق نشد)`
        : filteredCleaned,
      photoUrl: null,
      hasVideo: false,
    };
    await deliverMessage(env, msgNoSig, signature, telegramTargets, rubikaTargets);
  }

  const total = parseInt((await env.BOT_KV.get("stats_total")) || "0", 10);
  await env.BOT_KV.put("stats_total", String(total + 1));
  await env.BOT_KV.put("stats_last_run", new Date().toISOString());
}

async function handleRubikaUpdate(env, body) {
  const chatId = findChatId(body);
  if (!chatId) return;

  const sources = await getRubikaSources(env);
  if (sources.find((s) => s.chat_id === chatId)) {
    await processRubikaSourceMessage(env, chatId, body);
  }

  const discovered = await getRubikaDiscovered(env);
  if (!discovered.find((d) => d.chat_id === chatId)) {
    discovered.push({ chat_id: chatId, seen_at: new Date().toISOString() });
    // keep the list from growing forever
    await setJSON(env, "rubika_discovered", discovered.slice(-100));
  }
}

// ------------------------------------------------------------
// Worker entry points
// ------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      url.pathname === `/webhook/${env.WEBHOOK_SECRET}`
    ) {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(env, update));
      return new Response("OK");
    }

    if (
      request.method === "POST" &&
      url.pathname === `/rubika-webhook/${env.WEBHOOK_SECRET}`
    ) {
      const body = await request.json();
      ctx.waitUntil(handleRubikaUpdate(env, body));
      return new Response("OK");
    }

    if (url.pathname === "/setup") {
      const webhookUrl = `${url.origin}/webhook/${env.WEBHOOK_SECRET}`;
      const res = await tg(env, "setWebhook", { url: webhookUrl });
      return new Response(JSON.stringify(res, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/rubika-setup") {
      if (!rubikaEnabled(env)) {
        return new Response("RUBIKA_TOKEN not set", { status: 400 });
      }
      const endpointUrl = `${url.origin}/rubika-webhook/${env.WEBHOOK_SECRET}`;
      const r1 = await rb(env, "updateBotEndpoint", {
        url: endpointUrl,
        type: "ReceiveUpdate",
      });
      const r2 = await rb(env, "updateBotEndpoint", {
        url: endpointUrl,
        type: "ReceiveInlineMessage",
      });
      return new Response(JSON.stringify({ r1, r2 }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/poll-now") {
      // manual trigger for testing
      await pollSources(env);
      return new Response("polled");
    }

    return new Response("repost-bot is running", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollSources(env));
  },
};
