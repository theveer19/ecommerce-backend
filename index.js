// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// --- CONFIGURE CORS ---
// Add your frontend hosts here (development and deployed)
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://your-frontend.vercel.app", // <- replace with your deployed frontend
  "https://ecommerce-frontend-taupe-mu.vercel.app",
   "https://www.onet.co.in",
  
  // optional example
];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.indexOf(origin) === -1) {
        const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// --- SUPABASE CLIENT ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.warn("⚠️ SUPABASE_URL or SUPABASE_ANON_KEY missing in .env");
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// --- RAZORPAY CLIENT ---
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.warn("⚠️ RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET missing in .env");
}
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- Health check ---
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Backend is working" });
});

// --- Create Razorpay order ---
// Expects JSON body: { amount: <number in INR, e.g. 499.99> }
app.post("/create-order", async (req, res) => {
  try {
    let { amount } = req.body;

    if (amount === undefined || amount === null) {
      return res.status(400).json({ error: "Missing 'amount' in request body" });
    }

    if (typeof amount === "string") amount = parseFloat(amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "'amount' must be a positive number (INR)" });
    }

    // Convert INR to paise (integer)
    const paise = Math.round(amount * 100);

    // Simple limit check (avoid accidentally huge amounts)
    const MAX_PAISA = 10000000; // 1,00,000 INR
    if (paise > MAX_PAISA) {
      return res.status(400).json({ error: "Amount exceeds maximum allowed" });
    }

    const options = {
      amount: paise,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      payment_capture: 1, // auto-capture
    };

    const order = await razorpay.orders.create(options);
    // order contains id, amount, currency, etc.
    return res.json(order);
  } catch (err) {
    console.error("Failed to create Razorpay order:", err && err);
    return res.status(500).json({ error: "Failed to create Razorpay order", details: err?.message || err });
  }
});

// --- Save order to Supabase ---
// Expects JSON body: { userId, items, totalAmount, paymentMethod, paymentStatus, paymentId? }
// Adjust table/column names to match your Supabase schema (orders table fields).
app.post("/save-order", async (req, res) => {
  try {
    const { userId, items, totalAmount, paymentMethod, paymentStatus, paymentId } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing or invalid 'items' (array) in request body" });
    }
    if (totalAmount === undefined || totalAmount === null) {
      return res.status(400).json({ error: "Missing 'totalAmount' in request body" });
    }

    const payload = {
      user_id: userId || null,
      items,
      total_amount: totalAmount,
      payment_method: paymentMethod || null,
      payment_status: paymentStatus || null,
      payment_id: paymentId || null,
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from("orders").insert([payload]).select().single();

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ error: "Failed to save order", details: error });
    }

    return res.json({ success: true, order: data });
  } catch (err) {
    console.error("Error in /save-order:", err);
    return res.status(500).json({ error: "Failed to save order", details: err?.message || err });
  }
});

// --- Optional: simple products route (example) ---
app.get("/products", async (req, res) => {
  try {
    const { data, error } = await supabase.from("products").select("*");
    if (error) return res.status(500).json({ error });
    return res.json(data);
  } catch (err) {
    console.error("Products fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch products" });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
