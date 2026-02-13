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
        proxy_number TEXT,
        proxy_sid TEXT,
        forwarding_enabled BOOLEAN DEFAULT TRUE,
        subscription_expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP
      );
    `);

    console.log("✅ Users table ready (Sprint 4 schema).");
  } catch (err) {
    console.error("❌ DB init error:", err);
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

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/*
====================================
TWILIO CLIENT
====================================
*/

let twilioClient = null;

function getTwilioClient() {
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
  res.status(200).send("Quinn backend running – Sprint 4 Auto Provisioning.");
});

/*
====================================
PROXY FORWARD ENDPOINT
====================================
*/

app.post("/proxy-forward", async (req, res) => {
  try {
    const proxyNumber = req.body.To;
    const caller = req.body.From;

    const user = await pool.query(
      `SELECT phone, forwarding_enabled, subscription_expires_at
       FROM users WHERE proxy_number = $1`,
      [proxyNumber]
    );

    if (user.rows.length === 0) {
      return res.type("text/xml").send(`
        <Response>
          <Say>This number is not active.</Say>
        </Response>
      `);
    }

    const record = user.rows[0];

    if (!record.forwarding_enabled) {
      return res.type("text/xml").send(`
        <Response>
          <Say>Forwarding is currently disabled.</Say>
        </Response>
      `);
    }

    if (new Date(record.subscription_expires_at) < new Date()) {
      return res.type("text/xml").send(`
        <Response>
          <Say>Your protection has expired.</Say>
        </Response>
      `);
    }

    return res.type("text/xml").send(`
      <Response>
        <Dial>${record.phone}</Dial>
      </Response>
    `);

  } catch (err) {
    console.error("❌ proxy-forward error:", err);
    res.type("text/xml").send("<Response><Say>Error.</Say></Response>");
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
    console.error("❌ Stripe signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const phone = session.metadata.phone;

    try {
      const client = getTwilioClient();

      // 1️⃣ Purchase new number
      const availableNumbers = await client.availablePhoneNumbers("US")
        .local
        .list({ limit: 1 });

      if (availableNumbers.length === 0) {
        throw new Error("No available numbers.");
      }

      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: availableNumbers[0].phoneNumber,
        voiceUrl: process.env.PROXY_VOICE_WEBHOOK_URL,
        voiceMethod: "POST"
      });

      const expiration = new Date();
      expiration.setDate(expiration.getDate() + 30);

      // 2️⃣ Update DB
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
        phone
      ]);

      // 3️⃣ Send confirmation SMS
      await client.messages.create({
        body: `✅ Quinn AirGap Activated.\n\nYour private number:\n${purchased.phoneNumber}\n\nExpires: ${expiration.toDateString()}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone
      });

      console.log("🚀 AirGap provisioned for:", phone);

    } catch (err) {
      console.error("❌ Provisioning failed:", err);
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
