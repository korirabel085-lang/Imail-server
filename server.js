/**
 * iMali STK Push Server — Zambia Mobile Money
 * Supports MTN, Airtel, Zamtel via pawaPay through the iMali API.
 * Accepts all frontends (CORS open), returns human-readable messages.
 *
 * Required environment variables (set in .env):
 *   IMALI_API_KEY   — your iMali merchant secret key
 *   IMALI_BASE_URL  — iMali API base (default: https://app.imali.app/api/imali/v1)
 *   PORT            — port to listen on (default: 3000)
 *   WEBHOOK_SECRET  — optional secret to verify iMali webhook signatures
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const IMALI_API_KEY = process.env.IMALI_API_KEY || "";
const IMALI_BASE_URL =
  process.env.IMALI_BASE_URL || "https://app.imali.app/api/imali/v1";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

if (!IMALI_API_KEY) {
  console.warn(
    "⚠️  WARNING: IMALI_API_KEY is not set. Requests to iMali will fail."
  );
}

// ─── In-memory receipt store (replace with a real DB in production) ───────────
// Maps payment_intent id → receipt details
const receipts = {};

// ─── Axios client for iMali ────────────────────────────────────────────────────

const imali = axios.create({
  baseURL: IMALI_BASE_URL,
  headers: {
    Authorization: `Bearer ${IMALI_API_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();

// Accept all frontends — open CORS
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Parse JSON bodies (webhooks use raw body for signature verification)
app.use((req, res, next) => {
  if (req.path === "/webhook") {
    // Keep raw body for signature verification
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      req.rawBody = raw;
      try {
        req.body = JSON.parse(raw);
      } catch {
        req.body = {};
      }
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

// ─── Helper: human-readable messages ─────────────────────────────────────────

function friendlyStatus(status) {
  const map = {
    succeeded: "✅ Payment successful! Your transaction has been confirmed.",
    processing:
      "⏳ Payment is being processed. Please wait and check your phone.",
    requires_action:
      "📱 Please check your phone and approve the payment prompt.",
    requires_confirmation: "⏳ Payment is pending confirmation.",
    canceled: "❌ Payment was canceled. Please try again.",
    failed: "❌ Payment failed. Please check your number or try again.",
  };
  return map[status] || `Payment status: ${status}.`;
}

function friendlyError(err) {
  if (!err) return "An unexpected error occurred. Please try again.";

  const msg =
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    "";

  if (/invalid.*phone|phone.*invalid/i.test(msg))
    return "❌ The phone number you entered is invalid. Please use format 260XXXXXXXXX.";
  if (/insufficient/i.test(msg))
    return "❌ Insufficient funds. Please top up your mobile money wallet and try again.";
  if (/unauthorized|api.key/i.test(msg))
    return "❌ Server configuration error. Please contact support.";
  if (/timeout/i.test(msg))
    return "⏱️ The request timed out. Please check your phone for a payment prompt or try again.";
  if (/duplicate/i.test(msg))
    return "⚠️ A payment with this reference already exists. Please use a different reference.";
  if (msg) return `❌ ${msg}`;

  const statusCode = err?.response?.status;
  if (statusCode === 422)
    return "❌ Invalid payment details. Please check your inputs and try again.";
  if (statusCode === 401)
    return "❌ Authentication failed. Please contact support.";
  if (statusCode === 429)
    return "⚠️ Too many requests. Please wait a moment and try again.";
  if (statusCode >= 500)
    return "❌ The payment server is temporarily unavailable. Please try again shortly.";

  return "❌ Payment could not be initiated. Please try again.";
}

// ─── Validate Zambian mobile phone numbers ────────────────────────────────────

function isValidZambianPhone(phone) {
  // Accepts 260XXXXXXXXX or +260XXXXXXXXX (9 digits after country code)
  return /^(\+?260)[679]\d{8}$/.test(phone.replace(/\s/g, ""));
}

function normalizePhone(phone) {
  return phone.replace(/\s/g, "").replace(/^\+/, "");
}

function detectProvider(phone) {
  const normalized = normalizePhone(phone);
  const local = normalized.replace(/^260/, "");
  if (/^9[56789]/.test(local)) return "MTN"; // 095x, 096x, 097x
  if (/^97/.test(local)) return "MTN";
  if (/^75|^76|^77/.test(local)) return "Airtel";
  if (/^95/.test(local)) return "MTN";
  if (/^21|^22/.test(local)) return "Zamtel";
  return undefined; // let iMali decide
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Quick health check
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "iMali STK Push server is running." });
});

/**
 * POST /initiate-payment
 * Initiates a mobile money STK push in Zambia.
 *
 * Body:
 *   amount        {number}  Amount in ZMW (e.g. 50)
 *   phone         {string}  Customer phone: 260XXXXXXXXX
 *   name          {string}  Customer name
 *   email         {string}  Customer email (optional)
 *   reference     {string}  Your order/reference ID (optional)
 *   description   {string}  Payment description (optional)
 *   webhook_url   {string}  Your callback URL for payment updates (optional)
 */
app.post("/initiate-payment", async (req, res) => {
  try {
    const { amount, phone, name, email, reference, description, webhook_url } =
      req.body;

    // ── Validate inputs ──────────────────────────────────────────────────────
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "❌ Please provide a valid amount greater than 0.",
      });
    }

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "❌ Phone number is required.",
      });
    }

    if (!isValidZambianPhone(phone)) {
      return res.status(400).json({
        success: false,
        message:
          "❌ Invalid Zambian phone number. Please use format 260XXXXXXXXX (e.g. 260971234567).",
      });
    }

    if (!name || name.trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "❌ Customer name is required.",
      });
    }

    const normalizedPhone = normalizePhone(phone);
    const provider = detectProvider(phone);

    // ── First create/find a customer ─────────────────────────────────────────
    let customerId;
    try {
      const customerRes = await imali.post("/customers", {
        name: name.trim(),
        email: email || undefined,
        phone: normalizedPhone,
      });
      customerId = customerRes.data?.id;
    } catch (custErr) {
      // Non-fatal — some iMali configs allow payment without a pre-created customer
      console.warn("Customer creation skipped:", custErr?.response?.data);
    }

    // ── Create payment intent ────────────────────────────────────────────────
    const payload = {
      amount: Number(amount),
      currency: "ZMW",
      method: "momo",
      country: "ZM",
      ...(provider && { provider }),
      ...(description && { purpose: description }),
      ...(webhook_url && { webhook_url }),
      customer: {
        name: name.trim(),
        phone: normalizedPhone,
        ...(email && { email }),
      },
      metadata: {
        ...(reference && { reference }),
        source: "stk-push-server",
      },
    };

    const intentRes = await imali.post("/payment_intents", payload);
    const intent = intentRes.data;

    // Store in receipts map for later lookup
    receipts[intent.id] = {
      id: intent.id,
      amount: Number(amount),
      currency: "ZMW",
      phone: normalizedPhone,
      name: name.trim(),
      status: intent.status,
      reference: reference || null,
      createdAt: new Date().toISOString(),
    };

    return res.json({
      success: true,
      message: `📱 Payment prompt sent to ${normalizedPhone}. Please approve the request on your phone.`,
      data: {
        payment_intent_id: intent.id,
        status: intent.status,
        status_message: friendlyStatus(intent.status),
        amount: Number(amount),
        currency: "ZMW",
        phone: normalizedPhone,
        provider: provider || "Auto-detected",
        checkout_url: intent.checkout_url || null,
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
 * Manually confirm a payment intent (if required by the flow).
 */
app.post("/confirm-payment/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const confirmRes = await imali.post(`/payment_intents/${id}/confirm`);
    const intent = confirmRes.data;

    if (receipts[id]) {
      receipts[id].status = intent.status;
      receipts[id].confirmedAt = new Date().toISOString();
    }

    return res.json({
      success: intent.status === "succeeded",
      message: friendlyStatus(intent.status),
      data: {
        payment_intent_id: intent.id,
        status: intent.status,
        status_message: friendlyStatus(intent.status),
        amount: intent.amount,
        currency: intent.currency,
      },
    });
  } catch (err) {
    console.error("Confirm error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({
      success: false,
      message: friendlyError(err),
    });
  }
});

/**
 * GET /payment-status/:id
 * Check the status of a payment intent and return a human-readable message.
 */
app.get("/payment-status/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const intentRes = await imali.get(`/payment_intents/${id}`);
    const intent = intentRes.data;

    if (receipts[id]) {
      receipts[id].status = intent.status;
    }

    return res.json({
      success: intent.status === "succeeded",
      message: friendlyStatus(intent.status),
      data: {
        payment_intent_id: intent.id,
        status: intent.status,
        status_message: friendlyStatus(intent.status),
        amount: intent.amount,
        currency: intent.currency,
        livemode: intent.livemode,
        receipt: receipts[id] || null,
      },
    });
  } catch (err) {
    console.error("Status check error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({
      success: false,
      message: "❌ Could not retrieve payment status. Please try again.",
    });
  }
});

/**
 * GET /receipt/:id
 * Retrieve a stored receipt by payment intent ID.
 */
app.get("/receipt/:id", (req, res) => {
  const receipt = receipts[req.params.id];
  if (!receipt) {
    return res.status(404).json({
      success: false,
      message: "❌ No receipt found for this payment ID.",
    });
  }
  return res.json({
    success: true,
    message:
      receipt.status === "succeeded"
        ? `✅ Receipt confirmed. ZMW ${receipt.amount} paid by ${receipt.name} (${receipt.phone}).`
        : `⏳ Payment is still ${receipt.status}. Receipt not yet finalized.`,
    data: receipt,
  });
});

/**
 * GET /merchant-balance
 * Returns the merchant's current iMali balance.
 */
app.get("/merchant-balance", async (req, res) => {
  try {
    const balRes = await imali.get("/balance");
    return res.json({
      success: true,
      message: "✅ Balance retrieved successfully.",
      data: balRes.data,
    });
  } catch (err) {
    console.error("Balance error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({
      success: false,
      message: "❌ Could not retrieve balance. Please check your API key.",
    });
  }
});

/**
 * GET /payments
 * List all payments on the merchant account.
 */
app.get("/payments", async (req, res) => {
  try {
    const paymentsRes = await imali.get("/payments");
    return res.json({
      success: true,
      message: "✅ Payments retrieved successfully.",
      data: paymentsRes.data,
    });
  } catch (err) {
    console.error("Payments list error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({
      success: false,
      message: "❌ Could not retrieve payments.",
    });
  }
});

/**
 * POST /webhook
 * Handles iMali payment webhooks.
 * iMali posts payment status updates here — update receipts and log.
 *
 * Register this endpoint in iMali dashboard as:
 *   https://your-server.com/webhook
 */
app.post("/webhook", (req, res) => {
  // ── Verify signature if WEBHOOK_SECRET is configured ─────────────────────
  if (WEBHOOK_SECRET) {
    const signature = req.headers["x-imali-signature"] || "";
    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(req.rawBody || "")
      .digest("hex");

    if (signature !== expected) {
      console.warn("Webhook signature mismatch — rejected.");
      return res
        .status(401)
        .json({ received: false, message: "Invalid signature." });
    }
  }

  const event = req.body;
  const paymentIntentId =
    event?.data?.id || event?.data?.payment_intent_id || event?.id;
  const status = event?.data?.status || event?.status;
  const eventType = event?.type || event?.event || "unknown";

  console.log(`📩 Webhook received: ${eventType} | ID: ${paymentIntentId} | Status: ${status}`);

  // Update local receipt store
  if (paymentIntentId && receipts[paymentIntentId]) {
    receipts[paymentIntentId].status = status;
    receipts[paymentIntentId].webhookReceivedAt = new Date().toISOString();
    receipts[paymentIntentId].webhookEvent = eventType;
  }

  // Log a human-readable summary of the event
  if (status === "succeeded") {
    console.log(
      `✅ Payment SUCCEEDED — ID: ${paymentIntentId} — ${
        receipts[paymentIntentId]
          ? `ZMW ${receipts[paymentIntentId].amount} from ${receipts[paymentIntentId].phone}`
          : ""
      }`
    );
  } else if (status === "failed" || status === "canceled") {
    console.log(`❌ Payment ${status.toUpperCase()} — ID: ${paymentIntentId}`);
  }

  // Always respond 200 quickly to acknowledge receipt
  return res.status(200).json({
    received: true,
    message: friendlyStatus(status || "processing"),
  });
});

/**
 * POST /register-webhook
 * Registers a webhook endpoint with iMali on behalf of the merchant.
 *
 * Body:
 *   url     {string}    Your webhook URL
 *   events  {string[]}  Events to subscribe to (optional, defaults to all)
 */
app.post("/register-webhook", async (req, res) => {
  try {
    const { url, events } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "❌ Webhook URL is required.",
      });
    }

    const payload = {
      url,
      events: events || [
        "payment_intent.succeeded",
        "payment_intent.failed",
        "payment_intent.canceled",
        "payment.created",
      ],
    };

    const webhookRes = await imali.post("/webhook_endpoints", payload);

    return res.json({
      success: true,
      message: `✅ Webhook registered successfully for ${url}.`,
      data: webhookRes.data,
    });
  } catch (err) {
    console.error("Webhook registration error:", err?.response?.data || err.message);
    return res.status(err?.response?.status || 500).json({
      success: false,
      message: "❌ Could not register webhook. " + friendlyError(err),
    });
  }
});

// ─── 404 handler ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `❌ Route ${req.method} ${req.path} not found.`,
  });
});

// ─── Global error handler ─────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    success: false,
    message: "❌ An unexpected server error occurred. Please try again.",
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 iMali STK Push Server running on port ${PORT}`);
  console.log(`   Health:          http://localhost:${PORT}/health`);
  console.log(`   Initiate STK:    POST http://localhost:${PORT}/initiate-payment`);
  console.log(`   Confirm:         POST http://localhost:${PORT}/confirm-payment/:id`);
  console.log(`   Check status:    GET  http://localhost:${PORT}/payment-status/:id`);
  console.log(`   Receipt:         GET  http://localhost:${PORT}/receipt/:id`);
  console.log(`   Payments list:   GET  http://localhost:${PORT}/payments`);
  console.log(`   Balance:         GET  http://localhost:${PORT}/merchant-balance`);
  console.log(`   Webhook:         POST http://localhost:${PORT}/webhook`);
  console.log(`   Register hook:   POST http://localhost:${PORT}/register-webhook`);
  console.log(
    `\n   iMali API: ${IMALI_BASE_URL}`
  );
  if (!IMALI_API_KEY) {
    console.log("   ⚠️  Set IMALI_API_KEY in your .env file before processing payments.");
  }
  console.log();
});
