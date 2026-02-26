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
    email: 'admin@spireleap.com',
    password: 'admin123',
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
    firstName: 'John',
    lastName: 'Smith',
    email: 'john.smith@spireleap.com',
    password: 'agency123',
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
    firstName: 'Sarah',
    lastName: 'Johnson',
    email: 'sarah.johnson@spireleap.com',
    password: 'agent123',
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
    firstName: 'Mike',
    lastName: 'Davis',
    email: 'mike.davis@spireleap.com',
    password: 'staff123',
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
  // Regular User
  {
    firstName: 'Michael',
    lastName: 'Brown',
    email: 'michael.brown@example.com',
    password: 'user123',
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
          name: 'SPIRELEAP Real Estate',
          slug: 'spireleap-real-estate',
          description: 'Premier real estate agency in Miami',
          owner: agencyAdmin._id,
          contact: {
            email: 'info@spireleap.com',
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
    console.log('\nSample users created:');
    console.log('- Super Admin: admin@spireleap.com / admin123');
    console.log('- Agency Admin: john.smith@spireleap.com / agency123');
    console.log('- Agent: sarah.johnson@spireleap.com / agent123');
    console.log('- Staff: mike.davis@spireleap.com / staff123');
    console.log('- User: michael.brown@example.com / user123');
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
