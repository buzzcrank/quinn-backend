// server.js

const express = require("express");
const { Pool } = require("pg");
const twilio = require("twilio");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 3000;

/*
====================================
BODY PARSING
====================================
Stripe webhook requires raw body.
Everything else uses JSON.
====================================
*/

app.use((req, res, next) => {
  if (req.originalUrl === "/stripe-webhook") {
    next();
  } else {
    express.json()(req, res, next);
  }
});

app.use(express.urlencoded({ extended: false }));

/*
====================================
DATABASE CONNECTION
====================================
*/

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL not found.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        phone TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'caller',
        status TEXT DEFAULT 'new',
        verified BOOLEAN DEFAULT FALSE,
        verified_at TIMESTAMP,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP
      );
    `);

    console.log("✅ Users table ready with Stripe support.");
  } catch (err) {
    console.error("❌ Error initializing DB:", err);
    process.exit(1);
  }
}

pool.connect()
  .then(client => {
    console.log("✅ Connected to PostgreSQL.");
    client.release();
    return initializeDatabase();
  })
  .catch(err => {
    console.error("❌ DB connection failed:", err);
    process.exit(1);
  });

/*
====================================
STRIPE INIT
====================================
*/

if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID || !process.env.STRIPE_WEBHOOK_SECRET) {
  console.error("❌ Stripe environment variables missing.");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/*
====================================
TWILIO CLIENT
====================================
*/

let twilioClient = null;

function getTwilioClient() {
  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN
  ) {
    console.error("❌ Twilio environment variables missing.");
    return null;
  }

  if (!twilioClient) {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }

  return twilioClient;
}

/*
====================================
PHONE NORMALIZATION
====================================
*/

function normalizePhone(phone) {
  if (!phone) throw new Error("Phone number required.");

  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.startsWith("+") && digits.length >= 11) return phone;

  throw new Error("Invalid phone format.");
}

/*
====================================
ROOT
====================================
*/

app.get("/", (req, res) => {
  res.status(200).send("Quinn backend running with Stripe revenue layer.");
});

/*
====================================
VOICE WEBHOOK (CALLER ID AUTO-DETECT)
====================================
*/

app.post("/voice-webhook", async (req, res) => {
  try {
    const callerIdRaw = req.body.From;
    if (!callerIdRaw) {
      return res.status(400).json({ error: "Caller ID missing." });
    }

    const callerId = normalizePhone(callerIdRaw);

    const result = await pool.query(
      `SELECT name, verified FROM users WHERE phone = $1`,
      [callerId]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({
        exists: false,
        verified: false,
        phone: callerId
      });
    }

    const user = result.rows[0];

    if (user.verified) {
      await pool.query(
        `UPDATE users SET last_seen = NOW() WHERE phone = $1`,
        [callerId]
      );
    }

    return res.status(200).json({
      exists: true,
      verified: user.verified,
      name: user.name,
      phone: callerId
    });

  } catch (err) {
    console.error("❌ voice-webhook error:", err);
    res.status(400).json({ error: err.message });
  }
});

/*
====================================
CHECK USER STATUS
====================================
*/

app.post("/check-user-status", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone required." });

    const formattedPhone = normalizePhone(phone);

    const result = await pool.query(
      `SELECT name, verified, role, status FROM users WHERE phone = $1`,
      [formattedPhone]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({
        exists: false,
        verified: false
      });
    }

    const user = result.rows[0];

    if (user.verified) {
      await pool.query(
        `UPDATE users SET last_seen = NOW() WHERE phone = $1`,
        [formattedPhone]
      );
    }

    return res.status(200).json({
      exists: true,
      verified: user.verified,
      name: user.name,
      role: user.role,
      status: user.status
    });

  } catch (err) {
    console.error("❌ check-user-status error:", err);
    res.status(400).json({ error: err.message });
  }
});

/*
====================================
START VERIFICATION
====================================
*/

app.post("/start-verification", async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone required." });

    const formattedPhone = normalizePhone(phone);

    const client = getTwilioClient();
    if (!client) {
      return res.status(500).json({ error: "Twilio not configured." });
    }

    await pool.query(`
      INSERT INTO users (name, phone, role, status, verified)
      VALUES ($1, $2, 'caller', 'pending_verification', false)
      ON CONFLICT (phone)
      DO UPDATE SET
        name = EXCLUDED.name,
        status = 'pending_verification',
        verified = false;
    `, [name || null, formattedPhone]);

    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({
        to: formattedPhone,
        channel: "sms"
      });

    res.status(200).json({ status: "success" });

  } catch (err) {
    console.error("❌ Start verification error:", err);
    res.status(400).json({ error: err.message });
  }
});

/*
====================================
VERIFY OTP
====================================
*/

app.post("/verify", async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: "Phone and code required." });
    }

    const formattedPhone = normalizePhone(phone);

    const client = getTwilioClient();
    if (!client) {
      return res.status(500).json({ error: "Twilio not configured." });
    }

    const verificationCheck = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to: formattedPhone,
        code: code
      });

    if (verificationCheck.status === "approved") {

      await pool.query(`
        UPDATE users
        SET verified = true,
            verified_at = NOW(),
            status = 'verified',
            role = 'customer',
            last_seen = NOW()
        WHERE phone = $1
      `, [formattedPhone]);

      return res.status(200).json({ status: "approved" });

    } else {
      return res.status(400).json({ status: "pending" });
    }

  } catch (err) {
    console.error("❌ Verify error:", err);
    res.status(400).json({ error: err.message });
  }
});

/*
====================================
CREATE CHECKOUT SESSION
====================================
*/

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone required." });

    const formattedPhone = normalizePhone(phone);

    const user = await pool.query(
      `SELECT verified FROM users WHERE phone = $1`,
      [formattedPhone]
    );

    if (user.rows.length === 0 || !user.rows[0].verified) {
      return res.status(400).json({ error: "User must be verified first." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1
      }],
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
      metadata: {
        phone: formattedPhone
      }
    });

    const client = getTwilioClient();

    await client.messages.create({
      body: `Complete your Quinn activation here: ${session.url}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: formattedPhone
    });

    res.status(200).json({ status: "checkout_link_sent" });

  } catch (err) {
    console.error("❌ Checkout error:", err);
    res.status(400).json({ error: err.message });
  }
});

/*
====================================
STRIPE WEBHOOK
====================================
*/

app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const phone = session.metadata.phone;

    await pool.query(`
      UPDATE users
      SET role = 'subscriber',
          status = 'active',
          stripe_customer_id = $1,
          stripe_subscription_id = $2,
          last_seen = NOW()
      WHERE phone = $3
    `, [
      session.customer,
      session.subscription,
      phone
    ]);

    console.log("💰 Subscription activated for:", phone);
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
