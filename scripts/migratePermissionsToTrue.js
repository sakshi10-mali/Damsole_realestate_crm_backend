const mongoose = require('mongoose');
require('dotenv').config();
const RolePermission = require('../models/RolePermission');

/**
 * Migration script to update delete permissions from false to true
 * This allows dynamic permission control by super admins
 * Run: node scripts/migratePermissionsToTrue.js
 */
async function migratePermissions() {
    try {
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/spireleap_crm';
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB');

        const roles = ['agency_admin', 'agent', 'staff', 'user'];
        const modules = ['leads', 'properties', 'inquiries', 'contact_messages', 'users', 'agencies'];

        for (const role of roles) {
            let rolePerm = await RolePermission.findOne({ role });
            if (rolePerm) {
                let updated = false;

                // Update delete permissions for all modules to true
                for (const module of modules) {
                    if (rolePerm.permissions[module] && rolePerm.permissions[module].delete === false) {
                        console.log(`Updating ${role}.${module}.delete from false to true`);
                        rolePerm.permissions[module].delete = true;
                        updated = true;
                    }
                }

                if (updated) {
                    rolePerm.markModified('permissions');
                    await rolePerm.save();
                    console.log(`✓ Updated permissions for role: ${role}`);
                } else {
                    console.log(`✓ ${role} already has correct delete permissions`);
                }
            } else {
                console.log(`⚠ No permissions found for role: ${role}`);
            }
        }

        console.log('\n✓ Permission migration completed successfully!');
        console.log('All roles now have delete permissions set to true (dynamically controllable by super admin)');
        process.exit(0);
    } catch (error) {
        console.error('Migration error:', error);
        process.exit(1);
    }
}

migratePermissions();
