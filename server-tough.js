// Needed for dotenv
require("dotenv").config();

// Core packages
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const { PrismaClient } = require('@prisma/client');
const Tesseract = require('tesseract.js');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const prisma = new PrismaClient();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(__dirname + '/public'));
app.use(express.static('uploads'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'supersecretkns',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Receipt upload route
app.post('/upload', upload.single('receipt'), async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  try {
    const originalImagePath = path.join(__dirname, req.file.path);
    const processedImagePath = path.join(__dirname, 'uploads', `processed-${uuidv4()}.png`);

    await sharp(originalImagePath).grayscale().normalize().threshold(160).toFile(processedImagePath);
    const { data: { text: ocrText } } = await Tesseract.recognize(processedImagePath, 'eng');

    const chatPrompt = `You are a grocery receipt parser.\n\nHere is the receipt:\n"""\n${ocrText}\n"""\n\nExtract this in JSON:\n{\n  "date": "2025-05-18",\n  "supermarket": "NTUC",\n  "total": 45.80,\n  "discounts": 3.20,\n  "items": [\n    { "item": "Fresh Milk 1L", "category": "Dairy", "price": 4.50 },\n    { "item": "Bananas", "category": "Fruits", "price": 2.30 }\n  ]}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a smart grocery receipt parser.' },
        { role: 'user', content: chatPrompt }
      ]
    });

    const rawContent = response.choices[0].message.content;
    console.log("🔍 OpenAI raw content:\n", rawContent);

    const jsonStart = rawContent.indexOf('{');
    const jsonEnd = rawContent.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("JSON block not found");

    const jsonText = rawContent.substring(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonText);

    const parsedTotal = parseFloat((parsed.total || parsed.Total || '0').toString().replace(/[^\d.]/g, ''));
    const totalDiscount = Array.isArray(parsed.discounts)
      ? parsed.discounts.reduce((sum, d) => sum + (typeof d.amount === 'number' ? d.amount : 0), 0)
      : (typeof parsed.discounts === 'number' ? parsed.discounts : 0);

    const itemsRaw = parsed.items || parsed.Items || [];
    const itemsArray = Array.isArray(itemsRaw)
      ? itemsRaw.map(i => ({
          name: i.item || i.Item || 'Unnamed',
          category: i.category || 'others',
          price: parseFloat(i.total_price || i.price || i.Price || 0)
        })).filter(i => !isNaN(i.price))
      : [];

    const receiptData = {
      userId: user.id,
      supplier: parsed.supermarket || parsed.store || parsed.Company || 'Unknown',
      total: isNaN(parsedTotal) ? 0 : parsedTotal,
      discounts: totalDiscount,
      date: parsed.date ? new Date(parsed.date) : new Date(),
      imagePath: req.file.filename,
      items: {
        create: itemsArray
      }
    };

    await prisma.receipt.create({ data: receiptData });

    return res.render('pages/dashboard', {
      user,
      image: req.file.filename,
      receipt: {
        supplier_name: receiptData.supplier,
        total_amount: receiptData.total,
        line_items: itemsArray
      },
      overview: {
        totalSpent: 0,
        favouriteStore: 'N/A',
        topCategory: 'Coming Soon 👀'
      }
    });

  } catch (error) {
    console.error("Parsing or upload failed:", error);
    return res.render('pages/dashboard', {
      user,
      receipt: null,
      image: req.file?.filename || null,
      overview: {
        totalSpent: 0,
        favouriteStore: 'N/A',
        topCategory: 'Coming Soon 👀'
      }
    });
  }
});



// Save Receipt
app.post('/save-receipt', async (req, res) => {
  const { supplier, total, items = [] } = req.body;
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
        userId: user.id,
        items: {
          create: Array.isArray(items)
            ? items.map(i => ({
                name: i.description,
                category: i.category || 'others',
                price: parseFloat(i.unit_price)
              }))
            : []
        }
      }
    });

    res.redirect('/dashboard');
  } catch (error) {
    console.error('Failed to save receipt:', error);
    res.status(500).send('Error saving receipt.');
  }
});

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
    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        password, // Store password directly (no bcrypt)
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



// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(400).send("❌ Email not found.");
    }

    // ✅ Direct comparison now that password is plain text
    if (user.password !== password) {
      return res.status(400).send("❌ Incorrect password.");
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email
    };

    res.redirect('/dashboard');
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).send("❌ Something went wrong. Please try again.");
  }
});


app.post('/forgot-password', async (req, res) => {
  const { email, secret } = req.body;

  if (secret !== 'ilovekns') {
    return res.status(400).send("❌ Secret phrase incorrect.");
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) return res.status(404).send("❌ Email not found.");

    // Send email with the password
    await transporter.sendMail({
      to: email,
      subject: "Kiap N'Save Password Recovery",
      text: `Your original password is: ${user.password}`
    });

    res.send("✅ Your password has been sent to your email.");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Something went wrong.");
  }
});
const nodemailer = require('nodemailer');

// Create reusable transporter object using the default SMTP transport
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'babymookeymouse@gmail.com',
    pass: 'jzzv bstt sqhg krzy' // Use App Password if 2FA is on
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).send("Error logging out");
    }
    res.redirect('/'); // Redirect to landing page
  });
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

// Start server
app.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});
