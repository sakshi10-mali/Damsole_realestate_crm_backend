const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

async function createSuperAdmin() {
  try {
    // Connect to MongoDB
    const dbName = process.env.MONGODB_DB_NAME || 'spireleap_crm';
    const mongoUri = process.env.MONGODB_URI || `mongodb://localhost:27017/${dbName}`;
    
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log('✅ MongoDB connected');
    console.log(`📊 Database: ${mongoose.connection.name}\n`);

    // Super Admin credentials
    const adminEmail = 'superadmin@damsole.com';
    const adminPassword = 'Admin@123456';
    
    // Check if super admin already exists
    const existingAdmin = await User.findOne({ 
      $or: [
        { email: adminEmail },
        { role: 'super_admin' }
      ]
    });

    if (existingAdmin) {
      console.log('⚠️  Super Admin already exists!');
      console.log(`   Current Email: ${existingAdmin.email}\n`);
      
      // Update password and email if needed
      existingAdmin.password = adminPassword;
      if (existingAdmin.email !== adminEmail) {
        existingAdmin.email = adminEmail;
        console.log(`✅ Email updated to: ${adminEmail}`);
      }
      await existingAdmin.save();
      console.log('✅ Password updated successfully!\n');
    } else {
      // Create new super admin
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
      console.log('✅ Super Admin created successfully!\n');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 SUPER ADMIN LOGIN CREDENTIALS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Email    : ${adminEmail}`);
    console.log(`   Password : ${adminPassword}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('🌐 Login URL: http://localhost:3000/auth/login\n');

    await mongoose.connection.close();
    console.log('✅ Database connection closed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

createSuperAdmin();

