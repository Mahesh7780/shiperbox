const express = require("express");
const router = express.Router();
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("../db");
require("dotenv").config();

// Rate limiting: Maximum 5 OTP requests every 15 minutes per IP
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: "Too many OTP requests from this IP. Please try again in 15 minutes." }
});

const normalize = (email) => (email || "").trim().toLowerCase();

// Without this, someone could brute-force a 6-digit OTP by hammering
// /verify-otp directly (this endpoint has no limiter of its own so far).
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: "Too many attempts. Please try again in 15 minutes." },
});

router.post("/send-otp", otpLimiter, async (req, res) => {
  const email = normalize(req.body.email);

  if (!email) {
    return res.status(400).json({ success: false, message: "Email is required" });
  }

  const dummyOtp = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

  try {
    await db.query(
      "INSERT INTO otps (email, otp, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE otp = ?, expires_at = ?",
      [email, dummyOtp, expiresAt, dummyOtp, expiresAt]
    );
  } catch (dbErr) {
    console.error("Failed to store OTP in DB:", dbErr.message);
    return res.status(500).json({ success: false, message: "Server error while generating OTP" });
  }

  console.log(`\n🔑 [NEW LOGIN] Email: ${email} | OTP: ${dummyOtp}\n`);

  try {
    // Sent via Brevo's HTTP API instead of raw SMTP (nodemailer) - Render's
    // free tier silently hangs/blocks outbound SMTP connections on port 587,
    // which left every OTP request stuck pending forever with no error.
    // A normal HTTPS call like this works fine on Render.
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { name: "ShiperBox", email: process.env.EMAIL_USER },
        to: [{ email }],
        subject: "Your ShiperBox Login OTP",
        htmlContent: `
          <div style="font-family: Arial, sans-serif; padding: 20px; text-align: center;">
            <h2>Welcome to ShiperBox</h2>
            <p>Your one-time password (OTP) for login is:</p>
            <h1 style="color: #2874f0; letter-spacing: 5px;">${dummyOtp}</h1>
            <p>This OTP is valid for the next 10 minutes.</p>
          </div>
        `,
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
      }
    );

    return res.json({ success: true, message: "OTP sent to email successfully" });
  } catch (error) {
    console.error("❌ OTP Sending failed:", error.response?.data || error.message);
    return res.status(500).json({ success: false, message: "Failed to send OTP. Please try again." });
  }
});

router.post("/verify-otp", verifyLimiter, async (req, res) => {
  const email = normalize(req.body.email);
  const { otp } = req.body;
  const name = (req.body.name || "").trim();

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: "Email and OTP required" });
  }

  let storedData = null;
  try {
    const [rows] = await db.query("SELECT * FROM otps WHERE email = ?", [email]);
    if (rows.length > 0) {
      storedData = {
        otp: rows[0].otp,
        expiresAt: rows[0].expires_at
      };
    }
  } catch (dbErr) {
    console.error("Failed to fetch OTP from DB:", dbErr.message);
    return res.status(500).json({ success: false, message: "Server error while verifying OTP" });
  }

  if (!storedData) {
    return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
  }

  if (Date.now() > storedData.expiresAt) {
    await db.query("DELETE FROM otps WHERE email = ?", [email]).catch(e => console.error(e));
    return res.status(400).json({ success: false, message: "OTP expired. Please request a new one." });
  }

  if (storedData.otp === otp.toString().trim()) {
    await db.query("DELETE FROM otps WHERE email = ?", [email]).catch(e => console.error(e));

    if (!process.env.USER_JWT_SECRET) {
      console.error("USER_JWT_SECRET is not set in .env");
      return res.status(500).json({ success: false, message: "Login is not configured" });
    }

    // Record/refresh this user in the `users` table on every successful login.
    // Requires a UNIQUE constraint on `email` for the upsert to work - see
    // the migration note further down if that's not set up yet.
    try {
      await db.query(
        `INSERT INTO users (name, email, last_login, created_at)
         VALUES (?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           name = COALESCE(NULLIF(?, ''), name),
           last_login = NOW()`,
        [name || null, email, name]
      );
    } catch (dbErr) {
      // Don't block login if this write fails - log it and continue issuing the token.
      console.error("Failed to record user login:", dbErr.message);
    }

    // This token is what every user-data route (cart, orders, addresses,
    // garland, courier) now requires - it's the only thing that actually
    // proves who's making the request, instead of trusting whatever
    // user_id the client happens to send.
    const token = jwt.sign({ email }, process.env.USER_JWT_SECRET, { expiresIn: "30d" });

    res.json({ success: true, message: "Login successful", token, email });
  } else {
    res.status(400).json({ success: false, message: "Invalid OTP" });
  }
});

module.exports = router;