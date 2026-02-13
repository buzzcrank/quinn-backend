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

app.use("/stripe-webhook", express.raw({ type: "application/json" }));
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
    const phone = session.metadata?.phone;

    console.log("🔥 Checkout completed for:", phone);

    if (!phone) {
      console.error("❌ No phone in metadata");
      return res.json({ received: true });
    }

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

      /*
      ====================================
      SAFE COLUMN DETECTION
      ====================================
      */

      const columnCheck = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'users'
      `);

      const columns = columnCheck.rows.map(r => r.column_name);

      const updates = [];
      const values = [];
      let i = 1;

      function addIfExists(column, value) {
        if (columns.includes(column)) {
          updates.push(`${column} = $${i}`);
          values.push(value);
          i++;
        }
      }

      addIfExists("role", "subscriber");
      addIfExists("status", "active");
      addIfExists("stripe_customer_id", session.customer);
      addIfExists("stripe_subscription_id", session.subscription);
      addIfExists("proxy_number", purchased.phoneNumber);
      addIfExists("proxy_sid", purchased.sid);
      addIfExists("subscription_expires_at", expiration);
      addIfExists("last_seen", new Date());

      if (updates.length > 0) {
        const sql = `
          UPDATE users
          SET ${updates.join(", ")}
          WHERE phone = $${i}
        `;
        values.push(phone);

        await pool.query(sql, values);
      }

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
