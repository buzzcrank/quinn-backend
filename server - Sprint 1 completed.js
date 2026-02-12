// server.js
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/*
====================================
DATABASE CONNECTION
====================================
*/

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL not found in environment variables.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Initialize database
async function initializeDatabase() {
  try {
    // Drop old table (safe for MVP stage)
    await pool.query(`DROP TABLE IF EXISTS users;`);

    // Recreate with correct schema
    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        full_name TEXT,
        email TEXT,
        real_phone TEXT,
        consent BOOLEAN,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Users table reset with correct schema.");
  } catch (err) {
    console.error("❌ Error initializing database:", err);
    process.exit(1);
  }
}

// Test connection and initialize
pool.connect()
  .then(client => {
    console.log("✅ Connected to PostgreSQL database.");
    client.release();
    return initializeDatabase();
  })
  .catch(err => {
    console.error("❌ Database connection failed:", err);
    process.exit(1);
  });

/*
====================================
ROUTES
====================================
*/

// Health check route
app.get("/", (req, res) => {
  res.status(200).send("Quinn backend is running.");
});

// Onboarding webhook endpoint
app.post("/webhooks/onboarding", async (req, res) => {
  console.log("📥 Onboarding webhook received:");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const { full_name, email, real_phone, consent } = req.body;

    await pool.query(
      "INSERT INTO users (full_name, email, real_phone, consent) VALUES ($1, $2, $3, $4)",
      [full_name, email, real_phone, consent]
    );

    console.log("✅ User saved to database.");

    res.status(200).json({
      status: "success",
      message: "Onboarding data saved."
    });

  } catch (err) {
    console.error("❌ Error saving user:", err);

    res.status(500).json({
      status: "error",
      message: "Failed to save onboarding data."
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
