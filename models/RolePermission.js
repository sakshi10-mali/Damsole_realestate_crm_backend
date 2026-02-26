const mongoose = require('mongoose');

const rolePermissionSchema = new mongoose.Schema({
    role: {
        type: String,
        enum: ['agency_admin', 'agent', 'staff', 'user'],
        required: true,
        unique: true
    },
    permissions: {
        leads: {
            view: { type: Boolean, default: true },
            create: { type: Boolean, default: true },
            edit: { type: Boolean, default: true },
            delete: { type: Boolean, default: true }
        },
        properties: {
            view: { type: Boolean, default: true },
            create: { type: Boolean, default: true },
            edit: { type: Boolean, default: true },
            delete: { type: Boolean, default: true }
        },
        inquiries: {
            view: { type: Boolean, default: true },
            create: { type: Boolean, default: true },
            edit: { type: Boolean, default: true },
            delete: { type: Boolean, default: true }
        },
    subscriptions: {
        view: { type: Boolean, default: true },
        create: { type: Boolean, default: true },
        edit: { type: Boolean, default: true },
        delete: { type: Boolean, default: true }
    },
        contact_messages: {
            view: { type: Boolean, default: true },
            create: { type: Boolean, default: false },
            edit: { type: Boolean, default: true },
            delete: { type: Boolean, default: true }
        },
        users: {
            view: { type: Boolean, default: true },
            create: { type: Boolean, default: true },
            edit: { type: Boolean, default: true },
            delete: { type: Boolean, default: true }
        },
        agencies: {
            view: { type: Boolean, default: true },
            create: { type: Boolean, default: true },
            edit: { type: Boolean, default: true },
            delete: { type: Boolean, default: true }
        }
    },
    lastUpdatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('RolePermission', rolePermissionSchema);
