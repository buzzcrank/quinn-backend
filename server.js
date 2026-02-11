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

// Test DB connection on startup
pool.connect()
  .then(client => {
    console.log("✅ Connected to PostgreSQL database.");
    client.release();
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
app.post("/webhooks/onboarding", (req, res) => {
  console.log("📥 Onboarding webhook received:");
  console.log(JSON.stringify(req.body, null, 2));

  res.status(200).json({
    status: "success",
    message: "Onboarding data received."
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Quinn backend listening on port ${PORT}`);
});
