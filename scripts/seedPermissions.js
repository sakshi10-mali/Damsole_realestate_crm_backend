const mongoose = require('mongoose');
require('dotenv').config();
const RolePermission = require('../models/RolePermission');

const roles = ['agency_admin', 'agent', 'staff', 'user'];

async function seedPermissions() {
    try {
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/spireleap_crm';
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB');

        const defaultPermissions = {
            leads: { view: true, create: true, edit: true, delete: true },
            properties: { view: true, create: true, edit: true, delete: true },
            inquiries: { view: true, create: true, edit: true, delete: true },
            contact_messages: { view: true, create: false, edit: true, delete: true },
            users: { view: true, create: true, edit: true, delete: true },
            agencies: { view: true, create: true, edit: true, delete: true }
        };

        for (const role of roles) {
            let rolePerm = await RolePermission.findOne({ role });
            if (!rolePerm) {
                await RolePermission.create({
                    role,
                    permissions: defaultPermissions
                });
                console.log(`Created default permissions for role: ${role}`);
            } else {
                // If role exists, check if new modules are missing and patch them
                let needsUpdate = false;
                if (!rolePerm.permissions.inquiries) {
                    rolePerm.permissions.inquiries = defaultPermissions.inquiries;
                    needsUpdate = true;
                }
                if (!rolePerm.permissions.contact_messages) {
                    rolePerm.permissions.contact_messages = defaultPermissions.contact_messages;
                    needsUpdate = true;
                }
                if (!rolePerm.permissions.users) {
                    rolePerm.permissions.users = defaultPermissions.users;
                    needsUpdate = true;
                }
                if (!rolePerm.permissions.agencies) {
                    rolePerm.permissions.agencies = defaultPermissions.agencies;
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    rolePerm.markModified('permissions');
                    await rolePerm.save();
                    console.log(`Patched new modules for role: ${role}`);
                } else {
                    console.log(`Permissions already complete for role: ${role}`);
                }
            }
        }

        console.log('Permission seeding completed');
        process.exit(0);
    } catch (error) {
        console.error('Seeding error:', error);
        process.exit(1);
    }
}

seedPermissions();
