// server.js
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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
