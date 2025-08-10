require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// CORS setup - allow your frontend URLs here
app.use(cors({
  origin: ['http://localhost:3000', 'https://ecommerce-frontend-taupe-mu.vercel.app'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Razorpay client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('✅ Backend is working!');
});

// Create Razorpay order
app.post('/create-order', async (req, res) => {
  try {
    const { amount } = req.body;
    const options = {
      amount: amount * 100, // amount in paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
    };
    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    console.error('Failed to create Razorpay order:', error);
    res.status(500).json({ error: 'Failed to create Razorpay order' });
  }
});

// Save order to Supabase
app.post('/save-order', async (req, res) => {
  try {
    const {
      user_id,
      products,
      amount,
      payment_method,
      status,
      address,
      phone,
      payment_id,
    } = req.body;

    const { data, error } = await supabase.from('orders').insert([
      {
        user_id,
        products,
        amount,
        payment_method,
        status,
        address,
        phone,
        payment_id,
      },
    ]);

    if (error) {
      console.error('Error saving order:', error);
      return res.status(500).json({ error: 'Failed to save order' });
    }

    res.json({ success: true, orderId: data[0]?.id });
  } catch (error) {
    console.error('Unexpected error saving order:', error);
    res.status(500).json({ error: 'Failed to save order' });
  }
});

// Products routes
app.get('/products', async (req, res) => {
  const { data, error } = await supabase.from('products').select('*');
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/products', async (req, res) => {
  const { name, description, price, image_url } = req.body;
  const { data, error } = await supabase.from('products').insert([{ name, description, price, image_url }]);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.delete('/products/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('products').delete().eq('id', id);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
