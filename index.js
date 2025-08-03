require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ✅ SUPABASE CLIENT
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ✅ RAZORPAY CLIENT
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ✅ TEST ROUTE
app.get('/', (req, res) => {
  res.send('✅ Backend is working!');
});

// ✅ CREATE ORDER API
app.post('/create-order', async (req, res) => {
  try {
    const { amount } = req.body;
    const options = {
      amount: amount * 100, // convert to paisa
      currency: 'INR',
      receipt: `receipt_${Date.now()}`
    };

    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to create Razorpay order' });
  }
});

// ✅ PRODUCTS ROUTES
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

// ✅ START SERVER
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
