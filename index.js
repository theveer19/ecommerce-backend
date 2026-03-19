require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();

/* -------------------- RATE LIMITING -------------------- */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 500, 
});
app.use(limiter);

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors({
  origin: [
    "http://localhost:3000", 
    "https://ecommerce-frontend-taupe-mu.vercel.app",
    "https://onet.co.in",
    "https://www.onet.co.in" 
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* -------------------- SUPABASE INIT -------------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

/* -------------------- RAZORPAY INIT -------------------- */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

/* -------------------- HELPER: SECURE CALCULATION & MAPPING -------------------- */
async function calculateSecureTotals(items) {
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error("Items required for calculation");
  }

  const productIds = items.map(item => item.id);

  const { data: products, error: productError } = await supabase
    .from("products")
    .select("id, price")
    .in("id", productIds);

  if (productError) throw new Error(productError.message);

  // O(n) hash map creation for O(1) lookups later
  const productMap = {};
  products.forEach(p => {
    productMap[p.id] = p.price;
  });

  let subtotal = 0;
  items.forEach(item => {
    const dbPrice = productMap[item.id];
    if (dbPrice === undefined) throw new Error(`Invalid product ID: ${item.id}`);
    subtotal += dbPrice * item.quantity;
  });

  const shipping_fee = subtotal > 999 ? 0 : 49;
  const tax = subtotal * 0.18; 
  const total_amount = subtotal + shipping_fee + tax;

  return { subtotal, total_amount, shipping_fee, tax, productMap };
}

/* -------------------- HEALTH CHECK -------------------- */
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Backend Running (Secured)" });
});

/* -------------------- CREATE RAZORPAY ORDER -------------------- */
app.post("/create-order", async (req, res) => {
  try {
    const { items } = req.body; 
    const { total_amount } = await calculateSecureTotals(items);
    
    if (total_amount < 1) {
      return res.status(400).json({ success: false, error: "Invalid calculated amount" });
    }
    
    const options = {
      amount: Math.round(total_amount * 100), 
      currency: "INR",
      receipt: `receipt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    };
    
    const order = await razorpay.orders.create(options);
    
    return res.json({
      success: true,
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status
    });
    
  } catch (err) {
    console.error("❌ Create order error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- SAVE ORDER & VERIFY SIGNATURE -------------------- */
app.post("/save-order", async (req, res) => {
  const transactionStartTime = Date.now();
  
  try {
    const {
      user_id,
      items,
      payment_method,
      payment_details,
      shipping_info
    } = req.body;

    // 1. Initial Validations
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Items required" });
    }

    if (!shipping_info?.firstName || !shipping_info?.phone || !shipping_info?.address) {
      return res.status(400).json({ success: false, error: "Incomplete shipping details" });
    }

    // 2. CRITICAL: Verify Razorpay Signature BEFORE doing anything else
    if (payment_method === "razorpay") {
      if (!payment_details || !payment_details.razorpay_order_id || !payment_details.razorpay_payment_id || !payment_details.razorpay_signature) {
        return res.status(400).json({ success: false, error: "Missing Razorpay payment details." });
      }

      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = payment_details;
      const body = razorpay_order_id + "|" + razorpay_payment_id;
      
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body.toString())
        .digest("hex");

      if (expectedSignature !== razorpay_signature) {
        console.error("🚨 Signature mismatch detected!");
        return res.status(400).json({ success: false, error: "Payment verification failed. Invalid signature." });
      }
    }

    // 3. Fetch real prices & calculate totals
    const { subtotal, total_amount, shipping_fee, tax, productMap } = await calculateSecureTotals(items);

    const actualPaymentId = payment_method === 'razorpay' ? payment_details?.razorpay_payment_id : null;
    const razorpayOrderId = payment_method === 'razorpay' ? payment_details?.razorpay_order_id : null;

    const orderData = {
      user_id: user_id || null,
      total_amount,
      subtotal,
      shipping_fee,
      tax,
      payment_method,
      payment_id: actualPaymentId, 
      razorpay_order_id: razorpayOrderId, 
      status: payment_method === 'cod' ? 'pending' : 'confirmed', // Now safe to mark confirmed
      shipping_address: JSON.stringify({
        name: `${shipping_info?.firstName || ''} ${shipping_info?.lastName || ''}`.trim(),
        email: shipping_info?.email || null,
        phone: shipping_info?.phone || null,
        address: shipping_info?.address || null,
        city: shipping_info?.city || null,
        state: shipping_info?.state || null,
        pincode: shipping_info?.zipCode || null,
        country: shipping_info?.country || 'India'
      })
    };

    // 4. Insert Order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert([orderData])
      .select()
      .single();
    
    if (orderError) {
      console.error("❌ Order insert error:", orderError);
      throw new Error(`Order Insert Failed: ${orderError.message}`);
    }
    
    // 5. Insert Order Items using O(1) lookups
    const orderItems = items.map(item => ({
      order_id: order.id,
      product_id: item.id || null,
      product_name: item.name || 'Unnamed Product',
      quantity: parseInt(item.quantity) || 1,
      price_at_time: productMap[item.id] || 0, // Secure DB pricing
      image_url: item.image_url || item.images?.[0] || null,
      size: item.size || item.selectedSize || null, 
      vendor_id: item.vendor_id || null             
    }));
    
    const { error: itemsError } = await supabase.from('order_items').insert(orderItems);
    
    if (itemsError) {
      console.error("❌ ORDER ITEMS ERROR:", itemsError);
      await supabase.from('orders').delete().eq('id', order.id); // Rollback
      return res.status(500).json({ success: false, error: itemsError.message });
    }
    
    console.log(`✅ Order saved securely in ${Date.now() - transactionStartTime}ms`);
    return res.json({
      success: true,
      message: "Order processed successfully",
      order: { id: order.id, order_number: order.order_number }
    });
    
  } catch (err) {
    console.error("❌ Save order failed:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- GET ORDERS -------------------- */
app.get("/orders", async (req, res) => {
  try {
    const { user_id, limit = 20, page = 1 } = req.query;
    
    if (!user_id) return res.status(400).json({ success: false, error: "User ID required" });
    
    const pageSize = parseInt(limit);
    const offset = (parseInt(page) - 1) * pageSize;
    
    const { data: orders, error } = await supabase
      .from('orders')
      .select(`*, order_items (product_name, quantity, price_at_time, image_url, size)`)
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);
    
    if (error) throw error;
    
    return res.json({ success: true, data: orders || [] });
    
  } catch (err) {
    console.error("Get orders error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running securely on port ${PORT}`));