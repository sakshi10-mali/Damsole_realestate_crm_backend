const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const Agency = require('../models/Agency');

async function seedDamsoleDemo() {
  try {
    const dbName = process.env.MONGODB_DB_NAME || 'spireleap_crm';
    const mongoUri = process.env.MONGODB_URI || `mongodb://localhost:27017/${dbName}`;

    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('✅ MongoDB connected');
    console.log(`📊 Database: ${mongoose.connection.name}\n`);

    const superAdminEmail = 'superadmin@damsole.com';

    // Ensure super admin exists (run scripts/createSuperAdmin.js first if needed)
    const superAdmin = await User.findOne({ email: superAdminEmail, role: 'super_admin' });
    if (!superAdmin) {
      console.error(`❌ Super admin with email ${superAdminEmail} not found.`);
      console.error('   Please run scripts/createSuperAdmin.js first.');
      process.exit(1);
    }

    console.log(`👤 Using Super Admin: ${superAdmin.email} (${superAdmin._id})`);

    // 1) Create a demo agency owned by the super admin (if not exists)
    const agencySlug = 'damsole-demo-agency';
    let agency = await Agency.findOne({ slug: agencySlug });

    if (!agency) {
      agency = new Agency({
        name: 'Damsole Demo Agency',
        slug: agencySlug,
        description: 'Demo real estate agency seeded for Damsole CRM.',
        owner: superAdmin._id,
        contact: {
          email: 'agency@damsole.com',
          phone: '+91-99999-00001',
          address: {
            street: 'Demo Street 1',
            city: 'Bengaluru',
            state: 'KA',
            country: 'India',
            zipCode: '560001',
          },
        },
        isActive: true,
      });

      await agency.save();
      console.log(`🏢 Created agency: ${agency.name} (${agency._id})`);
    } else {
      console.log(`🏢 Agency already exists: ${agency.name} (${agency._id})`);
    }

    // 2) Create a demo agency admin for that agency
    const agencyAdminEmail = 'agencyadmin@damsole.com';
    let agencyAdmin = await User.findOne({ email: agencyAdminEmail });

    if (!agencyAdmin) {
      agencyAdmin = new User({
        firstName: 'Demo',
        lastName: 'AgencyAdmin',
        email: agencyAdminEmail,
        password: 'Admin@123456',
        role: 'agency_admin',
        phone: '+91-99999-00004',
        agency: agency._id,
        isActive: true,
      });

      await agencyAdmin.save();
      console.log(`🏦 Created agency admin: ${agencyAdmin.email} (${agencyAdmin._id})`);
    } else {
      console.log(`🏦 Agency admin already exists: ${agencyAdmin.email} (${agencyAdmin._id})`);
    }

    // 3) Create a demo agent under that agency
    const agentEmail = 'agent@damsole.com';
    let agent = await User.findOne({ email: agentEmail });

    if (!agent) {
      agent = new User({
        firstName: 'Demo',
        lastName: 'Agent',
        email: agentEmail,
        password: 'Admin@123456',
        role: 'agent',
        phone: '+91-99999-00002',
        agency: agency._id,
        agentInfo: {
          licenseNumber: 'AGENT-DEMO-001',
          bio: 'Demo agent created by seed script.',
          specialties: ['Residential'],
          languages: ['English'],
          yearsOfExperience: 3,
          commissionRate: 2,
        },
        isActive: true,
      });

      await agent.save();
      console.log(`🧑‍💼 Created agent: ${agent.email} (${agent._id})`);
    } else {
      console.log(`🧑‍💼 Agent already exists: ${agent.email} (${agent._id})`);
    }

    // 4) Create a demo customer (regular user)
    const customerEmail = 'customer@damsole.com';
    let customer = await User.findOne({ email: customerEmail });

    if (!customer) {
      customer = new User({
        firstName: 'Demo',
        lastName: 'Customer',
        email: customerEmail,
        password: 'Admin@123456',
        role: 'user',
        phone: '+91-99999-00003',
        address: {
          street: 'Customer Lane 1',
          city: 'Bengaluru',
          state: 'KA',
          country: 'India',
          zipCode: '560002',
        },
        isActive: true,
      });

      await customer.save();
      console.log(`👤 Created customer: ${customer.email} (${customer._id})`);
    } else {
      console.log(`👤 Customer already exists: ${customer.email} (${customer._id})`);
    }

    console.log('\n✅ Damsole demo data seeded successfully!');
    console.log('   Super Admin  : superadmin@damsole.com / Admin@123456');
    console.log('   Agency Admin : agencyadmin@damsole.com / Admin@123456');
    console.log('   Agent        : agent@damsole.com / Admin@123456');
    console.log('   Customer     : customer@damsole.com / Admin@123456');
    console.log('   Agency       : Damsole Demo Agency\n');
  } catch (error) {
    console.error('❌ Error seeding Damsole demo data:', error);
  } finally {
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
    process.exit(0);
  }
}

if (require.main === module) {
  seedDamsoleDemo();
}

module.exports = seedDamsoleDemo;

