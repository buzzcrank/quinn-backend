// server.js

const express = require("express");
const { Pool } = require("pg");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 3000;

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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP
      );
    `);

    console.log("✅ Users table ready with Caller ID + Fast Lane support.");
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
TWILIO VERIFY CLIENT
====================================
*/

let twilioClient = null;

function getTwilioClient() {
  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN ||
    !process.env.TWILIO_VERIFY_SERVICE_SID
  ) {
    console.error("❌ Twilio Verify environment variables missing.");
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
ROOT
====================================
*/

app.get("/", (req, res) => {
  res.status(200).send("Quinn backend running with Caller ID Fast Lane.");
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

    console.log("📞 Incoming call from:", callerId);

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
CHECK USER STATUS (WEB FAST LANE)
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
      return res.status(500).json({ error: "Twilio Verify not configured." });
    }

    console.log("📲 Sending verification to:", formattedPhone);

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
      return res.status(500).json({ error: "Twilio Verify not configured." });
    }

    const verificationCheck = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to: formattedPhone,
        code: code
      });

    console.log("🔎 Verification status:", verificationCheck.status);

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

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
