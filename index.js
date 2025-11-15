// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// --- CONFIGURE CORS ---
// More flexible CORS configuration
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://ecommerce-frontend-taupe-mu.vercel.app",
  "https://www.onet.co.in",
  "https://onet.co.in",
  "http://localhost:3001", // for local development
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      
      // Check if origin is in allowed list
      if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
        return callback(null, true);
      } else {
        // Log the blocked origin for debugging
        console.log(`CORS blocked origin: ${origin}`);
        // For development, you might want to be more permissive
        if (process.env.NODE_ENV === 'development') {
          return callback(null, true);
        }
        const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
        return callback(new Error(msg), false);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  })
);

// Handle preflight requests
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- SUPABASE CLIENT ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ SUPABASE_URL or SUPABASE_ANON_KEY missing in .env");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true
  }
});

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
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// --- Health check with Supabase connection ---
app.get("/health", async (req, res) => {
  try {
    // Test Supabase connection
    const { data, error } = await supabase.from('products').select('count').limit(1);
    
    res.json({ 
      status: 'healthy',
      database: error ? 'disconnected' : 'connected',
      razorpay: process.env.RAZORPAY_KEY_ID ? 'configured' : 'missing',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ 
      status: 'unhealthy',
      error: err.message 
    });
  }
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

    const payload = {
      user_id: user_id || null,
      items,
      total_amount: parseFloat(total_amount),
      subtotal: subtotal ? parseFloat(subtotal) : 0,
      shipping_fee: shipping_fee ? parseFloat(shipping_fee) : 0,
      tax: tax ? parseFloat(tax) : 0,
      shipping_info: shipping_info || {},
      payment_method: payment_method || null,
      payment_id: payment_id || null,
      status: status,
      created_at: new Date().toISOString(),
    };

    console.log('Inserting order payload:', payload);

    const { data, error } = await supabase
      .from("orders")
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase insert error:", error);
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

// --- Verify Razorpay payment ---
app.post("/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification data" });
    }

    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const generated_signature = hmac.digest('hex');

    if (generated_signature === razorpay_signature) {
      return res.json({ success: true, message: "Payment verified successfully" });
    } else {
      return res.status(400).json({ error: "Payment verification failed" });
    }
  } catch (err) {
    console.error("❌ Payment verification error:", err);
    return res.status(500).json({ error: "Payment verification failed" });
  }
});

// --- Get order by ID ---
app.get("/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      return res.status(404).json({ error: "Order not found" });
    }

    return res.json(data);
  } catch (err) {
    console.error("❌ Error fetching order:", err);
    return res.status(500).json({ error: "Failed to fetch order" });
  }
});

// --- Get user orders ---
app.get("/users/:userId/orders", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (err) {
    console.error("❌ Error fetching user orders:", err);
    return res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// --- Simple products route ---
app.get("/products", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("❌ Products fetch error:", error);
      return res.status(500).json({ error: error.message });
    }
    
    return res.json(data || []);
  } catch (err) {
    console.error("❌ Products fetch error:", err);
    return res.status(500).json({ error: "Failed to fetch products" });
  }
});

// --- Error handling middleware ---
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// --- 404 handler ---
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// --- Start server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS enabled for: ${ALLOWED_ORIGINS.join(', ')}`);
});

module.exports = app;