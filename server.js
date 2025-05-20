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

    const chatPrompt = `
You are a smart grocery receipt parser.

Here is a scanned receipt:
"""
${ocrText}
"""

Return JSON in this format:

{
  "supermarket": "FAIRPRICE XTRA",
  "total": 127.75,
  "items": [
    { "original_line": "B FRESH FISH BALL 230", "category": "Seafood", "price": 3.15 },
    { "original_line": "C LG ONION RED700G", "category": "Vegetables", "price": 1.85 }
  ],
  "discounts": [
    { "description": "Promo discount", "amount": 3.25 }
  ]
}

Guidelines:
- DO NOT rename items. Use the original text from the receipt as-is under "original_line".
- You are only allowed to suggest a **category** for each line.
- Use these categories only: Fruits, Staple, Vegetables, Meat, Seafood, Dairy, Eggs, Snacks, Beverages, Condiments, Household, Toiletries, Others.
- Estimate and include a "discounts" array if total < sum of items.
Return only JSON (no extra commentary or markdown).
`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a smart grocery receipt parser.' },
        { role: 'user', content: chatPrompt }
      ]
    });

    const rawContent = response.choices[0].message.content;
    console.log("🔍 OpenAI raw content:\n", rawContent);

    let jsonText;

const codeBlockMatch = rawContent.match(/```json([\s\S]*?)```/);
if (codeBlockMatch) {
  jsonText = codeBlockMatch[1];
} else {
  // Fallback: attempt to extract raw object manually
  const start = rawContent.indexOf('{');
  const end = rawContent.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("No JSON object found");
  jsonText = rawContent.substring(start, end + 1);
}

const parsed = JSON.parse(jsonText);


    const parsedTotal = parseFloat((parsed.total || parsed.Total || '0').toString().replace(/[^\d.]/g, ''));

const itemsRaw = parsed.items || parsed.Items || [];
const itemsArray = Array.isArray(itemsRaw)
  ? itemsRaw.map(i => ({
      name: i.original_line || i.item || 'Unnamed',
      category: i.category || 'Others',
      price: parseFloat(i.total_price || i.price || i.Price || 0)
    })).filter(i => !isNaN(i.price))
  : [];

const itemSum = itemsArray.reduce((sum, i) => sum + (i.price || 0), 0);

// Compute discount (from OpenAI or fallback)
let totalDiscount = 0;
if (Array.isArray(parsed.discounts)) {
  totalDiscount = parsed.discounts.reduce((sum, d) => sum + Math.abs(parseFloat(d.amount || 0)), 0);
} else if (itemSum > parsedTotal) {
  totalDiscount = parseFloat((itemSum - parsedTotal).toFixed(2));
}

const receiptDate = parsed.date ? new Date(parsed.date) : new Date();

const receiptData = {
  userId: user.id,
  supplier: parsed.supermarket || parsed.store || parsed.Company || 'Unknown',
  total: isNaN(parsedTotal) ? 0 : parsedTotal,
  discounts: totalDiscount,
  date: receiptDate,
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
    total_discount: totalDiscount,
    date: receiptDate.toISOString().split('T')[0], // format for input[type="date"]
    line_items: itemsArray.map(item => ({
      description: item.name,
      unit_price: item.price,
      category: item.category
    }))
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
  const { supplier, total, discount, date, items = [] } = req.body;
  const user = req.session.user;
  if (!user) return res.redirect('/login');

  try {
    await prisma.receipt.create({
      data: {
        supplier,
        total: parseFloat(total),
        discounts: parseFloat(discount || 0),
        date: new Date(date),
        userId: user.id,
        items: {
          create: Array.isArray(items)
            ? items.map(i => ({
                name: i.description,
                category: i.category || 'Others',
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
