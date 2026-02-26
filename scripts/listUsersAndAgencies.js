const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');
const Agency = require('../models/Agency');

// Connect to database
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/spireleap_crm', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

async function listUsersAndAgencies() {
  try {
    console.log('Fetching users and agencies...\n');

    // Get all agencies
    const agencies = await Agency.find();
    console.log(`Agencies (${agencies.length}):`);
    agencies.forEach((agency, index) => {
      console.log(`  ${index + 1}. ${agency.name} (ID: ${agency._id})`);
    });
    console.log('');

    // Get all users
    const users = await User.find().select('firstName lastName email role agency isActive');
    
    console.log(`Users (${users.length}):\n`);
    
    const usersByRole = {
      agency_admin: [],
      agent: [],
      super_admin: [],
      staff: [],
      user: []
    };

    users.forEach(user => {
      usersByRole[user.role] = usersByRole[user.role] || [];
      usersByRole[user.role].push(user);
    });

    // Display users by role
    Object.keys(usersByRole).forEach(role => {
      if (usersByRole[role].length > 0) {
        console.log(`${role.toUpperCase()} (${usersByRole[role].length}):`);
        usersByRole[role].forEach((user, index) => {
          const agencyInfo = user.agency 
            ? agencies.find(a => a._id.toString() === user.agency.toString())?.name || 'Unknown Agency'
            : '❌ NO AGENCY';
          const status = user.isActive ? '✅ Active' : '❌ Inactive';
          console.log(`  ${index + 1}. ${user.firstName} ${user.lastName}`);
          console.log(`     Email: ${user.email}`);
          console.log(`     Agency: ${agencyInfo}`);
          console.log(`     Status: ${status}`);
          console.log('');
        });
      }
    });

    // Show users without agency
    const usersWithoutAgency = users.filter(u => 
      (u.role === 'agency_admin' || u.role === 'agent') && !u.agency
    );

    if (usersWithoutAgency.length > 0) {
      console.log(`\n⚠️  Users without agency (${usersWithoutAgency.length}):`);
      usersWithoutAgency.forEach((user, index) => {
        console.log(`  ${index + 1}. ${user.firstName} ${user.lastName} (${user.email}) - Role: ${user.role}`);
      });
      console.log('\nTo assign agency, run:');
      console.log('  node server/scripts/assignAgencyToUsers.js');
      console.log('\nOr assign to specific user:');
      console.log('  node server/scripts/assignAgencyToSpecificUser.js <email>');
    } else {
      console.log('\n✅ All agency_admin and agent users have agencies assigned.');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
}

// Run the script
listUsersAndAgencies();

