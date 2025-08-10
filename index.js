require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors({
  origin: ['http://localhost:3000', 'ecommerce-frontend-taupe-mu.vercel.app'], // your frontend URLs here
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
}));
app.use(express.json());

// Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Razorpay client
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.get('/', (req, res) => {
  res.send('✅ Backend is working!');
});

// Create Razorpay order
app.post('/create-order', async (req, res) => {
  try {
    let { amount } = req.body;  // amount in INR, e.g. 100.50

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    amount = Math.round(amount); // Convert INR to paise

    // Razorpay max amount check (₹1,00,000 approx)
    if (amount > 10000000) {
      return res.status(400).json({ error: 'Amount exceeds maximum amount allowed.' });
    }

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
    });

    res.json(order);
  } catch (error) {
    console.error('Failed to create Razorpay order:', error);
    res.status(500).json({ error: 'Failed to create Razorpay order' });
  }
});

// Example fix for Supabase query expecting one row
app.get('/user-role/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('roles')
    .select('*')
    .eq('id', id)
    .maybeSingle(); // safer than single()

  if (error) {
    return res.status(500).json({ error });
  }
  if (!data) {
    return res.status(404).json({ error: 'Role not found' });
  }
  res.json(data);
});

// Your products routes here (unchanged)

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
