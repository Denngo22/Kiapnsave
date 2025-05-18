-- schema.sql — Kiap N'Save Database Schema

-- Users table
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  age_range VARCHAR(20) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  supermarket VARCHAR(50),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Receipts table
CREATE TABLE receipts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  supplier VARCHAR(100),
  total_amount DECIMAL(10,2),
  receipt_date DATE,
  image_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Line items table (individual items on receipts)
CREATE TABLE line_items (
  id SERIAL PRIMARY KEY,
  receipt_id INTEGER REFERENCES receipts(id) ON DELETE CASCADE,
  description VARCHAR(255),
  quantity INTEGER,
  unit_price DECIMAL(10,2),
  total_amount DECIMAL(10,2)
);

-- Sample seed data for development
INSERT INTO users (name, age_range, email, supermarket, password_hash)
VALUES
  ('Auntie May', '61-70', 'auntiemay@example.com', 'fairprice', 'hashed_password');

INSERT INTO receipts (user_id, supplier, total_amount, receipt_date, image_url)
VALUES
  (1, 'NTUC FairPrice', 68.40, '2025-05-03', '/uploads/1000045712.jpg');

INSERT INTO line_items (receipt_id, description, quantity, unit_price, total_amount)
VALUES
  (1, 'Cabbage', 1, 2.00, 2.00),
  (1, 'Chicken Thigh', 2, 5.50, 11.00),
  (1, 'Cereal Box', 1, 4.80, 4.80);