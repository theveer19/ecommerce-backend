// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// --- CONFIGURE CORS ---
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://ecommerce-frontend-taupe-mu.vercel.app",
  "https://www.onet.co.in",
  "https://onet.co.in",
  "http://localhost:3001",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
        return callback(null, true);
      } else {
        console.log(`CORS blocked origin: ${origin}`);
        if (process.env.NODE_ENV === 'development') {
          return callback(null, true);
        }
        const msg = `CORS policy blocks origin: ${origin}`;
        return callback(new Error(msg), false);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  })
);

app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- SUPABASE CLIENT ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ SUPABASE_URL or SUPABASE_ANON_KEY missing in .env");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// --- RAZORPAY CLIENT ---
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error("❌ RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET missing in .env");
  process.exit(1);
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- Health check ---
app.get("/", (req, res) => {
  res.json({ 
    ok: true, 
    message: "Backend is working",
    timestamp: new Date().toISOString()
  });
});

// --- Create Razorpay order ---
app.post("/create-order", async (req, res) => {
  try {
    console.log('Creating Razorpay order with data:', req.body);
    
    let { amount } = req.body;

    if (amount === undefined || amount === null) {
      return res.status(400).json({ error: "Missing 'amount' in request body" });
    }

    if (typeof amount === "string") amount = parseFloat(amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "'amount' must be a positive number (INR)" });
    }

    const paise = Math.round(amount * 100);
    const MAX_PAISA = 10000000;

    if (paise > MAX_PAISA) {
      return res.status(400).json({ error: "Amount exceeds maximum allowed" });
    }

    const options = {
      amount: paise,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      payment_capture: 1,
    };

    console.log('Razorpay options:', options);
    
    const order = await razorpay.orders.create(options);
    console.log('Razorpay order created:', order.id);
    
    return res.json(order);
  } catch (err) {
    console.error("❌ Failed to create Razorpay order:", err);
    return res.status(500).json({ 
      error: "Failed to create Razorpay order", 
      details: err?.error?.description || err?.message || 'Unknown error'
    });
  }
});

// --- Save order to Supabase ---
app.post("/save-order", async (req, res) => {
  try {
    console.log('Saving order to Supabase:', req.body);
    
    const { 
      user_id, 
      items, 
      total_amount, 
      subtotal, 
      shipping_fee, 
      tax, 
      shipping_info, 
      payment_method, 
      payment_id,
      status = 'confirmed'
    } = req.body;

    // Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing or invalid 'items' (array) in request body" });
    }
    if (total_amount === undefined || total_amount === null) {
      return res.status(400).json({ error: "Missing 'total_amount' in request body" });
    }

    // Build payload with only the fields that exist in our table
    const payload = {
      user_id: user_id || null,
      items: items,
      total_amount: parseFloat(total_amount),
      shipping_info: shipping_info || {},
      payment_method: payment_method || null,
      status: status,
      created_at: new Date().toISOString(),
    };

    // Only add these fields if they exist in the request
    if (subtotal !== undefined) payload.subtotal = parseFloat(subtotal);
    if (shipping_fee !== undefined) payload.shipping_fee = parseFloat(shipping_fee);
    if (tax !== undefined) payload.tax = parseFloat(tax);
    if (payment_id !== undefined) payload.payment_id = payment_id;

    console.log('Inserting order payload:', payload);

    const { data, error } = await supabase
      .from("orders")
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase insert error:", error);
      
      // If it's a column error, suggest running the SQL migration
      if (error.message.includes('column') && error.message.includes('does not exist')) {
        return res.status(500).json({ 
          error: "Database schema mismatch", 
          details: "Missing required columns in orders table. Please run the SQL migration script.",
          solution: "Run the ALTER TABLE queries provided in the documentation to add missing columns."
        });
      }
      
      return res.status(500).json({ 
        error: "Failed to save order", 
        details: error.message,
        code: error.code
      });
    }

    console.log('✅ Order saved successfully:', data.id);
    
    return res.json({ 
      success: true, 
      order: data,
      orderId: data.id 
    });
  } catch (err) {
    console.error("❌ Error in /save-order:", err);
    return res.status(500).json({ 
      error: "Failed to save order", 
      details: err?.message || 'Unknown error' 
    });
  }
});

// --- Alternative: Simple save order (minimal fields) ---
app.post("/save-order-simple", async (req, res) => {
  try {
    const { 
      user_id, 
      items, 
      total_amount,
      payment_method = 'Cash on Delivery'
    } = req.body;

    // Basic validation
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: "Invalid items" });
    }

    const payload = {
      user_id: user_id || null,
      items: items,
      total_amount: parseFloat(total_amount),
      payment_method: payment_method,
      status: 'confirmed',
      created_at: new Date().toISOString(),
    };

    console.log('Saving simple order:', payload);

    const { data, error } = await supabase
      .from("orders")
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("Simple order error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ success: true, order: data });
  } catch (err) {
    console.error("Simple order exception:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- Get orders ---
app.get("/orders", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (err) {
    console.error("Get orders error:", err);
    return res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// --- Get products ---
app.get("/products", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    
    return res.json(data || []);
  } catch (err) {
    console.error("Products fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch products" });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});