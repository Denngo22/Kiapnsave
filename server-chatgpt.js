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
const Tesseract = require('tesseract.js');
const OpenAI = require('openai');

// Express app
const app = express();

// Prisma
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(__dirname + '/public'));
app.use(express.static('uploads'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer setup
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Pages
app.get('/', async (req, res) => {
  try {
    const blogs = await prisma.post.findMany({ orderBy: { id: 'desc' } });
    res.render('pages/home', { blogs });
  } catch (error) {
    console.log(error);
    res.render('pages/home');
  }
});

app.get('/signup', (req, res) => {
  res.render('pages/signup');
});

app.post('/signup', async (req, res) => {
  const { name, age, email, supermarket, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await prisma.user.create({
      data: {
        name,
        ageRange: age,
        email,
        password: hashedPassword,
        supermarket
      }
    });
    res.redirect('/dashboard');
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Failed to sign up." });
  }
});

app.get('/dashboard', (req, res) => {
  res.render('pages/dashboard', { receipt: null, image: null });
});

// Tesseract + GPT OCR route
app.post('/upload', upload.single('receipt'), async (req, res) => {
  try {
    const imagePath = path.join(__dirname, req.file.path);

    // Preprocess
    const processedImagePath = path.join(__dirname, 'uploads', `processed-${uuidv4()}.png`);
    await sharp(imagePath)
      .grayscale()
      .normalize()
      .toFile(processedImagePath);

    // OCR with Tesseract
    const { data: { text: ocrText } } = await Tesseract.recognize(processedImagePath, 'eng');

    // GPT Parsing
    const gptResponse = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You're a helpful AI that extracts grocery receipt data.
Return a JSON object with: supplier_name, total_amount, and line_items (array of { description, quantity, unit_price, total_amount })`
        },
        {
          role: 'user',
          content: ocrText
        }
      ]
    });

    const receiptData = JSON.parse(gptResponse.choices[0].message.content);

    res.render('pages/dashboard', {
      receipt: receiptData,
      image: req.file.filename
    });

  } catch (error) {
    console.error('OCR Parsing failed:', error.message);
    res.send(`<pre>${error.message}</pre>`);
  }
});

// Receipt save demo
app.post('/save-receipt', async (req, res) => {
  const { supplier, total, items } = req.body;
  res.send('🧾 Receipt saved successfully! (demo only)');
});

// Start server
app.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});
