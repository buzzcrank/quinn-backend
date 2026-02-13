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

    console.log("✅ Users table ready.");
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
  res.status(200).send("Quinn backend running.");
});

/*
====================================
START VERIFICATION
====================================
*/

app.post("/start-verification", async (req, res) => {
  try {
    const { name, phone } = req.body;
    const formattedPhone = normalizePhone(phone);

    const client = getTwilioClient();

    await pool.query(`
      INSERT INTO users (name, phone, status, verified)
      VALUES ($1, $2, 'pending_verification', false)
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

    res.json({ status: "verification_started" });

  } catch (err) {
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
    const formattedPhone = normalizePhone(phone);
    const client = getTwilioClient();

    const check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to: formattedPhone,
        code
      });

    if (check.status === "approved") {
      await pool.query(`
        UPDATE users
        SET verified = true,
            verified_at = NOW(),
            status = 'verified',
            last_seen = NOW()
        WHERE phone = $1
      `, [formattedPhone]);

      return res.json({ status: "approved" });
    }

    res.status(400).json({ error: "Invalid code" });

  } catch (err) {
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

    res.json({ status: "checkout_link_sent" });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/*
====================================
PROXY FORWARD
====================================
*/

app.post("/proxy-forward", async (req, res) => {
  try {
    const proxyNumber = req.body.To;

    const user = await pool.query(
      `SELECT phone, forwarding_enabled, subscription_expires_at
       FROM users WHERE proxy_number = $1`,
      [proxyNumber]
    );

    if (!user.rows.length) {
      return res.type("text/xml").send(`<Response><Say>This number is not active.</Say></Response>`);
    }

    const record = user.rows[0];

    if (!record.forwarding_enabled) {
      return res.type("text/xml").send(`<Response><Say>Forwarding disabled.</Say></Response>`);
    }

    if (new Date(record.subscription_expires_at) < new Date()) {
      return res.type("text/xml").send(`<Response><Say>Subscription expired.</Say></Response>`);
    }

    res.type("text/xml").send(`
      <Response>
        <Dial>${record.phone}</Dial>
      </Response>
    `);

  } catch (err) {
    res.type("text/xml").send(`<Response><Say>Error.</Say></Response>`);
  }
});

/*
====================================
STRIPE WEBHOOK (AUTO PROVISIONING)
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
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const phone = session.metadata.phone;

    try {
      const client = getTwilioClient();

      const available = await client.availablePhoneNumbers("US")
        .local
        .list({ limit: 1 });

      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: available[0].phoneNumber,
        voiceUrl: process.env.PROXY_VOICE_WEBHOOK_URL,
        voiceMethod: "POST"
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
        phone
      ]);

      await client.messages.create({
        body: `✅ Quinn Activated\nYour private number: ${purchased.phoneNumber}\nExpires: ${expiration.toDateString()}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone
      });

      console.log("🚀 AirGap provisioned for:", phone);

    } catch (err) {
      console.error("Provisioning failed:", err);
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
