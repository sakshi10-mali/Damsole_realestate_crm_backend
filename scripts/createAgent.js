const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

async function createAgent() {
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

    // Agent credentials
    const agentEmail = 'agent@damsole.com';
    const agentPassword = 'Agent@123';
    
    // Check if agent already exists
    const existingAgent = await User.findOne({ email: agentEmail });

    if (existingAgent) {
      console.log('⚠️  Agent already exists!');
      console.log(`   Current Email: ${existingAgent.email}\n`);
      
      // Update password if needed
      existingAgent.password = agentPassword;
      existingAgent.isActive = true;
      existingAgent.role = 'agent';
      await existingAgent.save();
      console.log('✅ Password updated successfully!\n');
    } else {
      // Create new agent
      const agent = new User({
        firstName: 'John',
        lastName: 'Agent',
        email: agentEmail,
        password: agentPassword,
        role: 'agent',
        phone: '+1-555-0001',
        isActive: true,
        agentInfo: {
          licenseNumber: 'AG-12345',
          bio: 'Experienced real estate agent specializing in residential properties.',
          yearsOfExperience: 5,
          commissionRate: 3.5
        }
      });

      await agent.save();
      console.log('✅ Agent created successfully!\n');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 AGENT LOGIN CREDENTIALS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`   Email    : ${agentEmail}`);
    console.log(`   Password : ${agentPassword}`);
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

createAgent();

