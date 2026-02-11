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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT,
        phone TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Users table ready.");
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
    const { name, email, phone } = req.body;

    await pool.query(
      "INSERT INTO users (name, email, phone) VALUES ($1, $2, $3)",
      [name, email, phone]
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
