// server.js

const express = require("express");
const { Pool } = require("pg");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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
    await pool.query(`DROP TABLE IF EXISTS users;`);

    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        phone TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'caller',
        status TEXT DEFAULT 'new',
        verified BOOLEAN DEFAULT FALSE,
        verified_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Users table RESET with lifecycle schema.");
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
PHONE NORMALIZATION
====================================
*/

function normalizePhone(phone) {
  if (!phone) throw new Error("Phone number required.");

  const digits = phone.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (phone.startsWith("+") && digits.length >= 11) {
    return phone;
  }

  throw new Error("Invalid phone format. Must be valid US number.");
}

/*
====================================
ROUTES
====================================
*/

app.get("/", (req, res) => {
  res.status(200).send("Quinn backend running with lifecycle schema.");
});

/*
====================================
START VERIFICATION
====================================
*/

app.post("/start-verification", async (req, res) => {
  try {
    const { name, phone } = req.body;

    console.log("📥 Raw phone received from VAPI:", phone);

    if (!phone) {
      return res.status(400).json({ error: "Phone number required." });
    }

    const formattedPhone = normalizePhone(phone);

    console.log("📲 Sending verification to:", formattedPhone);

    const client = getTwilioClient();
    if (!client) {
      return res.status(500).json({ error: "Twilio Verify not configured." });
    }

    await pool.query(`
      INSERT INTO users (name, phone, role, status, verified)
      VALUES ($1, $2, 'caller', 'new', false)
      ON CONFLICT (phone)
      DO UPDATE SET
        name = EXCLUDED.name,
        status = 'new',
        verified = false;
    `, [name || null, formattedPhone]);

    const verification = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({
        to: formattedPhone,
        channel: "sms"
      });

    console.log("✅ Twilio Verify SID:", verification.sid);

    res.status(200).json({
      status: "success",
      message: "Verification code sent."
    });

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

    console.log("📥 Verify attempt for:", phone, "with code:", code);

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
        SET
          verified = true,
          verified_at = NOW(),
          status = 'verified'
        WHERE phone = $1
      `, [formattedPhone]);

      return res.status(200).json({
        status: "approved",
        message: "Phone verified."
      });

    } else {
      return res.status(400).json({
        status: "pending",
        message: "Invalid or expired code."
      });
    }

  } catch (err) {
    console.error("❌ Verify error:", err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
