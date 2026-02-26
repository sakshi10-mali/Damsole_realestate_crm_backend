const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

async function createSuperAdmin() {
  try {
    const dbName = process.env.MONGODB_DB_NAME || 'spireleap_crm';
    const mongoUri = process.env.MONGODB_URI || `mongodb://localhost:27017/${dbName}`;

    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('MongoDB connected');

    const adminEmail = 'sadmin@gmail.com';
    const adminPassword = 'Pass@123';

    const existingAdmin = await User.findOne({
      $or: [
        { email: adminEmail },
        { role: 'super_admin' }
      ]
    });

    if (existingAdmin) {
      existingAdmin.password = adminPassword;
      if (existingAdmin.email !== adminEmail) {
        existingAdmin.email = adminEmail;
      }
      await existingAdmin.save();
      console.log('Super Admin updated:', adminEmail);
    } else {
      const superAdmin = new User({
        firstName: 'Super',
        lastName: 'Admin',
        email: adminEmail,
        password: adminPassword,
        role: 'super_admin',
        phone: '+1-555-0000',
        isActive: true
      });
      await superAdmin.save();
      console.log('Super Admin created:', adminEmail);
    }

    console.log('Email:', adminEmail, '| Password:', adminPassword);
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

createSuperAdmin();
