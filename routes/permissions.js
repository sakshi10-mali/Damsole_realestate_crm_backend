const express = require('express');
const router = express.Router();
const RolePermission = require('../models/RolePermission');
const { auth, authorize } = require('../middleware/auth');

// @route   GET /api/permissions
// @desc    Get all role permissions
// @access  Private (Super Admin)
router.get('/', auth, authorize('super_admin'), async (req, res) => {
    try {
        const permissions = await RolePermission.find();
        res.json(permissions);
    } catch (error) {
        console.error('Error fetching permissions:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   GET /api/permissions/:role
// @desc    Get permissions for a specific role
// @access  Private (Authenticated)
router.get('/:role', auth, async (req, res) => {
    try {
        let permissions = await RolePermission.findOne({ role: req.params.role });

        // If not found, create default one
        if (!permissions) {
            permissions = new RolePermission({ role: req.params.role });
            await permissions.save();
        }

        res.json(permissions);
    } catch (error) {
        console.error('Error fetching role permissions:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   PUT /api/permissions/:role
// @desc    Update permissions for a role
// @access  Private (Super Admin)
router.put('/:role', auth, authorize('super_admin'), async (req, res) => {
    try {
        const { permissions } = req.body;

        let rolePermission = await RolePermission.findOne({ role: req.params.role });

        if (rolePermission) {
            rolePermission.permissions = permissions;
            rolePermission.lastUpdatedBy = req.user.id;
            await rolePermission.save();
        } else {
            rolePermission = new RolePermission({
                role: req.params.role,
                permissions,
                lastUpdatedBy: req.user.id
            });
            await rolePermission.save();
        }

        res.json(rolePermission);
    } catch (error) {
        console.error('Error updating permissions:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST /api/permissions/initialize
// @desc    Initialize default permissions for all roles
// @access  Private (Super Admin)
router.post('/initialize', auth, authorize('super_admin'), async (req, res) => {
    try {
        const roles = ['agency_admin', 'agent', 'staff', 'user'];
        const results = [];

        for (const role of roles) {
            let perm = await RolePermission.findOne({ role });
            if (!perm) {
                perm = new RolePermission({ role });
                await perm.save();
                results.push({ role, status: 'created' });
            } else {
                results.push({ role, status: 'exists' });
            }
        }

        res.json({ message: 'Permissions initialized', results });
    } catch (error) {
        console.error('Error initializing permissions:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
