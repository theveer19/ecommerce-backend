require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors({
  origin: [
    "http://localhost:3000", 
    "https://ecommerce-frontend-taupe-mu.vercel.app",
    "https://onet.co.in",
    "https://www.onet.co.in", 
    "http://127.0.0.1:3000",
    "http://10.204.161.58:3000",
    "http://10.127.149.58:3000"
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* -------------------- SUPABASE INIT (SERVICE ROLE) -------------------- */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY 
);

/* -------------------- RAZORPAY INIT -------------------- */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

/* -------------------- HEALTH CHECK -------------------- */
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Backend Running (Service Role Enabled)" });
});

/* -------------------- CREATE RAZORPAY ORDER -------------------- */
app.post("/create-order", async (req, res) => {
  try {
    console.log("📦 Creating Razorpay order:", req.body);
    const { amount } = req.body;
    
    if (!amount || isNaN(amount) || amount < 1) {
      return res.status(400).json({ success: false, error: "Invalid amount" });
    }
    
    const options = {
      amount: Math.round(parseFloat(amount) * 100), // Convert to paise
      currency: "INR",
      receipt: `receipt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      payment_capture: 1 
    };
    
    const order = await razorpay.orders.create(options);
    console.log("✅ Razorpay order created:", order.id);
    
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

/* -------------------- SAVE ORDER TO DATABASE -------------------- */
app.post("/save-order", async (req, res) => {
  const transactionStartTime = Date.now();
  
  try {
    console.log("💾 Saving order...");
    
    const {
  user_id,
  items,
  total_amount,
  subtotal,
  shipping_fee,
  tax,
  payment_method,
  payment_details, // ✅ correct name
  shipping_info
} = req.body;

    // Validate Items
    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: "Items required" });
    }
    
    // ✅ CRITICAL FIX: Safe ID Extraction for COD vs Razorpay
    // If Razorpay, extract from object. If COD, ensure null.
    const actualPaymentId =
  payment_method === 'razorpay' ? payment_details?.razorpay_payment_id : null;

const razorpayOrderId =
  payment_method === 'razorpay' ? payment_details?.razorpay_order_id : null;


    // Prepare Order Data
    const orderData = {
      user_id: user_id || null,
      total_amount: parseFloat(total_amount),
      subtotal: parseFloat(subtotal),
      shipping_fee: parseFloat(shipping_fee),
      tax: parseFloat(tax),
      
      payment_method,
      payment_id: actualPaymentId, 
      razorpay_order_id: razorpayOrderId, 
      
      status: payment_method === 'cod' ? 'pending' : 'confirmed',
      
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
    if (!shipping_info?.firstName || !shipping_info?.phone || !shipping_info?.address) {
  return res.status(400).json({
    success: false,
    error: "Incomplete shipping details"
  });
}
console.log("ORDER DATA:", JSON.stringify(orderData, null, 2));


    
    // Insert Order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert([orderData])
      .select()
      .single();
    
    if (orderError) throw new Error(`Order Insert Failed: ${orderError.message}`);
    
    console.log("✅ Order created:", order.id);
    
    // Insert Order Items
    const orderItems = items.map(item => ({
      order_id: order.id,
      product_id: item.id || null,
      product_name: item.name || 'Unnamed Product',
      quantity: parseInt(item.quantity) || 1,
      price_at_time: parseFloat(item.price) || 0,
      image_url: item.image_url || item.images?.[0] || null
    }));
    
    const { error: itemsError } = await supabase.from('order_items').insert(orderItems);
    
    if (itemsError) {
  console.error("ORDER ITEMS ERROR:", itemsError);

  await supabase.from('orders').delete().eq('id', order.id);

  return res.status(500).json({
    success: false,
    error: itemsError.message,
    details: itemsError.details,
    hint: itemsError.hint,
    code: itemsError.code
  });
}

    
    console.log(`✅ Order saved in ${Date.now() - transactionStartTime}ms`);
    
    return res.json({
      success: true,
      message: "Order saved successfully",
      order: { id: order.id, order_number: order.order_number }
    });
    
  } catch (err) {
    console.error("❌ Save order failed:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- VERIFY PAYMENT -------------------- */
app.post("/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, error: "Missing verification data" });
    }
    
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');
    
    if (expectedSignature === razorpay_signature) {
      console.log("✅ Payment Verified:", razorpay_payment_id);
      
      const { error } = await supabase
        .from('orders')
        .update({ 
          status: 'confirmed', 
          payment_id: razorpay_payment_id 
        })
        .eq('razorpay_order_id', razorpay_order_id);
          
      if (error) console.error("⚠️ Order update failed:", error);
      
      return res.json({ success: true, message: "Payment verified" });
    } else {
      return res.status(400).json({ success: false, error: "Invalid signature" });
    }
    
  } catch (err) {
    console.error("Verify Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------- GET ORDERS -------------------- */
app.get("/orders", async (req, res) => {
  try {
    const { user_id, limit = 20, page = 1 } = req.query;
    
    if (!user_id) {
      return res.status(400).json({ success: false, error: "User ID required" });
    }
    
    const pageSize = parseInt(limit);
    const offset = (parseInt(page) - 1) * pageSize;
    
    const { data: orders, error } = await supabase
      .from('orders')
      .select(`*, order_items (product_name, quantity, price_at_time, image_url)`)
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
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));