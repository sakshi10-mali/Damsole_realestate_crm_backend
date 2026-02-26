const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

async function activateUsers() {
  try {
    // Connect to MongoDB
    const dbName = process.env.MONGODB_DB_NAME || 'spireleap_crm';
    const mongoUri = process.env.MONGODB_URI || `mongodb://localhost:27017/${dbName}`;
    
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected');
    console.log(`Database: ${mongoose.connection.name}`);

    // Activate all users
    const result = await User.updateMany(
      { isActive: false },
      { $set: { isActive: true } }
    );

    console.log(`\n✅ Activated ${result.modifiedCount} user(s)`);

    // Show all users
    const users = await User.find({}).select('email role isActive');
    console.log('\n📋 All Users:');
    users.forEach(user => {
      console.log(`  - ${user.email} (${user.role}) - Active: ${user.isActive}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

activateUsers();

