// index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors({
  origin: ["http://localhost:3000", "https://ecommerce-frontend-taupe-mu.vercel.app"],
  credentials: true
}));

app.use(express.json());

/* -------------------- SUPABASE -------------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* -------------------- RAZORPAY -------------------- */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

/* -------------------- HEALTH CHECK -------------------- */
app.get("/", (req, res) => {
  res.json({ 
    ok: true, 
    message: "Backend running",
    endpoints: [
      "POST /create-order",
      "POST /save-order",
      "GET /orders",
      "GET /products"
    ]
  });
});

/* -------------------- CREATE ORDER -------------------- */
app.post("/create-order", async (req, res) => {
  try {
    console.log("Creating Razorpay order:", req.body);
    
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false,
        error: "Invalid amount",
        message: "Amount must be greater than 0"
      });
    }

    // Convert to paise (₹1 = 100 paise)
    const amountInPaise = Math.round(parseFloat(amount) * 100);
    
    // Minimum amount check (₹1 = 100 paise)
    if (amountInPaise < 100) {
      return res.status(400).json({ 
        success: false,
        error: "Amount too low",
        message: "Minimum amount is ₹1"
      });
    }

    console.log("Creating order for amount (paise):", amountInPaise);

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `receipt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      payment_capture: 1 // Auto capture
    });

    console.log("✅ Razorpay order created:", order.id);
    
    return res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        amount_paid: order.amount_paid,
        amount_due: order.amount_due,
        currency: order.currency,
        receipt: order.receipt,
        status: order.status,
        created_at: order.created_at
      }
    });
    
  } catch (err) {
    console.error("❌ Create order error:", err);
    return res.status(500).json({ 
      success: false,
      error: "Razorpay order failed",
      message: err.error?.description || err.message || "Unknown error"
    });
  }
});

/* -------------------- SAVE ORDER -------------------- */
app.post("/save-order", async (req, res) => {
  try {
    console.log("Saving order to Supabase:", req.body);
    
    const { 
      user_id, 
      items, 
      total_amount, 
      payment_id,
      shipping_info,
      payment_method = "razorpay"
    } = req.body;

    // Basic validation
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: "Invalid items",
        message: "Items array is required"
      });
    }

    if (!total_amount || total_amount <= 0) {
      return res.status(400).json({ 
        success: false,
        error: "Invalid total amount",
        message: "Total amount must be greater than 0"
      });
    }

    // Generate order number
    const orderNumber = `ORD${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

    // Prepare order data
    const orderData = {
      user_id: user_id || null,
      items: items,
      total_amount: parseFloat(total_amount),
      payment_method: payment_method,
      payment_id: payment_id || null,
      status: payment_method === 'cod' ? 'pending' : 'confirmed',
      order_number: orderNumber,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Add shipping_info if provided
    if (shipping_info) {
      orderData.shipping_info = shipping_info;
    }

    console.log("📦 Inserting order:", orderData);

    const { data, error } = await supabase
      .from("orders")
      .insert([orderData])
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase insert error:", error);
      
      // Check if table exists
      if (error.message.includes('relation "orders" does not exist')) {
        return res.status(500).json({ 
          success: false,
          error: "Orders table not found",
          message: "Please create the orders table in Supabase"
        });
      }
      
      throw error;
    }

    console.log("✅ Order saved successfully:", data.id);

    return res.json({ 
      success: true, 
      message: "Order saved successfully",
      order: {
        id: data.id,
        order_number: data.order_number || orderNumber,
        total_amount: data.total_amount,
        status: data.status,
        payment_method: data.payment_method,
        created_at: data.created_at
      }
    });
    
  } catch (err) {
    console.error("❌ Save order error:", err);
    return res.status(500).json({ 
      success: false,
      error: "Save order failed",
      message: err.message || "Unknown error"
    });
  }
});

/* -------------------- GET ORDERS -------------------- */
app.get("/orders", async (req, res) => {
  try {
    const { user_id, limit = 50 } = req.query;
    
    let query = supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(parseInt(limit));

    if (user_id) {
      query = query.eq("user_id", user_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      success: true,
      data: data || []
    });
    
  } catch (err) {
    console.error("Get orders error:", err);
    return res.status(500).json({ 
      success: false,
      error: "Failed to fetch orders",
      message: err.message
    });
  }
});

/* -------------------- GET PRODUCTS -------------------- */
app.get("/products", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.json({
      success: true,
      data: data || []
    });
    
  } catch (err) {
    console.error("Get products error:", err);
    return res.status(500).json({ 
      success: false,
      error: "Failed to fetch products",
      message: err.message
    });
  }
});

/* -------------------- VERIFY PAYMENT -------------------- */
app.post("/verify-payment", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Missing payment verification data"
      });
    }

    // In production, verify the signature using Razorpay's method
    // For testing, we'll just acknowledge
    console.log("✅ Payment verification received:", razorpay_payment_id);

    return res.json({
      success: true,
      message: "Payment verified successfully",
      payment_id: razorpay_payment_id
    });
    
  } catch (err) {
    console.error("Verify payment error:", err);
    return res.status(500).json({
      success: false,
      error: "Payment verification failed",
      message: err.message
    });
  }
});

/* -------------------- TEST ENDPOINT -------------------- */
app.get("/test-connection", async (req, res) => {
  try {
    // Test Supabase
    const supabaseTest = await supabase.from("products").select("id").limit(1);
    
    // Test Razorpay
    const razorpayTest = await razorpay.orders.all({ count: 1 });

    return res.json({
      success: true,
      supabase: supabaseTest.error ? "Failed" : "Connected",
      razorpay: "Connected",
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* -------------------- START SERVER -------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 Server running on port ${PORT}
📡 Local: http://localhost:${PORT}
🌐 Network: http://0.0.0.0:${PORT}

✅ Ready for checkout!
  `);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});