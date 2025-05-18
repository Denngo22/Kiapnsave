// Needed for dotenv
require("dotenv").config();

// Core packages
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const FormData = require('form-data');

// Express app
const app = express();

// Prisma
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(__dirname + '/public'));
app.use(express.static('uploads'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions
const session = require('express-session');
app.use(session({
  secret: 'supersecretkns',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Multer setup
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Home
app.get('/', async (req, res) => {
  try {
    const blogs = await prisma.post.findMany({ orderBy: { id: 'desc' } });
    res.render('pages/home', { blogs });
  } catch (error) {
    console.log(error);
    res.render('pages/home');
  }
});

// Signup
app.get('/signup', (req, res) => {
  res.render('pages/signup');
});

app.post('/signup', async (req, res) => {
  const { name, age, gender, email, supermarket, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        age: parseInt(age),
        gender,
        supermarket
      }
    });

    req.session.user = {
      id: newUser.id,
      name: newUser.name,
      gender: newUser.gender,
      email: newUser.email
    };

    res.redirect('/dashboard');
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Failed to sign up." });
  }
});

// Dashboard
app.get('/dashboard', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  try {
    const receipts = await prisma.receipt.findMany({
      where: {
        userId: user.id,
        createdAt: { gte: startOfMonth }
      }
    });

    const totalSpent = receipts.reduce((sum, r) => sum + r.total, 0);

    const storeCount = {};
    receipts.forEach(r => {
      storeCount[r.supplier] = (storeCount[r.supplier] || 0) + 1;
    });

    const favouriteStore = Object.entries(storeCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';

    res.render('pages/dashboard', {
      receipt: null,
      image: null,
      user,
      overview: {
        totalSpent,
        favouriteStore,
        topCategory: 'Coming Soon 👀'
      }
    });

  } catch (err) {
    console.error('Dashboard query failed:', err);
    res.render('pages/dashboard', {
      receipt: null,
      image: null,
      user,
      overview: {
        totalSpent: 0,
        favouriteStore: 'N/A',
        topCategory: 'Coming Soon 👀'
      }
    });
  }
});

// Upload Receipt (OCR)
app.post('/upload', upload.single('receipt'), async (req, res) => {
  try {
    const originalImagePath = path.join(__dirname, req.file.path);
    const processedImagePath = path.join(__dirname, 'uploads', `processed-${uuidv4()}.png`);

    await sharp(originalImagePath)
      .grayscale()
      .normalize()
      .threshold(160)
      .toFile(processedImagePath);

    const form = new FormData();
    form.append('document', fs.createReadStream(processedImagePath));

    const initialResponse = await axios.post(
      'https://api.mindee.net/v1/products/mookey/receipts/v1/predict_async',
      form,
      {
        headers: {
          Authorization: `Token ${process.env.MINDEE_API_KEY}`,
          ...form.getHeaders()
        }
      }
    );

    const jobId = initialResponse.data.job?.id;
    if (!jobId) throw new Error("Mindee response missing job.id");

    const pollingUrl = `https://api.mindee.net/v1/products/mookey/receipts/v1/documents/queue/${jobId}`;

    let prediction = null;
    let attempts = 0;

    while (attempts < 10) {
      const poll = await axios.get(pollingUrl, {
        headers: {
          Authorization: `Token ${process.env.MINDEE_API_KEY}`
        }
      });

      if (poll.data.document?.inference) {
        prediction = poll.data.document.inference.prediction;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    if (!prediction) throw new Error("Timed out waiting for prediction");

    const cleanedReceipt = {
      supplier_name: prediction.store_name?.value || 'Unknown',
      total_amount: prediction.total_amount?.value || '?',
      line_items: prediction.items?.map(item => ({
        description: item.item_name || '',
        unit_price: item.item_price || ''
      })) || []
    };

    res.render('pages/dashboard', {
      receipt: cleanedReceipt,
      image: req.file.filename,
      user: req.session.user,
      overview: {
        totalSpent: 0,
        favouriteStore: 'N/A',
        topCategory: 'Coming Soon 👀'
      }
    });

  } catch (error) {
    console.error('Mindee OCR failed:', error.response?.data || error.message);
    res.send(`<pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>`);
  }
});

// Save Receipt
app.post('/save-receipt', async (req, res) => {
  const { supplier, total } = req.body;
  const user = req.session.user;

  if (!user) return res.redirect('/login');
  if (!supplier || isNaN(parseFloat(total))) {
    console.error('❌ Missing supplier or total:', { supplier, total });
    return res.status(400).send('Missing or invalid data');
  }

  try {
    await prisma.receipt.create({
      data: {
        supplier,
        total: parseFloat(total),
        userId: user.id
      }
    });

    res.redirect('/dashboard'); // 👈 auto-return to updated dashboard

  } catch (error) {
    console.error('Failed to save receipt:', error);
    res.status(500).send('Error saving receipt.');
  }
});


// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) return res.status(401).send('Invalid email or password.');

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).send('Invalid email or password.');

    req.session.user = {
      id: user.id,
      name: user.name,
      gender: user.gender,
      email: user.email
    };

    res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

// Start server
app.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});
