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

    // Two Super Admins: existing + new one
    const superAdmins = [
      { email: 'superadmin@damsole.com', password: 'Admin@123456', firstName: 'Super', lastName: 'Admin' },
      { email: 'superadmin@gmail.com', password: '123456', firstName: 'Super', lastName: 'Admin' }  // min 6 chars required
    ];

    console.log('🔐 Creating/updating Super Admins...\n');

    for (const { email, password, firstName, lastName } of superAdmins) {
      const existingAdmin = await User.findOne({ email });

      if (existingAdmin) {
        existingAdmin.password = password;
        existingAdmin.role = 'super_admin';
        existingAdmin.isActive = true;
        await existingAdmin.save();
        console.log(`✅ Updated: ${email}`);
      } else {
        const superAdmin = new User({
          firstName,
          lastName,
          email,
          password,
          role: 'super_admin',
          phone: '+1-555-0000',
          isActive: true
        });
        await superAdmin.save();
        console.log(`✅ Created: ${email}`);
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 SUPER ADMIN LOGIN CREDENTIALS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('   1. Email    : superadmin@damsole.com');
    console.log('      Password : Admin@123456');
    console.log('');
    console.log('   2. Email    : superadmin@gmail.com');
    console.log('      Password : 123456  (min 6 chars; use 123456 for 1234-style)');
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

