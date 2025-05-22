const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding users and friendships...");

  // Delete in safe order: ReceiptItems → Receipts → Friends → Users
  await prisma.receiptItem.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.friend.deleteMany();
  await prisma.user.deleteMany();

  // Create test users
  const [alice, bob, chloe] = await Promise.all([
    prisma.user.create({
      data: {
        name: 'Alice',
        email: 'alice@test.com',
        password: 'password123',
        age: 28,
        gender: 'female'
      }
    }),
    prisma.user.create({
      data: {
        name: 'Bob',
        email: 'bob@test.com',
        password: 'password123',
        age: 30,
        gender: 'male'
      }
    }),
    prisma.user.create({
      data: {
        name: 'Chloe',
        email: 'chloe@test.com',
        password: 'password123',
        age: 27,
        gender: 'female'
      }
    })
  ]);

  // Create bi-directional friendships
  await prisma.friend.createMany({
    data: [
      { userId: alice.id, friendId: bob.id },
      { userId: bob.id, friendId: alice.id },
      { userId: alice.id, friendId: chloe.id },
      { userId: chloe.id, friendId: alice.id },
    ]
  });

  console.log("✅ Seed complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
