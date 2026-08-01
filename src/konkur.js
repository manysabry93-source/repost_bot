// ============================================================
// قابلیت «محتوای کنکوری»: جستجو (Serper) + تولید متن (Groq) +
// عکس (Serper Image یا Workers AI) + PDF + استیکر + پایش سایت‌ها
// این ماژول با تزریق وابستگی (deps) کار می‌کند تا نیازی به
// import چرخه‌ای از index.js نداشته باشد.
// ============================================================

const KONKUR_CATEGORIES = [
  "کنکور",
  "دروس مدرسه",
  "روش مطالعه",
  "تست‌زنی",
  "انگیزشی",
  "مشاوره تحصیلی",
];

async function getJSON(env, key, fallback) {
  const raw = await env.BOT_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
async function setJSON(env, key, value) {
  await env.BOT_KV.put(key, JSON.stringify(value));
}

// ---------------- Settings ----------------
async function getKonkurSettings(env) {
  return getJSON(env, "konkur_settings", {
    enabled: false,
    intervalHours: 3,
    activeStart: 8, // به وقت تهران
    activeEnd: 23,
    lastAutoAt: null,
    categoryIdx: 0,
  });
}
async function setKonkurSettings(env, settings) {
  await setJSON(env, "konkur_settings", settings);
}

async function getKonkurStickers(env) {
  return getJSON(env, "konkur_stickers", {});
}
async function setKonkurStickers(env, map) {
  await setJSON(env, "konkur_stickers", map);
}

async function getKonkurSites(env) {
  return getJSON(env, "konkur_sites", []);
}
async function setKonkurSites(env, list) {
  await setJSON(env, "konkur_sites", list);
}

async function getKonkurStats(env) {
  return getJSON(env, "konkur_stats", { approved: {}, rejected: {}, byCategory: {} });
}
async function bumpKonkurStat(env, field, category) {
  const stats = await getKonkurStats(env);
  const today = new Date().toISOString().slice(0, 10);
  stats[field][today] = (stats[field][today] || 0) + 1;
  if (field === "approved" && category) {
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
  }
  await setJSON(env, "konkur_stats", stats);
}

// ---------------- Serper search quota (free plan ~2500 credits, one-time) ----------------
async function konkurCheckQuota(env, deps) {
  const raw = (await env.BOT_KV.get("konkur_search_used")) || "0";
  const used = parseInt(raw, 10);
  const WARN_AT = 2400;
  if (used >= WARN_AT) {
    const adminIds = deps.getAdminIds(env);
    for (const id of adminIds) {
      await deps.tg(env, "sendMessage", {
        chat_id: id,
        text: `⚠️ سهمیه‌ی جستجوی Serper تقریباً تمام شده (${used} درخواست استفاده شده). تا تهیه‌ی کلید جدید، تولید محتوای کنکوری متوقف می‌شود.`,
      });
    }
    return false;
  }
  await env.BOT_KV.put("konkur_search_used", String(used + 1));
  return true;
}

async function serperSearchText(env, deps, query) {
  if (!env.SERPER_KEY) return [];
  const ok = await konkurCheckQuota(env, deps);
  if (!ok) return null; // quota exceeded
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": env.SERPER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl: "ir", hl: "fa" }),
    });
    const data = await res.json();
    if (Array.isArray(data.organic)) {
      return data.organic.slice(0, 5).map((r) => ({ title: r.title || "", snippet: r.snippet || "" }));
    }
  } catch (e) {}
  return [];
}

async function serperSearchImage(env, query) {
  if (!env.SERPER_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": env.SERPER_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl: "ir", hl: "fa" }),
    });
    const data = await res.json();
    if (Array.isArray(data.images)) {
      for (const img of data.images.slice(0, 8)) {
        if (img.imageUrl) return img.imageUrl;
      }
    }
  } catch (e) {}
  return null;
}

// ---------------- Groq text generation ----------------
async function groqGenerate(env, topic, category, template, snippets) {
  if (!env.GROQ_API_KEY) return null;
  const context = (snippets || []).map((s) => `- ${s.title}: ${s.snippet}`).join("\n");
  const templateInstruction =
    template === "story"
      ? "به‌صورت یک داستان کوتاه انگیزشی و کاربردی بنویس."
      : template === "qa"
      ? "به‌صورت یک سوال رایج دانش‌آموزان و پاسخ کوتاه و کاربردی بنویس."
      : "به‌صورت ۳ تا ۵ نکته‌ی کوتاه و کاربردی (هرکدام یک خط) بنویس.";
  const prompt = `تو دستیار تولید محتوای آموزشی برای یک کانال مشاوره‌ی کنکور هستی.
موضوع: ${topic}
دسته: ${category}
${templateInstruction}
قوانین:
- فقط فارسی بنویس.
- کوتاه و خلاصه باش (حداکثر حدود ۶۰۰ کاراکتر)، خسته‌کننده نباشد.
- هیچ لینک، آدرس اینترنتی یا @یوزرنیم داخل متن نیاور.
- از این خلاصه‌های جستجو فقط برای الهام‌گرفتن استفاده کن (عیناً کپی نکن):
${context || "(نتیجه‌ای پیدا نشد؛ از دانش عمومی درباره‌ی موضوع استفاده کن)"}
فقط خودِ متن نهایی را بنویس، بدون مقدمه یا توضیح اضافه.`;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
        max_tokens: 500,
      }),
    });
    const data = await res.json();
    let out = data.choices?.[0]?.message?.content?.trim();
    if (!out) return null;
    out = out.replace(/https?:\/\/\S+/g, "").replace(/www\.\S+/g, "").trim();
    return out;
  } catch (e) {
    return null;
  }
}

// ---------------- Workers AI image (fallback) ----------------
async function workersAIImage(env, prompt) {
  if (!env.AI) return null;
  try {
    const result = await env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt });
    if (result instanceof ReadableStream) {
      const buf = await new Response(result).arrayBuffer();
      return new Uint8Array(buf);
    }
    if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
      return result instanceof Uint8Array ? result : new Uint8Array(result);
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ---------------- PDF generation (best effort — see README caveat) ----------------
let cachedFontBytes = null;
async function getPersianFontBytes() {
  if (cachedFontBytes) return cachedFontBytes;
  try {
    const res = await fetch(
      "https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/ttf/Vazirmatn-Regular.ttf"
    );
    if (!res.ok) return null;
    cachedFontBytes = new Uint8Array(await res.arrayBuffer());
    return cachedFontBytes;
  } catch (e) {
    return null;
  }
}

// pdf-lib does NOT do Arabic/Persian contextual shaping or bidi reordering.
// This is a best-effort approximation (line-reversal for RTL reading order).
// Letters render in isolated form rather than properly joined — تا وقتی
// یه راه بهتر (مثل رندر به عکس) لازم نشه، همین نسخه‌ی ساده رو داریم.
function reshapeForPdf(text) {
  return text
    .split("\n")
    .map((line) => line.split("").reverse().join(""))
    .join("\n");
}

function wrapText(text, font, fontSize, maxWidth) {
  const paragraphs = text.split("\n");
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(" ");
    let current = "";
    for (const w of words) {
      const test = current ? `${current} ${w}` : w;
      if (font.widthOfTextAtSize(test, fontSize) > maxWidth && current) {
        lines.push(current);
        current = w;
      } else {
        current = test;
      }
    }
    lines.push(current);
  }
  return lines;
}

async function buildKonkurPdf(topic, text, sourceName) {
  try {
    const { PDFDocument, rgb } = await import("pdf-lib");
    const fontkitMod = await import("@pdf-lib/fontkit");
    const fontkit = fontkitMod.default || fontkitMod;
    const fontBytes = await getPersianFontBytes();
    if (!fontBytes) return null;

    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const font = await pdfDoc.embedFont(fontBytes);
    const pageWidth = 595;
    const pageHeight = 842;
    const margin = 50;
    const maxWidth = pageWidth - margin * 2;
    const fontSize = 15;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    const fullText = `${topic}\n\n${text}${sourceName ? `\n\nمنبع: ${sourceName}` : ""}`;
    const lines = wrapText(fullText, font, fontSize, maxWidth);
    let y = pageHeight - margin;
    for (const line of lines) {
      const shaped = reshapeForPdf(line);
      const width = font.widthOfTextAtSize(shaped, fontSize);
      page.drawText(shaped, {
        x: pageWidth - margin - width,
        y,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
      y -= fontSize + 8;
      if (y < margin) break; // best-effort: single page for now
    }
    return await pdfDoc.save();
  } catch (e) {
    return null;
  }
}

// ---------------- Orchestrator ----------------
// deps: { getFilterKeywords, applyFilters, getSignature, tg, getAdminIds }
async function buildKonkurContent(env, deps, topic, category) {
  const templates = ["tips", "story", "qa"];
  const template = templates[Math.floor(Math.random() * templates.length)];

  const snippets = await serperSearchText(env, deps, `${topic} کنکور`);
  if (snippets === null) return null; // quota exceeded, admin already notified

  let text = await groqGenerate(env, topic, category, template, snippets);
  if (!text) {
    text = `نکته‌ای درباره‌ی «${topic}» فعلاً آماده نشد؛ بعداً دوباره امتحان کن.`;
  }

  const filterList = await deps.getFilterKeywords(env);
  const filterResult = deps.applyFilters(text, filterList);
  if (filterResult.blocked) return null;
  text = filterResult.text;

  let imageUrl = await serperSearchImage(env, topic);
  let aiImageBytes = null;
  if (!imageUrl) {
    aiImageBytes = await workersAIImage(env, `${topic}, flat educational illustration, no text`);
  }

  const stickers = await getKonkurStickers(env);
  const stickerList = stickers[category] || [];
  const stickerFileId = stickerList.length
    ? stickerList[Math.floor(Math.random() * stickerList.length)]
    : null;

  const pdfBytes = await buildKonkurPdf(topic, text, "جستجوی اینترنتی");

  return {
    kind: "konkur",
    topic,
    category,
    text,
    imageUrl: imageUrl || null,
    aiImageBase64: aiImageBytes ? bytesToBase64(aiImageBytes) : null,
    stickerFileId: stickerFileId || null,
    pdfBase64: pdfBytes ? bytesToBase64(pdfBytes) : null,
  };
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------- Automatic mode (self-throttling, called every cron tick) ----------------
function tehranHour(date) {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const localMinutes = (utcMinutes + 210) % 1440; // UTC+3:30
  return localMinutes / 60;
}

// deps: { getFilterKeywords, applyFilters, getSignature, tg, getAdminIds, queueForReview }
async function konkurTick(env, deps) {
  const settings = await getKonkurSettings(env);
  if (!settings.enabled) return;

  const now = new Date();
  const hour = tehranHour(now);
  const { activeStart, activeEnd } = settings;
  const inActiveWindow =
    activeStart <= activeEnd ? hour >= activeStart && hour < activeEnd : hour >= activeStart || hour < activeEnd;
  if (!inActiveWindow) return;

  const last = settings.lastAutoAt ? new Date(settings.lastAutoAt) : null;
  const dueMs = settings.intervalHours * 60 * 60 * 1000;
  if (last && now - last < dueMs) return;

  const category = KONKUR_CATEGORIES[settings.categoryIdx % KONKUR_CATEGORIES.length];
  settings.lastAutoAt = now.toISOString();
  settings.categoryIdx = (settings.categoryIdx + 1) % KONKUR_CATEGORIES.length;
  await setKonkurSettings(env, settings);

  const content = await buildKonkurContent(env, deps, category, category);
  if (!content) return;
  await deps.queueForReview(env, content);
}

// ---------------- Source-site "new content" watcher (best effort) ----------------
// deps: { tg, getAdminIds }
async function konkurCheckSites(env, deps) {
  const sites = await getKonkurSites(env);
  if (!sites.length) return;
  let changed = false;
  for (const site of sites) {
    try {
      const res = await fetch(site.url);
      const html = await res.text();
      const sample = html.replace(/\s+/g, " ").slice(0, 500);
      let hash = 0;
      for (let i = 0; i < sample.length; i++) hash = (hash * 31 + sample.charCodeAt(i)) | 0;
      const hashStr = String(hash);
      if (site.lastHash && site.lastHash !== hashStr) {
        const adminIds = deps.getAdminIds(env);
        for (const id of adminIds) {
          await deps.tg(env, "sendMessage", {
            chat_id: id,
            text: `🔔 به‌نظر می‌رسد این سایت محتوای جدید دارد:\n${site.url}`,
          });
        }
      }
      site.lastHash = hashStr;
      changed = true;
    } catch (e) {}
  }
  if (changed) await setKonkurSites(env, sites);
}

export {
  KONKUR_CATEGORIES,
  getKonkurSettings,
  setKonkurSettings,
  getKonkurStickers,
  setKonkurStickers,
  getKonkurSites,
  setKonkurSites,
  getKonkurStats,
  bumpKonkurStat,
  buildKonkurContent,
  konkurTick,
  konkurCheckSites,
};
