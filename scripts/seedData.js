const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Import models
const User = require('../models/User');
const Agency = require('../models/Agency');
const Property = require('../models/Property');
const Lead = require('../models/Lead');

// Sample data
const sampleUsers = [
  // Super Admin
  {
    firstName: 'Super',
    lastName: 'Admin',
    email: 'superadmin@damsole.com',
    password: 'Admin@123456',
    role: 'super_admin',
    phone: '+1-555-0101',
    address: {
      street: '123 Business St',
      city: 'Miami',
      state: 'FL',
      country: 'USA',
      zipCode: '33101'
    },
    isActive: true
  },
  // Agency Admin
  {
    firstName: 'Demo',
    lastName: 'AgencyAdmin',
    email: 'agencyadmin@damsole.com',
    password: 'Admin@123456',
    role: 'agency_admin',
    phone: '+1-555-0102',
    address: {
      street: '456 Real Estate Ave',
      city: 'Miami',
      state: 'FL',
      country: 'USA',
      zipCode: '33102'
    },
    isActive: true
  },
  // Agent
  {
    firstName: 'Demo',
    lastName: 'Agent',
    email: 'agent@damsole.com',
    password: 'Admin@123456',
    role: 'agent',
    phone: '+1-555-0103',
    address: {
      street: '789 Agent Blvd',
      city: 'Miami',
      state: 'FL',
      country: 'USA',
      zipCode: '33103'
    },
    agentInfo: {
      licenseNumber: 'RE-2024-001',
      bio: 'Experienced real estate agent with 10+ years in the industry',
      specialties: ['Residential', 'Commercial'],
      languages: ['English', 'Spanish'],
      yearsOfExperience: 10,
      commissionRate: 3
    },
    isActive: true
  },
  // Staff
  {
    firstName: 'Demo',
    lastName: 'Staff',
    email: 'staff@damsole.com',
    password: 'Admin@123456',
    role: 'staff',
    phone: '+1-555-0104',
    address: {
      street: '321 Support St',
      city: 'Miami',
      state: 'FL',
      country: 'USA',
      zipCode: '33104'
    },
    staffInfo: {
      department: 'support',
      position: 'Support Specialist',
      employeeId: 'EMP-001'
    },
    isActive: true
  },
  // Regular User (Customer)
  {
    firstName: 'Demo',
    lastName: 'Customer',
    email: 'customer@damsole.com',
    password: 'Admin@123456',
    role: 'user',
    phone: '+1-555-0105',
    address: {
      street: '100 Main Street',
      city: 'Miami',
      state: 'FL',
      country: 'USA',
      zipCode: '33105'
    },
    isActive: true
  }
];

async function seedDatabase() {
  try {
    // Connect to MongoDB
    const dbName = process.env.MONGODB_DB_NAME || 'spireleap_crm';
    const mongoUri = process.env.MONGODB_URI || `mongodb://localhost:27017/${dbName}`;
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('Connected to MongoDB');
    console.log(`Database: ${mongoose.connection.name}`);

    // Clear existing data (optional - comment out if you want to keep existing data)
    // await User.deleteMany({});
    // await Agency.deleteMany({});
    // await Property.deleteMany({});
    // await Lead.deleteMany({});

    console.log('Seeding database...');

    // Create users
    const users = [];
    for (const userData of sampleUsers) {
      const existingUser = await User.findOne({ email: userData.email });
      if (existingUser) {
        console.log(`User already exists: ${userData.email}`);
        users.push(existingUser);
      } else {
        const user = new User(userData);
        await user.save();
        users.push(user);
        console.log(`Created user: ${user.email} (${user.role})`);
      }
    }

    // Create sample agency
    const agencyAdmin = users.find(u => u.role === 'agency_admin');
    if (agencyAdmin) {
      const existingAgency = await Agency.findOne({ owner: agencyAdmin._id });
      if (!existingAgency) {
        const agency = new Agency({
          name: 'Damsole Demo Agency',
          slug: 'damsole-demo-agency',
          description: 'Premier real estate agency for Damsole CRM',
          owner: agencyAdmin._id,
          contact: {
            email: 'agency@damsole.com',
            phone: '+1-555-0100',
            address: {
              street: '500 Real Estate Plaza',
              city: 'Miami',
              state: 'FL',
              country: 'USA',
              zipCode: '33101'
            }
          },
          isActive: true
        });
        await agency.save();
        
        // Update agency admin with agency reference
        agencyAdmin.agency = agency._id;
        await agencyAdmin.save();
        
        // Update agent with agency reference
        const agent = users.find(u => u.role === 'agent');
        if (agent) {
          agent.agency = agency._id;
          await agent.save();
        }
        
        console.log(`Created agency: ${agency.name}`);
      }
    }

    console.log('\n✅ Database seeded successfully!');
    console.log('\nSample users created (match Quick login on login page):');
    console.log('- Super Admin: superadmin@damsole.com / Admin@123456');
    console.log('- Agency Admin: agencyadmin@damsole.com / Admin@123456');
    console.log('- Agent: agent@damsole.com / Admin@123456');
    console.log('- Staff: staff@damsole.com / Admin@123456');
    console.log('- Customer: customer@damsole.com / Admin@123456');
    console.log('\nYou can now test the application with these credentials.');

  } catch (error) {
    console.error('Error seeding database:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
}

// Run the seeder
if (require.main === module) {
  seedDatabase();
}

module.exports = seedDatabase;
