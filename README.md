# Skamoffer — Telegram gift offer backend

This repository contains the Telegram Mini App demo and a Cloudflare Worker backend scaffold for gift offers.

## Important Telegram requirements

Real transfer of an existing collectible gift is only possible when the seller has connected a Telegram Business account to the bot and granted `can_transfer_and_upgrade_gifts`. The Bot API `transferGift` method operates on gifts owned by that connected business account. It does not let a bot take a gift from an arbitrary user or from a username alone.

The buyer/recipient must have opened the bot recently (Telegram requires the destination chat to have been active in the last 24 hours). The recipient account does not inherently need Telegram Premium. Some gifts require Stars for transfer; this Worker intentionally does not spend Stars and will not claim a transfer succeeded when Telegram rejects it.

The offer UI contains only the gift, the proposed price, and the **Продать** button. It does not process or promise a payment.

## Backend deployment (Cloudflare Workers)

1. Create a Cloudflare account and a KV namespace.
2. Replace the placeholder KV namespace ID in `wrangler.toml`.
3. Install Wrangler locally and run `npx wrangler secret put BOT_TOKEN`, `npx wrangler secret put WEBHOOK_SECRET`, `npx wrangler secret put ADMIN_SECRET`, and `npx wrangler secret put OWNER_CHAT_ID`. Never put the bot token in this repository or send it in chat.
4. Deploy with `npx wrangler deploy`.
5. Set the Telegram webhook to `https://YOUR-WORKER.workers.dev/webhook` with `secret_token=YOUR_WEBHOOK_SECRET` and allowed updates including `business_connection` and `callback_query`. Use Telegram's official `setWebhook` method.
6. The bot owner must open the bot once so Telegram can deliver messages to the owner account.

## Creating an offer

The protected endpoint is `POST /admin/offers`. Send an Authorization header with the ADMIN_SECRET and JSON:

```json
{
  "seller_user_id": 123456789,
  "owned_gift_id": "telegram-owned-gift-id",
  "gift_title": "Collectible gift",
  "price": "100 EUR"
}
```

The seller must already have started the bot and connected their Telegram Business account with gift-transfer permission. The endpoint checks that the unique gift is actually present in that seller's connected account before sending the offer.

## Security and limitations

- Keep all secrets in Cloudflare Worker secrets.
- The admin endpoint is intended for a private operator tool; do not expose ADMIN_SECRET in the Mini App.
- This Worker transfers only unique gifts that Telegram reports as transferable for free. It does not pay transfer Stars, make bank payments, or handle seller payouts.
- Offers are stored in Cloudflare KV and expire after 14 days.
- The current static Mini App is still a front-end demo. The Worker is a backend foundation and must be deployed/configured before live use.
