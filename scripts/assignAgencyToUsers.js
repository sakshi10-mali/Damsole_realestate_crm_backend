const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');
const Agency = require('../models/Agency');

// Connect to database
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/spireleap_crm', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function assignAgencyToUsers() {
  try {
    console.log('Starting agency assignment...');

    // Get all agencies
    const agencies = await Agency.find();
    if (agencies.length === 0) {
      console.log('No agencies found. Please create an agency first.');
      return;
    }

    console.log(`Found ${agencies.length} agency/agencies`);

    // Get first agency (or you can modify to assign to specific agency)
    const defaultAgency = agencies[0];
    console.log(`Using default agency: ${defaultAgency.name} (${defaultAgency._id})`);

    // Find users without agency (agency_admin and agent roles)
    const usersWithoutAgency = await User.find({
      $or: [
        { role: 'agency_admin', agency: { $exists: false } },
        { role: 'agency_admin', agency: null },
        { role: 'agent', agency: { $exists: false } },
        { role: 'agent', agency: null }
      ]
    });

    console.log(`Found ${usersWithoutAgency.length} users without agency`);

    if (usersWithoutAgency.length === 0) {
      console.log('All users already have agencies assigned.');
      return;
    }

    // Assign agency to users
    let updated = 0;
    for (const user of usersWithoutAgency) {
      user.agency = defaultAgency._id;
      await user.save();
      updated++;
      console.log(`Assigned agency to: ${user.firstName} ${user.lastName} (${user.email}) - Role: ${user.role}`);
    }

    console.log(`\n✅ Successfully assigned agency to ${updated} user(s)`);
    console.log(`All users are now associated with agency: ${defaultAgency.name}`);

  } catch (error) {
    console.error('Error assigning agency:', error);
  } finally {
    mongoose.connection.close();
    console.log('Database connection closed');
  }
}

// Run the script
assignAgencyToUsers();

