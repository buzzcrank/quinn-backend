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
    // TEMP RESET FOR SPRINT 2
    await pool.query(`DROP TABLE IF EXISTS users;`);

    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        phone TEXT UNIQUE NOT NULL,
        verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Users table RESET for Sprint 2.");
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
ROUTES
====================================
*/

app.get("/", (req, res) => {
  res.status(200).send("Quinn backend running with Twilio Verify.");
});

/*
====================================
START VERIFICATION (SEND OTP)
====================================
*/

app.post("/start-verification", async (req, res) => {
  try {
    const { name, phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone number required." });
    }

    const client = getTwilioClient();
    if (!client) {
      return res.status(500).json({ error: "Twilio Verify not configured." });
    }

    // Save or update user
    await pool.query(`
      INSERT INTO users (name, phone, verified)
      VALUES ($1, $2, false)
      ON CONFLICT (phone)
      DO UPDATE SET
        name = EXCLUDED.name,
        verified = false;
    `, [name || null, phone]);

    // Send OTP via Twilio Verify
    await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({
        to: phone,
        channel: "sms"
      });

    res.status(200).json({
      status: "success",
      message: "Verification code sent."
    });

  } catch (err) {
    console.error("❌ Start verification error:", err);
    res.status(500).json({ error: "Failed to start verification." });
  }
});

/*
====================================
CHECK VERIFICATION CODE
====================================
*/

app.post("/verify", async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: "Phone and code required." });
    }

    const client = getTwilioClient();
    if (!client) {
      return res.status(500).json({ error: "Twilio Verify not configured." });
    }

    const verificationCheck = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to: phone,
        code: code
      });

    if (verificationCheck.status === "approved") {

      await pool.query(
        "UPDATE users SET verified = true WHERE phone = $1",
        [phone]
      );

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
    res.status(500).json({ error: "Verification failed." });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
