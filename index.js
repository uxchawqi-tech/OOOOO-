
require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();

// ================= الإعدادات =================

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL = process.env.API_URL || "https://bot.tota.click/api/v2";
const API_KEY = process.env.API_KEY;
const OWNER_ID = String(process.env.OWNER_ID || "");
const POINTS_PER_USD = Number(process.env.POINTS_PER_USD || 1000);

if (!BOT_TOKEN || !API_KEY || !OWNER_ID) {
  throw new Error("يرجى ضبط BOT_TOKEN و API_KEY و OWNER_ID في إعدادات البيئة");
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new sqlite3.Database("./database.sqlite");

const states = new Map();
let servicesCache = [];
let cacheTime = 0;

// ================= قاعدة البيانات =================

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    points INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    provider_id TEXT,
    service_name TEXT,
    quantity INTEGER,
    points INTEGER,
    link TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY,
    points INTEGER,
    uses INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY
  )`);

  db.run("INSERT OR IGNORE INTO admins (id) VALUES (?)", [OWNER_ID]);
});

const get = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.get(sql, params, (e, r) => e ? reject(e) : resolve(r))
  );

const all = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (e, r) => e ? reject(e) : resolve(r))
  );

const run = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (e) {
      e ? reject(e) : resolve(this);
    })
  );

async function isAdmin(id) {
  return !!(await get("SELECT id FROM admins WHERE id=?", [String(id)]));
}

async function ensureUser(id) {
  await run("INSERT OR IGNORE INTO users (id, points) VALUES (?,0)", [String(id)]);
}

// ================= الاتصال بـ API =================

async function api(action, params = {}) {
  const body = new URLSearchParams({
    key: API_KEY,
    action,
    ...params
  });

  const response = await axios.post(API_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000
  });

  return response.data;
}

async function getServices(force = false) {
  if (!force && servicesCache.length && Date.now() - cacheTime < 60000) {
    return servicesCache;
  }

  const data = await api("services");

  if (!Array.isArray(data)) {
    throw new Error("تعذر قراءة قائمة الخدمات من API");
  }

  servicesCache = data;
  cacheTime = Date.now();

  return servicesCache;
}

function serviceId(s) {
  return String(s.service || s.id);
}

function serviceName(s) {
  return s.name || "خدمة بدون اسم";
}

function serviceCategory(s) {
  return s.category || "خدمات أخرى";
}

function serviceRate(s) {
  return Number(s.rate || s.price || 0);
}

function calculatePoints(service, quantity) {
  return Math.ceil(serviceRate(service) * quantity / 1000 * POINTS_PER_USD);
}

// ================= القوائم =================

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🛍 طلب الخدمات", callback_data: "services" },
        { text: "💰 رصيدي", callback_data: "balance" }
      ],
      [
        { text: "📦 طلباتي", callback_data: "orders" },
        { text: "🎁 استبدال كود", callback_data: "redeem" }
      ],
      [
        { text: "🔄 تحديث الخدمات", callback_data: "refresh" },
        { text: "ℹ️ معلومات البوت", callback_data: "info" }
      ]
    ]
  };
}

async function showCategories(chatId) {
  const services = await getServices();
  const categories = [...new Set(services.map(serviceCategory))];

  const keyboard = categories.map((category, i) => [{
    text: category,
    callback_data: `cat_${i}`
  }]);

  await bot.sendMessage(chatId, "📂 اختر القسم الذي تريد:", {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showCategory(chatId, index) {
  const services = await getServices();
  const categories = [...new Set(services.map(serviceCategory))];
  const category = categories[index];

  if (!category) return bot.sendMessage(chatId, "القسم غير موجود.");

  const list = services.filter(s => serviceCategory(s) === category).slice(0, 50);

  const keyboard = list.map(s => [{
    text: `${serviceName(s)} | ${serviceRate(s)}$ / 1000`,
    callback_data: `svc_${serviceId(s)}`
  }]);

  keyboard.push([{ text: "🔙 القائمة الرئيسية", callback_data: "home" }]);

  await bot.sendMessage(chatId, `📂 ${category}\n\nاختر الخدمة:`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ================= بدء البوت =================

bot.onText(/\/start/, async msg => {
  const id = String(msg.from.id);
  await ensureUser(id);

  await bot.sendMessage(
    msg.chat.id,
    "🏆 أهلاً بك في رشـق ARSLE'N 🔖\n\nاختر الخدمة التي تريدها من القائمة:",
    { reply_markup: mainKeyboard() }
  );
});

// ================= الأزرار =================

bot.on("callback_query", async query => {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const data = query.data;

  await bot.answerCallbackQuery(query.id);
  await ensureUser(userId);

  try {
    if (data === "home") {
      states.delete(userId);
      return bot.sendMessage(chatId, "🏆 القائمة الرئيسية:", {
        reply_markup: mainKeyboard()
      });
    }

    if (data === "services") return showCategories(chatId);

    if (data === "refresh") {
      await getServices(true);
      return bot.sendMessage(chatId, "✅ تم تحديث قائمة الخدمات والأسعار.");
    }

    if (data === "balance") {
      const user = await get("SELECT points FROM users WHERE id=?", [userId]);
      return bot.sendMessage(chatId, `💰 رصيدك الحالي: ${user.points} نقطة`);
    }

    if (data === "info") {
      return bot.sendMessage(chatId,
        "🏆 رشـق ARSLE'N 🔖\nخدمات متعددة بأسعار تتحدث تلقائياً.\nللدعم تواصل مع الإدارة."
      );
    }

    if (data === "orders") {
      const orders = await all(
        "SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 10",
        [userId]
      );

      if (!orders.length) return bot.sendMessage(chatId, "ليس لديك طلبات بعد.");

      for (const o of orders) {
        let status = "غير معروف";
        try {
          const result = await api("status", { order: o.provider_id });
          status = result.status || JSON.stringify(result);
        } catch {}

        await bot.sendMessage(chatId,
          `📦 الطلب: ${o.provider_id}\n` +
          `الخدمة: ${o.service_name}\n` +
          `الكمية: ${o.quantity}\n` +
          `الحالة: ${status}`
        );
      }
      return;
    }

    if (data === "redeem") {
      states.set(userId, { step: "redeem" });
      return bot.sendMessage(chatId, "🎁 أرسل كود النقاط الآن:");
    }

    if (data.startsWith("cat_")) {
      return showCategory(chatId, Number(data.split("_")[1]));
    }

    if (data.startsWith("svc_")) {
      const id = data.substring(4);
      const services = await getServices();
      const service = services.find(s => serviceId(s) === id);

      if (!service) return bot.sendMessage(chatId, "الخدمة غير موجودة.");

      states.set(userId, { step: "link", service });

      return bot.sendMessage(chatId,
        `🛍 ${serviceName(service)}\n` +
        `💵 السعر: ${serviceRate(service)} دولار لكل 1000\n` +
        `📉 أقل كمية: ${service.min || "غير محدد"}\n` +
        `📈 أكبر كمية: ${service.max || "غير محدد"}\n\n` +
        "📮 أرسل الرابط المطلوب:"
      );
    }

  } catch (error) {
    console.error(error.message);
    bot.sendMessage(chatId, "⚠️ حدث خطأ. حاول مرة أخرى.");
  }
});

// ================= استقبال الرسائل =================

bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const state = states.get(userId);

  if (!state) return;

  try {
    if (state.step === "redeem") {
      const code = msg.text.trim().toUpperCase();
      const item = await get("SELECT * FROM codes WHERE code=?", [code]);

      if (!item || item.uses <= 0) {
        states.delete(userId);
        return bot.sendMessage(chatId, "❌ الكود غير صحيح أو انتهى استخدامه.");
      }

      await run("UPDATE users SET points=points+? WHERE id=?", [item.points, userId]);
      await run("UPDATE codes SET uses=uses-1 WHERE code=?", [code]);

      states.delete(userId);
      return bot.sendMessage(chatId, `✅ تم إضافة ${item.points} نقطة إلى رصيدك.`);
    }

    if (state.step === "link") {
      state.link = msg.text.trim();
      state.step = "quantity";

      return bot.sendMessage(chatId, "🔢 أرسل الكمية التي تريد طلبها:");
    }

    if (state.step === "quantity") {
      const quantity = Number(msg.text.trim());
      const service = state.service;

      if (!Number.isInteger(quantity) ||
          quantity < Number(service.min || 1) ||
          quantity > Number(service.max || 2147483647)) {
        return bot.sendMessage(chatId, "❌ الكمية غير صحيحة. أرسل كمية ضمن الحدود الموضحة.");
      }

      state.quantity = quantity;
      state.step = "confirm";

      const cost = calculatePoints(service, quantity);
      state.cost = cost;

      const user = await get("SELECT points FROM users WHERE id=?", [userId]);

      if (user.points < cost) {
        states.delete(userId);
        return bot.sendMessage(chatId,
          `❌ رصيدك غير كافٍ.\nالسعر: ${cost} نقطة\nرصيدك: ${user.points} نقطة`
        );
      }

      return bot.sendMessage(chatId,
        `📋 تأكيد الطلب\n\n` +
        `الخدمة: ${serviceName(service)}\n` +
        `الكمية: ${quantity}\n` +
        `السعر: ${cost} نقطة\n\n` +
        `هل تريد تنفيذ الطلب؟`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ تأكيد", callback_data: "confirm_order" },
              { text: "❌ إلغاء", callback_data: "cancel_order" }
            ]]
          }
        }
      );
    }

  } catch (error) {
    console.error(error.message);
    states.delete(userId);
    bot.sendMessage(chatId, "⚠️ حدث خطأ أثناء تنفيذ العملية.");
  }
});

// ================= تأكيد الطلب وإلغاؤه =================

bot.on("callback_query", async query => {
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;

  if (query.data === "cancel_order") {
    states.delete(userId);
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, "❌ تم إلغاء العملية.");
  }

  if (query.data !== "confirm_order") return;

  await bot.answerCallbackQuery(query.id);

  const state = states.get(userId);
  if (!state || state.step !== "confirm") {
    return bot.sendMessage(chatId, "لا يوجد طلب قيد التأكيد.");
  }

  try {
    const user = await get("SELECT points FROM users WHERE id=?", [userId]);

    if (user.points < state.cost) {
      states.delete(userId);
      return bot.sendMessage(chatId, "❌ رصيدك لم يعد كافياً.");
    }

    const result = await api("add", {
      service: serviceId(state.service),
      link: state.link,
      quantity: String(state.quantity)
    });

    if (!result.order) {
      states.delete(userId);
      return bot.sendMessage(chatId,
        "❌ لم يقبل المزوّد الطلب:\n" + JSON.stringify(result)
      );
    }

    await run("UPDATE users SET points=points-? WHERE id=?",
      [state.cost, userId]);

    await run(
      `INSERT INTO orders (user_id, provider_id, service_name, quantity, points, link)
       VALUES (?,?,?,?,?,?)`,
      [userId, String(result.order), serviceName(state.service),
       state.quantity, state.cost, state.link]
    );

    states.delete(userId);

    return bot.sendMessage(chatId,
      `✅ تم إرسال طلبك بنجاح!\n\n` +
      `🆔 رقم الطلب: ${result.order}\n` +
      `📦 الكمية: ${state.quantity}\n` +
      `💰 المخصوم: ${state.cost} نقطة`
    );

  } catch (error) {
    console.error(error.message);
    states.delete(userId);
    return bot.sendMessage(chatId, "⚠️ تعذر إرسال الطلب. لم يتم خصم نقاطك.");
  }
});

// ================= أوامر الإدارة =================

bot.onText(/\/addpoints (.+)/, async (msg, match) => {
  if (!(await isAdmin(msg.from.id))) return;

  const parts = match[1].trim().split(/\s+/);
  const userId = parts[0];
  const amount = Number(parts[1]);

  if (!userId || !Number.isInteger(amount) || amount <= 0) {
    return bot.sendMessage(msg.chat.id, "الاستخدام:\n/addpoints USER_ID AMOUNT");
  }

  await ensureUser(userId);
  await run("UPDATE users SET points=points+? WHERE id=?", [amount, userId]);

  bot.sendMessage(msg.chat.id, `✅ تمت إضافة ${amount} نقطة للمستخدم ${userId}.`);
  bot.sendMessage(userId, `🎁 تمت إضافة ${amount} نقطة إلى رصيدك.`).catch(() => {});
});

bot.onText(/\/createcode (.+)/, async (msg, match) => {
  if (!(await isAdmin(msg.from.id))) return;

  const parts = match[1].trim().split(/\s+/);
  const amount = Number(parts[0]);
  const uses = Number(parts[1] || 1);

  if (!Number.isInteger(amount) || amount <= 0 ||
      !Number.isInteger(uses) || uses <= 0) {
    return bot.sendMessage(msg.chat.id, "الاستخدام:\n/createcode POINTS USES");
  }

  const code = Math.random().toString(36).substring(2, 10).toUpperCase();

  await run("INSERT INTO codes (code, points, uses) VALUES (?,?,?)",
    [code, amount, uses]);

  bot.sendMessage(msg.chat.id,
    `🎁 تم إنشاء الكود!\n\nالكود: ${code}\nالنقاط: ${amount}\nعدد الاستخدامات: ${uses}`
  );
});

bot.onText(/\/delcode (.+)/, async (msg, match) => {
  if (!(await isAdmin(msg.from.id))) return;
  await run("DELETE FROM codes WHERE code=?", [match[1].trim().toUpperCase()]);
  bot.sendMessage(msg.chat.id, "🗑 تم حذف الكود.");
});

bot.onText(/\/addadmin (.+)/, async (msg, match) => {
  if (String(msg.from.id) !== OWNER_ID) return;

  const id = match[1].trim();
  await run("INSERT OR IGNORE INTO admins (id) VALUES (?)", [id]);

  bot.sendMessage(msg.chat.id, `✅ تمت إضافة المدير: ${id}`);
});

bot.onText(/\/admins/, async msg => {
  if (!(await isAdmin(msg.from.id))) return;

  const admins = await all("SELECT id FROM admins");
  bot.sendMessage(msg.chat.id,
    "👑 قائمة المديرين:\n" + admins.map(a => a.id).join("\n")
  );
});

bot.onText(/\/deladmin (.+)/, async (msg, match) => {
  if (String(msg.from.id) !== OWNER_ID) return;

  const id = match[1].trim();
  if (id === OWNER_ID) {
    return bot.sendMessage(msg.chat.id, "لا يمكن حذف المالك الأساسي.");
  }

  await run("DELETE FROM admins WHERE id=?", [id]);
  bot.sendMessage(msg.chat.id, "✅ تم حذف المدير.");
});

bot.on("polling_error", error => {
  console.error("Telegram polling error:", error.message);
});

console.log("ARSLE'N SMM Bot is running...");
