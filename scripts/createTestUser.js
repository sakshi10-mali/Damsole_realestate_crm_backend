const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

async function createTestUser() {
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

    // Check if user already exists
    const existingUser = await User.findOne({ email: 'bhushan1@gmail.com' });
    if (existingUser) {
      console.log('User already exists:', existingUser.email);
      console.log('User details:', {
        id: existingUser._id,
        name: `${existingUser.firstName} ${existingUser.lastName}`,
        role: existingUser.role,
        isActive: existingUser.isActive,
        hasPassword: !!existingUser.password
      });
      
      // Update password if needed
      existingUser.password = '123456';
      await existingUser.save();
      console.log('Password updated for existing user');
    } else {
      // Create new test user
      const user = new User({
        firstName: 'Bhushan',
        lastName: 'Test',
        email: 'bhushan1@gmail.com',
        password: '123456',
        role: 'user', // Can be: super_admin, agency_admin, agent, staff, user
        phone: '1234567890',
        isActive: true
      });

      await user.save();
      console.log('Test user created successfully:', user.email);
    }

    // Test login
    const user = await User.findOne({ email: 'bhushan1@gmail.com' });
    if (user) {
      const isMatch = await user.comparePassword('123456');
      console.log('Password test:', isMatch ? '✓ Password matches' : '✗ Password does not match');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

createTestUser();



