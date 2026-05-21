/**
 * iMali STK Push Server — Zambia Mobile Money
 * Supports MTN, Airtel, Zamtel via pawaPay through the iMali API.
 * Accepts all frontends (CORS open), returns human-readable messages.
 */

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const crypto  = require("crypto");

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT           = process.env.PORT || 3000;
const IMALI_API_KEY  = "pk_live_1a3ae122dfd5ba5d9aa4706d8152110ba8ea23f6";
const IMALI_BASE_URL = "https://app.imali.app/api/imali/v1";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// ─── In-memory receipt store (replace with a real DB in production) ───────────
const receipts = {};

// ─── Axios client for iMali ────────────────────────────────────────────────────

const imali = axios.create({
  baseURL: IMALI_BASE_URL,
  headers: {
    Authorization:  `Bearer ${IMALI_API_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin:         "*",
  methods:        ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Parse JSON — keep raw body on /webhook for signature verification
app.use((req, res, next) => {
  if (req.path === "/webhook") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      req.rawBody = raw;
      try { req.body = JSON.parse(raw); } catch { req.body = {}; }
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function friendlyStatus(status) {
  const map = {
    succeeded:             "✅ Payment successful! Your transaction has been confirmed.",
    processing:            "⏳ Payment is being processed. Please approve the prompt on your phone.",
    requires_action:       "📱 Please check your phone and approve the payment prompt.",
    requires_confirmation: "⏳ Payment is pending confirmation.",
    requires_payment_method: "⏳ Awaiting payment method confirmation.",
    canceled:              "❌ Payment was canceled. Please try again.",
    failed:                "❌ Payment failed. Please check your number or try again.",
  };
  return map[status] || `Payment status: ${status}.`;
}

function friendlyError(err) {
  if (!err) return "An unexpected error occurred. Please try again.";

  const msg =
    err?.response?.data?.error?.message ||
    err?.response?.data?.message        ||
    err?.message || "";

  if (/invalid.*phone|phone.*invalid/i.test(msg))
    return "❌ The phone number is invalid. Please use format 260XXXXXXXXX.";
  if (/insufficient/i.test(msg))
    return "❌ Insufficient funds. Please top up your mobile money wallet and try again.";
  if (/unauthorized|api.key|invalid.*key/i.test(msg))
    return "❌ API key rejected by iMali. Please check your IMALI_API_KEY.";
  if (/timeout/i.test(msg))
    return "⏱️ The request timed out. Check your phone for a payment prompt or try again.";
  if (/duplicate/i.test(msg))
    return "⚠️ A payment with this reference already exists. Please use a different reference.";
  if (msg) return `❌ ${msg}`;

  const code = err?.response?.status;
  if (code === 401) return "❌ API key rejected. Please update IMALI_API_KEY on your server.";
  if (code === 422) return "❌ Invalid payment details. Please check your inputs and try again.";
  if (code === 429) return "⚠️ Too many requests. Please wait a moment and try again.";
  if (code >= 500)  return "❌ iMali server is temporarily unavailable. Please try again shortly.";

  return "❌ Payment could not be initiated. Please try again.";
}

// ─── Phone helpers ────────────────────────────────────────────────────────────

function isValidZambianPhone(phone) {
  // Accepts 260XXXXXXXXX or +260XXXXXXXXX
  return /^(\+?260)[5679]\d{8}$/.test(phone.replace(/\s/g, ""));
}

function normalizePhone(phone) {
  // Always send with + prefix as shown in the spec: +260977000111
  const digits = phone.replace(/\s/g, "").replace(/^\+/, "");
  return `+${digits}`;
}

function detectProviderCode(phone) {
  // Returns pawaPay provider codes as used in the iMali spec
  const local = phone.replace(/\s/g, "").replace(/^\+?260/, "");
  if (/^96|^76|^56/.test(local)) return "MTN_MOMO_ZM";     // MTN Zambia: 096, 076, 056
  if (/^97|^77|^57/.test(local)) return "AIRTEL_MOMO_ZM";  // Airtel Zambia: 097, 077, 057
  if (/^95|^75|^55/.test(local)) return "ZAMTEL_MOMO_ZM";  // Zamtel: 095, 075, 055
  return undefined; // let iMali auto-detect
}

function providerLabel(code) {
  const map = {
    MTN_MOMO_ZM:    "MTN Zambia",
    AIRTEL_MOMO_ZM: "Airtel Zambia",
    ZAMTEL_MOMO_ZM: "Zamtel",
  };
  return map[code] || "Auto-detected";
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Pings our server AND the iMali API /ping endpoint.
 */
app.get("/health", async (req, res) => {
  try {
    await imali.get("/ping");
    res.json({ status: "ok", message: "iMali STK Push server is running and connected to iMali API." });
  } catch {
    res.json({ status: "ok", message: "iMali STK Push server is running. (iMali API ping failed — check API key or network.)" });
  }
});

/**
 * POST /initiate-payment
 *
 * Body:
 *   amount       {number}  Amount in ZMW major units (e.g. 50)
 *   phone        {string}  Customer phone: 260XXXXXXXXX or +260XXXXXXXXX
 *   name         {string}  Customer full name (required)
 *   email        {string}  Customer email (required by iMali API)
 *   reference    {string}  Your order/reference ID (optional)
 *   description  {string}  Payment purpose (optional)
 *   webhook_url  {string}  Callback URL for payment updates (optional)
 */
app.post("/initiate-payment", async (req, res) => {
  try {
    const { amount, phone, name, email, reference, description, webhook_url } = req.body;

    // ── Input validation ─────────────────────────────────────────────────────
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "❌ Please provide a valid amount greater than 0." });
    }
    if (!phone) {
      return res.status(400).json({ success: false, message: "❌ Phone number is required." });
    }
    if (!isValidZambianPhone(phone)) {
      return res.status(400).json({ success: false, message: "❌ Invalid Zambian phone number. Use format 260XXXXXXXXX (e.g. 260971234567)." });
    }
    if (!name || name.trim().length < 2) {
      return res.status(400).json({ success: false, message: "❌ Customer full name is required." });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "❌ A valid email address is required." });
    }

    const formattedPhone  = normalizePhone(phone);
    const providerCode    = detectProviderCode(phone);

    // ── Create payment intent ────────────────────────────────────────────────
    // Per spec: customer.name, customer.email, customer.phone are all required.
    const payload = {
      amount:   Number(amount),
      currency: "ZMW",
      method:   "momo",
      country:  "ZM",
      ...(providerCode && { provider: providerCode }),
      ...(description   && { purpose: description }),
      ...(webhook_url   && { webhook_url }),
      customer: {
        name:  name.trim(),
        email: email.trim(),
        phone: formattedPhone,
      },
      metadata: {
        ...(reference && { reference }),
        source: "stk-push-server",
      },
    };

    const intentRes = await imali.post("/payment_intents", payload);
    const intent    = intentRes.data;

    // Store receipt
    receipts[intent.id] = {
      id:           intent.id,
      amount:       Number(amount),
      currency:     "ZMW",
      phone:        formattedPhone,
      name:         name.trim(),
      email:        email.trim(),
      provider:     providerCode || "auto",
      status:       intent.status,
      reference:    reference || null,
      createdAt:    new Date().toISOString(),
    };

    return res.json({
      success: true,
      message: `📱 Payment prompt sent to ${formattedPhone}. Please approve the request on your phone.`,
      data: {
        payment_intent_id: intent.id,
        status:            intent.status,
        status_message:    friendlyStatus(intent.status),
        amount:            Number(amount),
        currency:          "ZMW",
        phone:             formattedPhone,
        provider:          providerLabel(providerCode),
        checkout_url:      intent.checkout_url || null,
      },
    });

  } catch (err) {
    console.error("STK push error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({
      success: false,
      message: friendlyError(err),
    });
  }
});

/**
 * POST /confirm-payment/:id
 * Manually confirm a payment intent.
 */
app.post("/confirm-payment/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const confirmRes = await imali.post(`/payment_intents/${id}/confirm`);
    const intent     = confirmRes.data;

    if (receipts[id]) {
      receipts[id].status      = intent.status;
      receipts[id].confirmedAt = new Date().toISOString();
    }

    return res.json({
      success: intent.status === "succeeded",
      message: friendlyStatus(intent.status),
      data: {
        payment_intent_id: intent.id,
        status:            intent.status,
        status_message:    friendlyStatus(intent.status),
        amount:            intent.amount,
        currency:          intent.currency,
      },
    });
  } catch (err) {
    console.error("Confirm error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({ success: false, message: friendlyError(err) });
  }
});

/**
 * GET /payment-status/:id
 * Check status of a payment intent — returns human-readable message.
 */
app.get("/payment-status/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const intentRes = await imali.get(`/payment_intents/${id}`);
    const intent    = intentRes.data;

    if (receipts[id]) receipts[id].status = intent.status;

    return res.json({
      success: intent.status === "succeeded",
      message: friendlyStatus(intent.status),
      data: {
        payment_intent_id: intent.id,
        status:            intent.status,
        status_message:    friendlyStatus(intent.status),
        amount:            intent.amount,
        currency:          intent.currency,
        livemode:          intent.livemode,
        receipt:           receipts[id] || null,
      },
    });
  } catch (err) {
    console.error("Status check error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({ success: false, message: "❌ Could not retrieve payment status. Please try again." });
  }
});

/**
 * GET /receipt/:id
 * Retrieve a stored receipt by payment intent ID.
 */
app.get("/receipt/:id", (req, res) => {
  const receipt = receipts[req.params.id];
  if (!receipt) {
    return res.status(404).json({ success: false, message: "❌ No receipt found for this payment ID." });
  }
  return res.json({
    success: true,
    message: receipt.status === "succeeded"
      ? `✅ Receipt confirmed. ZMW ${receipt.amount} paid by ${receipt.name} (${receipt.phone}).`
      : `⏳ Payment is still ${receipt.status}. Receipt not yet finalized.`,
    data: receipt,
  });
});

/**
 * GET /merchant-balance
 */
app.get("/merchant-balance", async (req, res) => {
  try {
    const balRes = await imali.get("/balance");
    return res.json({ success: true, message: "✅ Balance retrieved successfully.", data: balRes.data });
  } catch (err) {
    console.error("Balance error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({ success: false, message: "❌ Could not retrieve balance." });
  }
});

/**
 * GET /payments
 */
app.get("/payments", async (req, res) => {
  try {
    const paymentsRes = await imali.get("/payments");
    return res.json({ success: true, message: "✅ Payments retrieved successfully.", data: paymentsRes.data });
  } catch (err) {
    console.error("Payments list error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({ success: false, message: "❌ Could not retrieve payments." });
  }
});

/**
 * POST /webhook
 * Receives iMali payment event notifications.
 * Register at: https://your-server.com/webhook
 */
app.post("/webhook", (req, res) => {
  if (WEBHOOK_SECRET) {
    const signature = req.headers["x-imali-signature"] || "";
    const expected  = crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.rawBody || "").digest("hex");
    if (signature !== expected) {
      console.warn("Webhook signature mismatch — rejected.");
      return res.status(401).json({ received: false, message: "Invalid signature." });
    }
  }

  const event          = req.body;
  const paymentIntentId = event?.data?.id || event?.data?.payment_intent_id || event?.id;
  const status          = event?.data?.status || event?.status;
  const eventType       = event?.type || event?.event || "unknown";

  console.log(`📩 Webhook: ${eventType} | ID: ${paymentIntentId} | Status: ${status}`);

  if (paymentIntentId && receipts[paymentIntentId]) {
    receipts[paymentIntentId].status           = status;
    receipts[paymentIntentId].webhookReceivedAt = new Date().toISOString();
    receipts[paymentIntentId].webhookEvent      = eventType;
  }

  if (status === "succeeded") {
    console.log(`✅ SUCCEEDED — ${paymentIntentId} — ZMW ${receipts[paymentIntentId]?.amount || "?"} from ${receipts[paymentIntentId]?.phone || "?"}`);
  } else if (status === "failed" || status === "canceled") {
    console.log(`❌ ${status.toUpperCase()} — ${paymentIntentId}`);
  }

  return res.status(200).json({ received: true, message: friendlyStatus(status || "processing") });
});

/**
 * POST /register-webhook
 * Note: iMali spec marks this endpoint as not yet implemented (returns 501).
 */
app.post("/register-webhook", async (req, res) => {
  try {
    const { url, events } = req.body;
    if (!url) return res.status(400).json({ success: false, message: "❌ Webhook URL is required." });

    const webhookRes = await imali.post("/webhook_endpoints", {
      url,
      events: events || ["payment_intent.succeeded", "payment_intent.failed", "payment_intent.canceled"],
    });

    return res.json({ success: true, message: `✅ Webhook registered for ${url}.`, data: webhookRes.data });
  } catch (err) {
    console.error("Webhook registration error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({ success: false, message: "❌ Could not register webhook. " + friendlyError(err) });
  }
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `❌ Route ${req.method} ${req.path} not found.` });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "❌ An unexpected server error occurred. Please try again." });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 iMali STK Push Server — port ${PORT}`);
  console.log(`   Health:        GET  /health`);
  console.log(`   STK Push:      POST /initiate-payment`);
  console.log(`   Confirm:       POST /confirm-payment/:id`);
  console.log(`   Status:        GET  /payment-status/:id`);
  console.log(`   Receipt:       GET  /receipt/:id`);
  console.log(`   Payments:      GET  /payments`);
  console.log(`   Balance:       GET  /merchant-balance`);
  console.log(`   Webhook in:    POST /webhook`);
  console.log(`   iMali API:     ${IMALI_BASE_URL}\n`);
});
