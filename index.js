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
    "http://10.127.149.58:3000"
  
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
  process.env.SUPABASE_ANON_KEY
);

/* -------------------- RAZORPAY INIT -------------------- */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

/* -------------------- HELPER FUNCTIONS -------------------- */
const validateOrderData = (data) => {
  const errors = [];
  
  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
    errors.push("Items are required and must be an array");
  }
  
  if (!data.total_amount || isNaN(data.total_amount) || data.total_amount <= 0) {
    errors.push("Valid total amount is required");
  }
  
  if (!data.shipping_info) {
    errors.push("Shipping information is required");
  } else {
    const requiredShippingFields = ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zipCode'];
    const missingFields = requiredShippingFields.filter(field => !data.shipping_info[field]);
    if (missingFields.length > 0) {
      errors.push(`Missing shipping fields: ${missingFields.join(', ')}`);
    }
  }
  
  return errors;
};

/* -------------------- HEALTH CHECK -------------------- */
app.get("/", (req, res) => {
  res.json({ 
    ok: true, 
    message: "E-commerce Backend Running",
    version: "1.0.0",
    endpoints: {
      payment: "POST /create-order",
      orders: "POST /save-order, GET /orders",
      products: "GET /products",
      verification: "POST /verify-payment"
    }
  });
});

/* -------------------- CREATE RAZORPAY ORDER -------------------- */
app.post("/create-order", async (req, res) => {
  try {
    console.log("📦 Creating Razorpay order:", req.body);
    
    const { amount } = req.body;
    
    // Validate amount
    if (!amount || isNaN(amount) || amount < 1) {
      return res.status(400).json({
        success: false,
        error: "Invalid amount. Minimum amount is 1 INR"
      });
    }
    
    // Convert to paise (Razorpay uses paise)
    const amountInPaise = Math.round(parseFloat(amount) * 100);
    
    // Create Razorpay order
    const options = {
      amount: amountInPaise,
      currency: "INR",
      receipt: `receipt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      payment_capture: 1 // Auto capture
    };
    
    const order = await razorpay.orders.create(options);
    
    console.log("✅ Razorpay order created:", order.id);
    
    // Return order details in expected format
    return res.json({
      success: true,
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status,
      created_at: order.created_at
    });
    
  } catch (err) {
    console.error("❌ Create order error:", err);
    
    // Handle specific Razorpay errors
    let errorMessage = err.message || "Failed to create payment order";
    let statusCode = 500;
    
    if (err.error && err.error.description) {
      errorMessage = err.error.description;
      if (err.error.code === "BAD_REQUEST_ERROR") {
        statusCode = 400;
      }
    }
    
    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      code: err.error?.code || "SERVER_ERROR"
    });
  }
});

/* -------------------- SAVE ORDER TO DATABASE -------------------- */
app.post("/save-order", async (req, res) => {
  const transactionStartTime = Date.now();
  
  try {
    console.log("💾 Saving order to database...");
    console.log("Order data received:", JSON.stringify(req.body, null, 2));
    
    const {
      user_id,
      items,
      total_amount,
      subtotal,
      shipping_fee,
      tax,
      payment_method,
      payment_id,
      shipping_info,
      status = 'pending'
    } = req.body;
    
    // Validate input data
    const validationErrors = validateOrderData(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: validationErrors
      });
    }
    
    // Check database connection
    const { data: connectionTest, error: connectionError } = await supabase
      .from('orders')
      .select('count', { count: 'exact', head: true });
      
    if (connectionError) {
      throw new Error(`Database connection failed: ${connectionError.message}`);
    }
    
    console.log("✅ Database connection verified");
    
    // Start transaction: Create order record
    const orderData = {
      user_id: user_id || null,
      total_amount: parseFloat(total_amount),
      subtotal: parseFloat(subtotal),
      shipping_fee: parseFloat(shipping_fee),
      tax: parseFloat(tax),
      payment_method,
      payment_id: payment_id || null,
      status: payment_method === 'cod' ? 'pending' : 'confirmed',
      shipping_address: {
        name: `${shipping_info.firstName} ${shipping_info.lastName}`.trim(),
        email: shipping_info.email,
        phone: shipping_info.phone,
        address: shipping_info.address,
        city: shipping_info.city,
        state: shipping_info.state,
        pincode: shipping_info.zipCode,
        country: shipping_info.country || 'India'
      }
    };
    
    console.log("📝 Inserting order data:", orderData);
    
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert([orderData])
      .select()
      .single();
    
    if (orderError) {
      console.error("❌ Order insertion failed:", orderError);
      throw new Error(`Failed to create order: ${orderError.message}`);
    }
    
    console.log("✅ Order created with ID:", order.id, "Order number:", order.order_number);
    
    // Create order items
    const orderItems = items.map(item => ({
      order_id: order.id,
      product_id: item.id || null,
      product_name: item.name || 'Unnamed Product',
      quantity: parseInt(item.quantity) || 1,
      price_at_time: parseFloat(item.price) || 0,
      image_url: item.image_url || item.images?.[0] || null
    }));
    
    console.log("📦 Creating order items:", orderItems.length, "items");
    
    const { error: itemsError } = await supabase
      .from('order_items')
      .insert(orderItems);
    
    if (itemsError) {
      console.error("❌ Order items insertion failed:", itemsError);
      
      // Rollback: Delete the order if items failed
      await supabase
        .from('orders')
        .delete()
        .eq('id', order.id);
      
      throw new Error(`Failed to save order items: ${itemsError.message}`);
    }
    
    // If COD and save address is checked, save to user addresses
    if (shipping_info.saveAddress && user_id) {
      try {
        const addressData = {
          user_id,
          first_name: shipping_info.firstName,
          last_name: shipping_info.lastName,
          email: shipping_info.email,
          phone: shipping_info.phone,
          address: shipping_info.address,
          city: shipping_info.city,
          state: shipping_info.state,
          zip_code: shipping_info.zipCode,
          country: shipping_info.country || 'India',
          is_default: true
        };
        
        await supabase
          .from('user_addresses')
          .insert([addressData]);
          
        console.log("✅ Address saved for user");
      } catch (addressError) {
        console.warn("⚠️ Failed to save address, but order was saved:", addressError.message);
        // Don't fail the order if address save fails
      }
    }
    
    const transactionTime = Date.now() - transactionStartTime;
    console.log(`✅ Order saved successfully in ${transactionTime}ms`);
    
    return res.json({
      success: true,
      message: "Order saved successfully",
      order: {
        id: order.id,
        order_number: order.order_number,
        total_amount: order.total_amount,
        status: order.status,
        created_at: order.created_at,
        items_count: orderItems.length
      }
    });
    
  } catch (err) {
    console.error("❌ Save order transaction failed:", err);
    console.error("Error stack:", err.stack);
    
    return res.status(500).json({
      success: false,
      error: "Failed to save order",
      message: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

/* -------------------- GET USER ORDERS -------------------- */
app.get("/orders", async (req, res) => {
  try {
    const { user_id, limit = 20, page = 1 } = req.query;
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "User ID is required"
      });
    }
    
    const pageSize = parseInt(limit);
    const pageNum = parseInt(page);
    const offset = (pageNum - 1) * pageSize;
    
    // Get orders with order items
    let query = supabase
      .from('orders')
      .select(`
        *,
        order_items (
          product_name,
          quantity,
          price_at_time,
          image_url
        )
      `)
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);
    
    const { data: orders, error, count } = await query;
    
    if (error) throw error;
    
    // Get total count for pagination
    const { count: totalCount } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user_id);
    
    return res.json({
      success: true,
      data: orders || [],
      pagination: {
        page: pageNum,
        limit: pageSize,
        total: totalCount || 0,
        pages: Math.ceil((totalCount || 0) / pageSize)
      }
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
    const { category, brand, limit = 50, page = 1 } = req.query;
    
    let query = supabase
      .from('products')
      .select('*', { count: 'exact' });
    
    // Apply filters if provided
    if (category) {
      query = query.ilike('category', `%${category}%`);
    }
    
    if (brand) {
      query = query.ilike('brand', `%${brand}%`);
    }
    
    const pageSize = parseInt(limit);
    const pageNum = parseInt(page);
    const offset = (pageNum - 1) * pageSize;
    
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);
    
    if (error) throw error;
    
    return res.json({
      success: true,
      data: data || [],
      pagination: {
        page: pageNum,
        limit: pageSize,
        total: count || 0,
        pages: Math.ceil((count || 0) / pageSize)
      }
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
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Missing payment verification data"
      });
    }
    
    // Generate signature for verification
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');
    
    if (expectedSignature === razorpay_signature) {
      console.log("✅ Payment verified:", razorpay_payment_id);
      
      // Update order status in database
      try {
        await supabase
          .from('orders')
          .update({ 
            status: 'confirmed',
            payment_id: razorpay_payment_id
          })
          .eq('payment_id', razorpay_order_id)
          .or(`payment_id.eq.${razorpay_order_id},order_number.eq.${razorpay_order_id}`);
          
        console.log("✅ Order status updated");
      } catch (dbError) {
        console.warn("⚠️ Could not update order status:", dbError.message);
      }
      
      return res.json({
        success: true,
        message: "Payment verified successfully",
        payment_id: razorpay_payment_id
      });
    } else {
      console.error("❌ Signature mismatch");
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

/* -------------------- GET ORDER BY ID -------------------- */
app.get("/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;
    
    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Order ID is required"
      });
    }
    
    let query = supabase
      .from('orders')
      .select(`
        *,
        order_items (
          product_name,
          quantity,
          price_at_time,
          image_url
        )
      `)
      .or(`id.eq.${id},order_number.eq.${id}`);
    
    // If user_id provided, ensure the order belongs to the user
    if (user_id) {
      query = query.eq('user_id', user_id);
    }
    
    const { data: order, error } = await query.single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          error: "Order not found"
        });
      }
      throw error;
    }
    
    return res.json({
      success: true,
      data: order
    });
    
  } catch (err) {
    console.error("Get order error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch order",
      message: err.message
    });
  }
});

/* -------------------- TEST ENDPOINTS -------------------- */
app.get("/test-db", async (req, res) => {
  try {
    // Test Supabase connection
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('count', { count: 'exact', head: true });
    
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('count', { count: 'exact', head: true });
    
    // Test Razorpay
    let razorpayStatus = "Not configured";
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
      try {
        const testOrder = await razorpay.orders.all({ count: 1 });
        razorpayStatus = "Connected";
      } catch (rzpError) {
        razorpayStatus = `Error: ${rzpError.message}`;
      }
    }
    
    return res.json({
      success: true,
      timestamp: new Date().toISOString(),
      supabase: {
        products: productsError ? `Error: ${productsError.message}` : "Connected",
        orders: ordersError ? `Error: ${ordersError.message}` : "Connected"
      },
      razorpay: razorpayStatus,
      environment: {
        node_env: process.env.NODE_ENV,
        port: process.env.PORT
      }
    });
    
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* -------------------- WEBHOOK FOR RAZORPAY -------------------- */
app.post("/webhook/razorpay", async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
      console.warn("⚠️ Webhook secret not configured");
      return res.status(400).json({ error: "Webhook not configured" });
    }
    
    const razorpaySignature = req.headers['x-razorpay-signature'];
    const body = JSON.stringify(req.body);
    
    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(body)
      .digest('hex');
    
    if (razorpaySignature !== expectedSignature) {
      console.error("❌ Webhook signature mismatch");
      return res.status(400).json({ error: "Invalid signature" });
    }
    
    const event = req.body.event;
    const payload = req.body.payload;
    
    console.log(`🔔 Razorpay webhook received: ${event}`);
    
    // Handle different events
    switch (event) {
      case 'payment.captured':
        // Update order status to confirmed
        if (payload.payment && payload.payment.entity) {
          const payment = payload.payment.entity;
          await supabase
            .from('orders')
            .update({ 
              status: 'confirmed',
              payment_id: payment.id
            })
            .eq('payment_id', payment.order_id);
          console.log(`✅ Order updated for payment: ${payment.id}`);
        }
        break;
        
      case 'payment.failed':
        // Update order status to failed
        if (payload.payment && payload.payment.entity) {
          const payment = payload.payment.entity;
          await supabase
            .from('orders')
            .update({ 
              status: 'failed',
              payment_id: payment.id
            })
            .eq('payment_id', payment.order_id);
          console.log(`❌ Order marked as failed: ${payment.id}`);
        }
        break;
        
      case 'order.paid':
        // Order is paid
        console.log(`💰 Order paid: ${payload.order.entity.id}`);
        break;
    }
    
    res.json({ received: true });
    
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- ERROR HANDLING -------------------- */
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });
});

app.use((err, req, res, next) => {
  console.error("🚨 Unhandled error:", err);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

/* -------------------- START SERVER -------------------- */
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`
🚀 E-commerce Backend Server Started!
📍 Port: ${PORT}
📡 Host: ${HOST}
🌐 URL: http://${HOST}:${PORT}
⏰ Time: ${new Date().toLocaleString()}

📋 Available Endpoints:
   • GET  /                 - Health check
   • POST /create-order     - Create Razorpay order
   • POST /save-order       - Save order to database
   • GET  /orders          - Get user orders
   • GET  /products        - Get products
   • POST /verify-payment  - Verify payment
   • GET  /test-db         - Test connections

✅ Server ready to accept requests!
  `);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 SIGINT received. Shutting down...');
  process.exit(0);
});