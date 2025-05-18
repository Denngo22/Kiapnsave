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

const session = require('express-session');

app.use(session({
  secret: 'supersecretkns',           // 🔒 use a strong secret in production!
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }           // set to true if using HTTPS
}));




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
        age: parseInt(age),        // convert to integer
        gender,                    // store as string
        supermarket
      }
    });

console.log("🧑 Gender stored in session:", newUser.gender);


req.session.user = {
  id: newUser.id,
  name: newUser.name,
  gender: newUser.gender, 
  email: newUser.email
};
    // Optional: Store in session or redirect with flash message
    res.redirect('/dashboard');
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ message: "Failed to sign up." });
  }
});


app.get('/dashboard', (req, res) => {
 console.log("🧾 Session user:", req.session.user);
  const user = req.session.user;

  if (!user) return res.redirect('/login'); // optional: protect route

  res.render('pages/dashboard', {
    receipt: null,
    image: null,
    user
  });
});


// Custom Mindee OCR route with polling for async result
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
console.log("🔍 Full Mindee prediction:", JSON.stringify(prediction, null, 2));

        break;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    if (!prediction) throw new Error("Timed out waiting for prediction");

    const cleanedReceipt = {
  supplier_name: prediction.store_name?.value || 'Unknown',
  total_amount: prediction.total_amount?.value || '?',
  line_items: prediction.items?.map((item, i) => ({
    description: item.item_name || '',
    unit_price: item.item_price || ''
  })) || []
};


console.log("🔐 Upload session user:", req.session.user);

    res.render('pages/dashboard', {
      receipt: cleanedReceipt,
      image: req.file.filename,
      user: req.session.user  // ✅ pass user to the view
    });

  } catch (error) {
    console.error('Mindee OCR failed:', error.response?.data || error.message);
    res.send(`<pre>${JSON.stringify(error.response?.data || error.message, null, 2)}</pre>`);
  }
});

// Receipt save demo
app.post('/save-receipt', async (req, res) => {
  const { supplier, total } = req.body;
  const user = req.session.user;

  if (!user) return res.redirect('/login');

  try {
    await prisma.receipt.create({
      data: {
        supplier,
        total: parseFloat(total),
        userId: user.id
      }
    });

    res.json({ message: '🧾 Receipt saved successfully!' });

  } catch (error) {
    console.error('Failed to save receipt:', error);
    res.status(500).send('Error saving receipt.');
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(401).send('Invalid email or password.');
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).send('Invalid email or password.');
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      gender: user.gender,
      email: user.email
    };

    return res.redirect('/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).send('Something went wrong. Please try again.');
  }
});


// Start server
app.listen(8080, () => {
  console.log('Server running on http://localhost:8080');
});
