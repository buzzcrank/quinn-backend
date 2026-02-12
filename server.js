// server.js

const express = require("express");
const { Pool } = require("pg");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/*
====================================
ENVIRONMENT VALIDATION
====================================
*/

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL not found.");
  process.exit(1);
}

if (!process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN ||
    !process.env.TWILIO_PHONE_NUMBER) {
  console.error("❌ Twilio environment variables missing.");
  process.exit(1);
}

/*
====================================
DATABASE CONNECTION
====================================
*/

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
        verified BOOLEAN DEFAULT FALSE,
        verification_code TEXT,
        code_expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Users table ready.");
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
TWILIO CLIENT
====================================
*/

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/*
====================================
UTILITY FUNCTIONS
====================================
*/

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function codeExpiration() {
  const expires = new Date();
  expires.setMinutes(expires.getMinutes() + 10);
  return expires;
}

/*
====================================
ROUTES
====================================
*/

// Health Check
app.get("/", (req, res) => {
  res.status(200).send("Quinn backend running.");
});

/*
------------------------------------
START VERIFICATION
Creates or updates caller profile
------------------------------------
*/

app.post("/start-verification", async (req, res) => {
  try {
    const { name, phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone number required." });
    }

    const code = generateCode();
    const expires = codeExpiration();

    await pool.query(`
      INSERT INTO users (name, phone, verification_code, code_expires_at, verified)
      VALUES ($1, $2, $3, $4, false)
      ON CONFLICT (phone)
      DO UPDATE SET
        name = EXCLUDED.name,
        verification_code = EXCLUDED.verification_code,
        code_expires_at = EXCLUDED.code_expires_at,
        verified = false;
    `, [name, phone, code, expires]);

    await twilioClient.messages.create({
      body: `Your Quinn verification code is ${code}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
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
------------------------------------
VERIFY CODE
Used by Web OR Voice
------------------------------------
*/

app.post("/verify", async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: "Phone and code required." });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE phone = $1",
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = result.rows[0];

    if (user.verification_code !== code) {
      return res.status(400).json({ error: "Invalid code." });
    }

    if (new Date() > user.code_expires_at) {
      return res.status(400).json({ error: "Code expired." });
    }

    await pool.query(
      "UPDATE users SET verified = true WHERE phone = $1",
      [phone]
    );

    res.status(200).json({
      status: "success",
      message: "Phone verified."
    });

  } catch (err) {
    console.error("❌ Verify error:", err);
    res.status(500).json({ error: "Verification failed." });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
