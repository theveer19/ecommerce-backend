require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto"); // Added for secure verification

const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors({
  origin: [
    "http://localhost:3000", 
    "https://ecommerce-frontend-taupe-mu.vercel.app",
    "https://onet.co.in",
    "https://www.onet.co.in", 
    "http://127.0.0.1:3000",
    "http://10.204.161.58:3000" 
  ],
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

/* -------------------- CREATE ORDER (Payment Gateway) -------------------- */
app.post("/create-order", async (req, res) => {
  try {
    console.log("➡️ Create-order request:", req.body);

    const { amount } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      console.error("❌ Invalid amount:", amount);
      return res.status(400).json({ error: "Invalid amount" });
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.error("❌ Razorpay env missing");
      return res.status(500).json({ error: "Payment config missing" });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(Number(amount) * 100),
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
    });

    console.log("✅ Razorpay order created:", order.id);
    return res.json(order);

  } catch (err) {
    console.error("❌ Create order error:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/* -------------------- SAVE ORDER (Database) -------------------- */
// ✅ UPDATED LOGIC: Writes to 'orders' AND 'order_items'
app.post("/save-order", async (req, res) => {
  try {
    console.log("📦 Saving order:", req.body);

    const {
      user_id,
      items,
      total_amount,
      payment_method,
      payment_id,
      shipping_info
    } = req.body;

    // 1️⃣ BASIC VALIDATION
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Items missing" });
    }

    if (!total_amount || total_amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // 2️⃣ CREATE ORDER (orders table)
    const order_number = `ORD-${Date.now()}`;

    // Note: We do NOT insert 'items' array into 'orders' table anymore
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert([{
        user_id: user_id || null, // Handle guest checkout if needed
        total_amount,
        payment_method,
        payment_id: payment_id || null,
        status: payment_method === "cod" ? "pending" : "confirmed",
        order_number,
        shipping_address: shipping_info, // Map shipping_info to shipping_address column
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (orderError) {
      console.error("❌ Order insert failed:", orderError);
      throw orderError;
    }

    // 3️⃣ CREATE ORDER ITEMS (order_items table)
    const orderItems = items.map(item => ({
      order_id: order.id,
      product_id: item.id,        // Matches products.id
      quantity: item.quantity || 1,
      price_at_time: item.price,
    }));

    const { error: itemsError } = await supabase
      .from("order_items")
      .insert(orderItems);

    if (itemsError) {
      console.error("❌ Order items insert failed:", itemsError);
      // Optional: Logic to delete the created order if items fail could go here
      throw itemsError;
    }

    console.log("✅ Order & Items saved successfully:", order.id);

    // 4️⃣ SUCCESS RESPONSE
    return res.json({
      success: true,
      order: {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        created_at: order.created_at,
      }
    });

  } catch (err) {
    console.error("❌ Save order FULL ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "Save order failed",
      message: err.message,
      details: err.details || null
    });
  }
});

/* -------------------- GET ORDERS -------------------- */
app.get("/orders", async (req, res) => {
  try {
    const { user_id, limit = 50 } = req.query;
    
    let query = supabase
      .from("orders")
      .select(`
        *,
        order_items (
          product_id,
          quantity,
          price_at_time
        )
      `)
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

    // Secure Verification
    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature === razorpay_signature) {
      console.log("✅ Payment Verified:", razorpay_payment_id);
      return res.json({
        success: true,
        message: "Payment verified successfully",
        payment_id: razorpay_payment_id
      });
    } else {
      console.error("❌ Signature Mismatch");
      return res.status(400).json({
        success: false,
        error: "Invalid signature"
      });
    }
    
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
    
    // Test Razorpay (Orders Fetch)
    let razorpayStatus = "Not Configured";
    if (process.env.RAZORPAY_KEY_ID) {
        try {
            await razorpay.orders.all({ count: 1 });
            razorpayStatus = "Connected";
        } catch (e) {
            razorpayStatus = "Error: " + e.message;
        }
    }

    return res.json({
      success: true,
      supabase: supabaseTest.error ? "Failed" : "Connected",
      razorpay: razorpayStatus,
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