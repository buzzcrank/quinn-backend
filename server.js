// server.js

const express = require("express");
const { Pool } = require("pg");
const twilio = require("twilio");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 10000;

/*
====================================
BODY PARSING
====================================
*/

// Stripe webhook must receive raw body
app.use("/stripe-webhook", express.raw({ type: "application/json" }));

// Everything else uses JSON
app.use(express.json());
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
      proxy_number TEXT,
      proxy_sid TEXT,
      forwarding_enabled BOOLEAN DEFAULT TRUE,
      subscription_expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP
    );
  `);

  console.log("✅ Users table ready.");
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

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("❌ STRIPE_SECRET_KEY missing.");
  process.exit(1);
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error("❌ STRIPE_WEBHOOK_SECRET missing.");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/*
====================================
TWILIO INIT
====================================
*/

function getTwilioClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

/*
====================================
PHONE NORMALIZATION
====================================
*/

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.startsWith("+")) return phone;

  throw new Error("Invalid phone format.");
}

/*
====================================
ROOT
====================================
*/

app.get("/", (req, res) => {
  res.status(200).send("Quinn backend running.");
});

/*
====================================
CREATE CHECKOUT SESSION
====================================
*/

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { phone } = req.body;
    const formattedPhone = normalizePhone(phone);

    const user = await pool.query(
      `SELECT verified FROM users WHERE phone = $1`,
      [formattedPhone]
    );

    if (!user.rows.length || !user.rows[0].verified) {
      return res.status(400).json({ error: "User must be verified first." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
      metadata: {
        phone: formattedPhone,
      },
    });

    const client = getTwilioClient();

    await client.messages.create({
      body: `Complete your Quinn activation here: ${session.url}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: formattedPhone,
    });

    res.json({ status: "checkout_link_sent" });

  } catch (err) {
    console.error("Checkout error:", err);
    res.status(400).json({ error: err.message });
  }
});

/*
====================================
STRIPE WEBHOOK
====================================
*/

app.post("/stripe-webhook", async (req, res) => {
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

    console.log("🔥 Checkout completed for:", phone);

    try {
      const client = getTwilioClient();

      const available = await client.availablePhoneNumbers("US")
        .local
        .list({ limit: 1 });

      if (!available.length) {
        throw new Error("No numbers available.");
      }

      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: available[0].phoneNumber,
        voiceUrl: process.env.PROXY_VOICE_WEBHOOK_URL,
        voiceMethod: "POST",
      });

      const expiration = new Date();
      expiration.setDate(expiration.getDate() + 30);

      await pool.query(`
        UPDATE users
        SET role = 'subscriber',
            status = 'active',
            stripe_customer_id = $1,
            stripe_subscription_id = $2,
            proxy_number = $3,
            proxy_sid = $4,
            subscription_expires_at = $5,
            last_seen = NOW()
        WHERE phone = $6
      `, [
        session.customer,
        session.subscription,
        purchased.phoneNumber,
        purchased.sid,
        expiration,
        phone,
      ]);

      await client.messages.create({
        body: `✅ Quinn Activated
Your private number: ${purchased.phoneNumber}
Expires: ${expiration.toDateString()}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
      });

      console.log("🚀 Provisioned for:", phone);

    } catch (err) {
      console.error("Provisioning failed:", err);
    }
  }

  res.json({ received: true });
});

/*
====================================
START SERVER
====================================
*/

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
