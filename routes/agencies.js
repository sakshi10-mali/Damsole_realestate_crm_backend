const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const Agency = require('../models/Agency');
const User = require('../models/User');
const AgencyPermission = require('../models/AgencyPermission');
const { auth, authorize, checkModulePermission } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/agencies
// @desc    Get all agencies
// @access  Private (Super Admin, Agency Admin, Staff)
router.get('/', auth, checkModulePermission('agencies', 'view'), async (req, res) => {
  try {
    const filter = {};
    if (req.user.role === 'agency_admin') {
      filter._id = req.user.agency;
    }

    // Search functionality - search by name, email, or phone
    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search, 'i');
      filter.$or = [
        { name: searchRegex },
        { 'contact.email': searchRegex },
        { 'contact.phone': searchRegex }
      ];
    }

    // Filter by active/inactive status
    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }

    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const agencies = await Agency.find(filter)
      .populate('owner', 'firstName lastName email')
      .sort('-createdAt')
      .skip(skip)
      .limit(limit);

    const total = await Agency.countDocuments(filter);

    res.json({
      agencies,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get agencies error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/agencies/:id/permissions
// @desc    Get permissions for a specific agency (super_admin only)
// @access  Private
router.get('/:id/permissions', auth, authorize('super_admin'), async (req, res) => {
  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) {
      return res.status(404).json({ message: 'Agency not found' });
    }
    let agencyPermission = await AgencyPermission.findOne({ agency: req.params.id });
    if (!agencyPermission) {
      agencyPermission = new AgencyPermission({ agency: req.params.id });
      await agencyPermission.save();
    }
    res.json(agencyPermission);
  } catch (error) {
    console.error('Get agency permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/agencies/:id/permissions
// @desc    Update permissions for a specific agency (super_admin only)
// @access  Private
router.put('/:id/permissions', auth, authorize('super_admin'), async (req, res) => {
  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) {
      return res.status(404).json({ message: 'Agency not found' });
    }
    const { permissions } = req.body;
    let agencyPermission = await AgencyPermission.findOne({ agency: req.params.id });
    if (agencyPermission) {
      agencyPermission.permissions = permissions;
      agencyPermission.lastUpdatedBy = req.user.id;
      await agencyPermission.save();
    } else {
      agencyPermission = new AgencyPermission({
        agency: req.params.id,
        permissions: permissions || {},
        lastUpdatedBy: req.user.id
      });
      await agencyPermission.save();
    }
    res.json(agencyPermission);
  } catch (error) {
    console.error('Update agency permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/agencies/:id
// @desc    Get single agency
// @access  Private
router.get('/:id', auth, checkModulePermission('agencies', 'view'), async (req, res) => {
  try {
    const agency = await Agency.findById(req.params.id)
      .populate('owner', 'firstName lastName email phone');

    if (!agency) {
      return res.status(404).json({ message: 'Agency not found' });
    }

    // Check permissions - agency_admin can only access their own agency
    if (req.user.role === 'agency_admin' && agency._id.toString() !== req.user.agency?.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json({ agency });
  } catch (error) {
    console.error('Get agency error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/agencies
// @desc    Create new agency and agency admin user
// @access  Private (Super Admin only)
router.post('/', auth, checkModulePermission('agencies', 'create'), [
  body('name').trim().notEmpty().withMessage('Agency name is required'),
  body('contact.email').isEmail().withMessage('Valid email is required'),
  body('contact.phone').notEmpty().withMessage('Phone is required'),
  body('password').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    // Ensure owner is set - use current user if not provided
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        message: 'User not authenticated',
        errors: [{ msg: 'Authentication required' }]
      });
    }

    // Check if user with agency email already exists
    const existingUser = await User.findOne({ email: req.body.contact.email });
    if (existingUser) {
      return res.status(400).json({
        message: 'User already exists with this email',
        errors: [{ msg: 'Please use a different email address' }]
      });
    }

    // Set owner to current user if not provided
    const agencyData = {
      ...req.body
    };

    // Remove password from agency data (we'll use it separately)
    const password = agencyData.password;
    delete agencyData.password;
    delete agencyData.confirmPassword;

    agencyData.owner = req.body.owner || req.user.id;

    // Ensure owner is a valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(agencyData.owner)) {
      return res.status(400).json({
        message: 'Invalid owner ID',
        errors: [{ msg: 'Owner must be a valid user ID' }]
      });
    }

    // Create agency
    const agency = new Agency(agencyData);
    await agency.save();

    // Create agency admin user if password is provided
    if (password) {
      try {
        // Extract name from agency name (use first word as first name, rest as last name)
        const nameParts = agencyData.name.trim().split(/\s+/);
        const firstName = nameParts[0] || 'Agency';
        const lastName = nameParts.slice(1).join(' ') || 'Admin';

        const agencyAdmin = new User({
          firstName,
          lastName,
          email: req.body.contact.email,
          password: password,
          role: 'agency_admin',
          agency: agency._id,
          phone: req.body.contact.phone || '',
          isActive: true
        });

        await agencyAdmin.save();

        // Send account creation email with credentials
        try {
          console.log('📧 Attempting to send agency admin creation email to:', agencyAdmin.email);
          const emailService = require('../services/emailService');

          // Prepare user object with agency data for email
          const adminWithAgency = agencyAdmin.toObject();
          adminWithAgency.agency = { name: agencyData.name };

          await emailService.sendAccountCreatedNotification(adminWithAgency, password);
          console.log('✅ Agency admin creation email sent successfully');
        } catch (emailError) {
          console.error('❌ Failed to send account creation email:', emailError);
          // Don't fail agency creation if email fails
        }
      } catch (userError) {
        console.error('Error creating agency admin user:', userError);
        // If user creation fails, delete the agency
        await Agency.findByIdAndDelete(agency._id);
        return res.status(400).json({
          message: 'Failed to create agency admin account',
          errors: [{ msg: userError.message || 'User creation failed' }]
        });
      }
    }

    const populatedAgency = await Agency.findById(agency._id)
      .populate('owner', 'firstName lastName email');

    res.status(201).json({
      agency: populatedAgency,
      message: password
        ? 'Agency and agency admin account created successfully. The admin can now login with the provided email and password.'
        : 'Agency created successfully'
    });
  } catch (error) {
    console.error('Create agency error:', error);
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => ({
        msg: err.message,
        param: err.path
      }));
      return res.status(400).json({
        message: 'Agency validation failed',
        errors: validationErrors
      });
    }
    if (error.code === 11000) {
      return res.status(400).json({
        message: 'Agency with this slug already exists',
        errors: [{ msg: 'Slug must be unique' }]
      });
    }
    res.status(500).json({
      message: error.message || 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// @route   PUT /api/agencies/:id
// @desc    Update agency
// @access  Private
router.put('/:id', auth, checkModulePermission('agencies', 'edit'), async (req, res) => {
  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) {
      return res.status(404).json({ message: 'Agency not found' });
    }

    // Check permissions
    if (req.user.role === 'agency_admin' && agency._id.toString() !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Extract password from request body if provided
    const password = req.body.password;
    const updateData = { ...req.body };
    delete updateData.password;

    // Update agency data
    Object.assign(agency, updateData);
    await agency.save();

    // If password is provided, update the agency admin user's password
    if (password) {
      // Validate password length
      if (password.length < 6) {
        return res.status(400).json({
          message: 'Password must be at least 6 characters',
          errors: [{ msg: 'Password must be at least 6 characters' }]
        });
      }

      // Find the agency admin user by email
      const agencyAdmin = await User.findOne({
        email: agency.contact.email,
        role: 'agency_admin',
        agency: agency._id
      });

      if (agencyAdmin) {
        // Update password (will be hashed by pre-save hook)
        agencyAdmin.password = password;
        await agencyAdmin.save();
      } else {
        // If no agency admin exists, create one
        const nameParts = agency.name.trim().split(/\s+/);
        const firstName = nameParts[0] || 'Agency';
        const lastName = nameParts.slice(1).join(' ') || 'Admin';

        const newAgencyAdmin = new User({
          firstName,
          lastName,
          email: agency.contact.email,
          password: password,
          role: 'agency_admin',
          agency: agency._id,
          phone: agency.contact.phone || '',
          isActive: true
        });

        await newAgencyAdmin.save();

        // Send account creation email with credentials
        try {
          console.log('📧 Attempting to send new agency admin creation email to:', newAgencyAdmin.email);
          const emailService = require('../services/emailService');

          // Prepare user object with agency data for email
          const adminWithAgency = newAgencyAdmin.toObject();
          adminWithAgency.agency = { name: agency.name };

          await emailService.sendAccountCreatedNotification(adminWithAgency, password);
          console.log('✅ New agency admin creation email sent successfully');
        } catch (emailError) {
          console.error('❌ Failed to send account creation email:', emailError);
        }
      }
    }

    const updatedAgency = await Agency.findById(agency._id)
      .populate('owner', 'firstName lastName email');

    res.json({
      agency: updatedAgency,
      message: password
        ? 'Agency updated successfully. Agency admin password has been reset.'
        : 'Agency updated successfully'
    });
  } catch (error) {
    console.error('Update agency error:', error);
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => ({
        msg: err.message,
        param: err.path
      }));
      return res.status(400).json({
        message: 'Agency validation failed',
        errors: validationErrors
      });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/agencies/:id/stats
// @desc    Get agency statistics
// @access  Private
router.get('/:id/stats', auth, checkModulePermission('agencies', 'view'), async (req, res) => {
  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) {
      return res.status(404).json({ message: 'Agency not found' });
    }

    // Check permissions
    if (req.user.role === 'agency_admin' && agency._id.toString() !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const Property = require('../models/Property');
    const Lead = require('../models/Lead');

    const stats = {
      totalProperties: await Property.countDocuments({ agency: agency._id }),
      activeProperties: await Property.countDocuments({ agency: agency._id, status: 'active' }),
      soldProperties: await Property.countDocuments({ agency: agency._id, status: 'sold' }),
      rentedProperties: await Property.countDocuments({ agency: agency._id, status: 'rented' }),
      totalLeads: await Lead.countDocuments({ agency: agency._id }),
      activeLeads: await Lead.countDocuments({ agency: agency._id, status: { $in: ['new', 'contacted', 'site_visit', 'negotiation'] } }),
      totalAgents: await User.countDocuments({ agency: agency._id, role: 'agent', isActive: true })
    };

    // Update agency stats
    agency.stats = stats;
    await agency.save();

    res.json({ stats });
  } catch (error) {
    console.error('Get agency stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/agencies/:id
// @desc    Delete agency
// @access  Private (Super Admin, Agency Admin - own agency only)
router.delete('/:id', auth, checkModulePermission('agencies', 'delete'), async (req, res) => {
  try {
    const agency = await Agency.findById(req.params.id);
    if (!agency) {
      return res.status(404).json({ message: 'Agency not found' });
    }

    // Agency admin can delete only their own agency
    if (req.user.role === 'agency_admin' && agency._id.toString() !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await Agency.findByIdAndDelete(req.params.id);

    res.json({
      message: 'Agency deleted successfully',
      deletedAgency: {
        id: agency._id,
        name: agency.name,
        slug: agency.slug
      }
    });
  } catch (error) {
    console.error('Delete agency error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;