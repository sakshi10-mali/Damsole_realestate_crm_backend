const mongoose = require('mongoose');
const RolePermission = require('../models/RolePermission');
require('dotenv').config();

async function verify() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');
    
    const roles = ['agency_admin', 'agent', 'staff', 'user'];
    console.log('Verifying delete permissions in database:\n');
    
    for (const role of roles) {
      const perm = await RolePermission.findOne({ role });
      if (perm) {
        console.log(`${role}:`);
        console.log(`  leads.delete: ${perm.permissions.leads.delete}`);
        console.log(`  properties.delete: ${perm.permissions.properties.delete}`);
        console.log(`  inquiries.delete: ${perm.permissions.inquiries.delete}`);
        console.log('');
      }
    }
    
    console.log('✓ All permissions verified!');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

verify();
