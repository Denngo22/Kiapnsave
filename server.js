// Needed for dotenv
require("dotenv").config();

// Needed for core packages
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');

// Initialize Express
const app = express();

// Needed for Prisma to connect to database
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Setup EJS view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files
app.use(express.static(__dirname + '/public'));
app.use(express.static('uploads'));

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// === ROUTES ===

// Landing page
app.get('/', async (req, res) => {
  try {
    const blogs = await prisma.post.findMany({ orderBy: { id: 'desc' } });
    res.render('pages/home', { blogs });
  } catch (error) {
    console.log(error);
    res.render('pages/home');
  }
});

// Signup page
app.get('/signup', (req, res) => {
  res.render('pages/signup');
});

// Dashboard page
app.get('/dashboard', (req, res) => {
  res.render('pages/dashboard', { receipt: null, image: null });
});

// Upload + OCR route
app.post('/upload', upload.single('receipt'), async (req, res) => {
  try {
    const originalImagePath = path.join(__dirname, req.file.path);
    const processedImagePath = path.join(__dirname, 'uploads', `processed-${uuidv4()}.png`);

    // Preprocess the image using sharp
    await sharp(originalImagePath)
      .grayscale()
      .normalize()
      .threshold(160)
      .toFile(processedImagePath);

    // Send to Mindee
    const form = new FormData();
    form.append('document', fs.createReadStream(processedImagePath));

    const mindeeResponse = await axios.post(
      'https://api.mindee.net/v1/products/mindee/expense_receipts/v5/predict',
      form,
      {
        headers: {
          Authorization: `Token ${process.env.MINDEE_API_KEY}`,
          ...form.getHeaders()
        }
      }
    );

    const prediction = mindeeResponse.data.document.inference.prediction;

    // Construct cleaned receipt object
    const cleanedReceipt = {
      supplier_name: prediction.supplier_name,
      total_amount: prediction.total_amount,
      line_items: prediction.line_items || []
    };

    res.render('pages/dashboard', {
      receipt: cleanedReceipt,
      image: req.file.filename
    });

  } catch (error) {
    console.error('Mindee OCR failed:', error.response?.data || error.message);
    res.send(`<pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>`);
  }
});

// Save receipt handler (demo)
app.post('/save-receipt', async (req, res) => {
  const { supplier, total, items } = req.body;
  // Optional: Save to Prisma DB
  res.send('🧾 Receipt saved successfully! (demo only)');
});

// Start server
app.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});
