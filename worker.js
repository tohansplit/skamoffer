const API = "https://api.telegram.org/bot";

async function tg(env, method, payload = {}) {
  const response = await fetch(API + env.BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8" }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

async function handleUpdate(update, env) {
  if (update.business_connection) {
    const connection = update.business_connection;
    const userId = connection.user?.id;
    if (userId) {
      await env.MARKET_KV.put("business:" + userId, JSON.stringify({
        id: connection.id,
        user_chat_id: connection.user_chat_id,
        is_enabled: connection.is_enabled,
        rights: connection.rights || {}
      }));
    }
  }

  if (update.callback_query) {
    const query = update.callback_query;
    const match = /^sell:([A-Za-z0-9_-]+)$/.exec(query.data || "");
    if (!match) return;
    const offerId = match[1];
    const raw = await env.MARKET_KV.get("offer:" + offerId);
    if (!raw) {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Оффер не найден", show_alert: true });
      return;
    }

    const offer = JSON.parse(raw);
    if (offer.status !== "pending") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Оффер уже обработан", show_alert: true });
      return;
    }

    const businessRaw = await env.MARKET_KV.get("business:" + offer.seller_user_id);
    if (!businessRaw) {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Аккаунт продавца не подключён", show_alert: true });
      return;
    }
    const business = JSON.parse(businessRaw);
    if (!business.is_enabled || !business.rights.can_transfer_and_upgrade_gifts) {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Передача подарков не разрешена", show_alert: true });
      return;
    }

    try {
      const owned = await tg(env, "getBusinessAccountGifts", {
        business_connection_id: business.id,
        limit: 100
      });
      const gift = (owned.gifts || []).find(item =>
        item.type === "unique" && item.owned_gift_id === offer.owned_gift_id
      );
      if (!gift || !gift.can_be_transferred) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Подарок сейчас нельзя передать", show_alert: true });
        return;
      }
      if (gift.next_transfer_date && gift.next_transfer_date > Math.floor(Date.now() / 1000)) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Для подарка ещё действует ограничение на передачу", show_alert: true });
        return;
      }
      if ((gift.transfer_star_count || 0) > 0) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Для передачи требуются Telegram Stars. Операция не выполнена.", show_alert: true });
        return;
      }

      await tg(env, "transferGift", {
        business_connection_id: business.id,
        owned_gift_id: offer.owned_gift_id,
        new_owner_chat_id: Number(env.OWNER_CHAT_ID),
        star_count: 0
      });

      offer.status = "transferred";
      offer.transferred_at = new Date().toISOString();
      await env.MARKET_KV.put("offer:" + offerId, JSON.stringify(offer));
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Подарок передан" });
      await tg(env, "editMessageReplyMarkup", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] }
      });
      await tg(env, "sendMessage", {
        chat_id: Number(env.OWNER_CHAT_ID),
        text: "Подарок получен: " + escapeHtml(offer.gift_title) + " · оффер " + offerId,
        parse_mode: "HTML"
      });
    } catch (error) {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Telegram не выполнил передачу. Подарок не отмечен как переданный.",
        show_alert: true
      });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "gift-market-backend" });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const update = await request.json();
      try {
        await handleUpdate(update, env);
      } catch (error) {
        return json({ ok: false }, 500);
      }
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/admin/offers") {
      if (request.headers.get("Authorization") !== "Bearer " + env.ADMIN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = await request.json();
      const sellerId = Number(body.seller_user_id);
      const giftId = String(body.owned_gift_id || "");
      const title = String(body.gift_title || "").slice(0, 100);
      const price = String(body.price || "").slice(0, 40);
      if (!Number.isSafeInteger(sellerId) || sellerId <= 0 || !giftId || !title || !price) {
        return json({ ok: false, error: "seller_user_id, owned_gift_id, gift_title and price are required" }, 400);
      }
      const businessRaw = await env.MARKET_KV.get("business:" + sellerId);
      if (!businessRaw) return json({ ok: false, error: "Seller has not connected a Business account" }, 409);
      const business = JSON.parse(businessRaw);
      if (!business.is_enabled || !business.rights.can_transfer_and_upgrade_gifts) {
        return json({ ok: false, error: "Gift transfer permission is not enabled" }, 409);
      }
      const owned = await tg(env, "getBusinessAccountGifts", {
        business_connection_id: business.id,
        limit: 100
      });
      const gift = (owned.gifts || []).find(item => item.type === "unique" && item.owned_gift_id === giftId);
      if (!gift) return json({ ok: false, error: "Unique gift not found in seller account" }, 404);

      const offerId = crypto.randomUUID().replace(/-/g, "");
      const offer = {
        id: offerId, seller_user_id: sellerId, owned_gift_id: giftId,
        gift_title: title, price, status: "pending", created_at: new Date().toISOString()
      };
      await env.MARKET_KV.put("offer:" + offerId, JSON.stringify(offer), { expirationTtl: 60 * 60 * 24 * 14 });
      await tg(env, "sendMessage", {
        chat_id: sellerId,
        text: "<b>Предложение о покупке</b>\n" + escapeHtml(title) + "\nЦена: " + escapeHtml(price),
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Продать", callback_data: "sell:" + offerId }]] }
      });
      return json({ ok: true, offer_id: offerId });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};
