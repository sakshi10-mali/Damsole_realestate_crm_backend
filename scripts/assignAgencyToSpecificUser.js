const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');
const Agency = require('../models/Agency');

// Connect to database
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/spireleap_crm', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function assignAgencyToSpecificUser() {
  try {
    console.log('Starting agency assignment to specific user...');

    // Get all agencies
    const agencies = await Agency.find();
    if (agencies.length === 0) {
      console.log('No agencies found. Please create an agency first.');
      return;
    }

    const defaultAgency = agencies[0];
    console.log(`Using agency: ${defaultAgency.name} (${defaultAgency._id})`);

    // Get email from command line argument or use a default
    const userEmail = process.argv[2] || null;

    if (!userEmail) {
      // If no email provided, show all users without agency
      const usersWithoutAgency = await User.find({
        $or: [
          { role: 'agency_admin', agency: { $exists: false } },
          { role: 'agency_admin', agency: null },
          { role: 'agent', agency: { $exists: false } },
          { role: 'agent', agency: null }
        ]
      }).select('firstName lastName email role agency');

      console.log(`\nFound ${usersWithoutAgency.length} users without agency:`);
      usersWithoutAgency.forEach((user, index) => {
        console.log(`${index + 1}. ${user.firstName} ${user.lastName} (${user.email}) - Role: ${user.role}`);
      });

      console.log('\nUsage: node assignAgencyToSpecificUser.js <email>');
      console.log('Example: node assignAgencyToSpecificUser.js admin@gmail.com');
      return;
    }

    // Find user by email
    const user = await User.findOne({ email: userEmail });
    if (!user) {
      console.log(`User with email ${userEmail} not found.`);
      return;
    }

    // Check if user already has agency
    if (user.agency) {
      const existingAgency = await Agency.findById(user.agency);
      console.log(`User ${user.email} already has agency: ${existingAgency ? existingAgency.name : 'Unknown'}`);
      return;
    }

    // Assign agency
    user.agency = defaultAgency._id;
    await user.save();

    console.log(`\n✅ Successfully assigned agency "${defaultAgency.name}" to:`);
    console.log(`   Name: ${user.firstName} ${user.lastName}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Role: ${user.role}`);

  } catch (error) {
    console.error('Error assigning agency:', error);
  } finally {
    mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

// Run the script
assignAgencyToSpecificUser();

